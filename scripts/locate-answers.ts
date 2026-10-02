/**
 * Locates, for each labelled query, the passages most likely to hold its answer —
 * using lexical overlap alone, with no pipeline and no decision engine.
 *
 * This exists to keep the decomposition honest. The sub-claims get written from what
 * these passages actually say, so they have to be chosen without reference to what the
 * pipeline happened to return. Reading the system's own output and then writing the
 * label from it is grading its own homework, and it is how a compositional label ends
 * up describing a passage the system never saw.
 *
 * No key needed. This is a reading aid, not a measurement.
 *
 *   npx tsx scripts/locate-answers.ts            # all
 *   npx tsx scripts/locate-answers.ts 5 9 14     # a few by index
 */

import { Store } from "../src/store/db.js";
import { fold, isStopword, words } from "../src/util/text.js";
import { CORPUS_FACTS } from "./helpers/corpus-facts.js";
import { CORPUS_DIR } from "./helpers/corpus-check.js";

const DB_DIR = process.env.EVAL_CORPUS ?? CORPUS_DIR;
const PER_QUERY = 3;

function contentTerms(text: string): Set<string> {
  return new Set(
    words(text)
      .map((w) => fold(w))
      .filter((w) => w.length > 3 && !isStopword(w)),
  );
}

function main(): void {
  const store = new Store(DB_DIR);
  const wanted = process.argv.slice(2).map(Number);

  const chunks = store
    .allDocs()
    .flatMap((d) => store.chunksOf(d.url).map((c) => ({ url: d.url, text: c.text })));

  console.log(
    `corpus: ${store.allDocs().length} documents, ${chunks.length} chunks\n` +
      `located by content-word overlap with the query alone. The pipeline is not\n` +
      `involved, so these passages are not the ones it would have chosen.\n`,
  );

  CORPUS_FACTS.forEach((testCase, i) => {
    if (wanted.length > 0 && !wanted.includes(i)) return;

    // The query, not the fact: the question is what a person typed, and the label
    // should be derived from what answers that.
    const queryTerms = contentTerms(testCase.query);
    const ranked = chunks
      .map((c) => {
        const terms = contentTerms(c.text);
        let shared = 0;
        for (const t of queryTerms) if (terms.has(t)) shared++;
        return { ...c, shared };
      })
      .filter((c) => c.shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, PER_QUERY);

    console.log("=".repeat(78));
    console.log(`[${i}] ${testCase.query}`);
    console.log(`     currently labelled page: *${testCase.pageFragment}*`);
    for (const c of ranked) {
      const isLabelled = c.url.includes(testCase.pageFragment);
      console.log(
        `\n  ${isLabelled ? "*" : " "} ${c.url.replace("https://nodejs.org/learn/", "")}  (shared ${c.shared})`,
      );
      console.log(`    ${c.text.replace(/\s+/g, " ").trim().slice(0, 460)}`);
    }
    console.log("");
  });

  store.close();
}

main();
