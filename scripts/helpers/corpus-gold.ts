/**
 * Labelled queries against the crawled Node.js Learn documentation, shared by the
 * corpus probe and the eval so both measure the same thing.
 *
 * Every gold is a fragment of a URL the crawl actually indexed, verified before any
 * number is reported. That check exists because the first version of this list
 * borrowed its golds from the nodejs.org API docs — pages the Learn crawl does not
 * contain. Nine of ten golds were absent, recall@20 read 1/10, and it looked like a
 * retrieval failure when nothing had been searched for. A gold label pointing at a
 * document outside the corpus is not a hard query; it is a broken measurement.
 *
 * Each query is phrased as a person would phrase it — describing the problem rather
 * than quoting the page title. A query that reused its gold's wording would only
 * measure lexical overlap, which is the one thing the dense channel needs no help
 * with.
 */

export interface GoldCase {
  query: string;
  goldFragment: string;
}

export const CORPUS_GOLD: GoldCase[] = [
  // "backpressure" is in the gold's own body text, so this one is genuinely lexical.
  { query: "what happens when a stream buffer fills up", goldFragment: "backpressuring-in-streams" },
  { query: "how do I stop my program from sitting idle waiting for work", goldFragment: "asynchronous-flow-control" },
  { query: "what actually happens to my code between each turn of the loop", goldFragment: "event-loop-timers-and-nexttick" },
  { query: "what is the difference between an async function and a plain promise chain", goldFragment: "discover-promises-in-nodejs" },
  { query: "what runs first, a resolved promise or a timer callback", goldFragment: "understanding-processnexttick" },
  { query: "my callbacks pile up and nothing makes progress", goldFragment: "dont-block-the-event-loop" },
  { query: "how do I let a caller subscribe to something happening", goldFragment: "the-nodejs-event-emitter" },
  { query: "reading something off disk without blocking everything else", goldFragment: "reading-files-with-nodejs" },
  { query: "finding out what a directory contains", goldFragment: "working-with-folders-in-nodejs" },
  { query: "where should I put my own code and how does it find it", goldFragment: "nodejs-file-paths" },
  { query: "why is my process using more memory than the numbers say", goldFragment: "understanding-and-tuning-memory" },
  { query: "capturing what my program is doing while it runs, without pausing it", goldFragment: "live-debugging" },
  { query: "attaching a debugger to something that is already running", goldFragment: "using-inspector" },
  { query: "cooking the profiles down to see what is taking the time", goldFragment: "flame-graphs" },
  { query: "the snapshot I need to look at what is still reachable", goldFragment: "using-heap-snapshot" },
  { query: "what does the request lifecycle look like end to end", goldFragment: "anatomy-of-an-http-transaction" },
  { query: "running my code straight from the source with no build step", goldFragment: "run-natively" },
  { query: "stripping the types out before it runs", goldFragment: "transpile" },
  { query: "checking how much of my tests actually ran", goldFragment: "collecting-code-coverage" },
  { query: "replacing one library with a newer one without rewriting everything", goldFragment: "userland-migrations" },
  { query: "what happens to an add-on between major versions", goldFragment: "abi-stability" },
  { query: "what the difference is between here and a browser", goldFragment: "differences-between-nodejs-and-the-browser" },
  { query: "getting a hold of the engine underneath", goldFragment: "the-v8-javascript-engine" },
  { query: "sharing my code with someone who has never used this before", goldFragment: "introduction-to-nodejs" },
];
