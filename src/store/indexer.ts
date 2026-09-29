/** Chunking, near-duplicate detection, and index maintenance over the store. */

import { Bm25Index } from "../retrieval/bm25.js";
import { docTokens } from "../retrieval/tokenize.js";
import { detectLanguage, splitSentences, estimateTokens, clamp } from "../util/text.js";
import { sha1, sha256 } from "../util/hash.js";
import type { Store, StoredChunk, StoredDoc } from "./db.js";

export interface Chunk {
  id: string;
  url: string;
  ord: number;
  title: string;
  headingPath: string[];
  text: string;
  tokens: number;
  lang: string;
  simhash: string;
  contentHash: string;
}

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  minTokens?: number;
}

/**
 * Structure-aware chunking.
 *
 * Splits on heading boundaries first, then packs sentences into chunks that respect
 * those boundaries. A heading is part of its chunks' context, which is what makes
 * the re-ranker able to tell "expired on" from "renews on" when both appear under
 * similarly named sections.
 */
/**
 * Structure-aware chunking.
 *
 * Sibling headings are grouped under their shared parent before cutting, because a
 * `##` subsection is rarely a useful retrieval unit on its own: 150 tokens of prose
 * stripped of its parent heading is a passage both BM25 and the decision engine have
 * to judge without context. The grouping keeps the parent as the chunk's heading
 * path and retains each subsection's own heading inline, so nothing is lost.
 *
 * The page title is the root of every heading path and is not repeated inside it.
 */
export function chunkDocument(
  doc: { url: string; title: string; markdown: string },
  options: ChunkOptions = {},
): Chunk[] {
  const target = options.targetTokens ?? 220;
  const max = options.maxTokens ?? 400;
  const min = options.minTokens ?? 60;

  const groups = groupSections(splitByHeadings(doc.markdown), max);
  const chunks: Chunk[] = [];
  let ord = 0;

  for (const group of groups) {
    const headingPath = dedupePath([doc.title, ...group.heading]);
    const sentences = splitSentences(group.body);
    const lang = detectLanguage(`${headingPath.join(" ")} ${group.body.slice(0, 400)}`);
    let buffer: string[] = [];
    let bufferTokens = 0;

    const flush = (force = false) => {
      const text = normalize(buffer.join(" "));
      if (!text) {
        buffer = [];
        bufferTokens = 0;
        return;
      }
      const tokens = estimateTokens(text);
      if (tokens < min && !force) {
        // Below the floor and nothing more is coming: emit it anyway rather than
        // silently drop content from the index.
        if (buffer.length === sentences.length) chunks.push(makeChunk(doc.url, ord++, headingPath, text, lang));
        buffer = [];
        bufferTokens = 0;
        return;
      }
      chunks.push(makeChunk(doc.url, ord++, headingPath, text, lang));
      buffer = [];
      bufferTokens = 0;
    };

    for (const sentence of sentences) {
      const sentenceTokens = estimateTokens(sentence);
      if (bufferTokens + sentenceTokens > max && buffer.length > 0) flush(true);
      buffer.push(sentence);
      bufferTokens += sentenceTokens;
      if (bufferTokens >= target) flush(true);
    }
    if (buffer.length > 0) flush(true);
  }

  if (chunks.length === 0) {
    const text = normalize(doc.markdown);
    if (text) chunks.push(makeChunk(doc.url, 0, [doc.title], text, detectLanguage(text)));
  }
  return chunks;
}

/** Drops a repeated title from a heading path: `A > A > B` reads as `A > B`. */
function dedupePath(path: string[]): string[] {
  const out: string[] = [];
  for (const part of path) {
    if (!part) continue;
    if (out.length > 0 && out[out.length - 1] === part) continue;
    out.push(part);
  }
  return out;
}

interface Section {
  heading: string[];
  body: string;
}

/**
 * Groups consecutive sections that share a parent heading into one unit, then
 * splits any group that is still too large.
 *
 * A `##` subsection is normally too small to retrieve on its own, but a `##` whose
 * parent is the document root is already a natural unit. The rule is therefore:
 * sibling subsections merge into their parent, and a group only splits when it
 * exceeds `max`.
 */
