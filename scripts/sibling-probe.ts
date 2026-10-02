/**
 * Where does the answer live: in the returned chunk, in a sibling chunk of the same
 * page, or nowhere in the corpus?
 *
 * The fact probe found 6 of 24 questions answered correctly against 14 pages present,
 * and reading the failures showed the right page arriving with the wrong passage. The
 * stream case is the clearest: a 33-chunk page where the returned chunk stops
 * mid-sentence just before the part that states the fact.
 *
 * That leaves one question, and it decides what to build next. If the fact sits in a
 * sibling chunk of a page already retrieved, then the answer stage is being starved
 * and expanding its evidence to adjacent chunks fixes those cases. If the fact is in
 * no chunk of the returned pages at all, expansion does nothing and the defect is
 * upstream, in which page was retrieved.
 *
 * The third bucket needs care. Asking the engine about all 729 chunks per fact costs
 * roughly twenty dollars of decisions, so the corpus-wide sweep is prefiltered
 * lexically: only chunks sharing a content word with the fact are judged. That
 * prefilter is a superset of anything the engine would endorse, since a chunk that
 * states a fact necessarily shares vocabulary with it, so a miss here still means
 * the fact is absent.
 *
 *   OPENROUTER_API_KEY=... npx tsx scripts/sibling-probe.ts
 */

import { Store } from "../src/store/db.js";
import { IndexManager } from "../src/store/indexer.js";
import { createDecisionService } from "../src/decision/service.js";
import { createEngine } from "../src/decision/index.js";
import { createGenerator } from "../src/llm/generator.js";
import { runSearch } from "../src/pipeline/search.js";
import { citationQuestions } from "../src/decision/questions.js";
import { CORPUS_FACTS } from "./helpers/corpus-facts.js";
import { requireCorpus, CORPUS_DIR } from "./helpers/corpus-check.js";
import { fold, isStopword, words } from "../src/util/text.js";

const DB_DIR = process.env.EVAL_CORPUS ?? CORPUS_DIR;
const STATED = 0.6;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function contentTerms(text: string): Set<string> {
  return new Set(
    words(text)
      .map((w) => fold(w))
      .filter((w) => w.length > 3 && !isStopword(w)),
  );
}

async function main(): Promise<void> {
  const store = new Store(DB_DIR);
  const index = new IndexManager(store);
  await index.rebuild();

  const engine = createEngine();
  const decisions = createDecisionService(engine);
  const generator = createGenerator();

  const allChunks = store.allDocs().flatMap((d) =>
    store.chunksOf(d.url).map((c) => ({ url: d.url, text: c.text })),
  );

  // Before anything is measured. This probe's first run reported 16 of 24 facts
  // "not in the corpus" against a database holding 39 documents instead of 87, and
  // the table it printed was indistinguishable from a correct one.
  requireCorpus(store, "probe:siblings");

  process.stdout.write(
    `\n` +
      `engine: ${engine.name} (${decisions.calibrated ? "calibrated" : "uncalibrated"})\n` +
      `a passage states the fact at noul >= ${STATED}\n`,
  );

  const buckets = { returned: [] as string[], sibling: [] as string[], elsewhere: [] as string[], absent: [] as string[] };

  for (const testCase of CORPUS_FACTS) {
    const { response } = await runSearch(
      { store, index, embedder: null, decisions, generator },
      {
        query: testCase.query,
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
      } as never,
    );

    const judges = async (text: string): Promise<number> => {
      const answers = await decisions.evaluate(
        "citation",
        { claim: testCase.fact, source: { title: "t", text: text.slice(0, 1600) } },
        citationQuestions(),
      );
      return decisions.noul(answers, "supported");
    };

    const best = async (texts: string[]): Promise<number> => {
      let top = 0;
      for (const text of texts) {
        const noul = await judges(text);
        if (noul > top) top = noul;
        if (top >= STATED) break;
      }
      return top;
    };

    const returned = response.results.map((r) => r.content);
    const returnedPrefixes = new Set(response.results.map((r) => r.content.slice(0, 40)));
    const returnedUrls = new Set(response.results.map((r) => r.url));
    const siblings = allChunks
      .filter((c) => returnedUrls.has(c.url) && !returnedPrefixes.has(c.text.slice(0, 40)))
      .map((c) => c.text);

    // Lexical prefilter for the corpus-wide sweep: a chunk that states a fact shares
    // at least one content word with it, so this is a superset of the engine's answer.
    const factTerms = contentTerms(testCase.fact);
    const prefiltered = allChunks
      .filter((c) => {
        const terms = contentTerms(c.text);
        for (const t of factTerms) if (terms.has(t)) return true;
        return false;
      })
      .map((c) => c.text);

    const inReturned = await best(returned);
    if (inReturned >= STATED) {
      buckets.returned.push(testCase.query);
    } else {
      const inSibling = await best(siblings);
      if (inSibling >= STATED) {
        buckets.sibling.push(testCase.query);
      } else {
        const elsewhere = await best(prefiltered);
        if (elsewhere >= STATED) buckets.elsewhere.push(testCase.query);
        else buckets.absent.push(testCase.query);
      }
    }

    process.stdout.write(
      `  ${pad(testCase.query.slice(0, 52), 54)} ` +
        `${inReturned >= STATED ? "returned" : "not returned"}\n`,
    );
  }

  const n = CORPUS_FACTS.length;
  process.stdout.write(
    `\n  fact stated in a returned chunk:       ${buckets.returned.length}/${n}\n` +
      `  stated in a SIBLING chunk of a page already retrieved: ${buckets.sibling.length}/${n}\n` +
      `  stated only elsewhere in the corpus:   ${buckets.elsewhere.length}/${n}\n` +
      `  not in the corpus at all:              ${buckets.absent.length}/${n}\n`,
  );

  if (buckets.sibling.length > 0) {
    process.stdout.write(`\n  expanding a retrieved page's evidence would reach:\n`);
    for (const q of buckets.sibling) process.stdout.write(`    + ${q}\n`);
  }
  if (buckets.absent.length > 0) {
    process.stdout.write(`\n  no amount of expansion reaches these:\n`);
    for (const q of buckets.absent) process.stdout.write(`    ? ${q}\n`);
  }
  if (buckets.elsewhere.length > 0) {
    process.stdout.write(`\n  these need a different page, not a longer one:\n`);
    for (const q of buckets.elsewhere) process.stdout.write(`    > ${q}\n`);
  }

  const usage = decisions.usage;
  process.stdout.write(`\n  decisions: ${usage.requests} requests, $${usage.costUsd?.toFixed(5) ?? "?"}\n\n`);

  store.close();
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
