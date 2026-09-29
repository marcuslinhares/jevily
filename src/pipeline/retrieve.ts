/**
 * Stage 2 — retrieve.
 *
 * Hybrid: BM25 for lexical precision, dense vectors for paraphrase recall, fused
 * with RRF. Then code-level filtering: domains, language, date window, safety, and
 * near-duplicate collapse. None of the filtering here needs a model.
 */

import { config } from "../config.js";
import { reciprocalRankFusion, type RankedId } from "../retrieval/fusion.js";
import { extractQuotedPhrases } from "../retrieval/tokenize.js";
import { simhashSimilarity } from "../store/indexer.js";
import type { IndexManager } from "../store/indexer.js";
import type { Store, StoredChunk, StoredDoc } from "../store/db.js";
import type { Embedder } from "../retrieval/vectors.js";
import { cosine, embedQuery } from "../retrieval/vectors.js";
import { fold, round } from "../util/text.js";
import type { SearchRequest } from "../domain/types.js";
import type { QueryPlan } from "../decision/questions.js";

export interface Candidate {
  chunk: StoredChunk;
  doc: StoredDoc;
  lexical: number | null;
  dense: number | null;
  fused: number;
  channels: number;
  exactPhraseHit: boolean;
}

export interface RetrieveInput {
  queries: string[];
  request: SearchRequest;
  plan: QueryPlan;
  pool: number;
}

export interface RetrieveOutput {
  candidates: Candidate[];
  stats: { lexical: number; dense: number; fused: number; afterFilter: number };
}

export async function retrieve(
  index: IndexManager,
  store: Store,
  request: SearchRequest,
  plan: QueryPlan,
  queries: string[],
  embedder: Embedder | null,
): Promise<RetrieveOutput> {
  const c = config();
  const pool = Math.max(20, c.DEFAULT_CANDIDATES_RERANKED * 3);
  const perQuery = Math.max(15, Math.round(pool / Math.max(1, queries.length)));

  const lexicalLists: RankedId[][] = [];
  const denseLists: RankedId[][] = [];

  const docCache = new Map<string, StoredDoc | null>();

  for (const query of queries) {
    lexicalLists.push(index.bm25.search(query, perQuery));
    if (embedder && c.HYBRID_ENABLED) {
      try {
        const vector = await embedQuery(embedder, query);
        if (vector) {
          const scored: RankedId[] = [];
          for (const hit of lexicalLists[lexicalLists.length - 1] ?? []) {
            const chunk = store.getChunk(hit.id);
            if (chunk?.vector) scored.push({ id: chunk.id, score: cosine(vector, chunk.vector) });
          }
          // The dense channel also sees chunks BM25 missed, via a wider lexical pass.
          if (scored.length < perQuery) {
            for (const hit of index.bm25.search(query, perQuery * 4)) {
              if (scored.some((s) => s.id === hit.id)) continue;
              const chunk = store.getChunk(hit.id);
              if (chunk?.vector) scored.push({ id: chunk.id, score: cosine(vector, chunk.vector) });
            }
          }
          scored.sort((a, b) => b.score - a.score);
          denseLists.push(scored.slice(0, perQuery));
        }
      } catch (err) {
        // Dense retrieval is an enhancement; a failure must not fail the search.
        index.stats();
      }
    }
  }

  const fused = reciprocalRankFusion(
    [
      ...lexicalLists.map((ranked) => ({ channel: "lexical", ranked, weight: 1 })),
      ...denseLists.map((ranked) => ({ channel: "dense", ranked, weight: 0.8 })),
    ],
    c.FUSION_RRF_K,
    pool,
  );

  const lexicalScores = new Map<string, number>();
  for (const list of lexicalLists) list.forEach((r) => lexicalScores.set(r.id, r.score));
  const denseScores = new Map<string, number>();
  for (const list of denseLists) list.forEach((r) => denseScores.set(r.id, r.score));

  const filters = buildFilters(request, plan);
  const exactPhrases = extractQuotedPhrases(request.query);
  const seenSimhash: string[] = [];
  const candidates: Candidate[] = [];
  let afterFilter = 0;

  for (const item of fused) {
    const chunk = store.getChunk(item.id);
    if (!chunk) continue;
    let doc = docCache.get(chunk.url) ?? null;
    if (doc === null && !docCache.has(chunk.url)) {
      doc = store.getDoc(chunk.url);
      docCache.set(chunk.url, doc);
    }
    if (!doc) continue;
    if (!passesFilters(doc, chunk, filters)) continue;
    afterFilter++;

    // Near-duplicate collapse: syndicated copies of one article add no evidence.
    if (seenSimhash.some((h) => simhashSimilarity(h, chunk.simhash) > 0.92)) continue;
    seenSimhash.push(chunk.simhash);

    const exactPhraseHit = exactPhrases.length === 0 || exactPhrases.some((p) => containsPhrase(doc!.markdown, p));

    candidates.push({
      chunk,
      doc,
      lexical: lexicalScores.get(chunk.id) ?? null,
      dense: denseScores.get(chunk.id) ?? null,
      fused: item.score,
      channels: fused.find((f) => f.id === item.id) ? 1 : 0,
      exactPhraseHit,
    });
    if (candidates.length >= pool) break;
  }

  return {
    candidates,
    stats: {
      lexical: lexicalLists.reduce((n, l) => n + l.length, 0),
      dense: denseLists.reduce((n, l) => n + l.length, 0),
      fused: fused.length,
      afterFilter,
    },
  };
}

