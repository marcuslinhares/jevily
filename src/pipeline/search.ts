/**
 * The search pipeline.
 *
 *   understand -> (expand) -> retrieve -> rerank -> gate -> [answer -> verify]
 *
 * Every arrow is a separate, individually inspectable stage. The decision engine
 * is called in three places, each with a different question batch, and the trace
 * records exactly what it was asked and what came back. That trace is the product:
 * a search API you can audit is worth more than one that is merely fast.
 */

import { config } from "../config.js";
import { log } from "../util/log.js";
import { shortId, stableKey } from "../util/hash.js";
import { detectLanguage } from "../retrieval/tokenize.js";
import { round, truncate } from "../util/text.js";
import { decision } from "../decision/service.js";
import { createGenerator } from "../llm/generator.js";
import { resolvePolicy } from "./policy.js";
import { understandQuery } from "./understand.js";
import { buildQueries, followUpQueries, type QueryPlanLike } from "./expand.js";
import { retrieve } from "./retrieve.js";
import { rerank, type RerankedCandidate } from "./rerank.js";
import { applyDomainDiversity, gate } from "./gate.js";
import { answerStage } from "./answer.js";
import type { IndexManager } from "../store/indexer.js";
import type { Store } from "../store/db.js";
import type { Embedder } from "../retrieval/vectors.js";
import type {
  QueryPlanEcho,
  SearchDepth,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from "../domain/types.js";
import type { DecisionService, DecisionTraceEntry } from "../decision/service.js";

export interface PipelineDeps {
  store: Store;
  index: IndexManager;
  embedder: Embedder | null;
  decisions?: DecisionService;
  generator?: ReturnType<typeof createGenerator>;
}

export interface SearchOutcome {
  response: SearchResponse;
  trace: SearchTrace;
}

export interface SearchTrace {
  id: string;
  query: string;
  engine: { name: string; calibrated: boolean };
  policy: { calibration_aware: boolean };
  plan: QueryPlanLike & { candidatePool: number; rounds: number; searchDepth: string };
  stages: {
    understand: { questions: string[]; answers: Record<string, number | string> };
    retrieval: Record<string, number | string>;
    rerank: { considered: number; kept: number; top: number };
    gate: { include: number; conflicting: number; excluded: number };
    answer: Record<string, unknown>;
  };
  decisions: DecisionTraceEntry[];
  usage: Record<string, number | null>;
  latencyMs: number;
  degraded: number;
}

export async function runSearch(
  deps: PipelineDeps,
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const started = Date.now();
  const c = config();
  const decisions = deps.decisions ?? decision();
  const generator = deps.generator !== undefined ? deps.generator : createGenerator();
  const policy = resolvePolicy(decisions.calibrated);
  const traceId = shortId("trc");
  const language = detectLanguage(request.query);

  // --- 1. understand --------------------------------------------------------
  const { plan: rawPlan, answers: planAnswers } = await understandQuery(
    decisions,
    {
      query: request.query,
      language,
      ...(request.search_depth ? { requestedDepth: request.search_depth } : {}),
      ...(request.topic ? { requestedTopic: request.topic } : {}),
      ...(request.candidate_pool ? { requestedPool: request.candidate_pool } : {}),
      ...(request.max_rounds !== undefined ? { maxRounds: request.max_rounds } : {}),
      autoParameters: Boolean(request.auto_parameters),
      hasConstraintFilter: Boolean(
        request.include_domains?.length || request.exclude_domains?.length || request.time_range,
      ),
    },
    signal,
  );

  const queries = await buildQueries(generator, request.query, rawPlan, signal);
  const pool = Math.max(20, Math.min(request.candidate_pool ?? c.DEFAULT_CANDIDATE_POOL, 200));
  const rounds = request.max_rounds !== undefined ? request.max_rounds : rawPlan.multiRound ? 2 : 1;

  // --- 2. retrieve (possibly twice) ----------------------------------------
  let retrieval = await retrieve(deps.index, deps.store, request, rawPlan, queries, deps.embedder);

  if (rounds > 1 && retrieval.candidates.length > 0) {
    const followUps = followUpQueries(
      request.query,
      retrieval.candidates.slice(0, 6).map((cand) => cand.doc.title),
      2,
    );
    if (followUps.length > 0) {
      const second = await retrieve(
        deps.index,
        deps.store,
        request,
        rawPlan,
        followUps,
        deps.embedder,
      );
      const seen = new Set(retrieval.candidates.map((cand) => cand.chunk.id));
      retrieval.candidates.push(...second.candidates.filter((cand) => !seen.has(cand.chunk.id)));
      retrieval.candidates = retrieval.candidates.slice(0, pool);
      log.debug("second retrieval round", { followUps, added: second.candidates.length });
    }
  }

  const candidates = retrieval.candidates.slice(0, pool);
  if (candidates.length === 0) {
    return emptyOutcome(deps.store, traceId, request, started, decisions, policy, rawPlan, planAnswers, retrieval.stats, language);
  }

  // --- 3. rerank ------------------------------------------------------------
  const constraintRequired = planAnswers.userConstraint === true || Boolean(request.time_range);
  const reranked = await rerank(
    decisions,
    policy,
    {
      query: request.query,
      candidates,
      constraintRequired,
      exactPhraseHit: (candidate) => candidate.exactPhraseHit,
      timeHorizon: rawPlan.timeHorizon,
    },
    signal,
  );
  const kept = reranked.filter((r) => r.keep).slice(0, Math.max(c.DEFAULT_CANDIDATES_RERANKED, request.max_results ?? 10) * 2);

  if (kept.length === 0) {
    return emptyOutcome(deps.store, traceId, request, started, decisions, policy, rawPlan, planAnswers, retrieval.stats, language, reranked);
  }

  // --- 4. gate --------------------------------------------------------------
  const evidenceLimit = Math.max(4, (request.max_results ?? c.DEFAULT_MAX_RESULTS) * 2);
  const gated = await gate(decisions, policy, { query: request.query, candidates: kept, limit: evidenceLimit }, signal);
  const maxResults = request.max_results ?? c.DEFAULT_MAX_RESULTS;

  // The domain cap applies to the page the caller receives, and it is not padded
  // past. `max_results` is a ceiling, not a target: if the index only holds two
  // usable passages from one domain, returning two is the truth. Padding the page
  // with the rest of that domain's chunks would present five windows onto one
  // document as five independent sources, which is exactly the failure the cap
  // exists to prevent.
  //
  // The cap is overridable because its right value depends entirely on the index. On
  // a web index, 3 per domain is a sensible guard against one vendor filling the
  // page. On a single-domain index — a documentation site, the most natural thing to
  // index — it silently makes `max_results` unreachable.
  const { kept: diverse } = applyDomainDiversity(
    gated,
    c.MAX_PER_DOMAIN > 0 ? c.MAX_PER_DOMAIN : policy.maxPerDomain,
    policy.minDistinctDomains,
  );
  const finalGated = diverse.filter((g) => g.route !== "exclude");

  // Order the returned page by score. The diversity pass and the gate both reorder
  // for their own reasons, but `score` has to be monotonic or the field is a lie.
  finalGated.sort((a, b) => {
    if (a.route !== b.route) {
      const order: Record<string, number> = { include: 0, conflicting: 1, exclude: 2 };
      return (order[a.route] ?? 3) - (order[b.route] ?? 3);
    }
    return b.composite - a.composite;
  });

  // --- 5. answer ------------------------------------------------------------
  const answerOutput = await answerStage(
    {
      query: request.query,
      plan: { ...rawPlan, language },
      request,
      policy,
      calibrated: decisions.calibrated,
      engineName: decisions.name,
      gated: finalGated,
      evidenceLimit,
      generator,
      decisions,
    },
    signal,
  );

  // --- 6. shape the response ------------------------------------------------
  const results = finalGated.slice(0, maxResults).map((g) => shapeResult(g, request, Boolean(request.include_trace)));

  const searchDepth: SearchDepth =
    planAnswers.searchDepth === "fast" || planAnswers.searchDepth === "advanced"
      ? planAnswers.searchDepth
      : "basic";

  const planEcho: QueryPlanEcho = {
    intent: rawPlan.intent,
    topic: rawPlan.topic,
    answer_shape: rawPlan.answerShape,
    search_depth: searchDepth,
    candidate_pool: pool,
    rounds,
    time_horizon: rawPlan.timeHorizon,
    complexity: rawPlan.complexity,
    ambiguity: round(rawPlan.ambiguity, 3),
    expand_query: rawPlan.expandQuery,
    requires_exact_phrase: rawPlan.requiresExactPhrase,
    engine: decisions.name,
    calibrated: decisions.calibrated,
  };

  const usage = decisions.usage;
  const response: SearchResponse = {
    query: request.query,
    answer: answerOutput.answer,
    abstained: answerOutput.abstained,
    results,
    response_time: round((Date.now() - started) / 1000, 3),
    plan: planEcho,
    ...(request.verify_citations ?? config().VERIFY_CITATIONS
      ? { citations: answerOutput.citations }
      : {}),
    request_id: traceId,
    usage: {
      decision_input_tokens: usage.inputTokens,
      decision_output_tokens: usage.outputTokens,
      decision_requests: usage.requests,
    },
  };

  const trace: SearchTrace = {
    id: traceId,
    query: request.query,
    engine: { name: decisions.name, calibrated: decisions.calibrated },
    policy: { calibration_aware: true },
    plan: { ...rawPlan, language, candidatePool: pool, rounds, searchDepth },
    stages: {
      understand: {
        questions: Object.keys(planAnswers),
        answers: planAnswers as Record<string, number | string>,
      },
      retrieval: retrieval.stats,
      rerank: {
        considered: reranked.length,
        kept: reranked.filter((r) => r.keep).length,
        top: reranked[0]?.composite ?? 0,
      },
      gate: {
        include: finalGated.filter((g) => g.route === "include").length,
        conflicting: finalGated.filter((g) => g.route === "conflicting").length,
        excluded: gated.filter((g) => g.route === "exclude").length,
      },
      answer: {
        abstained: answerOutput.abstained,
        reason: answerOutput.abstainedReason,
        sufficiency: answerOutput.sufficiency,
        verification: answerOutput.verification,
      },
    },
    decisions: decisions.trace,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: usage.costUsd,
      requests: usage.requests,
    },
    latencyMs: Date.now() - started,
    degraded: decisions.degraded,
  };

  if (request.include_trace) (response as { trace?: unknown }).trace = trace;
  deps.store.saveTrace(traceId, { trace, response: redact(response) });
  return { response, trace };
}

