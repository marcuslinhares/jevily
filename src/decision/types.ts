/**
 * Type-safe decision engine: the port every provider implements.
 *
 * Everything the pipeline needs to *judge* something (intent, relevance, quality,
 * injection risk, citation support) goes through this interface, and every answer
 * comes back as a typed value with a probability — never as prose to be parsed.
 *
 * Three question primitives, mirroring the System One model:
 *   - `noul`   -> P(yes) in [0,1]
 *   - `choice` -> selected option + full distribution + confidence
 *   - `score`  -> position on an ordered rubric + distribution + confidence
 */

export type QuestionContent = string | Record<string, unknown> | unknown[];

export interface NoulCriteria {
  true?: QuestionContent;
  false?: QuestionContent;
}

export type Question =
  | { type: "noul"; instructions: QuestionContent; criteria?: NoulCriteria }
  | { type: "choice"; instructions: QuestionContent; criteria: Record<string, QuestionContent | null> }
  | { type: "score"; instructions: QuestionContent; criteria: QuestionContent[] };

/** A request carries a batch of questions, all evaluated against the same state. */
export interface DecisionRequest {
  /** The content under judgment. Plain string, or structured data the instructions can path into. */
  state: unknown;
  /** Batched questions. The engine may evaluate them in parallel in a single call. */
  questions: Record<string, Question>;
  /** Overrides the engine's default model. */
  model?: string;
  signal?: AbortSignal;
  /** Batching + cache hints; advisory. */
  meta?: { stage?: string; [key: string]: unknown };
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
  /** Only present on calibrated engines. */
  confidence?: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost in USD when available, else null. */
  costUsd: number | null;
  requests: number;
}

export interface DecisionResult {
  engine: string;
  model: string;
  answers: Record<string, Answer>;
  usage: DecisionUsage;
  latencyMs: number;
}

export interface DecisionEngine {
  readonly name: string;
  /**
   * True only when probabilities come from a model trained to be calibrated
   * (the native System One endpoint). Uncalibrated engines widen every threshold
   * via {@link DecisionPolicy}, because a self-reported 0.8 is not a real 0.8.
   */
  readonly calibrated: boolean;
  evaluate(request: DecisionRequest): Promise<DecisionResult>;
}

export class DecisionError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DecisionError";
  }
}
