/**
 * Measures whether the right *answer* came back, rather than whether the labelled
 * *page* did.
 *
 * The page-fragment metric counted `understanding-setimmediate` as a miss for "what
 * runs first, a resolved promise or a timer callback", when that page answers the
 * question completely. It also would have counted a page that merely mentions the
 * topic as a hit. Both errors come from using a URL as a stand-in for a fact.
 *
 * So this runs the pipeline as usual, then asks the decision engine — the same
 * `supported` question the citation verifier uses — whether any returned passage
 * states the fact the answer has to convey. The page-fragment result is printed
 * beside it, because the gap between the two is the part worth reading.
 *
 *   OPENROUTER_API_KEY=... npx tsx scripts/fact-probe.ts
 */

import { Store } from "../src/store/db.js";
import { IndexManager } from "../src/store/indexer.js";
import { createDecisionService } from "../src/decision/service.js";
import { createEngine } from "../src/decision/index.js";
import { createGenerator } from "../src/llm/generator.js";
import { runSearch } from "../src/pipeline/search.js";
import { citationQuestions } from "../src/decision/questions.js";
import { CORPUS_FACTS } from "./helpers/corpus-facts.js";
import { requireCorpus } from "./helpers/corpus-check.js";
import type { SearchRequest } from "../src/domain/types.js";

const DB_DIR = process.env.EVAL_CORPUS ?? "/tmp/opencode/jevily-corpus";
/** A passage has to clear this to count as stating the fact. */
const STATES_FACT = 0.6;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function request(query: string): SearchRequest {
  return {
    query,
    search_depth: "advanced",
    max_results: 20,
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

async function main(): Promise<void> {
  const store = new Store(DB_DIR);
  const index = new IndexManager(store);
  await index.rebuild();

  const engine = createEngine();
  const decisions = createDecisionService(engine);
  const generator = createGenerator();
  if (!generator) {
    process.stderr.write("no writer configured — set GENERATOR_PROVIDER=openrouter\n");
    process.exit(2);
  }

  // Before anything is measured. A run against the wrong index prints a
  // well-formed table of numbers that describe a corpus these labels were not
  // written for, which is the most convincing kind of wrong.
  requireCorpus(store, "probe:facts");

  process.stdout.write(
    `\n` +
      `engine: ${engine.name} (${decisions.calibrated ? "calibrated" : "uncalibrated"})\n` +
      `cases:  ${CORPUS_FACTS.length}\n` +
      `a passage states the fact at noul >= ${STATES_FACT}\n`,
  );

  let pageHits = 0;
  let factHits = 0;
  let withheld = 0;
  const pageMissFactHit: string[] = [];
  const pageHitFactMiss: string[] = [];
  const neither: string[] = [];

  for (const testCase of CORPUS_FACTS) {
    const { response } = await runSearch(
      { store, index, embedder: null, decisions, generator },
      request(testCase.query),
    );
    if (response.abstained) withheld++;

    const pageHit = response.results.some((r) => r.url.includes(testCase.pageFragment));

    // Does any returned passage state the fact? Judged by the engine, over whatever
    // came back, so neither a different page nor a longer page changes the verdict.
    let factHit = false;
    let best = 0;
    for (const result of response.results) {
      const answers = await decisions.evaluate(
        "citation",
        { claim: testCase.fact, source: { title: result.title, text: result.content.slice(0, 1600) } },
        citationQuestions(),
      );
      const noul = decisions.noul(answers, "supported");
      if (noul > best) best = noul;
      if (noul >= STATES_FACT) {
        factHit = true;
        break;
      }
    }

    if (pageHit) pageHits++;
    if (factHit) factHits++;
    if (!pageHit && factHit) pageMissFactHit.push(testCase.query);
    if (pageHit && !factHit) pageHitFactMiss.push(`${testCase.query}  (best noul ${best.toFixed(2)})`);
    if (!pageHit && !factHit) neither.push(`${testCase.query}  (best noul ${best.toFixed(2)})`);

    process.stdout.write(
      `  ${pad(testCase.query.slice(0, 52), 54)} page=${pageHit ? "hit " : "miss"}  ` +
        `fact=${factHit ? "hit " : "miss"}  best=${best.toFixed(2)}\n`,
    );
  }

  const n = CORPUS_FACTS.length;
  process.stdout.write(
    `\n  labelled page present:   ${pageHits}/${n}\n` +
      `  fact stated:             ${factHits}/${n}\n` +
      `  answered anyway withheld: ${withheld}/${n}\n` +
      `\n  page said miss, fact said hit — the page metric was wrong: ${pageMissFactHit.length}\n`,
  );
  for (const q of pageMissFactHit) process.stdout.write(`    + ${q}\n`);

  process.stdout.write(`\n  page said hit, fact said miss — the page metric was wrong the other way: ${pageHitFactMiss.length}\n`);
  for (const q of pageHitFactMiss) process.stdout.write(`    - ${q}\n`);

  if (neither.length > 0) {
    process.stdout.write(`\n  neither: ${neither.length}\n`);
    for (const q of neither) process.stdout.write(`    ? ${q}\n`);
  }

  const usage = decisions.usage;
  process.stdout.write(
    `\n  decisions: ${usage.requests} requests, $${usage.costUsd?.toFixed(5) ?? "?"}\n` +
      `  the fact labels are still written by the same hand as the queries, so this\n` +
      `  removes the page preference from the metric and nothing else.\n\n`,
  );

  store.close();
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
