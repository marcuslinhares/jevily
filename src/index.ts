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

  // API key auth, off unless API_KEYS is set.
  app.addHook("onRequest", async (request, reply) => {
    const keys = c.API_KEYS;
    if (!keys || keys.length === 0) return;
    if (request.url === "/health") return;
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : (request.headers["x-api-key"] as string | undefined);
    if (!token || !keys.includes(token)) {
      await reply.code(401).send({ detail: { error: "Unauthorized: missing or invalid API key." } });
    }
  });

  return { app, store, index, embedder };
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
