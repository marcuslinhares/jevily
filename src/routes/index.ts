/**
 * HTTP surface.
 *
 * `/v1/search` is Tavily-compatible plus extensions. The rest is the index and
 * crawl surface that makes it a real search engine rather than a proxy, and
 * `/v1/evaluate` exposes the decision engine directly for debugging a threshold.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { log } from "../util/log.js";
import { mapPool } from "../util/async.js";
import { runSearch } from "../pipeline/search.js";
import { Crawler } from "../crawler/crawler.js";
import { extract } from "../crawler/extract.js";
import { decision } from "../decision/service.js";
import { createEngine } from "../decision/index.js";
import { createGenerator } from "../llm/generator.js";
import { createEmbedder, embedMissing } from "../retrieval/vectors.js";
import { toArray } from "../util/params.js";
import {
  crawlBodySchema,
  evaluateBodySchema,
  extractBodySchema,
  indexBodySchema,
  normalizeSearchRequest,
  searchBodySchema,
} from "../domain/schema.js";
import type { IndexManager } from "../store/indexer.js";
import type { Store } from "../store/db.js";

export interface RouteDeps {
  store: Store;
  index: IndexManager;
  embedder: ReturnType<typeof createEmbedder>;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const crawler = new Crawler(deps.store, deps.index);

  app.get("/health", async () => {
    const c = config();
    const active = decision();
    return {
      status: "ok",
      decision_engine: {
        name: active.name,
        calibrated: active.calibrated,
        // Where the judgements actually ran, and which model was requested.
        base_url: c.DECISION_BASE_URL,
        configured_model: c.DECISION_MODEL,
      },
      generator: c.GENERATOR_PROVIDER === "none" ? null : c.GENERATOR_MODEL,
      embeddings: c.EMBEDDING_PROVIDER === "none" ? null : c.EMBEDDING_MODEL,
      index: deps.index.stats(),
      store: deps.store.stats(),
    };
  });

  app.post("/v1/search", async (request, reply) => {
    const parsed = searchBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const searchRequest = normalizeSearchRequest(parsed.data);
    const { response } = await runSearch({ ...deps, generator: createGenerator() }, searchRequest, requestAbort(request));
    return response;
  });

  // Convenience GET, so a browser or curl can try the API without a JSON body.
  app.get("/v1/search", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (!query.q && !query.query) return badRequest(reply, "provide ?q=");
    const body: Record<string, unknown> = {
      query: String(query.q ?? query.query),
      ...(query.depth ? { search_depth: query.depth } : {}),
      ...(query.max_results ? { max_results: Number(query.max_results) } : {}),
      ...(query.topic ? { topic: query.topic } : {}),
      ...(query.answer ? { include_answer: query.answer === "1" || query.answer === "true" } : {}),
      ...(query.trace ? { include_trace: true } : {}),
      ...(query.auto ? { auto_parameters: true } : {}),
    };
    const parsed = searchBodySchema.safeParse(body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { response } = await runSearch(
      { ...deps, generator: createGenerator() },
      normalizeSearchRequest(parsed.data),
      requestAbort(request),
    );
    return response;
  });

  app.post("/v1/extract", async (request, reply) => {
    const parsed = extractBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const urls = toArray(parsed.data.urls).slice(0, 20);
    const results = await mapPool(urls, 4, async (url) => {
      try {
        const res = await fetch(url, { headers: { "User-Agent": config().CRAWL_USER_AGENT } });
        if (!res.ok) return { url, ok: false, error: `http ${res.status}`, results: [] };
        const html = await res.text();
        const extracted = extract(html, url);
        return {
          url,
          ok: true,
          results: [
            {
              url,
              raw_content: parsed.data.format === "text" ? extracted.text : extracted.markdown,
              images: parsed.data.include_images ? extracted.images : undefined,
            },
          ],
        };
      } catch (err) {
        return { url, ok: false, error: String(err), results: [] };
      }
    });
    return { results, response_time: 0 };
  });

  app.post("/v1/crawl", async (request, reply) => {
    const parsed = crawlBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { url, mode, max_depth, max_pages, force } = parsed.data;

    if (mode === "queue") {
      const queued = deps.store.enqueue([{ url, depth: 0, priority: 1 }]);
      return { queued, pending: deps.store.pendingCount() };
    }
    if (mode === "page") {
      const outcome = await crawler.crawlOne(url, force ? { force: true } : {});
      return outcome;
    }
    const outcomes: unknown[] = [];
    const result = await crawler.crawlSite(url, {
      maxDepth: max_depth ?? 2,
      onProgress: (o) => {
        outcomes.push(o);
        if (max_pages && outcomes.length >= max_pages) log.debug("crawl page budget reached", { url });
      },
    });
    return {
      discovered: result.discovered,
      indexed: result.outcomes.filter((o) => o.status === "indexed").length,
      outcomes: max_pages ? result.outcomes.slice(0, max_pages) : result.outcomes,
    };
  });

  app.post("/v1/index", async (request, reply) => {
    const parsed = indexBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const urls = toArray(parsed.data.urls);
    if (parsed.data.mode === "site") {
      const result = await crawler.crawlSite(urls[0] as string, {});
      return { discovered: result.discovered, indexed: result.outcomes.length };
    }
    const outcomes = await mapPool(urls, 3, (url) => crawler.crawlOne(url, parsed.data.force ? { force: true } : {}));
    const embedded = deps.embedder ? await embedMissing(deps.store, deps.embedder, 2000) : 0;
    return { outcomes, embedded };
  });

  app.post("/v1/index/rebuild", async () => {
    const result = await deps.index.rebuild();
    return result;
  });

  app.get("/v1/stats", async () => {
    const c = config();
    const active = decision();
    return {
      index: deps.index.stats(),
      store: deps.store.stats(),
      decision_engine: {
        engine: active.name,
        calibrated: active.calibrated,
        base_url: c.DECISION_BASE_URL,
        model: c.DECISION_MODEL,
      },
      generator: c.GENERATOR_PROVIDER,
      embeddings: c.EMBEDDING_PROVIDER,
    };
  });

  app.get<{ Params: { id: string } }>("/v1/trace/:id", async (request, reply) => {
    const trace = deps.store.getTrace(request.params.id);
    if (!trace) return reply.code(404).send({ detail: { error: "trace not found" } });
    return trace;
  });

  /**
   * Direct access to the decision engine. Useful for tuning a threshold without
   * paying for a full search, and for seeing exactly what the engine returned.
   */
  app.post("/v1/evaluate", async (request, reply) => {
    const parsed = evaluateBodySchema.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    const { state, questions, model } = parsed.data;
    const engine = createEngine();
    const result = await engine.evaluate({
      state,
      questions: questions as never,
      ...(model ? { model } : {}),
    });
    return result;
  });
}

function requestAbort(request: FastifyRequest): AbortSignal | undefined {
  const anyRequest = request as unknown as { raw?: { destroyed?: boolean } };
  if (anyRequest.raw?.destroyed) return AbortSignal.abort();
  return undefined;
}

function badRequest(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof z.ZodError) {
    return reply.code(422).send({
      detail: error.issues.map((issue) => ({
        type: "value_error",
        loc: ["body", ...issue.path],
        msg: issue.message,
      })),
    });
  }
  return reply.code(400).send({ detail: { error: String(error) } });
}
