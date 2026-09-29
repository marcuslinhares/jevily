/**
 * The dense channel's reason for existing.
 *
 * BM25 matches shared words. Dense retrieval matches meaning. A hybrid is only
 * worth running if the second channel can surface something the first one cannot,
 * so that is exactly what these tests assert — with a deterministic fake embedder,
 * so they need no key and no network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IndexManager, chunkDocument } from "../src/store/indexer.js";
import { Store } from "../src/store/db.js";
import { retrieve } from "../src/pipeline/retrieve.js";
import { sha256 } from "../src/util/hash.js";
import type { Embedder } from "../src/retrieval/vectors.js";
import type { QueryPlan } from "../src/decision/questions.js";
import type { SearchRequest } from "../src/domain/types.js";

process.env.EMBEDDING_PROVIDER = "none";
process.env.DECISION_ENGINE = "mock";
process.env.LOG_LEVEL = "silent";

/**
 * A vocabulary-free embedder: every member of a concept occupies the *same*
 * dimension, so any synonym pair points the same way and their cosine is 1.
 * "queue" and "nobody is reading" therefore mean the same thing here, which is
 * the whole point — and the corpus shares no literal token with the query.
 */
const CONCEPTS = [
  ["memory", "heap", "oom", "ram"],
  ["queue", "buffer", "backlog", "growth", "nobody", "reading"],
  ["death", "dies", "crash", "terminated", "killed"],
  ["flour", "starter", "sourdough", "bread"],
];

const DIM = CONCEPTS.length;

class FakeEmbedder implements Embedder {
  readonly name = "fake";
  readonly dims = DIM;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(DIM);
    for (const word of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
      // A word may belong to more than one concept; light up all of them, so
      // co-occurrence reads as partial agreement.
      for (let c = 0; c < CONCEPTS.length; c++) {
        if ((CONCEPTS[c] as string[]).includes(word)) v[c] = 1;
      }
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
    return v;
  }
}

const DOCS = [
  {
    url: "https://a.test/queue",
    title: "Queue growth under load",
    // States the answer in entirely different words from any query used below.
    markdown: [
      "# Queue growth under load",
      "When the producer outruns the consumer the heap grows without bound and the process is eventually killed.",
      "Bounded buffers are the fix, and the depth of the queue is the signal to watch.",
    ].join("\n\n"),
  },
  {
    url: "https://b.test/unrelated",
    title: "Sourdough",
    markdown: [
      "# Sourdough",
      "Feed a starter with equal weights of flour and water every twelve hours at room temperature.",
    ].join("\n\n"),
  },
];

/**
 * Shares no content word with the passage that answers it: neither "service" nor
 * "terminated" appears anywhere in the corpus. A query that merely looks like a
 * paraphrase can still be caught by stem overlap, which would make the test prove
 * nothing about the dense channel.
 */
const QUERY = "why does my service get terminated";
const GOLD = "https://a.test/queue";

const plan: QueryPlan = {
  intent: "factual_lookup",
  topic: "general",
  answerShape: "short_paragraph",
  synthesisNeed: 0.3,
  timeHorizon: 1,
  complexity: 1,
  ambiguity: 0.2,
  requiresExactPhrase: false,
  expandQuery: false,
  expansionStrategy: "none",
  multiRound: false,
};

const request: SearchRequest = {
  query: QUERY,
  search_depth: "advanced",
  max_results: 10,
  topic: "general",
  time_range: null,
  include_answer: false,
  include_raw_content: false,
  include_published_date: false,
  filter_by_published_date: false,
  filter_by_language: false,
  exact_match: false,
  auto_parameters: false,
  safe_search: false,
};

let dir: string;
let store: Store;
let index: IndexManager;

