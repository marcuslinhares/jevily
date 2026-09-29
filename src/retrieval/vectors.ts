/**
 * Optional dense channel.
 *
 * Vectors live on the chunk row; retrieval is a brute-force cosine scan, which is
 * fine up to ~200k chunks and keeps the code honest. The `EMBEDDING_PROVIDER=none`
 * default means the whole system runs lexical-only until someone configures keys.
 */

import { config } from "../config.js";
import { log } from "../util/log.js";
import { mapPool } from "../util/async.js";
import type { Store, StoredChunk } from "../store/db.js";
import type { RankedId } from "./fusion.js";

export interface Embedder {
  readonly name: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

class OpenRouterEmbedder implements Embedder {
  readonly name: string;
  readonly dims: number;
  constructor(
    private readonly apiKey: string,
    model: string,
    dims: number,
    private readonly baseUrl = config().OPENROUTER_BASE_URL,
  ) {
    this.name = model;
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const batch of batches(texts, 64)) {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.name, input: batch, dimensions: this.dims }),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { data?: { embedding: number[] }[] };
      for (const item of json.data ?? []) out.push(Float32Array.from(item.embedding));
    }
    return out;
  }
}

export function createEmbedder(): Embedder | null {
  const c = config();
  if (c.EMBEDDING_PROVIDER === "none" || !c.OPENROUTER_API_KEY) return null;
  return new OpenRouterEmbedder(c.OPENROUTER_API_KEY, c.EMBEDDING_MODEL, c.EMBEDDING_DIMS);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Backfills embeddings for chunks that do not have one yet. */
export async function embedMissing(store: Store, embedder: Embedder, limit = 2000): Promise<number> {
  const pending = store.chunksMissingVector(limit);
  if (pending.length === 0) return 0;
  const vectors = await embedder.embed(pending.map((c) => embedInput(c)));
  pending.forEach((chunk, i) => {
    const vector = vectors[i];
    if (vector) store.setVector(chunk.id, vector);
  });
  log.info("embedded chunks", { count: pending.length, model: embedder.name });
  return pending.length;
}

export function embedInput(chunk: StoredChunk): string {
  return `${chunk.headingPath.join(" > ")}\n${chunk.text}`;
}

/** Brute-force cosine search over the chunks that already carry vectors. */
export function denseSearch(
  store: Store,
  queryVector: Float32Array,
  limit: number,
  candidates: StoredChunk[],
): RankedId[] {
  const scored: RankedId[] = [];
  for (const chunk of candidates) {
    if (!chunk.vector) continue;
    scored.push({ id: chunk.id, score: cosine(queryVector, chunk.vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function embedQuery(embedder: Embedder, query: string): Promise<Float32Array | null> {
  const [vector] = await embedder.embed([query]);
  return vector ?? null;
}

function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

export { mapPool };
