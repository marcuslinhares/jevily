/**
 * Reranking evaluation.
 *
 * The question this answers is narrow and specific: *given the candidate pool, does
 * asking the decision engine reorder it better than BM25 already did?*
 *
 * Two things make an eval set useless for that question, and this one is built to
 * avoid both:
 *
 *   1. Queries that copy the document's own vocabulary. BM25 scores 100% and the
 *      reranker is never asked to do anything.
 *   2. A corpus without distractors. If only one document could possibly answer,
 *      rank 1 is free.
 *
 * So every case here pairs a gold passage with a distractor that shares most of the
 * query's terms and answers a different question. That is the lexical trap a real
 * index is full of, and it is the only situation where reranking earns its cost.
 *
 * Recall is reported twice: overall, and restricted to the cases where the gold was
 * in the pool but not first. The second number is the one the reranker controls.
 */

import { DecisionService, createDecisionService } from "../src/decision/service.js";
import { createEngine } from "../src/decision/index.js";
import { Bm25Index } from "../src/retrieval/bm25.js";
import { rerank } from "../src/pipeline/rerank.js";
import { resolvePolicy } from "../src/pipeline/policy.js";
import type { Candidate } from "../src/pipeline/retrieve.js";
import type { Store } from "../src/store/db.js";

interface Doc {
  id: string;
  title: string;
  text: string;
}

interface Case {
  query: string;
  gold: string;
  /**
   * How time-sensitive the question is, on the query plan's 0..3 scale. Matters:
   * the recency weight is scaled by it, so an evergreen question must not let a
   * changelog outrank the page explaining the problem.
   */
  horizon: 0 | 1 | 2 | 3;
}

const CORPUS: Doc[] = [
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
      "Node can strip types itself, or you can compile ahead of time. Type stripping is convenient; compiling is faster on cold start.",
      "The built-in stripper removes types without transforming the rest of the program. It will not erase enums or namespaces, because those change runtime behaviour.",
    ].join("\n\n"),
  },
  {
    id: "wal",
    title: "Write-ahead logging",
    text: [
      "Write-ahead logging",
      "WAL lets readers and a writer proceed concurrently, which removes the reader-writer contention of rollback journal mode.",
      "A WAL database cannot be written over a network filesystem, and checkpointing adds a background cost.",
    ].join("\n\n"),
  },
  {
    id: "release",
    title: "Node 22 stream changes",
    text: [
      "Node 22 stream changes",
      "The release changes how backpressure propagates through a pipeline, so code that assumed a single drain event per writable needs updating.",
      "Audit pipelines that count drain events. Anything relying on one event per write should await the write instead.",
    ].join("\n\n"),
  },
  // --- distractors ---------------------------------------------------------
  // Each one shares vocabulary with a query above while answering something else.
  // They are what a real corpus is mostly made of.
  {
    id: "buffer-pool",
    title: "Buffer pool sizing",
    text: [
      "Buffer pool sizing",
      "A buffer pool holds recently used pages in memory so the writer does not hit disk for every read. Sizing it wrong costs throughput, not correctness.",
      "The pool grows on demand up to its configured maximum, and pages are evicted once the pool is full.",
    ].join("\n\n"),
  },
  {
    id: "drain-schedule",
    title: "Household draining",
    text: [
      "Draining a house",
      "Drain a sink by removing the stopper, then run hot water until the flow slows, then scrub the trap.",
      "If the drain runs slowly the problem is usually a trap or a blocked branch rather than the waste pipe.",
    ].join("\n\n"),
  },
  {
    id: "typecheck-ci",
    title: "Running a type check in CI",
    text: [
      "Running a type check in CI",
      "Run a type check on every build so a type error never reaches a release. Compiling with noEmit is the fastest way to type check in a pipeline.",
      "A bundler is not required: the type check only reads your source, it does not transform it.",
    ].join("\n\n"),
  },
  {
    id: "journal-mode",
    title: "Choosing a journal mode",
    text: [
      "Choosing a journal mode",
      "Rollback journal mode blocks readers while a write is in progress, so two readers and one writer contend for the same database file.",
      "A network filesystem cannot support either mode safely, and switching modes requires an exclusive lock.",
    ].join("\n\n"),
  },
  {
    id: "pipe-tracing",
    title: "Tracing a shell pipeline",
    text: [
      "Tracing a shell pipeline",
      "Count the processes in a pipeline with jobs, and use time to see which stage is slow when a stream of data is being processed.",
      "Shell pipelines are not Node streams: the stages are separate processes, and backpressure between them is handled by the kernel.",
    ].join("\n\n"),
  },
  {
    id: "node-release-policy",
    title: "Node release policy",
    text: [
      "Node release policy",
      "Odd-numbered releases become unsupported after six months, even-numbered lines stay in maintenance for thirty months. Plan upgrades accordingly.",
      "A release that is no longer maintained stops receiving security fixes, which is the real reason to upgrade rather than the newest feature.",
    ].join("\n\n"),
  },
];

