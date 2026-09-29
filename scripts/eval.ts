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

/**
 * One pass over the set. Kept separate from reporting so the whole thing can be
 * repeated: a single pass over eleven queries is not a measurement, because the
 * decision model is not deterministic between runs and the ranking inherits that.
 */
async function onePass(reuseCache: boolean): Promise<Pass> {
  const engine = createEngine();
  // Repeats have to be independent samples. The decision cache is process-wide, so
  // a cached repeat would re-read the same answers and report zero variance — which
  // is how "100% over 5 passes" can be a single pass wearing a hat.
  const service: DecisionService = reuseCache ? createDecisionService(engine) : new DecisionService(engine, null);
  const policy = resolvePolicy(service.calibrated);

  const index = new Bm25Index();
  for (const doc of CORPUS) index.add(doc.id, `${doc.title}\n${doc.text}`);

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

  const pooledRows = rows.filter((r) => r.pooled);
  return {
    rows,
    pooledCount: pooledRows.length,
    rerankableCount: pooledRows.filter((r) => r.bm25 !== 1).length,
    overall: hitRates(rows),
    rerankable: hitRates(pooledRows.filter((r) => r.bm25 !== 1)),
    movedUp: rows.filter((r) => r.bm25 !== null && r.after !== null && r.after < r.bm25).length,
    movedDown: rows.filter((r) => r.bm25 !== null && r.after !== null && r.after > r.bm25).length,
    dropped: pooledRows.filter((r) => r.after === null).length,
    engine: `${engine.name} (${engine.calibrated ? "calibrated" : "uncalibrated"})`,
    usage: service.usage,
  };
}

function hitRates(rows: Row[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const t of THRESHOLDS) out[t] = rows.filter((r) => r.after !== null && r.after <= t).length;
  return out;
}

async function main(): Promise<void> {
  const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 1));
  const passes: Pass[] = [];
  for (let i = 0; i < repeat; i++) {
    const pass = await onePass(false);
    passes.push(pass);
    if (repeat > 1) {
      process.stdout.write(
        `  pass ${i + 1}/${repeat}: ${pass.rerankable[1] ?? 0}/${pass.rerankableCount} at rank 1, ` +
          `${pass.movedUp} up / ${pass.movedDown} down\n`,
      );
    }
  }
  report(passes);
}

interface Row {
  case: Case;
  bm25: number | null;
  after: number | null;
  pooled: boolean;
  /** Whichever document ended up ahead of the gold, when the reranker lost rank. */
  winner: string | null;
}

interface Pass {
  rows: Row[];
  pooledCount: number;
  rerankableCount: number;
  overall: Record<number, number>;
  rerankable: Record<number, number>;
  movedUp: number;
  movedDown: number;
  dropped: number;
  engine: string;
  usage: DecisionService["usage"];
}

function report(passes: Pass[]): void {
  const first = passes[0]!;
  const rows = first.rows;
  const pooled = rows.filter((r) => r.pooled);
  const rerankableRows = pooled.filter((r) => r.bm25 !== 1);
  const pct = (v: number, n: number) => (n === 0 ? "n/a" : `${((v / n) * 100).toFixed(0)}%`);

  process.stdout.write(`\nengine: ${first.engine}\n`);
  if (first.engine.endsWith("(uncalibrated)")) {
    process.stdout.write(
      "  note: the mock engine is a lexical stand-in, not a judgement model. It is\n" +
        "  expected to score below BM25. These numbers check the plumbing; they say\n" +
        "  nothing about reranking quality.\n",
    );
  }

  for (const row of rows) {
    const mark =
      row.bm25 === row.after
        ? "  "
        : row.after !== null && row.bm25 !== null && row.after < row.bm25
          ? "->"
          : "!!";
    const status = !row.pooled ? "not in pool" : row.after === null ? "reranked out" : "";
    process.stdout.write(
      `  ${mark} ${pad(row.case.query, 52)} bm25=${pad(String(row.bm25 ?? "-"), 4)}` +
        `decisions=${pad(String(row.after ?? "-"), 4)} ${status}\n`,
    );
    if (row.bm25 !== null && row.after !== null && row.after > row.bm25 && row.winner) {
      process.stdout.write(`       lost rank to ${row.winner} — measured, not assumed\n`);
    }
  }

  // Aggregate across passes. Reporting one pass over eleven queries is how you end
  // up "measuring" a 100% that is really a 4-out-of-5 coin flip: the decision model
  // is not deterministic between runs and the ranking inherits that.
  const minMax = (pick: (p: Pass) => number) => {
    const values = passes.map(pick);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const bm25At1 = rows.filter((r) => r.bm25 === 1).length;
  const overallAt1 = minMax((p) => p.overall[1] ?? 0);
  const rerankAt1 = minMax((p) => p.rerankable[1] ?? 0);

  process.stdout.write("\n  recall@1, all queries\n");
  process.stdout.write(`    bm25      ${pct(bm25At1, rows.length)}  (deterministic)\n`);
  process.stdout.write(
    `    decisions  ${passes.length > 1 ? `${pct(overallAt1.min, rows.length)}-${pct(overallAt1.max, rows.length)} over ${passes.length} passes` : pct(overallAt1.min, rows.length)}\n`,
  );

  process.stdout.write(
    `\n  recall@1 over the ${rerankableRows.length} queries the reranker can act on\n` +
      "  (gold retrieved, but not already ranked first by bm25)\n",
  );
  process.stdout.write(`    bm25      0%  (deterministic)\n`);
  process.stdout.write(
    `    decisions  ${passes.length > 1 ? `${pct(rerankAt1.min, rerankableRows.length)}-${pct(rerankAt1.max, rerankableRows.length)}` : pct(rerankAt1.min, rerankableRows.length)}\n`,
  );

  if (passes.length === 1) {
    process.stdout.write(
      "\n  warning: one pass over this set is not a measurement. The decision model is\n" +
        "  not deterministic between runs — re-run with EVAL_REPEAT=5 before\n" +
        "  believing a difference.\n",
    );
  }

  const up = minMax((p) => p.movedUp);
  process.stdout.write(
    `\n  moved up: ${first.movedUp}-${up.max}   moved down: ${first.movedDown}   dropped out: ${first.dropped}\n`,
  );
  process.stdout.write(
    `  ceiling: gold in pool for ${pooled.length}/${rows.length} queries — the rest is retrieval, not ranking\n`,
  );
  const requests = passes.reduce((a, x) => a + x.usage.requests, 0);
  const tokens = passes.reduce((a, x) => a + x.usage.inputTokens, 0);
  const cost = passes.reduce((a, x) => a + (x.usage.costUsd ?? 0), 0);
  process.stdout.write(
    `  usage: ${requests} requests, ${tokens.toLocaleString()} input tokens` +
      `${cost > 0 ? `, $${cost.toFixed(5)}` : ""}\n\n`,
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
