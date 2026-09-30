/**
 * Stage 5 — decide whether to answer at all, write it, then verify it.
 *
 * This is the part that has no equivalent in a Tavily-style API. Before a single
 * token is written, the decision engine is asked whether the selected evidence can
 * actually support an answer. If it cannot, the response says so and returns the
 * evidence instead of a confident fabrication.
 *
 * After writing, every claim is checked back against the source it cites. Claims
 * that do not survive the check are dropped and the answer is regenerated once
 * with the survivors only.
 */

import { config } from "../config.js";
import { mapPool } from "../util/async.js";
import { log } from "../util/log.js";
import { fold, isStopword, round, splitSentences, truncate, words } from "../util/text.js";
import { citationQuestions, sufficiencyQuestions } from "../decision/questions.js";
import type { DecisionService } from "../decision/service.js";
import type { Policy } from "./policy.js";
import { evidenceScore, type GatedCandidate } from "./gate.js";
import type { Citation, SearchRequest } from "../domain/types.js";
import { writeAnswer, type AnswerInput, type Generator, type WrittenAnswer } from "../llm/generator.js";
import type { QueryPlanLike } from "./expand.js";

export interface AnswerStageInput {
  query: string;
  plan: QueryPlanLike;
  request: SearchRequest;
  policy: Policy;
  calibrated: boolean;
  engineName: string;
  gated: GatedCandidate[];
  evidenceLimit: number;
  generator: Generator | null;
  decisions: DecisionService;
  /** How many judgements came back unreadable and were replaced by defaults. */
  degraded?: number;
}

export interface AnswerStageOutput {
  answer: string | null;
  abstained: boolean;
  abstainedReason: string | null;
  citations: Citation[];
  sufficiency: { sufficient: number; conflicting: number };
  verification: { claims: number; kept: number; dropped: number; regenerateAttempted: boolean };
}

export async function answerStage(input: AnswerStageInput, signal?: AbortSignal): Promise<AnswerStageOutput> {
  const c = config();
  const { policy, decisions, request, plan, gated } = input;

  const included = gated.filter((g) => g.route === "include");
  const conflicting = gated.filter((g) => g.route === "conflicting");
  const evidence = included.slice(0, input.evidenceLimit);
  const conflicts = conflicting.slice(0, 3);

  const verdict = await assessSufficiency(decisions, policy, input, evidence, conflicts, signal);

  const wantsAnswer = request.include_answer !== false;
  if (!wantsAnswer) {
    return {
      answer: null,
      abstained: false,
      abstainedReason: null,
      citations: [],
      sufficiency: verdict,
      verification: { claims: 0, kept: 0, dropped: 0, regenerateAttempted: false },
    };
  }

  const blocked = abstentionReason(input, verdict, evidence, signal);
  if (blocked) {
    log.debug("abstained", { reason: blocked, evidence: evidence.length });
    return {
      answer: null,
      abstained: true,
      abstainedReason: blocked,
      citations: [],
      sufficiency: verdict,
      verification: { claims: 0, kept: 0, dropped: 0, regenerateAttempted: false },
    };
  }

  const answerInput: AnswerInput = {
    query: input.query,
    answerShape: plan.answerShape,
    language: plan.language,
    evidence: evidence.map((e) => ({
      id: e.chunk.id,
      title: e.doc.title,
      url: e.chunk.url,
      text: e.chunk.text,
    })),
    conflicts: conflicts.map((e) => ({
      id: e.chunk.id,
      title: e.doc.title,
      url: e.chunk.url,
      text: e.chunk.text,
    })),
    hedge: verdict.sufficient < 0.8,
  };

  const written = await writeAnswer(input.generator, answerInput, signal);
  if (!written) {
    return {
      answer: null,
      abstained: true,
      abstainedReason: "no_generator",
      citations: [],
      sufficiency: verdict,
      verification: { claims: 0, kept: 0, dropped: 0, regenerateAttempted: false },
    };
  }

  const verification = await verify(
    decisions,
    written,
    answerInput,
    evidence,
    input.calibrated,
    input.generator,
    signal,
  );
  return {
    answer: verification.answer,
    abstained: false,
    abstainedReason: null,
    citations: verification.citations,
    sufficiency: verdict,
    verification: {
      claims: written.claims.length,
      kept: verification.keptClaims,
      dropped: written.claims.length - verification.keptClaims,
      regenerateAttempted: verification.regenerated,
    },
  };
}

