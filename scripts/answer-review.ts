/**
 * Prints the answers that were written without the gold page in their evidence, in
 * full, for a human to judge.
 *
 * These four cases are the ones the pipeline answered while the page the label
 * pointed at was absent. Reading the summary said "confidently wrong"; reading the
 * actual prose said the opposite, because a different page genuinely answered the
 * question. Neither the test suite nor this script can settle that — whether prose is
 * correct is a judgement, and the point of this output is to hand it to a person
 * rather than to a threshold.
 *
 *   OPENROUTER_API_KEY=... GENERATOR_PROVIDER=openrouter npx tsx scripts/answer-review.ts
 */

import { Store } from "../src/store/db.js";
import { IndexManager } from "../src/store/indexer.js";
import { createDecisionService } from "../src/decision/service.js";
import { createEngine } from "../src/decision/index.js";
import { createGenerator } from "../src/llm/generator.js";
import { runSearch } from "../src/pipeline/search.js";
import { chunkStats } from "./helpers/chunk-stats.js";

const DB_DIR = process.env.EVAL_CORPUS ?? "/tmp/opencode/jevily-corpus";

/** The four questions that were answered while their gold page was missing. */
const CASES = [
  {
    query: "what runs first, a resolved promise or a timer callback",
    goldFragment: "understanding-processnexttick",
  },
  {
    query: "reading something off disk without blocking everything else",
    goldFragment: "reading-files-with-nodejs",
  },
  {
    query: "attaching a debugger to something that is already running",
    goldFragment: "using-inspector",
  },
  {
    query: "stripping the types out before it runs",
    goldFragment: "transpile",
  },
];

function rule(char = "="): string {
  return char.repeat(78);
}

/** The first substantive prose of the gold page, so a reader can compare sources. */
function goldSummary(store: Store, fragment: string): string {
  const doc = store.allDocs().find((d) => d.url.includes(fragment));
  if (!doc) return "(gold page is not in the index)";
  const chunks = store.chunksOf(doc.url);
  const prose = chunks
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return `${doc.title.replace(/ \| Node\.js Learn$/, "")} — ${chunks.length} chunks in the index\n    ${prose.slice(0, 620)}`;
}

async function main(): Promise<void> {
  const store = new Store(DB_DIR);
  const index = new IndexManager(store);
  await index.rebuild();

  const decisions = createDecisionService(createEngine());
  const generator = createGenerator();
  if (!generator) {
    process.stderr.write("no writer configured — set GENERATOR_PROVIDER=openrouter\n");
    process.exit(2);
  }

  const stats = chunkStats(store);
  process.stdout.write(
    `\ncorpus: ${stats.docs} documents, ${stats.chunks} chunks\n` +
      `writer: ${generator.model}\n` +
      `these are the four questions answered without the labelled page in evidence.\n` +
      `the decision engine is not deterministic between runs, so a rerun may answer\n` +
      `them differently or withhold them; the outcome line reports what happened.\n`,
  );

  const request = (query: string) =>
    ({
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
    }) as never;

  for (const testCase of CASES) {
    const { response, trace } = await runSearch(
      { store, index, embedder: null, decisions, generator },
      request(testCase.query),
    );
    const answer = trace.stages.answer as Record<string, unknown>;
    const goldPresent = response.results.some((r) => r.url.includes(testCase.goldFragment));

    process.stdout.write(`\n${rule()}\nQUESTION: ${testCase.query}\n${rule()}\n`);
    process.stdout.write(
      `outcome: ${response.abstained ? `WITHHELD (${answer.reason})` : "answered"}` +
        `   gold page in evidence: ${goldPresent ? "yes" : "NO"}\n`,
    );
    const sufficiency = answer.sufficiency as { sufficient?: number; conflicting?: number } | undefined;
    if (sufficiency) {
      process.stdout.write(
        `sufficiency: ${sufficiency.sufficient}   conflicting: ${sufficiency.conflicting}\n`,
      );
    }
    const verification = answer.verification as
      | { claims?: number; kept?: number; dropped?: number }
      | undefined;
    if (verification) {
      process.stdout.write(
        `verification: ${verification.claims} claims, ${verification.kept} kept, ${verification.dropped} dropped\n`,
      );
    }

    process.stdout.write(`\n--- the labelled page (*${testCase.goldFragment}*) ---\n`);
    process.stdout.write(`  ${goldSummary(store, testCase.goldFragment)}\n`);

    process.stdout.write(`\n--- evidence the writer actually received ---\n`);
    for (const r of response.results) {
      process.stdout.write(
        `  [${r.score.toFixed(3)}] ${r.title.replace(/ \| Node\.js Learn$/, "")}` +
          `${r.url.includes(testCase.goldFragment) ? "   <== the labelled page" : ""}\n`,
      );
      process.stdout.write(`         ${r.url.replace("https://nodejs.org/learn/", "")}\n`);
      process.stdout.write(`         ${r.content.replace(/\s+/g, " ").slice(0, 300)}\n`);
    }

    process.stdout.write(`\n--- answer ---\n`);
    process.stdout.write(`  ${(response.answer ?? "(withheld)").replace(/\s+/g, " ").trim()}\n`);

    if ((response.citations ?? []).length > 0) {
      process.stdout.write(`\n--- citations ---\n`);
      for (const c of response.citations ?? []) {
        process.stdout.write(
          `  support ${c.support.toFixed(3)}  ${c.url.replace("https://nodejs.org/learn/", "")}\n`,
        );
        if (c.quote) process.stdout.write(`      "${c.quote.slice(0, 200)}"\n`);
      }
    }
  }

  const usage = decisions.usage;
  process.stdout.write(
    `\n${rule()}\ndecisions: ${usage.requests} requests, $${usage.costUsd?.toFixed(5) ?? "?"}\n`,
  );

  store.close();
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