const CASES: Case[] = [
  {
    query: "how do I stop the producer when the reader cannot keep up",
    gold: "backpressure",
    horizon: 0,
  },
  {
    query: "what signal tells a writer to stop producing",
    gold: "backpressure",
    horizon: 0,
  },
  {
    query: "the drain never fires so my queue keeps growing",
    gold: "backpressure",
    horizon: 0,
  },
  {
    query: "why does memory climb until the process is killed",
    gold: "backpressure",
    horizon: 0,
  },
  {
    query: "do I need a bundler to use type annotations in node",
    gold: "typescript",
    horizon: 0,
  },
  {
    query: "why will the type remover refuse my enum",
    gold: "typescript",
    horizon: 1,
  },
  {
    query: "can two readers use the same database file while it is written",
    gold: "wal",
    horizon: 0,
  },
  {
    query: "which sqlite mode breaks on nfs",
    gold: "wal",
    horizon: 0,
  },
  {
    query: "what do I change after upgrading to the newest major",
    gold: "release",
    horizon: 3,
  },
  {
    query: "my code counts drain events and behaves differently now",
    gold: "release",
    horizon: 3,
  },
  {
    query: "shell pipeline stages are not node streams",
    gold: "pipe-tracing",
    horizon: 0,
  },
];

const HORIZON: Record<0 | 1 | 2 | 3, number> = { 0: 0, 1: 1, 2: 2, 3: 3 };

const THRESHOLDS = [1, 3, 5];
const TOP_K = 5;

function rankOf(ranked: string[], gold: string): number | null {
  const i = ranked.indexOf(gold);
  return i === -1 ? null : i + 1;
}

function toCandidate(id: string): Candidate {
  const doc = CORPUS.find((d) => d.id === id);
  if (!doc) throw new Error(`unknown corpus doc: ${id}`);
  return {
    chunk: {
      id,
      url: `https://eval.test/${id}`,
      ord: 0,
      headingPath: [doc.title],
      text: doc.text,
      tokens: Math.ceil(doc.text.length / 4),
      simhash: "0",
      contentHash: id,
      vector: null,
    },
    doc: {
      url: `https://eval.test/${id}`,
      domain: "eval.test",
      title: doc.title,
      lang: "en",
      markdown: doc.text,
      text: doc.text,
      publishedDate: null,
      fetchedAt: 0,
      etag: null,
      lastModified: null,
      status: "ok",
      contentHash: id,
      stale: 0,
    },
    lexical: 1,
    dense: null,
    fused: 1,
    channels: 1,
    exactPhraseHit: false,
  };
}

