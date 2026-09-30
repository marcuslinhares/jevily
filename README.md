# jevily

A search API for language-model agents. Own crawler, own index, and a type-safe
decision engine doing the work a Tavily-style API pays an LLM to do.

The premise: a search pipeline is mostly *judgement*, not generation. Which channel
to search, how deep to go, whether a passage answers the question, whether it is
authoritative or padding, whether it contradicts the question, whether it contains
a prompt injection, whether it can support a given claim. Those are all small,
independent, well-scoped decisions with a probability attached. That is exactly
what a System One model is for, and none of it needs a paragraph of reasoning.

So the architecture is: **the code decides, the model judges, and the model that
judges never writes a word.** Jev cannot generate text. Whenever the pipeline needs
strings — a rewritten query, a final answer, an extracted claim — a generative model
produces them under a strict schema, and the decision engine judges the result.
Generation proposes; typed judgement disposes.

## What it does differently

| | Tavily-style | jevily |
| --- | --- | --- |
| Search parameters | guessed from the query string, or `auto_parameters` | derived by a decision batch, and returned in `plan` so you can see why |
| Ranking | one opaque relevance score | a weighted composite of six named signals, all inspectable |
| Reranking | LLM prompt over a shortlist | six atomic questions per candidate, combined in code |
| Prompt injection | not addressed | every passage is gated, and injections never reach the writer |
| Premise conflicts | silently averaged into the answer | routed to a separate block the writer must address |
| Citations | strings in the prose | every claim verified against its source, unverified claims dropped |
| Weak evidence | still produces a confident answer | `abstained: true` with the reason, and no answer |
| Result pages | padded to `max_results` | capped per domain; a thin page returns thin rather than five windows onto one document |
| Hybrid retrieval | one channel | BM25 plus a dense channel that scans the whole corpus, fused with RRF |
| Debugging | a request id | a full trace: every question, every answer, every threshold |

The abstention behaviour is the one that matters most. Any search API that always
returns prose will confidently answer questions its index cannot support. jevily
checks whether the selected evidence can actually answer the question, and returns
the evidence without an answer when it cannot.

## Pipeline

```
understand  →  expand  →  retrieve  →  rerank  →  gate  →  answer  →  verify
   │                                                      │           │
   └─ one decision batch, 9 questions        one batch per candidate  one per claim
```

**understand** — nine questions about the query alone, before a single document is
fetched: intent, topic, expected answer shape, how much the answer needs synthesis,
how much recency matters, how complex it is, how ambiguous it is, whether it pins
an exact phrase or a hard constraint, and whether a second search round is worth it.
The result is the search plan, and it is returned to you.

**retrieve** — BM25 and, when configured, dense vectors, fused with reciprocal rank
fusion. Filters (domains, language, date window, safe search) and near-duplicate
collapse by simhash are pure code.

**rerank** — one decision call per candidate, six questions at once: does this
passage answer the question, is it self-contained, is the publisher authoritative,
is the writing substantive, how current does it need to be, does it satisfy the
user's stated constraints. Code combines them with weights you can change.

**gate** — five more questions per candidate, routed in code to `include`,
`conflicting`, or `exclude`. Injection first, because it is a security decision.
Conflicts before evidence, because a passage that denies the premise usually also
states something usable and would otherwise land in the wrong block.

**answer** — sufficiency check, then a generative model writes against the accepted
evidence with the conflicting evidence in a separate block. **verify** — each claim
is checked back against the source it cites; unsupported claims are removed and the
answer says so.

## Quick start

```bash
npm install
cp .env.example .env

npm run index:seed        # sample corpus, no network needed
npm run dev
```

```bash
curl -s 'localhost:8787/v1/search?q=how+does+backpressure+work+in+node+streams&trace=1' | jq
```

It runs keyless. With no keys configured the decision engine is a deterministic
mock, so you can see the whole pipeline immediately.

To use the real decision model, set one key. Jev is reachable two ways, and the
config derives the base URL and model id to match whichever you pick:

```bash
# TypeSafe direct
DECISION_API_KEY=ts_... npm run dev

# OpenRouter — same model, same protocol, billed to your OpenRouter account
OPENROUTER_API_KEY=sk-or-... npm run dev
```

Either way the engine posts to `{base}/v1/systemone` with the same request and
response shape, and reports itself as `calibrated`. OpenRouter also documents a
second surface, `POST /api/alpha/decisions`, for callers not using the TypeSafe
SDKs; this project uses the System One path because it is the SDK-compatible one.

