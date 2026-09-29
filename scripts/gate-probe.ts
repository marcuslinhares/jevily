/**
 * Measures the gate and the abstention on the real corpus.
 *
 * Retrieval and reranking have both been read against crawled documentation. The two
 * headline claims have not: that the gate keeps the right passages and drops the
 * rest, and that the system withholds an answer rather than guessing when the
 * evidence is thin. Both run on thresholds in policy.ts that were written by
 * reasoning, and reasoning does not survive a corpus nobody designed.
 *
 * This runs the whole pipeline — understand, retrieve, rerank, gate, answer, verify —
 * and reports what came out, not what was supposed to come out.
 *
 *   npx tsx scripts/gate-probe.ts
 *
 * Needs a key for the decision engine, and one for the writer, and the corpus from
 * `probe:corpus crawl`.
 */

import { Store } from "../src/store/db.js";
import { IndexManager } from "../src/store/indexer.js";
import { DecisionService, createDecisionService } from "../src/decision/service.js";
import { createEngine } from "../src/decision/index.js";
import { createGenerator } from "../src/llm/generator.js";
import { runSearch } from "../src/pipeline/search.js";
import { resolvePolicy } from "../src/pipeline/policy.js";
import { CORPUS_GOLD } from "./helpers/corpus-gold.js";
import type { SearchRequest } from "../src/domain/types.js";

const DB_DIR = process.env.EVAL_CORPUS ?? "/tmp/opencode/jevily-corpus";
const MAX_RESULTS = Number(process.env.PROBE_MAX_RESULTS ?? 20);

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function request(query: string): SearchRequest {
  return {
    query,
    search_depth: "advanced",
    max_results: MAX_RESULTS,
    topic: "general",
    time_range: null,
    include_answer: "basic",
    include_raw_content: false,
    include_published_date: false,
    filter_by_published_date: false,
    filter_by_language: false,
    exact_match: false,
    auto_parameters: false,
    safe_search: false,
  };
}

/**
 * Questions the corpus genuinely cannot answer, in the register a real user would
 * use. Abstention that never fires on these is not abstention, and a system that
 * answers them is confidently wrong — which is the failure this project exists to
 * avoid, so it is worth measuring rather than assuming.
 */
const UNANSWERABLE: string[] = [
  "what is the optimal team size for a scrum team",
  "how much does a senior nodejs engineer cost per hour in london",
  "what is the best postgres hosting provider for a startup",
  "how long should I sleep to wake up at 5am",
  "which javascript framework will still exist in ten years",
  "what is the capital of australia",
];

