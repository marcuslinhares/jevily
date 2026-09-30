/**
 * Refuses to measure against a corpus that is not the one the labels were written
 * for.
 *
 * Every measurement here is meaningless if the corpus underneath it changed, and the
 * failure is silent in the worst way: the probe runs, prints a well-formed table, and
 * every number in it describes a different index. That is not hypothetical. A
 * sibling-chunk run reported 16 of 24 facts "not in the corpus" against a database
 * holding 39 documents instead of 87 — pages the crawl had reached days earlier were
 * simply gone, and the output looked exactly as authoritative as a correct one.
 *
 * So the check runs before anything else: the pages every label names must be
 * present, and a shortfall stops the run with an explanation instead of a number.
 */

import { Store } from "../../src/store/db.js";
import { CORPUS_FACTS } from "./corpus-facts.js";
import { CORPUS_GOLD } from "./corpus-gold.js";

export interface CorpusCheck {
  docs: number;
  chunks: number;
  /** Every page a label depends on, by label file. */
  missing: { from: string; page: string; query: string }[];
}

/**
 * Both label sets are checked, not just the caller's: a page named by one set and
 * missing from the index means the index is not the one the numbers describe, and the
 * cheap thing is to refuse rather than to work out which labels were affected.
 */
export function checkCorpus(store: Store): CorpusCheck {
  const urls = store.allDocs().map((d) => d.url);
  const missing: CorpusCheck["missing"] = [];

  for (const { goldFragment, query } of CORPUS_GOLD) {
    if (!urls.some((u) => u.includes(goldFragment))) {
      missing.push({ from: "page labels", page: goldFragment, query });
    }
  }
  for (const { pageFragment, query } of CORPUS_FACTS) {
    if (!urls.some((u) => u.includes(pageFragment))) {
      missing.push({ from: "fact labels", page: pageFragment, query });
    }
  }

  return {
    docs: urls.length,
    chunks: store.allDocs().reduce((n, d) => n + store.chunksOf(d.url).length, 0),
    missing,
  };
}

/** Prints the state and the shortfall, then exits. Returns only when the index is sane. */
export function requireCorpus(store: Store, label: string): void {
  const check = checkCorpus(store);
  if (check.missing.length === 0) {
    process.stdout.write(
      `corpus: ${check.docs} documents, ${check.chunks} chunks ` +
        `(${CORPUS_FACTS.length} labelled queries, every page present)\n`,
    );
    return;
  }

  process.stderr.write(
    `\n${label}: the index does not hold the pages these labels name.\n` +
      `  ${check.docs} documents, ${check.chunks} chunks, ` +
      `${check.missing.length} labelled pages missing:\n` +
      check.missing.map((m) => `    ${m.from}: ${m.page}   <- "${m.query}"\n`).join("") +
      `\n  Every number this probe would print describes a different index than the\n` +
      `  labels were written for. Re-crawl first:\n` +
      `      npm run probe:corpus crawl 200\n\n`,
  );
  process.exit(1);
}