Add `GENERATOR_PROVIDER=openrouter` to enable answer synthesis. Answers are the one
thing that requires a generative model, since Jev produces no text.

## Indexing

```bash
# a single page
curl -X POST localhost:8787/v1/index -H 'content-type: application/json' \
  -d '{"urls":"https://nodejs.org/en/learn/modules/backpressuring-in-streams"}'

# a whole site, from its sitemap
curl -X POST localhost:8787/v1/index -H 'content-type: application/json' \
  -d '{"urls":"https://sqlite.org","mode":"site"}'

# local markdown
npm run index:seed -- ./notes
```

Storage is `node:sqlite`, so there is no native build step. Conditional requests
mean re-crawling an unchanged page costs one 304. `robots.txt` is parsed per host
including `Crawl-delay`, and per-host politeness is enforced by the scheduler, not
just by the crawler.

## API

`POST /v1/search` accepts Tavily's body unchanged, plus:

| field | meaning |
| --- | --- |
| `auto_parameters` | let the decision engine choose depth, pool size and rounds |
| `candidate_pool` | cap on candidates sent to the reranker (10–200) |
| `max_rounds` | 1–3, how many retrieval rounds to run |
| `include_trace` | return the full decision trace inline |
| `verify_citations` | force citation verification on or off |

The response adds `abstained`, `plan`, and `citations` alongside the usual fields.
Other endpoints: Auth is per API key (`API_KEYS`, off by default) and rate limiting is per key
(`RATE_LIMIT_RPM`, off when 0). Auth runs first on purpose: limiting before it would
let an anonymous caller enumerate valid keys by watching which requests return 429
instead of 401.

`GET /v1/search` (query-string convenience), `/v1/extract`,
`/v1/crawl`, `/v1/index`, `/v1/index/rebuild`, `/v1/stats`, `/v1/trace/:id`, and
`/v1/evaluate` for querying the decision engine directly while tuning a threshold.

## Decisions are typed

```bash
curl -X POST localhost:8787/v1/evaluate -H 'content-type: application/json' -d '{
  "state": "The central bank raised rates by 25 basis points.",
  "questions": {
    "is_factual": { "type": "noul", "instructions": "Does this state a verifiable fact?" },
    "severity":    { "type": "score", "instructions": "How market-moving is this?",
                     "criteria": ["Routine", "Notable", "Significant"] },
    "topic":       { "type": "choice", "instructions": "Which area?",
                     "criteria": { "monetary": "Rates and policy", "equity": "Stock markets" } }
  }
}'
```

Three primitives, three answer shapes, all type-safe by construction:
`noul` returns P(yes), `choice` returns an option plus its distribution and a
confidence, `score` returns a position on your rubric. You cannot get a type error
back. Ask as many as you want in one call — they run in parallel, so a sixth
question costs tokens and almost no time.

## Calibration changes the policy

`DecisionEngine.calibrated` is `true` for the System One endpoint — TypeSafe direct,
or the same model routed through OpenRouter — where a `noul` of 0.45 genuinely means
about 45% of the time. A probability written by a chat model in a JSON blob means
considerably less.

Treating both identically is how a pipeline ends up confidently wrong, so they do not
get the same thresholds. `resolvePolicy(false)` raises every inclusion gate, lowers
every exclusion gate, and leans harder on the lexical signal we can verify
ourselves. Uncalibrated, the system keeps more evidence and asks for more proof
before claiming anything. The numbers live in one file, `src/pipeline/policy.ts`.

## Where things are

```
src/
  decision/      the engine port, the System One client, and the question library
  retrieval/     tokenizer, BM25, rank fusion, dense channel
  crawler/       robots, fetch, HTML extraction, sitemaps
  store/         sqlite schema, chunking, simhash, index manager
  pipeline/      understand, retrieve, rerank, gate, answer, policy
  llm/           the generative half
  routes/        HTTP surface
```

`src/decision/questions.ts` is the part worth reading. Every question the system
asks is there, with the criteria that define what true and false mean. Changing
policy is usually a number in `policy.ts`; changing *judgement* is a question in
`questions.ts`.

`test/systemone.test.ts` pins the wire contract against the published request and
response schema, so a silent break with the real API fails a test instead of quietly
degrading every judgement in the pipeline.

## Scripts

