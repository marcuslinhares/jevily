/**
 * Server bootstrap.
 *
 * On boot: open the store, load the lexical index from it, then serve. Index
 * loading is the slow part, so it happens before the listener opens and `/health`
 * is not reachable until the index is warm.
 */

import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { config } from "./config.js";
import { log } from "./util/log.js";
import { RateLimiter } from "./util/rate-limit.js";
import type { FastifyRequest } from "fastify";
import { Store } from "./store/db.js";
import { IndexManager } from "./store/indexer.js";
import { createEmbedder, embedMissing } from "./retrieval/vectors.js";
import { registerRoutes } from "./routes/index.js";
import { decision } from "./decision/service.js";

export async function buildServer() {
  const c = config();
  const app = Fastify({
    logger: false,
    bodyLimit: c.BODY_LIMIT_BYTES,
    trustProxy: true,
  });

  const store = new Store();
  const index = new IndexManager(store);
  const embedder = createEmbedder();

  const loaded = await index.rebuild();
  log.info("index loaded", { ...loaded, terms: index.stats().terms });

  if (embedder && store.countChunks() > 0) {
    // Backfill is best-effort at boot: search works lexically either way.
    embedMissing(store, embedder, 500).catch((err) => log.warn("embedding backfill failed", { err: String(err) }));
  }

  registerRoutes(app, { store, index, embedder });

  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error as { message?: string; statusCode?: number };
    log.error("request failed", { url: request.url, method: request.method, err: error });
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ detail: { error: err.message ?? "internal error" } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ detail: { error: `no route for ${request.method} ${request.url}` } });
  });

  // Auth, then rate limit. Limiting before authenticating would let an anonymous
  // caller probe which keys exist — a valid-looking key would earn a 429 instead of
  // a 401 — and would let one anonymous caller exhaust a shared anonymous budget.
  const limiter =
    c.RATE_LIMIT_RPM > 0 ? new RateLimiter({ limit: c.RATE_LIMIT_RPM, windowMs: c.RATE_LIMIT_WINDOW_MS }) : null;

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;

    const token = readKey(request);
    if (c.API_KEYS && c.API_KEYS.length > 0) {
      if (!token || !c.API_KEYS.includes(token)) {
        return reply.code(401).send({ detail: { error: "Unauthorized: missing or invalid API key." } });
      }
    }

    if (!limiter) return;
    // Anonymous callers share one bucket. Without a key there is nothing to
    // attribute spend to, so the bucket has to be common.
    const verdict = limiter.take(token ?? "anonymous");
    reply.header("X-RateLimit-Limit", String(verdict.limit));
    reply.header("X-RateLimit-Remaining", String(verdict.remaining));
    reply.header("X-RateLimit-Reset", String(verdict.resetSeconds));
    if (!verdict.allowed) {
      reply.header("Retry-After", String(verdict.retryAfterSeconds));
      return reply
        .code(429)
        .send({ detail: { error: `Rate limit exceeded. Retry in ${verdict.retryAfterSeconds}s.` } });
    }
  });

  return { app, store, index, embedder, limiter };
}

/** The presented credential, from either header. */
function readKey(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || undefined;
  const alt = request.headers["x-api-key"];
  return typeof alt === "string" && alt.trim() ? alt.trim() : undefined;
}

export async function start(): Promise<void> {
  const c = config();
  const { app, store } = await buildServer();
  await app.listen({ port: c.PORT, host: c.HOST });
  log.info("jevily listening", {
    url: `http://${c.HOST}:${c.PORT}`,
    decision_engine: c.DECISION_ENGINE,
    calibrated: decision().calibrated,
  });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// `ts src/index.ts` and `node dist/index.js` both land here, but so does any
// `import { buildServer } from "./index.js"`, so compare resolved paths rather
// than guessing from the URL suffix.
const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry && fileURLToPath(import.meta.url) === entry) {
  start().catch((err) => {
    log.error("startup failed", { err });
    process.exit(1);
  });
}
