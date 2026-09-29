/**
 * Prints the gate signals for every candidate the retriever finds, so a
 * surprising zero-result search can be diagnosed without guessing.
 *
 *   npx tsx scripts/debug-gate.ts "my buffer grows until the process dies"
 */

import { Store } from "../src/store/db.js";
import { IndexManager } from "../src/store/indexer.js";
import { DecisionService, createDecisionService } from "../src/decision/service.js";
import { createEngine } from "../src/decision/index.js";
import { retrieve } from "../src/pipeline/retrieve.js";
import { gate, route } from "../src/pipeline/gate.js";
import { resolvePolicy } from "../src/pipeline/policy.js";
import { rerank } from "../src/pipeline/rerank.js";
import type { SearchRequest } from "../src/domain/types.js";

const query = process.argv[2] ?? "backpressure";
const store = new Store();
const index = new IndexManager(store);
await index.rebuild();

const decisions: DecisionService = createDecisionService(createEngine());
const policy = resolvePolicy(decisions.calibrated);

const request: SearchRequest = {
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

const plan = {
  intent: "factual_lookup" as const,
  topic: "general" as const,
  answerShape: "short_paragraph" as const,
  synthesisNeed: 0.5,
  timeHorizon: 1,
  complexity: 1,
  ambiguity: 0.3,
  requiresExactPhrase: false,
  expandQuery: false,
  expansionStrategy: "none" as const,
  multiRound: false,
};

const { candidates } = await retrieve(index, store, request, plan, [query], null);
process.stdout.write(`\nretrieved ${candidates.length} candidates\n\n`);

const reranked = await rerank(decisions, policy, {
  query,
  candidates,
  constraintRequired: false,
  exactPhraseHit: () => false,
});
const kept = reranked.filter((r) => r.keep);
process.stdout.write(`rerank kept ${kept.length}/${reranked.length}  (keepAbove=${policy.rerank.keepAbove})\n\n`);

const gated = await gate(decisions, policy, { query, candidates: kept, limit: 20 });

process.stdout.write("gate thresholds: ");
for (const [k, v] of Object.entries(policy.gate)) process.stdout.write(`${k}=${v} `);
process.stdout.write("\n\n");

for (const item of gated) {
  const s = item.gateSignals;
  const expected = route(s, policy);
  const flag = expected === item.route ? "" : `  <-- MISMATCH (route() would say ${expected})`;
  process.stdout.write(
    `${item.route.padEnd(12)} ${item.chunk.url}\n` +
      `             ${Object.entries(s)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(" ")}\n` +
      `             composite=${item.composite.toFixed(3)} len=${item.chunk.text.length}${flag}\n\n`,
  );
}
store.close();