```bash
npm run dev            # watch mode
npm run build && npm start
npm test               # 206 tests, no network, no keys
npm run typecheck
npm run eval           # reranking recall, BM25 vs decisions
npm run eval:rerank -- "your query"   # per-candidate gate signals
npm run probe:answer                  # answer path, real models (needs keys)
npm run probe:dense                   # hybrid retrieval, real embeddings
npm run probe:corpus                  # real-corpus crawl and measurement
npm run probe:gate                    # gate + abstention on the real corpus
npm run index:seed     # seed the index
```

`npm run eval` is how the thresholds get checked instead of guessed. It reports the
recall ceiling separately from the ranking, so a retrieval regression is never
mistaken for a ranking one.

```bash
DECISION_API_KEY=... npm run eval   # or OPENROUTER_API_KEY=...
```

The set is built to make reranking measurable rather than to flatter it. Every query
is paraphrased away from the corpus's own wording, and every gold passage is paired
with a distractor that shares most of the query's terms while answering a different
question — otherwise BM25 scores 100% and the reranker is never asked to do
anything. Results are reported twice: overall, and restricted to the queries the
reranker can actually act on, since a passage that never reached the pool is a
retrieval failure no re-ranker can repair.

```bash
EVAL_REPEAT=5 npm run eval
```

`EVAL_REPEAT` matters. The decision model is not deterministic between runs, so a
single pass is a coin flip dressed as a measurement, and the eval says so when you
ask for one. Over five independent passes on an 11-query set:

| recall@1 | bm25 | decisions |
| --- | --- | --- |
| all queries | 55% (deterministic) | 73%–82% |
| the 4 queries bm25 ranks wrong | 0% (deterministic) | 75%–100% |

Four of the five passes fix all four; one fixes three. One query regresses in every
pass, and the eval names the document responsible rather than assuming one.

### The real corpus

The synthetic set above is a controlled comparison: known corpus, known gold, one
variable. It cannot say whether anything holds on a corpus nobody designed. So there
is a second reading, against the real Node.js Learn documentation — 87 pages, 729
chunks, crawled with the crawler and measured with the pipeline's own `retrieve`:

```bash
npm run probe:corpus crawl 200            # ~50s, honours robots.txt
EVAL_CORPUS=/tmp/opencode/jevily-corpus \
  DECISION_API_KEY=... EMBEDDING_PROVIDER=openrouter npm run eval
```

Retrieval, 24 human-written queries whose gold pages are all present in the crawl:

| recall | lexical | hybrid |
| --- | --- | --- |
| @1 | 25% | 33% |
| @3 | 46% | 63% |
| @5 | 50% | 75% |

Reranking, gold already inside the top 5 (18 of 24 cases):

| | |
| --- | --- |
| promoted to rank 1 | 4 of 10 rerankable |
| lost a rank 1 it already had | 0 of 8 |
| rank 1 overall | 12 of 18 |

Three independent runs gave the same 4/10 and 0/8, each 90 decision requests at
$0.0049. Jev is not deterministic between runs, so that stability is a reading worth
having — but the thresholds in `policy.ts` were fitted to the synthetic set, not this
one, so these numbers are evidence, not a score. The eval prints which case moved and
which document won, because a regression should be read before it is tuned away.

The recall ceiling is content, not pool depth. Widening the candidate pool from 72 to
150 and 240 does not improve it — @5 drops from 18/24 to 17/24 and @20 holds at 20/24,
while recall at the full pool edge only rises 22/24 to 23/24. The missing pages are
not being truncated; neither channel ranks them. A deeper pool buys reranking more
candidates to reject and nothing else.

### What the gate and the abstention actually do

`npm run probe:gate` runs the whole pipeline — understand, retrieve, rerank, gate,
answer, verify — over the same 24 queries with the real engine and the real writer.
On 87 pages from one domain, 960 decision requests, $0.05:

```
  candidates after fusion:  72.0 per query
  kept by rerank:            7.5 per query
  surviving the gate:        2.6 per query
  results returned:          min 0  mean 2.6  max 3   (asked for 20)
  gold in the response:      14/24
  answered 12/24   withheld 12/24
```

`max 3` against `asked for 20` is the domain cap: every page of a documentation site
is on the same domain, so `maxPerDomain: 3` made `max_results` unreachable. The cap
is right for a web index, where one domain usually means one vendor shouting, and
wrong for a single-domain corpus, so it is now `MAX_PER_DOMAIN` and overridable.

