/**
 * Stage 4 — gate the evidence.
 *
 * Between retrieval and generation. Each surviving passage is asked five questions
 * in one call, and code turns the answers into one of three routes:
 *
 *   include  -> goes into the evidence block
 *   conflicting -> goes into a separate block, so the writer can push back
 *   excluded -> never reaches the prompt
 *
 * The injection check is a filter, not a security boundary. The writer's prompt
 * treats every passage as untrusted text regardless of what the check said.
 */

import { config } from "../config.js";
import { mapPool } from "../util/async.js";
import { clamp, round } from "../util/text.js";
import type { DecisionService } from "../decision/service.js";
import { gateQuestions, type Route } from "../decision/questions.js";
import type { Policy } from "./policy.js";
import type { RerankedCandidate } from "./rerank.js";

export interface GatedCandidate extends RerankedCandidate {
  route: Route;
  gateSignals: Record<string, number>;
}

export interface GateInput {
  query: string;
  candidates: RerankedCandidate[];
  /** How many passages can go into the evidence block. */
  limit: number;
}

export async function gate(
  decisions: DecisionService,
  policy: Policy,
  input: GateInput,
  signal?: AbortSignal,
): Promise<GatedCandidate[]> {
  const c = config();
  const questions = gateQuestions();

  const judged = await mapPool(input.candidates, c.DECISION_CONCURRENCY, async (candidate) => {
    const state = {
      query: input.query,
      candidate: {
        title: candidate.doc.title,
        heading: candidate.chunk.headingPath.join(" > "),
        url: candidate.chunk.url,
        text: candidate.chunk.text,
      },
    };
    const answers = await decisions.evaluate("gate", state, questions, signal ? { signal } : {});

    const gateSignals: Record<string, number> = {
      relevant: round(decisions.noul(answers, "relevant"), 4),
      usable_evidence: round(decisions.noul(answers, "usable_evidence"), 4),
      contradicts_premise: round(decisions.noul(answers, "contradicts_premise"), 4),
      prompt_injection: round(decisions.noul(answers, "prompt_injection"), 4),
      advertisement: round(decisions.noul(answers, "advertisement"), 4),
    };
    return { candidate, gateSignals, route: route(gateSignals, policy) };
  });

  const results: GatedCandidate[] = judged
    .filter((j): j is { candidate: RerankedCandidate; gateSignals: Record<string, number>; route: Route } => j !== undefined)
    .map((j) => ({ ...j.candidate, route: j.route, gateSignals: j.gateSignals }));

  // Security first, then conflicts, then relevance. Order matters: a passage that
  // denies the premise usually also states something usable, so it must be tested
  // for conflict *before* the evidence test or it lands in the wrong block.
  const order: Record<Route, number> = { include: 0, conflicting: 1, exclude: 2 };
  results.sort((a, b) => {
    if (order[a.route] !== order[b.route]) return order[a.route] - order[b.route];
    return b.composite - a.composite;
  });

  const included = results.filter((r) => r.route === "include");
  return [...included.slice(0, input.limit), ...results.filter((r) => r.route !== "include")];
}

/** Pure function: five probabilities and the policy in, one route out. */
export function route(signals: Record<string, number>, policy: Policy): Route {
  const t = policy.gate;
  if ((signals.prompt_injection ?? 0) > t.injectionMax) return "exclude";
  if ((signals.advertisement ?? 0) > t.advertisementMax) return "exclude";
  if ((signals.contradicts_premise ?? 0) > t.contradictMin) return "conflicting";
  if ((signals.relevant ?? 0) < t.relevantMin) return "exclude";
  if ((signals.usable_evidence ?? 0) < t.evidenceMin) return "exclude";
  return "include";
}

/**
 * Caps how many results any one domain may contribute, so a single site cannot fill
 * a page with five windows onto the same document.
 *
 * The cap is not relaxed to reach a requested result count. `max_results` is a
 * ceiling, not a target: if the index holds two usable passages from one domain,
 * returning two is the truth. Overflow comes back separately as `deferred` for a
 * caller with a different budget, but the search pipeline ignores it — padding the
 * page with more of the same domain is the failure this prevents.
 */
export function applyDomainDiversity(
  candidates: GatedCandidate[],
  maxPerDomain: number,
  minDistinctDomains: number,
): { kept: GatedCandidate[]; deferred: GatedCandidate[] } {
  const perDomain = new Map<string, number>();
  const kept: GatedCandidate[] = [];
  const deferred: GatedCandidate[] = [];
  // Relax the cap only if diversity would otherwise be impossible.
  const effectiveCap = Math.max(maxPerDomain, minDistinctDomains > 1 ? 2 : 1);

  for (const candidate of candidates) {
    const domain = candidate.doc.domain;
    const used = perDomain.get(domain) ?? 0;
    if (used >= effectiveCap) {
      deferred.push(candidate);
      continue;
    }
    perDomain.set(domain, used + 1);
    kept.push(candidate);
  }
  return { kept, deferred };
}

export function evidenceScore(candidates: GatedCandidate[]): number {
  if (candidates.length === 0) return 0;
  const top = Math.max(...candidates.map((c) => c.composite));
  const depth = clamp(candidates.length / 4, 0, 1);
  return round(clamp(top * 0.7 + depth * 0.3, 0, 1), 4);
}
