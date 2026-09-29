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
Other endpoints: `GET /v1/search` (query-string convenience), `/v1/extract`,
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
npm test               # 128 tests, no network, no keys
npm run typecheck
npm run eval           # reranking recall, BM25 vs decisions
npm run eval:rerank -- "your query"   # per-candidate gate signals
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

With a calibrated engine on an 11-query set: recall@1 goes 55% -> 82% overall, and
0% -> 100% on the four queries BM25 ranked wrong. One query regresses, and the eval
names the document responsible rather than assuming one.

## Limits

- Dense retrieval is a brute-force cosine scan. Correct to roughly 200k chunks,
  after which it wants an ANN index.
- `node:sqlite` is still flagged experimental in Node 22–23.
- The injection check is a filter, not a security boundary. The writer's prompt
  treats every passage as untrusted text regardless of what the check said.
- The mock decision engine scores *below* BM25 on paraphrased queries. It is a
  stand-in for wiring, not a judgement model, and the eval script says so when you
  run it.
- Thresholds in `policy.ts` are starting points. They want tuning against a labelled
  set for your domain.
- Retrieval quality is bounded by the index. If the corpus is small, so is recall,
  and no amount of reranking recovers a passage the retriever never surfaced —
  `npm run eval` reports that ceiling separately for exactly this reason.