Raising it does not fix the abstention, which was the more interesting hypothesis:
at a cap of 8 the response grows from 2.7 to 5.8 results per query and the answered
count does not move. Mean sufficiency sits at 0.61 against a `minSufficiency` of
0.55 — the verdict is landing on the threshold, not above or below it, which is why
the withheld rate hovers near half. Three repeat runs on an identical corpus answered
6, 5 and 4 of 12, so the answer stage is far less stable between runs than the
reranker is, which was reproducible to the case across three passes.

Lowering `minSufficiency` would convert withheld into answered immediately, and the
measurement does not support doing it: the distribution is narrow, so any threshold
near the middle splits it arbitrarily, and 24 self-authored queries are not a basis
for moving a number. It stays where it is, labelled as a product decision.

The unanswerable half behaves better: 6 of 6 questions the corpus cannot answer were
withheld, all on `no_candidates`.

### A metric that measured the labelling, not the system

Of the 12 questions that were answered, 4 did not have the gold page in their
evidence, which reads as four confident wrong answers. Inspecting them says
otherwise. "What runs first, a resolved promise or a timer callback" was answered
from `understanding-setimmediate` and `discover-promises-in-nodejs`; "reading
something off disk without blocking everything else" from
`overview-of-blocking-vs-non-blocking`. Both are pages that genuinely answer those
questions. The gold label named one page, and the system found a different correct
one.

This is the third time a measurement on this corpus turned out to be about the labels
rather than the code — first gold pages that were not in the index, then a fusion
between two id spaces that could not intersect, now a gold label that is a page
rather than a fact. "The gold page is absent" is not a correctness metric, and any
count built on it will be wrong in whichever direction the answer happens to come
from. Whether those four answers are actually right is a judgement about prose, which
this suite cannot make and should not pretend to.

### Labelling by fact instead of by page

`npm run probe:facts` replaces the page labels with the substance each answer has to
convey, and asks the decision engine — the same `supported` question the citation
verifier uses — whether any returned passage states it. That makes the check
independent of which page the retriever preferred.

The engine is well calibrated for this, which was worth confirming before trusting
anything built on it: the stream `highWaterMark` fact scores 0.89 against the
sentence that states it and 0.01 against a deliberately impossible one.

| | |
| --- | --- |
| labelled page present in results | 14/24 |
| fact stated by a returned passage | 6/24 |

The four cases where the fact is stated but the labelled page is absent are the page
metric being simply wrong, and they are the ones the earlier reading had dismissed as
confident mistakes. The twelve in the other direction are not the metric being wrong
twice: the correct page came back, and the passage from it did not state the fact. The
stream case shows why. The page has 33 chunks; the one returned is chunk 15, which
says the buffer "has exceeded the highWaterMark" and stops mid-sentence. The part
that says to wait for `drain` is a different chunk of the same page, and it did not
come back. noul 0.51 is the right verdict on that passage — it mentions the mechanism
without stating the fact.

So the two numbers describe different failures, and the second one is about chunking.
A chunk here is a median of 4 sentences, 17% of its page, and the gate keeps about 2.6
of the 8.4 chunks a page has. The answer stage therefore sees a thin, arbitrary slice
of the right page — which is also why sufficiency lands at 0.61 against a threshold of
0.55, and why the withheld rate hovers near half. The thresholds are not the thing to
adjust; the evidence handed to the verdict is.

The fact labels are still written by the same hand as the queries, so this removes the
page preference from the metric and nothing else.

### The labels are now the bottleneck, not the pipeline

`npm run probe:siblings` asks where the answer lives: in a returned chunk, in a sibling
chunk of a page already retrieved, or nowhere. On a verified 87-document corpus:

| | |
| --- | --- |
| stated in a returned chunk | 8/24 |
| stated in a sibling chunk of a page already retrieved | 1/24 |
| stated only elsewhere in the corpus | 3/24 |
| not stated anywhere in the corpus | 12/24 |

Only one case would be reached by expanding a retrieved page's evidence, so building
context expansion would be fixing a single query out of twenty-four. The measurement
argues against the fix I expected to build.

The twelve are not a chunking defect either. Taking the clearest one, "what happens
when a stream buffer fills up", the backpressure page has 33 chunks and the best of
them scores 0.54. Read verbatim, that chunk says the data buffer exceeding the
`highWaterMark` makes `.write()` return false, that this pauses the incoming Readable
stream, and that a `drain` event resumes the flow. It states the fact. The label says
"the *producer* is expected to wait for the drain event", and the page says the
*Readable* is paused and resumed. The engine scored 0.54 because the scopes differ,
which is the question it was asked and the right answer to it.

