/**
 * Probes the dense channel with a real embedding model.
 *
 * The unit tests use a fake embedder and prove the *code* is right: the channel scans
 * the whole corpus rather than BM25's shortlist, and `channels` reflects genuine
 * cross-channel agreement. What a fake embedder cannot prove is whether real
 * embeddings are discriminative enough for any of that to matter.
 *
 * So this builds the situation the dense channel exists for — queries that share no
 * content word with the passage that answers them — and reports, per query, whether
 * BM25 alone retrieves the gold and whether the hybrid does.
 *
 *   OPENROUTER_API_KEY=... EMBEDDING_PROVIDER=openrouter npx tsx scripts/dense-probe.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { IndexManager, chunkDocument } from "../src/store/indexer.js";
import { Bm25Index } from "../src/retrieval/bm25.js";
import { createEmbedder, embedMissing } from "../src/retrieval/vectors.js";
import { retrieve } from "../src/pipeline/retrieve.js";
import { sha256 } from "../src/util/hash.js";
import type { QueryPlan } from "../src/decision/questions.js";
import type { SearchRequest } from "../src/domain/types.js";

interface Doc {
  id: string;
  title: string;
  text: string;
}

const DOCS: Doc[] = [
  {
    id: "backpressure",
    title: "Backpressuring in streams",
    text: [
      "Backpressuring in streams",
      "When a stream buffers more data than its consumer can handle, the producer has to be told to stop. That signal is backpressure.",
      "Every writable stream carries a highWaterMark. Once the internal buffer passes it, write() returns false and the producer waits for the drain event.",
      "A fast writer feeding a slow reader creates a queue that grows without bound, and skipping backpressure is how a service runs out of memory.",
    ].join("\n\n"),
  },
  {
    id: "typescript",
    title: "Running TypeScript on Node.js",
    text: [
      "Running TypeScript on Node.js",
      "Node can strip types itself, or you can compile ahead of time. The built-in stripper removes types without transforming the rest of the program.",
    ].join("\n\n"),
  },
  {
    id: "wal",
    title: "Write-ahead logging",
    text: [
      "Write-ahead logging",
      "WAL lets readers and a writer proceed concurrently, removing the reader-writer contention of rollback journal mode. A WAL database cannot live on a network filesystem.",
    ].join("\n\n"),
  },
  // Distractors: topically close, answer something else.
  {
    id: "buffer-pool",
    title: "Buffer pool sizing",
    text: [
      "Buffer pool sizing",
      "A buffer pool holds recently used pages in memory so the writer does not hit disk for every read. Sizing it wrong costs throughput, not correctness.",
    ].join("\n\n"),
  },
  {
    id: "drain-schedule",
    title: "Draining a house",
    text: [
      "Draining a house",
      "Drain a sink by removing the stopper, then run hot water until the flow slows, then scrub the trap.",
    ].join("\n\n"),
  },
  {
    id: "memory-leaks",
    title: "Diagnosing memory leaks",
    text: [
      "Diagnosing memory leaks",
      "Take a heap snapshot before and after the suspected leak, compare retained objects, and look for a closure that outlives what it captures.",
    ].join("\n\n"),
  },
];

/**
 * Every query is written to share as little vocabulary as possible with the passage
 * that answers it. A query that merely looks like a paraphrase can still be caught
 * by stemming, which would make the whole probe measure nothing.
 */
const CASES: { query: string; gold: string; note: string }[] = [
  {
    query: "why does my service get terminated",
    gold: "backpressure",
    note: "the gold never says 'terminated'; it says the process runs out of memory",
  },
  {
    query: "what do I do when the disk write keeps failing",
    gold: "wal",
    note: "the gold says 'cannot live on a network filesystem', not 'write failing'",
  },
  {
    query: "is a build step mandatory for annotations",
    gold: "typescript",
    note: "the gold says 'strip types itself, or compile ahead of time'",
  },
  {
    query: "a queue that keeps filling up",
    gold: "backpressure",
    note: "the gold says 'a fast writer feeding a slow reader'",
  },
];