async function main(): Promise<void> {
  const store = new Store(DB_DIR);
  const index = new IndexManager(store);
  await index.rebuild();

  const engine = createEngine();
  const decisions: DecisionService = createDecisionService(engine);
  const generator = createGenerator();
  const policy = resolvePolicy(decisions.calibrated);
  const domains = new Set(store.allDocs().map((d) => d.domain));

  process.stdout.write(
    `\ncorpus: ${store.allDocs().length} documents, ${domains.size} distinct domain [${[...domains].join(", ")}]\n` +
      `engine: ${engine.name} (${decisions.calibrated ? "calibrated" : "uncalibrated"})\n` +
      `policy: maxPerDomain=${policy.maxPerDomain} minDistinctDomains=${policy.minDistinctDomains} ` +
      `minAccepted=${policy.abstain.minAccepted} minSufficiency=${policy.sufficiency.minSufficiency}\n` +
      `writer: ${generator ? generator.model : "(none — no prose will be written)"}\n` +
      `max_results requested: ${MAX_RESULTS}\n`,
  );

  // --- answerable questions: does the gold survive the whole pipeline? -------
  process.stdout.write("\n  answerable questions (the gold page is in the corpus)\n");
  let goldReturned = 0;
  let answered = 0;
  const resultCounts: number[] = [];
  const reasons = new Map<string, number>();
  const missingGold: string[] = [];
  const abstainedOnAnswerable: { query: string; reason: string }[] = [];
  let retrieved = 0;
  let rerankKept = 0;
  let gateIncluded = 0;

  for (const testCase of CORPUS_GOLD) {
    const { response, trace } = await runSearch(
      { store, index, embedder: null, decisions, generator },
      request(testCase.query),
    );
    const stats = trace.stages.retrieval as Record<string, number>;
    retrieved += stats.fused ?? 0;
    rerankKept += trace.stages.rerank.kept;
    gateIncluded += trace.stages.gate.include + trace.stages.gate.conflicting;

    const returned = response.results.length;
    resultCounts.push(returned);

    // Only the returned results are something a caller ever sees. Everything
    // upstream is instrumentation, and reporting it as if it were recall is how a
    // pipeline looks like it works when the user gets nothing.
    if (response.results.some((r) => r.url.includes(testCase.goldFragment))) goldReturned++;
    else missingGold.push(testCase.query);

    if (response.abstained) {
      const reason = String((trace.stages.answer as Record<string, unknown>).reason ?? "unknown");
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      abstainedOnAnswerable.push({ query: testCase.query, reason });
    } else {
      answered++;
    }
  }

  const n = CORPUS_GOLD.length;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  process.stdout.write(
    `    candidates after fusion:  ${(retrieved / n).toFixed(1)} per query\n` +
      `    kept by rerank:         ${(rerankKept / n).toFixed(1)} per query\n` +
      `    surviving the gate:     ${(gateIncluded / n).toFixed(1)} per query\n` +
      `    results returned:       min ${Math.min(...resultCounts)}  mean ${avg(resultCounts).toFixed(1)}  ` +
      `max ${Math.max(...resultCounts)}   (asked for ${MAX_RESULTS})\n` +
      `    gold in the response:   ${goldReturned}/${n}\n` +
      `    answered: ${answered}/${n}   withheld: ${abstainedOnAnswerable.length}/${n}\n`,
  );

  if (missingGold.length > 0) {
    process.stdout.write(`    gold missing from the response: ${missingGold.length}\n`);
    for (const q of missingGold.slice(0, 4)) process.stdout.write(`      - ${q}\n`);
  }
  if (reasons.size > 0) {
    process.stdout.write("    withheld, with reason:\n");
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`      ${pad(reason, 34)} ${count}\n`);
      for (const a of abstainedOnAnswerable.filter((x) => x.reason === reason).slice(0, 2)) {
        process.stdout.write(`        ${a.query}\n`);
      }
    }
  }

  // --- unanswerable questions: does it hold its tongue? ----------------------
  process.stdout.write("\n  unanswerable questions (nothing in the corpus answers these)\n");
  let held = 0;
  const answeredAnyway: string[] = [];
  const heldReasons = new Map<string, number>();

  for (const query of UNANSWERABLE) {
    const { response, trace } = await runSearch(
      { store, index, embedder: null, decisions, generator },
      request(query),
    );
    const reason = String((trace.stages.answer as Record<string, unknown>).reason ?? "unknown");
    if (response.abstained) {
      held++;
      heldReasons.set(reason, (heldReasons.get(reason) ?? 0) + 1);
    } else {
      answeredAnyway.push(
        `      "${query}"\n` +
          `        -> ${(response.answer ?? "(no answer text)").replace(/\s+/g, " ").slice(0, 170)}`,
      );
    }
  }

  process.stdout.write(`    withheld: ${held}/${UNANSWERABLE.length}\n`);
  for (const [reason, count] of [...heldReasons].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`      ${pad(reason, 34)} ${count}\n`);
  }
  if (answeredAnyway.length > 0) {
    process.stdout.write(`    answered anyway: ${answeredAnyway.length}\n`);
    for (const a of answeredAnyway) process.stdout.write(`${a}\n`);
  }

  const usage = decisions.usage;
  process.stdout.write(
    `\n  decisions: ${usage.requests} requests, $${usage.costUsd?.toFixed(5) ?? "?"}\n\n`,
  );

  store.close();
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