So the fact is compositional: no single documentation page states it in one sentence,
because the label fused three separate statements and then attributed them to a
different actor than the page does. Reading the passage is what found that, and no
aggregate would have.

The lesson is about the ruler rather than the system. Four times a measurement on this
corpus turned out to be about the labels, and the fix each time was a better label —
except the last one, where the label was made more demanding than the document is.
`probe:corpus` now refuses to run unless every labelled page is present in the index,
because a run against a 39-document database printed sixteen "not in the corpus"
verdicts in a table indistinguishable from a correct one.

What this leaves is a judgement about prose that the suite should not make on its own:
whether a passage that states the fact in its own words counts as answering the
question. A label per query is the wrong granularity for a documentation corpus.

## Probes

Four things are only verified against real services, because stubbing them would test
the wiring and not the product:

```bash
OPENROUTER_API_KEY=... npm run eval              # reranking, with the real model
OPENROUTER_API_KEY=... GENERATOR_PROVIDER=openrouter npm run probe:answer
OPENROUTER_API_KEY=... EMBEDDING_PROVIDER=openrouter npm run probe:dense
npm run probe:corpus crawl 200                   # real corpus, no key needed
```

The dense probe is the one that validates the hybrid channel: on a corpus where the
queries deliberately share no vocabulary with the passages that answer them, lexical
retrieval alone finds 2 of 4 and the hybrid finds 4 of 4, recovering two passages
that BM25 never saw.

The corpus probe is the one that would catch a measurement that is not measuring
anything. Its first run reported `recall@20 = 1/10` on a corpus of 177 real pages,
which read as a catastrophic retrieval failure; nine of the ten gold pages were simply
not in the index, because the seed was a locale alias the sitemap does not list. It now
verifies every gold against the crawl and refuses to report recall otherwise. An
earlier version also built its own `Bm25Index` keyed by document url and fused it with
a dense list keyed by chunk id — two id spaces that never intersect, so no candidate
could be promoted across channels and the hybrid reproduced the lexical numbers exactly
at every k. Identical numbers were the tell.

## Limits

- Dense retrieval is a brute-force cosine scan. Measured at 729 chunks: 0.1–2ms per
  query. Correct to roughly 200k chunks, after which it wants an ANN index.
- `node:sqlite` is still flagged experimental in Node 22–23.
- The injection check is a filter, not a security boundary. The writer's prompt
  treats every passage as untrusted text regardless of what the check said.
- The mock decision engine scores *below* BM25 on paraphrased queries. It is a
  stand-in for wiring, not a judgement model, and the eval script says so when you
  run it.
- Answer writing and citation verification are only exercised for real by
  `npm run probe:answer`, which needs a key. The test suite stubs the generator, so
  it tests the wiring around the model and not the model.
- The abstention thresholds in `policy.ts` are reasoned, not measured. `decisive`
  in particular — the sufficiency level above which the count-based floors stop
  applying — has no labelled data behind it yet. What the real corpus does show is
  that the evidence handed to the verdict is a thin slice of the right page, which
  puts sufficiency near its threshold and the withheld rate near half; the evidence
  is the thing to change, not the number.
- A degraded decision engine now withholds the answer with
  `decision_engine_unavailable` rather than writing prose on default judgements. A
  missing noul reads as 0.5, which is a plausible number rather than an absent one,
  and an auth failure used to produce complete-looking answers that were unfounded.
- Thresholds in `policy.ts` are starting points. They want tuning against a labelled
  set for your domain. The real-corpus run above is a first look at how they behave
  off-distribution, not a fit.
- A site crawl is scoped to the seed's path prefix. Sitemaps are published per host,
  so without a scope, seeding `https://nodejs.org/en/learn` — a locale alias the
  sitemap does not list — indexes the entire host: 1651 URLs, of which 88 are the
  section asked for. The crawler honours robots.txt and a per-host delay, and
  `max_pages` stops the drain rather than truncating the response, leaving the rest
  of the frontier pending.
- Retrieval quality is bounded by the index. If the corpus is small, so is recall,
  and no amount of reranking recovers a passage the retriever never surfaced —
  `npm run eval` reports that ceiling separately for exactly this reason.