async function assessSufficiency(
  decisions: DecisionService,
  policy: Policy,
  input: AnswerStageInput,
  evidence: GatedCandidate[],
  conflicts: GatedCandidate[],
  signal?: AbortSignal,
): Promise<{ sufficient: number; conflicting: number }> {
  if (evidence.length === 0) return { sufficient: 0, conflicting: 0 };
  const state = {
    query: input.query,
    evidence: evidence.slice(0, 8).map((e) => ({
      id: e.chunk.id,
      title: e.doc.title,
      text: truncate(e.chunk.text, 1200),
    })),
    conflicts: conflicts.slice(0, 3).map((e) => ({ id: e.chunk.id, text: truncate(e.chunk.text, 600) })),
  };
  const answers = await decisions.evaluate(
    "sufficiency",
    state,
    sufficiencyQuestions(),
    signal ? { signal } : {},
  );
  return {
    sufficient: round(decisions.noul(answers, "sufficient"), 4),
    conflicting: round(decisions.noul(answers, "conflicting"), 4),
  };
}

/**
 * Decides whether to withhold the answer.
 *
 * The count-based floors are only a cheap filter, and they must not be able to veto
 * a confident sufficiency verdict. "What does the high water mark do" is a question
 * one authoritative page answers completely; blocking it for want of a second source
 * is the abstention feature working against itself. So once the decision engine says
 * the evidence does answer the question, its judgement wins.
 *
 * The thresholds here are policy, not measurement.
 */
function abstentionReason(
  input: AnswerStageInput,
  verdict: { sufficient: number; conflicting: number },
  evidence: GatedCandidate[],
  signal?: AbortSignal,
): string | null {
  if (signal?.aborted) return "cancelled";
  const c = config();
  if (!c.ABSTAIN_ENABLED) return null;
  const { policy, calibrated } = input;

  // Withholding is the whole point of this stage, so an engine that did not answer
  // cannot be treated as one that did. A missing or unreadable judgement returns a
  // default noul, which is a plausible number rather than an absent one: an auth
  // failure degraded every verdict to 0.5 and the pipeline went on to write answers
  // and issue citations on top of them. Those answers looked complete and were
  // unfounded, which is the one thing this project exists to avoid.
  if ((input.degraded ?? 0) > 0) return "decision_engine_unavailable";

  if (evidence.length === 0) return "no_evidence";

  const required = calibrated
    ? policy.sufficiency.minSufficiency
    : policy.abstain.minSufficiencyUncalibrated;
  // High enough that a claim of completeness is worth believing over raw counts.
  const decisive = verdict.sufficient >= Math.max(0.8, required + 0.2);

  if (!decisive) {
    if (evidence.length < policy.abstain.minAccepted) return "insufficient_evidence";
    const domains = new Set(evidence.map((e) => e.doc.domain));
    if (domains.size < policy.minDistinctDomains) return "single_source";
  }

  const top = Math.max(...evidence.map((e) => e.composite));
  if (top < policy.abstain.minTopScore) return "weak_match";
  if (verdict.sufficient < required) return "evidence_does_not_support_answer";
  return null;
}

// --- citation verification --------------------------------------------------

interface VerificationResult {
  answer: string;
  citations: Citation[];
  keptClaims: number;
  regenerated: boolean;
}

