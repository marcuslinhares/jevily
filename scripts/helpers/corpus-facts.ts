/**
 * Gold labels as facts rather than as pages.
 *
 * The URL-fragment labels had a defect that showed up three times on the real
 * corpus: "the gold page is in the results" is not correctness. A different page can
 * answer the question completely — `understanding-setimmediate` answers "what runs
 * first" just as well as `understanding-processnexttick` does — and a metric built on
 * page presence counts those as failures while counting a page that merely mentions
 * the topic as a success.
 *
 * So each case here states the substance a correct answer must convey. Presence of
 * that substance is then judged by the decision engine, over whatever passages came
 * back, which makes the check independent of which page the retriever happened to
 * prefer and independent of whether the page is the "right" one.
 *
 * These facts are still written by the same author as the queries, which is the
 * standing limitation: they encode one reading of what each question is asking. What
 * they do not encode is a preference for one URL, which is the part that was wrong.
 */

export interface FactCase {
  query: string;
  /** The substance a correct answer must state. */
  fact: string;
  /** The page the earlier label pointed at, kept only to compare the two metrics. */
  pageFragment: string;
}

export const CORPUS_FACTS: FactCase[] = [
  {
    query: "what happens when a stream buffer fills up",
    fact: "When a writable stream's internal buffer passes its highWaterMark, write() returns false and the producer is expected to wait for the 'drain' event before writing again.",
    pageFragment: "backpressuring-in-streams",
  },
  {
    query: "how do I stop my program from sitting idle waiting for work",
    fact: "Node.js runs JavaScript on a single thread, so long or synchronous work blocks the event loop; work is scheduled onto the loop so the program can continue between callbacks.",
    pageFragment: "asynchronous-flow-control",
  },
  {
    query: "what actually happens to my code between each turn of the loop",
    fact: "The event loop iterates over ordered phases — timers, pending callbacks, poll, check, and close callbacks — and drains the callbacks belonging to each phase before moving to the next.",
    pageFragment: "event-loop-timers-and-nexttick",
  },
  {
    query: "what is the difference between an async function and a plain promise chain",
    fact: "An async function always returns a promise, and awaiting inside it is equivalent to chaining .then() callbacks; both let the event loop continue rather than blocking.",
    pageFragment: "discover-promises-in-nodejs",
  },
  {
    query: "what runs first, a resolved promise or a timer callback",
    fact: "process.nextTick callbacks run before promise microtasks, and promise microtasks run before timers and other macrotasks.",
    pageFragment: "understanding-processnexttick",
  },
  {
    query: "my callbacks pile up and nothing makes progress",
    fact: "Long-running synchronous or CPU-heavy code blocks the event loop, so already-queued callbacks cannot run until it finishes.",
    pageFragment: "dont-block-the-event-loop",
  },
  {
    query: "how do I let a caller subscribe to something happening",
    fact: "An EventEmitter emits named events and callers subscribe with .on(); when the event is emitted the registered listeners are invoked.",
    pageFragment: "the-nodejs-event-emitter",
  },
  {
    query: "reading something off disk without blocking everything else",
    fact: "fs.readFile reads a file asynchronously without blocking the event loop, fs.promises offers the same as promises, and readFileSync is the blocking variant.",
    pageFragment: "reading-files-with-nodejs",
  },
  {
    query: "finding out what a directory contains",
    fact: "fs.readdir (or fs.promises.readdir, or readdirSync) lists the entries of a directory.",
    pageFragment: "working-with-folders-in-nodejs",
  },
  {
    // The earlier label pointed at nodejs-file-paths, which is about the path module
    // rather than about module resolution. The query was asking something the page
    // does not answer, so the query changed instead of the label being excused.
    query: "how do I join and manipulate filesystem paths",
    fact: "The path module provides join, resolve, parse and format for building and taking apart filesystem paths, and path.sep is the platform separator.",
    pageFragment: "nodejs-file-paths",
  },
  {
    query: "why is my process using more memory than the numbers say",
    fact: "Resident set size includes memory the process is not actively using, and V8's garbage collector is lazy and grows its heap, so process memory can exceed what the application is holding.",
    pageFragment: "understanding-and-tuning-memory",
  },
  {
    query: "capturing what my program is doing while it runs, without pausing it",
    fact: "Node's inspector can be attached to a running process so code can be profiled and inspected without stopping the program.",
    pageFragment: "live-debugging",
  },
  {
    query: "attaching a debugger to something that is already running",
    fact: "Sending SIGUSR1 to a Node process opens the inspector, which then listens for a debugging client on 127.0.0.1:9229 by default.",
    pageFragment: "using-inspector",
  },
  {
    query: "cooking the profiles down to see what is taking the time",
    fact: "A flame graph shows call stacks on the vertical axis and time on the horizontal axis, aggregating samples so the widest section identifies the hot path.",
    pageFragment: "flame-graphs",
  },
  {
    query: "the snapshot I need to look at what is still reachable",
    fact: "A heap snapshot records the object graph retained in memory, which is how retained objects and memory leaks are found.",
    pageFragment: "using-heap-snapshot",
  },
  {
    query: "what does the request lifecycle look like end to end",
    fact: "An incoming HTTP request arrives on a server object and is emitted through successive events — headers, then body chunks — before a response is written.",
    pageFragment: "anatomy-of-an-http-transaction",
  },
  {
    query: "running my code straight from the source with no build step",
    fact: "Node can execute TypeScript directly by stripping types, with no build step, provided the code uses only erasable TypeScript syntax.",
    pageFragment: "run-natively",
  },
  {
    query: "stripping the types out before it runs",
    fact: "Type stripping removes erasable TypeScript syntax such as type annotations and interfaces; it does not type-check, and syntax that requires code generation is not handled.",
    pageFragment: "transpile",
  },
  {
    query: "checking how much of my tests actually ran",
    fact: "The built-in test runner can report code coverage, showing which lines and branches the tests exercised.",
    pageFragment: "collecting-code-coverage",
  },
  {
    query: "replacing one library with a newer one without rewriting everything",
    fact: "A migration guide maps the old library's calls onto the replacement's, so callers can move across without rewriting everything at once.",
    pageFragment: "userland-migrations",
  },
  {
    query: "what happens to an add-on between major versions",
    fact: "Node guarantees a stable ABI for native add-ons across major versions, identified by NODE_MODULE_VERSION.",
    pageFragment: "abi-stability",
  },
  {
    query: "what the difference is between here and a browser",
    fact: "Node is a server-side runtime with no DOM but with filesystem, networking and server APIs, rather than a browser environment.",
    pageFragment: "differences-between-nodejs-and-the-browser",
  },
  {
    query: "getting a hold of the engine underneath",
    fact: "Node.js embeds Google's V8 JavaScript engine.",
    pageFragment: "the-v8-javascript-engine",
  },
  {
    query: "sharing my code with someone who has never used this before",
    fact: "Node.js is a JavaScript runtime built on V8 that runs outside the browser, on the server, driven by an event loop.",
    pageFragment: "introduction-to-nodejs",
  },
];
