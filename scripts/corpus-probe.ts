/**
 * Builds a real corpus and measures the system on it.
 *
 * Everything measured so far ran on five or six synthetic documents I wrote, which
 * means the numbers describe my own vocabulary and my own document lengths. The
 * recall ceiling in the eval was an artifact of a corpus of five. This is the test
 * that a corpus I did not design breaks: BM25 at real scale, extraction on real
 * pages, and whether the thresholds in policy.ts — which are reasoning, not
 * measurement — survive contact with it.
 *
 * Two phases, so a measurement iteration does not re-crawl:
 *
 *   npx tsx scripts/corpus-probe.ts crawl   [pages]
 *   npx tsx scripts/corpus-probe.ts measure
 *
 * The crawl honours robots.txt and the configured per-host delay, because the
 * point of measuring on a real site is to treat it like one.
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { Crawler } from "../src/crawler/crawler.js";
import { IndexManager } from "../src/store/indexer.js";
import { Store } from "../src/store/db.js";
import { createEmbedder, embedMissing } from "../src/retrieval/vectors.js";
import { retrieve } from "../src/pipeline/retrieve.js";
import type { QueryPlan } from "../src/decision/questions.js";
import type { SearchRequest } from "../src/domain/types.js";
import { chunkStats } from "./helpers/chunk-stats.js";
import { CORPUS_GOLD } from "./helpers/corpus-gold.js";

const DB_DIR = "/tmp/opencode/jevily-corpus";
// The canonical Learn docs live at /learn, not /en/learn: nodejs.org publishes the
// learn section in its dedicated sitemap under /learn URLs, while /en/learn is a
// locale alias that the sitemap does not list. Seeding the alias with a path scope
// filters every real page out, which is the correct behaviour for a scope and the
// wrong seed for a corpus.
const SEED = process.env.CORPUS_SEED ?? "https://nodejs.org/learn";
const BUDGET = Number(process.argv[3] ?? process.env.CORPUS_PAGES ?? 200);

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** A plain factual lookup: no expansion, no recency weighting, so recall is recall. */
function request(query: string): SearchRequest {
  return {
    query,
    search_depth: "advanced",
    max_results: 20,
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
}

async function crawl(): Promise<void> {
  if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });
  const store = new Store(DB_DIR);
  const index = new IndexManager(store);
  const crawler = new Crawler(store, index);

  process.stdout.write(`\ncrawling ${SEED}, budget ${BUDGET} pages\n\n`);

  // Read the sitemaps here rather than through the crawler: reporting what the crawl
  // was seeded from is worth knowing, and exposing RobotsCache for a log line is not
  // worth the API surface.
  const robotsTxt = await fetch(new URL("/robots.txt", SEED), {
    headers: { "user-agent": "jevily-bot/0.1" },
  })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const sitemaps = [...robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  process.stdout.write(`  sitemaps: ${sitemaps.join(", ") || "(none)"}\n`);
  const crawled: string[] = [];
  let indexed = 0;

  const started = Date.now();
  const result = await crawler.crawlSite(SEED, {
    maxPages: BUDGET,
    followInternalLinks: false,
    onProgress: (o) => {
      crawled.push(o.url);
      if (o.status === "indexed") indexed++;
      if (crawled.length % 25 === 0) {
        const rate = (crawled.length / ((Date.now() - started) / 1000)).toFixed(1);
        process.stdout.write(
          `  ${String(crawled.length).padStart(4)} pages  ${rate}/s  indexed=${indexed}  ` +
            `pending=${store.pendingCount()}\n`,
        );
      }
    },
  });


  const outcomes = result.outcomes;
  const byStatus = new Map<string, number>();
  for (const o of outcomes) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);

  const elapsed = (Date.now() - started) / 1000;
  process.stdout.write(`\n  done in ${elapsed.toFixed(0)}s — ${outcomes.length} pages attempted\n`);
  for (const [status, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${pad(status, 12)} ${n}\n`);
  }

  // The reason a page failed matters more than the fact that it did: an extraction
  // that returns nothing is a different problem from a 403.
  const reasons = new Map<string, number>();
  for (const o of outcomes) {
    if (o.reason) reasons.set(o.reason, (reasons.get(o.reason) ?? 0) + 1);
  }
  if (reasons.size > 0) {
    process.stdout.write("\n  reasons:\n");
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      process.stdout.write(`    ${pad(reason, 46)} ${n}\n`);
    }
  }

  const docs = store.allDocs();
  const stats = chunkStats(store);
  process.stdout.write(
    `\n  documents: ${stats.docs}\n` +
      `  chunks:    ${stats.chunks}\n` +
      `  chars/chunk: mean ${stats.meanChars.toFixed(0)}  median ${stats.medianChars}  ` +
      `p05 ${stats.p05Chars}  p95 ${stats.p95Chars}  max ${stats.maxChars}\n` +
      `  chunks/doc:  mean ${stats.meanChunksPerDoc.toFixed(1)}  max ${stats.maxChunksPerDoc}\n` +
      `  docs with zero chunks: ${stats.zeroChunkDocs}   single-chunk docs: ${stats.singleChunkDocs}\n` +
      `  db size: ${(statSync(`${DB_DIR}/jevily.db`).size / 1e6).toFixed(1)} MB\n`,
  );

  index.rebuild();
  store.close();
}

async function measure(): Promise<void> {
  if (!existsSync(`${DB_DIR}/jevily.db`)) {
    process.stderr.write("no corpus — run the crawl phase first\n");
    process.exit(2);
  }
  const store = new Store(DB_DIR);
  const index = new IndexManager(store);
  await index.rebuild();

  const docs = store.allDocs();
  const stats = chunkStats(store);
  process.stdout.write(`\n  corpus: ${stats.docs} documents, ${stats.chunks} chunks\n`);

  // Fail before reporting any recall, because a gold that is not in the corpus makes
  // every number below meaningless while still looking like a result.
  const missing = GOLD_CASES.filter((c) => !docs.some((d) => d.url.includes(c.goldFragment)));
  if (missing.length > 0) {
    process.stderr.write(
      `\n  ${missing.length} of ${GOLD_CASES.length} gold pages are not in the corpus:\n` +
        missing.map((m) => `    ${m.goldFragment}  <- "${m.query}"\n`).join("") +
        `  recall would be measuring nothing. Re-crawl, or fix the labels.\n\n`,
    );
    store.close();
    process.exit(1);
  }
  process.stdout.write(`  all ${GOLD_CASES.length} gold pages present in the index\n`);

  // --- BM25 latency at scale -------------------------------------------------
  process.stdout.write("\n  bm25 latency by query count (ms):\n");
  for (const queries of [1, 10, 50, 200]) {
    const qs = Array.from({ length: queries }, (_, i) => SAMPLE_QUERIES[i % SAMPLE_QUERIES.length]!);
    const started = process.hrtime.bigint();
    for (const q of qs) index.bm25.search(q, 72);
    const per = Number(process.hrtime.bigint() - started) / 1e6 / queries;
    process.stdout.write(`    ${pad(`${queries} queries`, 14)} ${pad(per.toFixed(2), 8)} per query\n`);
  }

  // --- recall: lexical alone vs hybrid, through the pipeline's own retrieve ----
  //
  // The gold is a URL the crawl reached, and each query is phrased as a person would
  // phrase it — describing the problem rather than quoting the page title. A query
  // that reused its gold's wording would only measure lexical overlap.
  //
  // Both baselines go through the same retrieve path, differing only in whether an
  // embedder is passed. An earlier version of this probe hand-rolled a Bm25Index
  // keyed by document url and fused it with a dense list keyed by chunk id: the two
  // id spaces never met, so nothing could be promoted across channels and the hybrid
  // reproduced the lexical numbers exactly at every k. Identical numbers were the tell.
  const embedder = createEmbedder();
  const plan: QueryPlan = {
    intent: "factual_lookup",
    topic: "general",
    answerShape: "short_paragraph",
    synthesisNeed: 0.3,
    timeHorizon: 0,
    complexity: 1,
    ambiguity: 0.2,
    requiresExactPhrase: false,
    expandQuery: false,
    expansionStrategy: "none",
    multiRound: false,
  };

  async function recallAt(
    label: string,
    k: number,
    useDense: boolean,
    source: IndexManager = index,
  ): Promise<Set<string>> {
    let hits = 0;
    const missed: string[] = [];
    for (const q of GOLD_CASES) {
      const { candidates } = await retrieve(
        source,
        store,
        request(q.query),
        plan,
        [q.query],
        useDense ? embedder : null,
      );
      if (candidates.slice(0, k).some((c) => c.chunk.url.includes(q.goldFragment))) hits++;
      else missed.push(q.query);
    }
    process.stdout.write(`    @${pad(String(k), 3)} ${hits}/${GOLD_CASES.length}\n`);
    if (k === 5 && missed.length > 0) {
      for (const m of missed.slice(0, 4)) process.stdout.write(`         ${label} missed: ${m}\n`);
    }
    return new Set(missed);
  }

  process.stdout.write("\n  recall@k, lexical only (BM25, via retrieve):\n");
  const lexicalMissed = new Map<number, Set<string>>();
  for (const k of [1, 5, 10, 20]) lexicalMissed.set(k, await recallAt("lexical", k, false));

  // --- the hybrid channel on the same corpus --------------------------------
  //
  // The synthetic dense probe showed the hybrid recovering passages that share no
  // vocabulary with the query. The question here is whether that survives real chunk
  // lengths and real topical neighbours — 87 pages of Node documentation are far more
  // confusable than six invented documents.
  if (!embedder) {
    process.stdout.write(
      "\n  no embedder configured — set OPENROUTER_API_KEY and EMBEDDING_PROVIDER=openrouter\n" +
        "  to compare the hybrid channel against the lexical baseline above.\n",
    );
    store.close();
    return;
  }

  process.stdout.write(`\n  embedding the corpus with ${embedder.name}\n`);
  // Embed everything: a partial backfill would leave the dense channel blind to
  // exactly the chunks it is being judged on, and the two baselines would no longer
  // be searching the same corpus.
  let embedded = 0;
  for (;;) {
    const n = await embedMissing(store, embedder, 200);
    if (n === 0) break;
    embedded += n;
  }
  // IndexManager loads vectors once and caches them, so the backfill above is
  // invisible to it. A fresh instance is the way to see what was just written.
  const denseIndex = new IndexManager(store);
  await denseIndex.rebuild();
  process.stdout.write(
    `  ${embedded} new vectors, ${denseIndex.vectorCount()}/${stats.chunks} chunks have one\n`,
  );
  if (denseIndex.vectorCount() !== stats.chunks) {
    process.stderr.write("  dense baseline would be searching only a subset of the corpus\n");
  }

  process.stdout.write("\n  recall@k, hybrid (BM25 + dense + RRF, via retrieve):\n");
  for (const k of [1, 5, 10, 20]) {
    const missed = await recallAt("hybrid", k, true, denseIndex);
    const recovered = [...lexicalMissed.get(k)!].filter((m) => !missed.has(m));
    const lost = [...missed].filter((m) => lexicalMissed.get(k)!.has(m));
    if (recovered.length > 0) {
      process.stdout.write(`         recovered by dense: ${recovered.length}\n`);
      for (const m of recovered.slice(0, 3)) process.stdout.write(`           + ${m}\n`);
    }
    if (lost.length > 0) {
      process.stdout.write(`         lost relative to lexical: ${lost.length}\n`);
      for (const m of lost.slice(0, 3)) process.stdout.write(`           - ${m}\n`);
    }
  }

  store.close();
}
/** Generic technical vocabulary, sampled from the corpus's own subject matter. */
const SAMPLE_QUERIES = [
  "how do streams work",
  "what is the event loop",
  "buffer",
  "async await",
  "how to read a file",
  "child process",
  "http server",
  "tls",
  "dns lookup",
  "test runner",
];

const GOLD_CASES = CORPUS_GOLD;

const phase = process.argv[2] ?? "measure";
if (phase === "crawl") await crawl();
else await measure();
