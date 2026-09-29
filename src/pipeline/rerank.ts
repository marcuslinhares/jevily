/**
 * Stage 3 — re-rank.
 *
 * BM25 recall is a bag of words; this stage is the reason a passage that answers
 * the question outranks one that merely repeats its vocabulary. One decision call
 * per candidate, asking six atomic questions at once and combining them in code.
 *
 * Six questions in one call is not six times the cost of one: questions are
 * evaluated in parallel against the same state, so a 24-candidate rerank is 24
 * calls regardless of how many questions each one carries.
 */

import { config } from "../config.js";
import { mapPool } from "../util/async.js";
import { log } from "../util/log.js";
import { clamp, round } from "../util/text.js";
import type { DecisionService } from "../decision/service.js";
import { rerankQuestions } from "../decision/questions.js";
import { constraintPenalty, type Policy, type RerankThresholds } from "./policy.js";
import type { Candidate } from "./retrieve.js";

export interface RerankInput {
  query: string;
  candidates: Candidate[];
  /** The user pinned a constraint, so failing it is close to disqualifying. */
  constraintRequired: boolean;
  /** Hard phrase from the query, used as a tie-breaker. */
  exactPhraseHit: (candidate: Candidate) => boolean;
}

export interface RerankedCandidate extends Candidate {
  composite: number;
  signals: Record<string, number>;
  keep: boolean;
  reasons: string[];
}

export async function rerank(
  decisions: DecisionService,
  policy: Policy,
  input: RerankInput,
  signal?: AbortSignal,
): Promise<RerankedCandidate[]> {
  const c = config();
  const shortlist = input.candidates.slice(0, Math.max(10, c.DEFAULT_CANDIDATES_RERANKED));
  const questions = rerankQuestions();

  const scored = await mapPool(shortlist, c.DECISION_CONCURRENCY, async (candidate) =>
    scoreOne(decisions, input, candidate, questions, policy.rerank, signal),
  );

  const results: RerankedCandidate[] = [];
  for (const item of scored) {
    if (!item) continue;
    const reasons = [...item.reasons];
    if (input.exactPhraseHit(item.candidate)) reasons.push("exact phrase match");
    if (item.candidate.lexical !== null && item.candidate.dense !== null) {
      reasons.push("both channels agree");
    }
    const adjusted = clamp(item.composite - constraintPenalty(item.constraintFailed, policy), 0, 1);
    results.push({
      ...item.candidate,
      composite: round(adjusted, 4),
      signals: item.signals,
      keep: adjusted >= policy.rerank.keepAbove,
      reasons,
    });
  }

  results.sort((a, b) => {
    if (b.composite !== a.composite) return b.composite - a.composite;
    if (a.channels !== b.channels) return b.channels - a.channels;
    return (b.fused ?? 0) - (a.fused ?? 0);
  });

  log.debug("rerank done", {
    candidates: results.length,
    kept: results.filter((r) => r.keep).length,
    top: results[0]?.composite,
  });
  return results;
}

interface ScoredItem {
  candidate: Candidate;
  composite: number;
  signals: Record<string, number>;
  reasons: string[];
  constraintFailed: boolean;
}

async function scoreOne(
  decisions: DecisionService,
  input: RerankInput,
  candidate: Candidate,
  questions: ReturnType<typeof rerankQuestions>,
  policy: RerankThresholds,
  signal?: AbortSignal,
): Promise<ScoredItem> {
  const state = {
    query: input.query,
    candidate: {
      title: candidate.doc.title,
      heading: candidate.chunk.headingPath.join(" > "),
      url: candidate.chunk.url,
      text: candidate.chunk.text,
      published_date: candidate.doc.publishedDate,
    },
  };

  const answers = await decisions.evaluate("rerank", state, questions, signal ? { signal } : {});

  const signals: Record<string, number> = {
    relevance: round(decisions.noul(answers, "relevance"), 4),
    directness: round(decisions.noul(answers, "directness"), 4),
    authority: round(decisions.noul(answers, "authority"), 4),
    quality: round(decisions.noul(answers, "quality"), 4),
    recency: round(decisions.expectedLevel(answers, "recency", 3) / 2, 4),
    constraint: round(decisions.noul(answers, "constraint_match"), 4),
    lexical: candidate.lexical === null ? 0 : round(candidate.lexical, 4),
    dense: candidate.dense === null ? 0 : round(candidate.dense, 4),
    fused: round(candidate.fused, 6),
  };

  const reasons: string[] = [];
  if ((signals.relevance ?? 0) < 0.4) reasons.push("low relevance");
  if ((signals.authority ?? 0) < 0.3) reasons.push("not authoritative");
  if ((signals.quality ?? 0) < 0.35) reasons.push("low quality");
  if ((signals.constraint ?? 0) < 0.4) reasons.push("constraint unmatched");

  return {
    candidate,
    composite: compositeOf(signals, policy),
    signals,
    reasons,
    constraintFailed: input.constraintRequired && (signals.constraint ?? 0) < 0.5,
  };
}

/**
 * Composite scoring: the weights live in code so a policy change is a number, and
 * a regression in ranking is measurable rather than a vibe.
 */
function compositeOf(signals: Record<string, number>, policy: RerankThresholds): number {
  const w = policy.weights;
  let total = 0;
  total += (signals.relevance ?? 0) * w.relevance;
  total += (signals.authority ?? 0) * w.authority;
  total += (signals.quality ?? 0) * w.quality;
  total += (signals.directness ?? 0) * w.directness;
  total += (signals.recency ?? 0) * w.recency;
  total += (signals.constraint ?? 0) * w.constraint;
  // Lexical agreement is a floor, not a reward: a passage nobody retrieved is suspect.
  if ((signals.lexical ?? 0) === 0) total -= 0.08;
  return clamp(total, 0, 1);
}