async function main(): Promise<void> {
  const engine = createEngine();
  const service: DecisionService = createDecisionService(engine);
  const policy = resolvePolicy(service.calibrated);

  const index = new Bm25Index();
  for (const doc of CORPUS) index.add(doc.id, `${doc.title}\n${doc.text}`);

  type Row = {
    case: Case;
    bm25: number | null;
    after: number | null;
    pooled: boolean;
    /** Whichever document ended up ahead of the gold, when the reranker lost rank. */
    winner: string | null;
  };
  const rows: Row[] = [];

  for (const testCase of CASES) {
    const hits = index.search(testCase.query, TOP_K);
    const pooled = hits.some((h) => h.id === testCase.gold);
    const bm25 = rankOf(hits.map((h) => h.id), testCase.gold);

    // Only rerank the shortlist, exactly as the pipeline does. A re-ranker cannot
    // rescue a passage that never made it into the pool, and pretending otherwise
    // would hide the real ceiling.
    const reranked = pooled
      ? await rerank(service, policy, {
          query: testCase.query,
          candidates: hits.map((h) => toCandidate(h.id)),
          constraintRequired: false,
          exactPhraseHit: () => false,
          timeHorizon: HORIZON[testCase.horizon],
        })
      : [];
    const kept = reranked.filter((r) => r.keep).map((r) => r.chunk.id);
    const after = rankOf(kept, testCase.gold);
    // Measured, so a regression names the document that actually caused it rather
    // than the one the author assumed would.
    const winner =
      after !== null && bm25 !== null && after > bm25 ? (kept[after - 2] ?? null) : null;

    rows.push({ case: testCase, bm25, after, pooled, winner });
  }

  // --- report ---------------------------------------------------------------
  const pooled = rows.filter((r) => r.pooled);
  // The subset the reranker can actually act on: gold retrieved, but not already first.
  const rerankable = pooled.filter((r) => r.bm25 !== 1);
  const pct = (v: number, n: number) => (n === 0 ? "  n/a" : `${((v / n) * 100).toFixed(0)}%`);

  process.stdout.write(`\nengine: ${engine.name} (calibrated: ${engine.calibrated})\n`);
  if (!service.calibrated) {
    process.stdout.write(
      "\n  note: the mock engine is a lexical stand-in, not a judgement model.\n" +
        "  It is expected to score below BM25. These numbers check the plumbing;\n" +
        "  they say nothing about reranking quality.\n",
    );
  }

  for (const row of rows) {
    const mark = row.bm25 === row.after ? "  " : row.after !== null && row.bm25 !== null && row.after < row.bm25 ? "->" : "!!";
    const status = !row.pooled ? "not in pool" : row.after === null ? "reranked out" : "";
    process.stdout.write(
      `  ${mark} ${pad(row.case.query, 52)} bm25=${pad(String(row.bm25 ?? "-"), 4)}` +
        `decisions=${pad(String(row.after ?? "-"), 4)} ${status}\n`,
    );
    if (row.bm25 !== null && row.after !== null && row.after > row.bm25 && row.winner) {
      process.stdout.write(`       lost rank to ${row.winner} — measured, not assumed\n`);
    }
  }

  process.stdout.write("\n  overall recall@N (all queries)\n");
  process.stdout.write(`    ${pad("N", 5)}${pad("bm25", 12)}decisions\n`);
  for (const t of THRESHOLDS) {
    const before = rows.filter((r) => r.bm25 !== null && r.bm25 <= t).length;
    const after = rows.filter((r) => r.after !== null && r.after <= t).length;
    process.stdout.write(`    ${pad(`@${t}`, 5)}${pad(pct(before, rows.length), 12)}${pct(after, rows.length)}\n`);
  }

  process.stdout.write(
    `\n  recall@N over the ${rerankable.length} queries the reranker can act on\n` +
      `  (gold retrieved but not already ranked first by bm25)\n`,
  );
  process.stdout.write(`    ${pad("N", 5)}${pad("bm25", 12)}decisions\n`);
  for (const t of THRESHOLDS) {
    const before = rerankable.filter((r) => r.bm25 !== null && r.bm25 <= t).length;
    const after = rerankable.filter((r) => r.after !== null && r.after <= t).length;
    process.stdout.write(`    ${pad(`@${t}`, 5)}${pad(pct(before, rerankable.length), 12)}${pct(after, rerankable.length)}\n`);
  }

  const lost = rows.filter((r) => r.bm25 !== null && r.after !== null && r.after > r.bm25).length;
  const won = rows.filter((r) => r.bm25 !== null && r.after !== null && r.after < r.bm25).length;
  process.stdout.write(
    `\n  moved up: ${won}   moved down: ${lost}   dropped out: ${pooled.filter((r) => r.after === null).length}\n`,
  );
  process.stdout.write(
    `  ceiling: gold in pool for ${pooled.length}/${rows.length} queries — the rest is retrieval, not ranking\n`,
  );
  process.stdout.write(
    `  usage: ${service.usage.requests} requests, ${service.usage.inputTokens.toLocaleString()} input tokens` +
      `${service.usage.costUsd !== null ? `, $${service.usage.costUsd.toFixed(5)}` : ""}\n\n`,
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