export function groupSections(sections: Section[], maxTokens: number): Section[] {
  if (sections.length === 0) return [];
  const out: Section[] = [];
  let current: Section | null = null;

  // Everything under the same top-level heading is one unit of meaning.
  const keyOf = (heading: string[]) => heading[0] ?? "";

  for (const section of sections) {
    if (!current) {
      current = { heading: [...section.heading], body: section.body };
      continue;
    }
    const sameUnit = keyOf(current.heading) === keyOf(section.heading);
    const fits = estimateTokens(current.body) + estimateTokens(section.body) <= maxTokens;

    if (sameUnit && fits) {
      // Absorb the subsection, keeping its heading inline so the structure survives.
      const label = section.heading.at(-1);
      const head = label && label !== current.heading.at(-1) ? `**${label}**\n\n` : "";
      current.body = `${current.body}\n\n${head}${section.body}`;
      // The chunk's heading path stays at the top-level section.
      if (current.heading.length > 1) current.heading = current.heading.slice(0, 1);
    } else {
      if (current) out.push(current);
      current = { heading: [...section.heading], body: section.body };
    }
  }
  if (current) out.push(current);
  return out;
}

/** Splits markdown on ATX headings, keeping a heading stack for context. */
export function splitByHeadings(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  const stack: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const push = () => {
    const body = current.join("\n").trim();
    if (body) sections.push({ heading: [...stack], body });
    current = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) {
      push();
      const level = (match[1] as string).length;
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = (match[2] as string).trim();
      continue;
    }
    current.push(line);
  }
  push();
  return sections.length > 0 ? sections : [{ heading: [], body: markdown }];
}

function makeChunk(url: string, ord: number, headingPath: string[], text: string, lang: string): Chunk {
  return {
    id: `${sha1(url).slice(0, 10)}-${ord.toString(36)}`,
    url,
    ord,
    title: headingPath[0] ?? "",
    headingPath,
    text,
    tokens: estimateTokens(text),
    lang,
    simhash: simhash64(text),
    contentHash: sha256(text).slice(0, 32),
  };
}

function normalize(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// --- near-duplicate detection ----------------------------------------------

/** 64-bit simhash over token 3-grams, as a hex string. */
export function simhash64(text: string): string {
  const tokens = docTokens(text);
  if (tokens.length === 0) return "0000000000000000";
  const grams: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    grams.push(tokens[i] as string);
    if (i + 2 < tokens.length) grams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  const vector = new Array<number>(64).fill(0);
  for (const gram of grams) {
    const h = sha1(gram);
    for (let bit = 0; bit < 64; bit++) {
      const nibble = parseInt(h[bit >> 2] as string, 16);
      const on = (nibble >> (3 - (bit & 3))) & 1;
      vector[bit] = (vector[bit] as number) + (on ? 1 : -1);
    }
  }
  let hex = "";
  for (let byte = 0; byte < 8; byte++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) | ((vector[byte * 8 + bit] as number) > 0 ? 1 : 0);
    hex += value.toString(16).padStart(2, "0");
  }
  return hex;
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i += 2) {
    const x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    distance += popcount(x);
  }
  return distance;
}

function popcount(x: number): number {
  let bits = 0;
  let v = x;
  while (v) {
    v &= v - 1;
    bits++;
  }
  return bits;
}

/** Similarity in 0..1 from simhash distance. ~6 bits apart is the usual cutoff. */
export function simhashSimilarity(a: string, b: string): number {
  return clamp(1 - hamming(a, b) / 64, 0, 1);
}

// --- index ------------------------------------------------------------------

/**
 * Owns the lexical index and keeps it in step with the store.
 * Rebuild is explicit: `sync()` applies pending writes, `rebuild()` reindexes all.
 */
export class IndexManager {
  bm25 = new Bm25Index();

  constructor(private readonly store: Store) {}

  /** Loads every live chunk into the in-memory index. */
  async rebuild(): Promise<{ chunks: number; docs: number; ms: number }> {
    const started = Date.now();
    const fresh = new Bm25Index();
    const docs = this.store.allDocs();
    let chunks = 0;
    for (const doc of docs) {
      for (const chunk of this.store.chunksOf(doc.url)) {
        fresh.add(chunk.id, `${doc.title}\n${chunk.headingPath.join(" > ")}\n${chunk.text}`);
        chunks++;
      }
    }
    this.bm25 = fresh;
    return { chunks, docs: docs.length, ms: Date.now() - started };
  }

  /** Adds a single document's chunks without a full rebuild. */
  async addDocument(url: string): Promise<number> {
    const doc = this.store.getDoc(url);
    if (!doc) return 0;
    const previous = this.store.chunksOf(url);
    for (const chunk of previous) this.bm25.remove(chunk.id);
    let count = 0;
    for (const chunk of this.store.chunksOf(url)) {
      this.bm25.add(chunk.id, `${doc.title}\n${chunk.headingPath.join(" > ")}\n${chunk.text}`);
      count++;
    }
    return count;
  }

  async removeDocument(url: string): Promise<void> {
    for (const chunk of this.store.chunksOf(url)) this.bm25.remove(chunk.id);
  }

  stats(): { documents: number; terms: number; avgDocLen: number } {
    return this.bm25.stats();
  }
}

export type { StoredChunk, StoredDoc };