function seed(target: Store, docs: typeof DOCS): void {
  for (const doc of docs) {
    target.upsertDoc({
      url: doc.url,
      domain: new URL(doc.url).hostname,
      title: doc.title,
      lang: "en",
      markdown: doc.markdown,
      text: doc.markdown,
      publishedDate: null,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      status: "ok",
      contentHash: sha256(doc.markdown),
    });
    target.replaceChunks(doc.url, chunkDocument(doc));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "jevily-dense-"));
  store = new Store(dir);
  seed(store, DOCS);
  index = new IndexManager(store);
  await index.rebuild();

  const embedder = new FakeEmbedder();
  for (const doc of DOCS) {
    for (const chunk of store.chunksOf(doc.url)) {
      const [vector] = await embedder.embed([chunk.text]);
      if (!vector) continue;
      index.putVector(chunk.id, vector);
      store.setVector(chunk.id, vector);
    }
  }
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dense channel", () => {
  it("holds the vectors, so the channel knows it can run", () => {
    expect(index.hasVectors()).toBe(true);
    expect(index.vectorCount()).toBeGreaterThan(0);
  });

  it("recalls a passage that shares no term with the query", async () => {
    // The premise of the whole channel. If this passes only because BM25 also
    // found the passage, the test proves nothing, so assert the negative first.
    const lexicalUrls = index.bm25.search(QUERY, 10).map((hit) => store.getChunk(hit.id)?.url);
    expect(lexicalUrls, "the lexical channel should miss this").not.toContain(GOLD);

    const [vector] = await new FakeEmbedder().embed([QUERY]);
    const dense = index.denseSearch(vector as Float32Array, 10);
    const denseUrls = dense.map((hit) => store.getChunk(hit.id)?.url);
    expect(denseUrls).toContain(GOLD);
    expect(dense[0]!.score).toBeGreaterThan(0);
  });

  it("ranks the on-topic passage above the unrelated one", async () => {
    const [vector] = await new FakeEmbedder().embed([QUERY]);
    const dense = index.denseSearch(vector as Float32Array, 10);
    expect(store.getChunk(dense[0]!.id)?.url).toBe(GOLD);
  });

  it("brings the paraphrased passage into the fused candidate pool", async () => {
    const { candidates, stats } = await retrieve(index, store, request, plan, [QUERY], new FakeEmbedder());
    expect(stats.dense).toBeGreaterThan(0);
    expect(candidates.map((c) => c.chunk.url)).toContain(GOLD);
  });

  it("records genuine cross-channel agreement instead of a hardcoded 1", async () => {
    const { candidates } = await retrieve(index, store, request, plan, [QUERY], new FakeEmbedder());
    expect(candidates.length).toBeGreaterThan(0);

    for (const candidate of candidates) {
      const seenLexically = candidate.lexical !== null;
      const seenDensely = candidate.dense !== null;
      expect(candidate.channels).toBe(seenLexically && seenDensely ? 2 : 1);
    }
  });

  it("agrees on nothing when the two channels see different things", async () => {
    // A purely lexical query. Dense has no concept for it here, so nothing should
    // be marked as cross-channel agreement — a hardcoded 1 would hide that.
    const { candidates } = await retrieve(
      index,
      store,
      { ...request, query: "sourdough starter feeding" },
      plan,
      ["sourdough starter feeding"],
      new FakeEmbedder(),
    );
    for (const candidate of candidates) {
      expect(candidate.channels).toBe(candidate.lexical !== null && candidate.dense !== null ? 2 : 1);
    }
  });

  it("skips the channel entirely when nothing is embedded, without calling the embedder", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "jevily-bare-"));
    const bareStore = new Store(bareDir);
    try {
      const bareIndex = new IndexManager(bareStore);
      await bareIndex.rebuild();
      expect(bareIndex.hasVectors()).toBe(false);

      let called = false;
      const exploding: Embedder = {
        name: "explosive",
        dims: 1,
        embed: async () => {
          called = true;
          throw new Error("must not be called when the corpus has no vectors");
        },
      };
      const { candidates, stats } = await retrieve(bareStore ? bareIndex : bareIndex, bareStore, request, plan, [QUERY], exploding);
      expect(candidates).toEqual([]);
      expect(stats.dense).toBe(0);
      expect(called).toBe(false);
    } finally {
      bareStore.close();
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("survives an embedder that fails mid-search", async () => {
    const flaky: Embedder = {
      name: "flaky",
      dims: DIM,
      embed: async () => {
        throw new Error("rate limited");
      },
    };
    // The lexical channel must still deliver, since dense is only an enhancement.
    const { candidates } = await retrieve(index, store, request, plan, [QUERY], flaky);
    expect(Array.isArray(candidates)).toBe(true);
  });
});