interface Filters {
  includeDomains: string[];
  excludeDomains: string[];
  includeMode: "restrict" | "prefer" | null;
  language: string | null;
  filterByLanguage: boolean;
  from: number | null;
  to: number | null;
  requireDate: boolean;
  safeSearch: boolean;
}

function buildFilters(request: SearchRequest, plan: QueryPlan): Filters {
  const now = Date.now();
  const day = 86_400_000;
  const from =
    request.start_date !== undefined
      ? Date.parse(request.start_date)
      : request.time_range
        ? now - rangeMs(request.time_range, day)
        : null;
  let to = request.end_date !== undefined ? Date.parse(request.end_date) : null;
  if (request.time_range && plan.timeHorizon >= 3) to = now;
  const requireDate = Boolean(request.filter_by_published_date);
  return {
    includeDomains: (request.include_domains ?? []).map(normalizeDomain),
    excludeDomains: (request.exclude_domains ?? []).map(normalizeDomain),
    includeMode: request.include_domains?.length ? (request.include_domains_mode ?? "restrict") : null,
    language: request.language ?? null,
    filterByLanguage: Boolean(request.filter_by_language && request.language),
    from: Number.isFinite(from) ? (from as number) : null,
    to: Number.isFinite(to) ? (to as number) : null,
    requireDate,
    safeSearch: Boolean(request.safe_search),
  };
}

function passesFilters(doc: StoredDoc, chunk: StoredChunk, f: Filters): boolean {
  if (doc.stale && doc.status !== "ok") return false;
  if (f.excludeDomains.some((d) => doc.domain === d || doc.domain.endsWith(`.${d}`))) return false;
  if (f.includeMode === "restrict" && f.includeDomains.length > 0) {
    const inside = f.includeDomains.some((d) => doc.domain === d || doc.domain.endsWith(`.${d}`));
    if (!inside) return false;
  }
  if (f.filterByLanguage && f.language && doc.lang && !doc.lang.toLowerCase().startsWith(f.language.toLowerCase().slice(0, 2))) {
    return false;
  }
  const published = doc.publishedDate ? Date.parse(doc.publishedDate) : Number.NaN;
  if (f.requireDate) {
    if (!Number.isFinite(published)) return false;
    if (f.from !== null && published < f.from) return false;
    if (f.to !== null && published > f.to) return false;
  } else if ((f.from !== null || f.to !== null) && Number.isFinite(published)) {
    if (f.from !== null && published < f.from) return false;
    if (f.to !== null && published > f.to) return false;
  }
  if (f.safeSearch && isUnsafe(doc, chunk)) return false;
  return true;
}

const UNSAFE = /\b(how to make (a )?(bomb|explosive|meth)|child (porn|abuse)|bestiality|self.?harm methods)\b/i;
function isUnsafe(doc: StoredDoc, chunk: StoredChunk): boolean {
  return UNSAFE.test(doc.title) || UNSAFE.test(chunk.text);
}

function rangeMs(range: string, day: number): number {
  switch (range) {
    case "day":
      return day;
    case "week":
      return 7 * day;
    case "month":
      return 30 * day;
    case "year":
      return 365 * day;
    default:
      return 365 * day;
  }
}

function normalizeDomain(domain: string): string {
  return fold(domain).replace(/^www\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return fold(haystack).includes(fold(phrase));
}

export function lexicalToUnit(score: number, max: number): number {
  return max <= 0 ? 0 : round(score / max, 4);
}
