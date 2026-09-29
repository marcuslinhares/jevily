/**
 * BM25 inverted index.
 *
 * In-memory postings held in typed arrays so a query over ~1M chunks stays in the
 * low hundreds of milliseconds. Documents are chunk ids (stable strings mapped to
 * dense integers internally). Deletions are tombstones; `compact()` rebuilds.
 *
 * The index is the recall stage. It is deliberately not trying to be precise —
 * ranking precision is the decision engine's job.
 */

import { docTokens, queryTokens, type Tokenizer } from "./tokenize.js";
import { round } from "../util/text.js";

export interface Bm25Options {
  k1?: number;
  b?: number;
}

export interface ScoredDoc {
  id: string;
  score: number;
}

interface Posting {
  docs: Int32Array;
  tfs: Float32Array;
}

const DEFAULTS: Required<Bm25Options> = { k1: 1.2, b: 0.75 };

export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;

  /** term -> postings */
  private postings = new Map<string, Posting>();
  /** dense id -> external id */
  private externalIds: string[] = [];
  private docLen: number[] = [];
  private dead: Uint8Array = new Uint8Array(0);
  private liveCount = 0;
  private pendingWrites = new Set<string>();
  private deleted = new Set<string>();

  constructor(opts: Bm25Options = {}) {
    this.k1 = opts.k1 ?? DEFAULTS.k1;
    this.b = opts.b ?? DEFAULTS.b;
  }

  get size(): number {
    return this.liveCount;
  }

  get terms(): number {
    return this.postings.size;
  }

  has(id: string): boolean {
    return this.externalIds.includes(id) && !this.deleted.has(id);
  }

  /** Adds or replaces a document. Replacing a document re-adds its terms. */
  add(id: string, text: string, tokenizer: Tokenizer = docTokens): void {
    this.remove(id);
    const docId = this.externalIds.length;
    this.externalIds.push(id);
    this.docLen.push(0);
    if (this.dead.length < docId + 1) {
      const grown = new Uint8Array(docId + 1 - this.dead.length);
      this.dead = new Uint8Array([...this.dead, ...grown]);
    }

    const tokens = tokenizer(text);
    if (tokens.length === 0) {
      this.liveCount++;
      this.pendingWrites.add(id);
      return;
    }
    this.docLen[docId] = tokens.length;
    this.liveCount++;

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    for (const [term, freq] of tf) {
      let posting = this.postings.get(term);
      if (!posting) {
        posting = { docs: new Int32Array(0), tfs: new Float32Array(0) };
        this.postings.set(term, posting);
      }
      const n = posting.docs.length;
      const docs = new Int32Array(n + 1);
      const tfs = new Float32Array(n + 1);
      docs.set(posting.docs);
      tfs.set(posting.tfs);
      docs[n] = docId;
      tfs[n] = freq;
      this.postings.set(term, { docs, tfs });
    }
    this.pendingWrites.add(id);
  }

  remove(id: string): void {
    const at = this.externalIds.indexOf(id);
    if (at === -1) return;
    this.dead[at] = 1;
    this.liveCount--;
    this.pendingWrites.delete(id);
    this.deleted.add(id);
  }

  /**
   * BM25 search. Returns at most `limit` results ordered by descending score.
   * Terms absent from the corpus are ignored; a query with no known term returns [].
   */
  search(query: string, limit = 20, tokenizer: Tokenizer = queryTokens): ScoredDoc[] {
    const terms = tokenizer(query);
    if (terms.length === 0 || this.liveCount === 0) return [];

    const N = this.externalIds.length;
    const avgdl = this.avgDocLen();
    const scores = new Map<number, number>();
    const seen = new Set<string>();

    for (const term of terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.docs.length;
      if (df === 0) continue;
      // BM25 idf, floored so very common terms cannot contribute negative weight.
      const idf = Math.max(0.01, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
      for (let i = 0; i < posting.docs.length; i++) {
        const docId = posting.docs[i] as number;
        if (this.dead[docId]) continue;
        const tf = posting.tfs[i] as number;
        const dl = this.docLen[docId] ?? 0;
        const norm = this.k1 * (1 - this.b + (this.b * (dl || 1)) / (avgdl || 1));
        const contribution = idf * ((tf * (this.k1 + 1)) / (tf + norm));
        scores.set(docId, (scores.get(docId) ?? 0) + contribution);
      }
    }
    return this.top(scores, limit);
  }

  /**
   * Scores every live document that contains at least one term, without a limit.
   * Used by the index-side phrase boost and by offline evaluation.
   */
  scoreAll(query: string, tokenizer: Tokenizer = queryTokens): Map<string, number> {
    const out = new Map<string, number>();
    for (const hit of this.search(query, this.liveCount, tokenizer)) out.set(hit.id, hit.score);
    return out;
  }

  private top(scores: Map<number, number>, limit: number): ScoredDoc[] {
    const entries = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const out: ScoredDoc[] = [];
    for (const [docId, score] of entries) {
      if (out.length >= limit) break;
      const id = this.externalIds[docId];
      if (id) out.push({ id, score: round(score, 6) });
    }
    return out;
  }

  private avgDocLen(): number {
    if (this.docLen.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.docLen.length; i++) sum += this.dead[i] ? 0 : (this.docLen[i] ?? 0);
    return sum / Math.max(1, this.liveCount);
  }

  /** Drops tombstoned documents and rebuilds postings. */
  compact(): void {
    const keep: number[] = [];
    for (let i = 0; i < this.externalIds.length; i++) if (!this.dead[i]) keep.push(i);
    const remap = new Map<number, number>();
    keep.forEach((old, next) => remap.set(old, next));

    const before = this.postingsSnapshot();
    this.postings.clear();
    const externalIds: string[] = [];
    const docLen: number[] = [];
    const dead: number[] = [];
    for (const old of keep) {
      externalIds.push(this.externalIds[old] as string);
      docLen.push(this.docLen[old] ?? 0);
      dead.push(0);
    }
    for (const [term, posting] of before) {
      for (let i = 0; i < posting.docs.length; i++) {
        const next = remap.get(posting.docs[i] as number);
        if (next === undefined) continue;
        let target = this.postings.get(term);
        if (!target) {
          target = { docs: new Int32Array(0), tfs: new Float32Array(0) };
          this.postings.set(term, target);
        }
        const n = target.docs.length;
        const docs = new Int32Array(n + 1);
        const tfs = new Float32Array(n + 1);
        docs.set(target.docs);
        tfs.set(target.tfs);
        docs[n] = next;
        tfs[n] = posting.tfs[i] as number;
        this.postings.set(term, { docs, tfs });
      }
    }
    this.externalIds = externalIds;
    this.docLen = docLen;
    this.dead = new Uint8Array(dead);
    this.deleted.clear();
    this.liveCount = externalIds.length;
  }

  private postingsSnapshot(): Map<string, Posting> {
    return new Map(this.postings);
  }

  /** Small stats object for /health and /stats. */
  stats(): { documents: number; terms: number; avgDocLen: number } {
    return {
      documents: this.liveCount,
      terms: this.postings.size,
      avgDocLen: round(this.avgDocLen(), 2),
    };
  }
}
