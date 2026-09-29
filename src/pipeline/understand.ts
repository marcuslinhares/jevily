/**
 * Stage 1 — understand the query.
 *
 * One batched decision call, made before a single document is fetched. It decides
 * how to search: the topic channel, how deep to go, how many candidates to pull,
 * whether to expand, whether a second round is worth it, and whether the user's
 * wording pins a hard constraint.
 *
 * Everything downstream reads this plan. When the caller sets `auto_parameters`,
 * this replaces guessing from the query string; when they do not, this only fills
 * in what they left unset.
 */

import type { DecisionService } from "../decision/service.js";
import {
  COMPLEXITY_LEVELS,
  EXPANSION_STRATEGY,
  TIME_HORIZON_LEVELS,
  queryUnderstandingQuestions,
  type QueryPlan,
} from "../decision/questions.js";
import type { SearchDepth, Topic } from "../domain/types.js";
import { extractQuotedPhrases } from "../retrieval/tokenize.js";
import { clamp } from "../util/text.js";
import type { QueryPlanLike } from "./expand.js";

const DEPTH_BY_COMPLEXITY: Record<number, SearchDepth> = {
  0: "fast",
  1: "basic",
  2: "advanced",
};

const POOL_BY_DEPTH: Record<SearchDepth, number> = {
  fast: 24,
  basic: 60,
  advanced: 110,
};

const TOPIC_MAP: Record<string, Topic> = {
  general: "general",
  news: "news",
  finance: "finance",
  technology: "general",
  code: "general",
  academic: "general",
  medical_legal: "general",
};

export interface UnderstandInput {
  query: string;
  language: string;
  requestedDepth?: SearchDepth;
  requestedTopic?: Topic;
  requestedPool?: number;
  maxRounds?: number;
  autoParameters: boolean;
  hasConstraintFilter: boolean;
}

export async function understandQuery(
  decisions: DecisionService,
  input: UnderstandInput,
  signal?: AbortSignal,
): Promise<{ plan: QueryPlanLike; answers: Record<string, unknown> }> {
  const questions = queryUnderstandingQuestions();
  const state = { query: input.query, language: input.language };
  const answers = await decisions.evaluate("understand", state, questions, signal ? { signal } : {});

  const complexity = decisions.expectedLevel(answers, "complexity", COMPLEXITY_LEVELS.length);
  const timeHorizon = decisions.expectedLevel(answers, "time_horizon", TIME_HORIZON_LEVELS.length);
  const synthesisNeed = decisions.noul(answers, "synthesis_need");
  const ambiguity = decisions.noul(answers, "ambiguity");
  const requiresExactPhrase =
    decisions.noul(answers, "requires_exact_phrase") > 0.5 || extractQuotedPhrases(input.query).length > 0;
  const expansionChoice = decisions.choice(answers, "expansion_strategy", "none").choice;
  const multiRoundNoul = decisions.noul(answers, "multi_round");
  const userConstraint = decisions.noul(answers, "user_supplied_constraints");

  const complexityLevel = Math.round(clamp(complexity, 0, COMPLEXITY_LEVELS.length - 1));
  const plannedDepth = DEPTH_BY_COMPLEXITY[complexityLevel] ?? "basic";

  // Callers always win over the plan; auto_parameters just decides the rest.
  const searchDepth = input.autoParameters
    ? plannedDepth
    : strongest(input.requestedDepth, plannedDepth);

  const pool = input.requestedPool ?? POOL_BY_DEPTH[searchDepth];
  const ambiguityPenalty = ambiguity > 0.6 ? 1.4 : 1;
  const candidatePool = Math.round(pool * ambiguityPenalty);

  const expandQuery = expansionChoice !== "none";
  const expansionStrategy = (Object.keys(EXPANSION_STRATEGY) as (keyof typeof EXPANSION_STRATEGY)[]).includes(
    expansionChoice as keyof typeof EXPANSION_STRATEGY,
  )
    ? (expansionChoice as QueryPlan["expansionStrategy"])
    : "none";

  const wantsSecondRound =
    multiRoundNoul > 0.55 || expansionStrategy === "decomposition" || timeHorizon >= 2.5;
  const rounds = input.maxRounds !== undefined ? input.maxRounds : wantsSecondRound ? 2 : 1;

  const topicRaw = decisions.choice(answers, "topic", "general").choice;
  const topic = input.requestedTopic ?? TOPIC_MAP[topicRaw] ?? "general";

  const plan: QueryPlanLike = {
    language: input.language,
    intent: decisions.choice(answers, "intent", "factual_lookup").choice as QueryPlan["intent"],
    topic,
    answerShape: decisions
      .choice(answers, "answer_shape", "short_paragraph")
      .choice as QueryPlan["answerShape"],
    synthesisNeed,
    timeHorizon: Math.round(clamp(timeHorizon, 0, TIME_HORIZON_LEVELS.length - 1)),
    complexity: complexityLevel,
    ambiguity,
    requiresExactPhrase,
    expandQuery,
    expansionStrategy,
    multiRound: rounds > 1,
  };

  return {
    plan,
    answers: {
      intent: plan.intent,
      topic: topicRaw,
      answerShape: plan.answerShape,
      timeHorizon: plan.timeHorizon,
      complexity: plan.complexity,
      ambiguity: plan.ambiguity,
      requiresExactPhrase: plan.requiresExactPhrase,
      expansionStrategy: plan.expansionStrategy,
      candidatePool,
      rounds,
      searchDepth,
      userConstraint: userConstraint > 0.5 || input.hasConstraintFilter,
    },
  };
}

const DEPTH_ORDER: Record<SearchDepth, number> = { fast: 0, basic: 1, advanced: 2 };
function strongest(a: SearchDepth | undefined, b: SearchDepth): SearchDepth {
  if (!a) return b;
  return DEPTH_ORDER[a] >= DEPTH_ORDER[b] ? a : b;
}
