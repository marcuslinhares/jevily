/** Rank fusion for the two retrieval channels. */

import { round } from "../util/text.js";

export interface RankedId {
  id: string;
  score: number;
  /** How many channels contributed this document. A cheap precision signal. */
  channels?: number;
}

export interface FusedId extends RankedId {
  channels: number;
}

/**
 * Reciprocal Rank Fusion. Combines rankings without needing comparable scores,
 * which is exactly the situation with BM25 (unbounded, corpus-dependent) and
 * cosine similarity (bounded, model-dependent) in the same result list.
 */
export function reciprocalRankFusion(
  lists: { channel: string; ranked: RankedId[]; weight?: number }[],
  k = 60,
  limit = 100,
): FusedId[] {
  const scores = new Map<string, { score: number; channels: Set<string> }>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.ranked.forEach((item, index) => {
      const entry = scores.get(item.id) ?? { score: 0, channels: new Set<string>() };
      entry.score += weight / (k + index + 1);
      entry.channels.add(list.channel);
      scores.set(item.id, entry);
    });
  }
  const fused: FusedId[] = [...scores.entries()].map(([id, entry]) => ({
    id,
    score: round(entry.score, 8),
    channels: entry.channels.size,
  }));
  return fused.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function normalizeScores(ranked: RankedId[]): Map<string, number> {
  if (ranked.length === 0) return new Map();
  const max = ranked[0]?.score ?? 1;
  const min = ranked[ranked.length - 1]?.score ?? 0;
  const span = max - min || 1;
  const out = new Map<string, number>();
  for (const item of ranked) out.set(item.id, (item.score - min) / span);
  return out;
}