const plan: QueryPlan = {
  intent: "factual_lookup",
  topic: "general",
  answerShape: "short_paragraph",
  synthesisNeed: 0.3,
  timeHorizon: 0,
  complexity: 1,
  ambiguity: 0.2,
  requiresExactPhrase: false,
  expandQuery: false,
  expansionStrategy: "none",
  multiRound: false,
};

function request(query: string): SearchRequest {
  return {
    query,
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
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  const embedder = createEmbedder();
  if (!embedder) {
    process.stderr.write(
      "no embedder configured — set OPENROUTER_API_KEY and EMBEDDING_PROVIDER=openrouter\n",
    );
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), "jevily-dense-"));
  const store = new Store(dir);
  try {
    for (const doc of DOCS) {
      const url = `https://dense.test/${doc.id}`;
      store.upsertDoc({
        url,
        domain: "dense.test",
        title: doc.title,
        lang: "en",
        markdown: doc.text,
        text: doc.text,
        publishedDate: null,
        fetchedAt: Date.now(),
        etag: null,
        lastModified: null,
        status: "ok",
        contentHash: sha256(doc.text),
      });
      store.replaceChunks(url, chunkDocument({ url, title: doc.title, markdown: doc.text }));
    }
    const index = new IndexManager(store);
    await index.rebuild();

    const embedded = await embedMissing(store, embedder, 500);
    // loadVectors reads from the store, so the backfill above is what feeds the channel.
    void embedded;
    process.stdout.write(`\nembedded ${index.vectorCount()} chunks with ${embedder.name}\n`);
    if (index.vectorCount() === 0) {
      process.stderr.write("no vectors written — the dense channel cannot run\n");
      process.exit(1);
    }

    // Baseline: the lexical channel on its own, same index.
    const lexical = new Bm25Index();
    for (const doc of DOCS) lexical.add(doc.id, `${doc.title}\n${doc.text}`);

    let lexicalHits = 0;
    let hybridHits = 0;

    process.stdout.write("\n");
    for (const testCase of CASES) {
      const lexicalUrls = lexical.search(testCase.query, 10).map((h) => h.id);
      const lexicalFound = lexicalUrls.includes(testCase.gold);
      if (lexicalFound) lexicalHits++;

      const { candidates, stats } = await retrieve(
        index,
        store,
        request(testCase.query),
        plan,
        [testCase.query],
        embedder,
      );
      // Candidates carry a chunk id, not the document id, so match on the url.
      const hybridUrls = candidates.map((c) => c.chunk.url.split("/").pop());
      const hybridFound = hybridUrls.includes(testCase.gold);
      if (hybridFound) hybridHits++;

      const mark = hybridFound && !lexicalFound ? "->" : hybridFound ? "  " : "!!";
      process.stdout.write(
        `  ${mark} ${pad(`"${testCase.query}"`, 40)} lex=${lexicalFound ? "hit " : "miss"}` +
          `  hybrid=${hybridFound ? "hit " : "miss"}  (${testCase.note})\n`,
      );
      if (hybridFound && !lexicalFound) {
        const recovered = candidates.find((c) => c.chunk.url.endsWith(testCase.gold))!;
        process.stdout.write(
          `     recovered: ${recovered.chunk.url}  channels=${recovered.channels}  ` +
            `lexical=${recovered.lexical !== null}  dense=${recovered.dense !== null}\n`,
        );
      }
      if (stats.dense === 0) process.stdout.write("     dense channel contributed nothing\n");
    }

    const n = CASES.length;
    process.stdout.write(
      `\n  gold retrieved — lexical only: ${lexicalHits}/${n}\n` +
        `  gold retrieved — hybrid:       ${hybridHits}/${n}\n\n`,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