function shapeResult(
  gated: import("./gate.js").GatedCandidate,
  request: SearchRequest,
  withDiagnostics: boolean,
): SearchResult {
  const raw =
    request.include_raw_content === false
      ? undefined
      : truncate(gated.chunk.text, request.include_raw_content === "text" ? 20_000 : 6_000);
  return {
    id: gated.chunk.id,
    title: gated.doc.title,
    url: gated.chunk.url,
    content: truncate(gated.chunk.text, 1_500),
    score: round(gated.composite, 4),
    ...(raw !== undefined ? { raw_content: raw } : {}),
    ...(request.include_published_date || gated.doc.publishedDate
      ? { published_date: gated.doc.publishedDate }
      : {}),
    route: gated.route === "exclude" ? "excluded" : gated.route,
    ...(withDiagnostics
      ? {
          diagnostics: {
            rerank: gated.signals,
            lexical: gated.lexical ?? 0,
            dense: gated.dense,
            fused: gated.fused,
            composite: gated.composite,
            gate: gated.gateSignals,
          },
        }
      : {}),
  };
}

function emptyOutcome(
  store: Store,
  traceId: string,
  request: SearchRequest,
  started: number,
  decisions: DecisionService,
  policy: ReturnType<typeof resolvePolicy>,
  plan: QueryPlanLike,
  planAnswers: Record<string, unknown>,
  retrievalStats: Record<string, number>,
  language: string,
  reranked: RerankedCandidate[] = [],
): SearchOutcome {
  const usage = decisions.usage;
  const searchDepth: SearchDepth =
    planAnswers.searchDepth === "fast" || planAnswers.searchDepth === "advanced"
      ? planAnswers.searchDepth
      : "basic";
  const response: SearchResponse = {
    query: request.query,
    answer: null,
    abstained: true,
    results: [],
    response_time: round((Date.now() - started) / 1000, 3),
    plan: {
      intent: plan.intent,
      topic: plan.topic,
      answer_shape: plan.answerShape,
      search_depth: searchDepth,
      candidate_pool: request.candidate_pool ?? 0,
      rounds: 1,
      time_horizon: plan.timeHorizon,
      complexity: plan.complexity,
      ambiguity: round(plan.ambiguity, 3),
      expand_query: plan.expandQuery,
      requires_exact_phrase: plan.requiresExactPhrase,
      engine: decisions.name,
      calibrated: decisions.calibrated,
    },
    request_id: traceId,
    usage: {
      decision_input_tokens: usage.inputTokens,
      decision_output_tokens: usage.outputTokens,
      decision_requests: usage.requests,
    },
  };
  const trace: SearchTrace = {
    id: traceId,
    query: request.query,
    engine: { name: decisions.name, calibrated: decisions.calibrated },
    policy: { calibration_aware: true },
    plan: { ...plan, language, candidatePool: 0, rounds: 1, searchDepth: "fast" },
    stages: {
      understand: { questions: Object.keys(planAnswers), answers: planAnswers as Record<string, number | string> },
      retrieval: retrievalStats,
      rerank: { considered: reranked.length, kept: 0, top: 0 },
      gate: { include: 0, conflicting: 0, excluded: 0 },
      answer: { abstained: true, reason: "no_candidates" },
    },
    decisions: decisions.trace,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cost_usd: usage.costUsd,
      requests: usage.requests,
    },
    latencyMs: Date.now() - started,
    degraded: decisions.degraded,
  };
  void policy;
  if (request.include_trace) (response as { trace?: unknown }).trace = trace;
  store.saveTrace(traceId, { trace, response });
  return { response, trace };
}

function redact(response: SearchResponse): SearchResponse {
  const clone = { ...response };
  delete (clone as { trace?: unknown }).trace;
  return clone;
}

export { stableKey };
