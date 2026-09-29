/**
 * Shape statistics for an indexed corpus.
 *
 * A synthetic corpus has whatever chunk lengths its author happened to write. Real
 * pages have a distribution, and the chunking thresholds were set by reading real
 * pages rather than by looking at that distribution. So: what actually landed in
 * the index, and is anything degenerate.
 */

import type { Store } from "../../src/store/db.js";

export interface ChunkStats {
  docs: number;
  chunks: number;
  meanChars: number;
  medianChars: number;
  p05Chars: number;
  p95Chars: number;
  maxChars: number;
  meanChunksPerDoc: number;
  maxChunksPerDoc: number;
  zeroChunkDocs: number;
  /** Documents that produced a single chunk covering the whole page. */
  singleChunkDocs: number;
}

export function chunkStats(store: Store): ChunkStats {
  const docs = store.allDocs();
  const chars: number[] = [];
  const perDoc: number[] = [];
  let zeroChunkDocs = 0;
  let singleChunkDocs = 0;

  for (const doc of docs) {
    const n = store.chunksOf(doc.url).length;
    perDoc.push(n);
    if (n === 0) zeroChunkDocs++;
    if (n === 1) singleChunkDocs++;
  }
  for (const doc of docs) {
    for (const c of store.chunksOf(doc.url)) chars.push(c.text.length);
  }

  chars.sort((a, b) => a - b);
  const sum = chars.reduce((a, b) => a + b, 0);
  const at = (q: number) => chars[Math.min(chars.length - 1, Math.floor(chars.length * q))] ?? 0;

  return {
    docs: docs.length,
    chunks: chars.length,
    meanChars: chars.length > 0 ? sum / chars.length : 0,
    medianChars: at(0.5),
    p05Chars: at(0.05),
    p95Chars: at(0.95),
    maxChars: chars.at(-1) ?? 0,
    meanChunksPerDoc: perDoc.length > 0 ? perDoc.reduce((a, b) => a + b, 0) / perDoc.length : 0,
    maxChunksPerDoc: perDoc.length > 0 ? Math.max(...perDoc) : 0,
    zeroChunkDocs,
    singleChunkDocs,
  };
}