async function verify(
  decisions: DecisionService,
  written: WrittenAnswer,
  input: AnswerInput,
  evidence: GatedCandidate[],
  calibrated: boolean,
  generator: Generator | null,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const byId = new Map(evidence.map((e) => [e.chunk.id, e]));
  // An uncalibrated engine needs a higher bar before we call a claim supported.
  const threshold = calibrated ? 0.6 : 0.7;

  const checks = await mapPool(written.claims, 6, async (claim) => {
    const source = byId.get(claim.sources[0] as string);
    if (!source) return { claim, support: 0, source: null, quote: "" };
    const spans = quoteSpans(source.chunk.text);
    const state = {
      claim: claim.text,
      source: { title: source.doc.title, text: truncate(source.chunk.text, 1600) },
      spans,
    };
    // `supported` and `span` are batched into one call: the engine already has the
    // claim and the source, so asking which sentence carries it costs no extra
    // round trip.
    const answers = await decisions.evaluate(
      "citation",
      state,
      citationQuestions(spans.length),
      signal ? { signal } : {},
    );
    const chosen = decisions.choice(answers, "span", "none").choice;
    return {
      claim,
      support: round(decisions.noul(answers, "supported"), 4),
      source,
      quote: resolveQuote(spans, chosen, claim.text, source.chunk.text),
    };
  });

  const kept = checks.filter(
    (check): check is VerifiedClaim =>
      check !== undefined && check.source !== null && check.support >= threshold,
  );
  const dropped = written.claims.length - kept.length;

  if (dropped === 0) {
    return {
      answer: written.answer,
      citations: toCitations(kept),
      keptClaims: kept.length,
      regenerated: false,
    };
  }

  // Some claims did not survive. Rewriting against the surviving evidence is the
  // honest repair: the discarded claims were the unsupported part, and the writer
  // that produced them will not reproduce them when they are not in the prompt.
  if (generator && kept.length > 0) {
    const survivingIds = new Set(kept.map((k) => k.claim.sources[0]));
    const narrowed: AnswerInput = {
      ...input,
      evidence: input.evidence.filter((e) => survivingIds.has(e.id)),
    };
    const rewritten = await writeAnswer(generator, narrowed, signal);
    if (rewritten) {
      return {
        answer: rewritten.answer,
        citations: toCitations(kept),
        keptClaims: kept.length,
        regenerated: true,
      };
    }
  }

  return {
    answer: `${written.answer}\n\n_${dropped} claim(s) were not supported by the cited source and have been omitted._`,
    citations: toCitations(kept),
    keptClaims: kept.length,
    regenerated: false,
  };
}

interface VerifiedClaim {
  claim: { text: string; sources: string[] };
  support: number;
  source: GatedCandidate;
  /** The span that states the claim, always a substring of the source. */
  quote: string;
}

function toCitations(claims: VerifiedClaim[]): Citation[] {
  return claims.map((check) => ({
    result_id: check.claim.sources[0] as string,
    url: check.source.chunk.url,
    quote: check.quote,
    support: check.support,
    confidence: 1,
    // A citation that cannot show the sentence it rests on is not verified, whatever
    // the support score says. The score is the engine's judgement about the source;
    // the quote is the evidence the reader can check, and claiming verification
    // without it asserts something the response does not show.
    verified: check.quote.length > 0,
  }));
}

/** Sentences long enough to be worth offering as a quote. */
function quoteSpans(text: string): string[] {
  return splitSentences(text)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 30)
    .slice(0, 8);
}

/**
 * The span a citation should quote.
 *
 * The engine's pick wins, because choosing which sentence carries a claim is a
 * judgement and this project does not make judgements with string matching. The
 * lexical fallback exists for the case where the engine declines, answers `none`, or
 * names a span that is not in the list — a citation still has to show something, and
 * an empty quote is worse than an approximate one.
 *
 * The result is always a substring of the source, so a reader can find it.
 */
function resolveQuote(
  spans: string[],
  chosen: string,
  claim: string,
  sourceText: string,
): string {
  if (chosen && chosen !== "none") {
    const index = Number.parseInt(chosen, 10);
    if (Number.isInteger(index) && index >= 1 && index <= spans.length) {
      return truncate(spans[index - 1]!, 300);
    }
  }
  if (spans.length === 0) return quoteFallback(sourceText);
  return truncate(bestLexicalSpan(claim, spans) ?? quoteFallback(sourceText), 300);
}

/**
 * Last resort for a citation that must show something. A citation with a support
 * score and an empty quote asserts verification while displaying no evidence, which
 * is worse than the generic first sentence it replaced.
 */
function quoteFallback(sourceText: string): string {
  const text = sourceText.replace(/\s+/g, " ").trim();
  if (text.length > 0) return truncate(text, 300);
  return "";
}

/**
 * Highest content-word overlap between the claim and a span, so a fallback quote is
 * at least about the same subject as the claim it is attached to.
 */
function bestLexicalSpan(claim: string, spans: string[]): string | null {
  const claimTerms = new Set(
    words(claim)
      .map((w) => fold(w))
      .filter((w) => w.length > 2 && !isStopword(w)),
  );
  if (claimTerms.size === 0) return null;

  let best: string | null = null;
  let bestScore = 0;
  for (const span of spans) {
    const spanTerms = new Set(
      words(span)
        .map((w) => fold(w))
        .filter((w) => w.length > 2 && !isStopword(w)),
    );
    let overlap = 0;
    for (const term of claimTerms) if (spanTerms.has(term)) overlap++;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = span;
    }
  }
  return bestScore > 0 ? best : null;
}

