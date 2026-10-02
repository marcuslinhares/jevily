/**
 * Runs the user's own queries against the real pipeline.
 *
 * This is the first measurement here whose labels were not written by the author of
 * this project, and it is the first one that asks the question the product is actually
 * for: given five real questions in Portuguese against an English documentation index,
 * does it answer the one it can and decline the four it cannot?
 *
 * The abstention half is the interesting half. Retrieval quality gets measured on
 * every other probe; the ability to say "I don't have that" only gets measured when
 * the questions are ones the index genuinely cannot answer, and four questions about
 * a YouTube personality, human physiology, a studio's Oscar count and the relative
 * merit of two board games are not questions anyone would invent for a search API.
 *
 *   OPENROUTER_API_KEY=... GENERATOR_PROVIDER=openrouter npx tsx scripts/user-probe.ts
 */

import { Store } from "../src/store/db.js";
import { IndexManager } from "../src/store/indexer.js";
import { createDecisionService } from "../src/decision/service.js";
import { createEngine } from "../src/decision/index.js";
import { createGenerator } from "../src/llm/generator.js";
import { runSearch } from "../src/pipeline/search.js";
import { createEmbedder } from "../src/retrieval/vectors.js";
import { citationQuestions } from "../src/decision/questions.js";
import { detectLanguage } from "../src/util/text.js";
import { CORPUS_LANGUAGE, USER_QUERIES } from "./helpers/user-queries.js";
import { requireCorpus, CORPUS_DIR } from "./helpers/corpus-check.js";
import type { SearchRequest } from "../src/domain/types.js";

const DB_DIR = process.env.EVAL_CORPUS ?? CORPUS_DIR;

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

interface Outcome {
  query: string;
  expect: string;
  note: string;
  answered: boolean;
  reason: string;
  results: number;
  goldSubstance: number;
  answer: string;
  sources: string[];
  degraded: number;
}

async function main(): Promise<void> {
  const store = new Store(DB_DIR);
  const index = new IndexManager(store);
  await index.rebuild();
  requireCorpus(store, "user-probe");

  const engine = createEngine();
  const decisions = createDecisionService(engine);
  const generator = createGenerator();
  const embedder = createEmbedder();

  process.stdout.write(
    `\nengine: ${engine.name} (${decisions.calibrated ? "calibrated" : "uncalibrated"})\n` +
      `writer: ${generator ? generator.model : "(none)"}\n` +
      `embeddings: ${embedder ? embedder.name : "(none — lexical only)"}\n` +
      `index language: ${CORPUS_LANGUAGE}\n\n`,
  );

  const outcomes: Outcome[] = [];

  for (const testCase of USER_QUERIES) {
    const { response, trace } = await runSearch(
      { store, index, embedder, decisions, generator },
      request(testCase.query),
    );
    const answerStage = trace.stages.answer as Record<string, unknown>;

    // Did the response convey the substance the label requires? Judged by the engine,
    // against the whole response text rather than a single passage, because a correct
    // answer can assemble it from several.
    let substance = 0;
    if (testCase.substance && response.answer) {
      const answers = await decisions.evaluate(
        "citation",
        {
          claim: testCase.substance,
          source: { title: "response", text: response.answer.slice(0, 1600) },
        },
        citationQuestions(),
      );
      substance = decisions.noul(answers, "supported");
    }

    const outcome: Outcome = {
      query: testCase.query,
      expect: testCase.expect,
      note: testCase.note,
      answered: !response.abstained,
      reason: String(answerStage.reason ?? "-"),
      results: response.results.length,
      goldSubstance: substance,
      answer: (response.answer ?? "").replace(/\s+/g, " ").trim(),
      sources: response.results.map((r) => r.url.replace("https://nodejs.org/learn/", "")),
      degraded: trace.degraded,
    };
    outcomes.push(outcome);

    const lang = detectLanguage(testCase.query);
    process.stdout.write("=".repeat(78));
    process.stdout.write(
      `\n"${testCase.query}"\n` +
        `  query language: ${lang}   index language: ${CORPUS_LANGUAGE}   degraded: ${outcome.degraded}\n` +
        `  expected: ${testCase.expect}\n` +
        `  got:      ${outcome.answered ? "ANSWERED" : `withheld (${outcome.reason})`}` +
        `${testCase.substance ? `   substance conveyed: ${substance.toFixed(2)}` : ""}\n` +
        `  results returned: ${outcome.results}\n`,
    );
    if (outcome.sources.length > 0) {
      process.stdout.write(`  sources: ${outcome.sources.slice(0, 4).join(", ")}\n`);
    }
    if (outcome.answer) {
      process.stdout.write(`\n  answer: ${outcome.answer.slice(0, 400)}\n`);
    }
    process.stdout.write("\n");
  }

  // --- the scoreboard --------------------------------------------------------
  const shouldRefuse = outcomes.filter((o) => o.expect === "refuse");
  const refused = shouldRefuse.filter((o) => !o.answered);
  const shouldAnswer = outcomes.filter((o) => o.expect !== "refuse");
  const answered = shouldAnswer.filter((o) => o.answered);
  const substanceCarried = shouldAnswer.filter((o) => o.goldSubstance >= 0.6);

  process.stdout.write("-".repeat(78));
  process.stdout.write(
    `\n  should decline: ${refused.length}/${shouldRefuse.length} declined\n`,
  );
  for (const o of shouldRefuse) {
    process.stdout.write(`    ${o.answered ? "ANSWERED ANYWAY" : "declined"}   ${o.reason.padEnd(28)} "${o.query}"\n`);
  }
  process.stdout.write(`\n  should answer:  ${answered.length}/${shouldAnswer.length} answered`);
  process.stdout.write(
    `, ${substanceCarried.length}/${shouldAnswer.length} carried the required substance\n`,
  );
  for (const o of shouldAnswer) {
    process.stdout.write(
      `    ${o.answered ? "answered" : "withheld"} substance=${o.goldSubstance.toFixed(2)}   "${o.query}"\n`,
    );
  }

  const usage = decisions.usage;
  process.stdout.write(`\n  decisions: ${usage.requests} requests, $${usage.costUsd?.toFixed(5) ?? "?"}\n\n`);

  store.close();
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
