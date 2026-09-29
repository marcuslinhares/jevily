/**
 * Request-scoped facade over a {@link DecisionEngine}.
 *
 * Adds three things the raw engine should not care about:
 *   - **Accessors that never throw.** A missing or malformed answer degrades to a
 *     safe default (noul -> 0.5, choice -> first option, score -> mid-rubric). The
 *     pipeline keeps running and the trace records the degradation.
 *   - **Usage accounting** rolled up across every judgment made for one API request.
 *   - **Caching**, so re-running a search with the same passages costs nothing.
 */

import { config } from "../config.js";
import { log } from "../util/log.js";
import { TtlCache } from "../util/async.js";
import { stableKey } from "../util/hash.js";
import { createEngine } from "./index.js";
import type { Answer, ChoiceAnswer, DecisionEngine, DecisionRequest, DecisionUsage, Question, ScoreAnswer } from "./types.js";

export interface DecisionTraceEntry {
  stage: string;
  engine: string;
  model: string;
  questions: string[];
  latencyMs: number;
  usage: DecisionUsage;
  /** Cached or freshly computed. */
  cached: boolean;
  /** Set when the engine's answer was missing or unusable. */
  degraded?: string[];
}

const EMPTY_USAGE: DecisionUsage = { inputTokens: 0, outputTokens: 0, costUsd: null, requests: 0 };

export class DecisionService {
  private totals: DecisionUsage = { ...EMPTY_USAGE };
  private entries: DecisionTraceEntry[] = [];
  private degradedCount = 0;

  constructor(
    private readonly engine: DecisionEngine,
    private readonly cache: TtlCache<Record<string, Answer>> | null = null,
  ) {}

  get name(): string {
    return this.engine.name;
  }

  get calibrated(): boolean {
    return this.engine.calibrated;
  }

  /** Total spend and calls for everything judged in this request. */
  get usage(): DecisionUsage {
    return { ...this.totals };
  }

  get trace(): DecisionTraceEntry[] {
    return this.entries;
  }

  get degraded(): number {
    return this.degradedCount;
  }

  /**
   * Evaluates a batch of questions against one state. Results are cached on the
   * stable serialization of (state, questions, model), so callers can be greedy
   * about asking speculative questions at close to zero marginal cost.
   */
  async evaluate(
    stage: string,
    state: unknown,
    questions: Record<string, Question>,
    options: { model?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, Answer>> {
    const ids = Object.keys(questions);
    if (ids.length === 0) return {};

    const key = stableKey({ state, questions, model: options.model ?? null });
    const cached = this.cache?.get(key);
    if (cached) {
      this.entries.push({
        stage,
        engine: this.engine.name,
        model: options.model ?? "default",
        questions: ids,
        latencyMs: 0,
        usage: { ...EMPTY_USAGE, requests: 0 },
        cached: true,
      });
      return cached;
    }

    const request: DecisionRequest = {
      state,
      questions,
      ...(options.model ? { model: options.model } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      meta: { stage },
    };

    try {
      const result = await this.engine.evaluate(request);
      this.addUsage(result.usage);
      this.entries.push({
        stage,
        engine: result.engine,
        model: result.model,
        questions: ids,
        latencyMs: result.latencyMs,
        usage: result.usage,
        cached: false,
      });
      this.cache?.set(key, result.answers);
      return result.answers;
    } catch (err) {
      log.error("decision batch failed, degrading to defaults", { stage, err: String(err) });
      this.entries.push({
        stage,
        engine: this.engine.name,
        model: options.model ?? "default",
        questions: ids,
        latencyMs: 0,
        usage: { ...EMPTY_USAGE, requests: 1 },
        cached: false,
        degraded: ids.map((id) => `${id}: engine error`),
      });
      this.degradedCount += ids.length;
      return defaults(questions);
    }
  }

  // --- accessors -----------------------------------------------------------

  /** P(yes), defaulting to a neutral 0.5 when the answer is unusable. */
  noul(answers: Record<string, Answer>, id: string): number {
    const answer = answers[id];
    if (!answer || answer.type !== "noul" || !Number.isFinite(answer.noul)) {
      this.markDegraded(id);
      return 0.5;
    }
    return answer.noul;
  }

  choice(answers: Record<string, Answer>, id: string, fallback = ""): ChoiceAnswer {
    const answer = answers[id];
    if (!answer || answer.type !== "choice") {
      this.markDegraded(id);
      return { type: "choice", choice: fallback, probabilities: {}, confidence: 0 };
    }
    return answer;
  }

  score(answers: Record<string, Answer>, id: string, fallback = 0): ScoreAnswer {
    const answer = answers[id];
    if (!answer || answer.type !== "score" || !Number.isFinite(answer.score)) {
      this.markDegraded(id);
      return {
        type: "score",
        score: fallback,
        legend: {},
        probabilities: {},
        confidence: 0,
      };
    }
    return answer;
  }

  /**
   * Expected value of a score answer: a probability-weighted position on the
   * rubric. Survives partial distributions better than reading `.score`.
   */
  expectedLevel(answers: Record<string, Answer>, id: string, levels: number): number {
    const answer = answers[id];
    if (!answer) {
      this.markDegraded(id);
      return 0;
    }
    if (answer.type === "score") {
      const expected = Object.entries(answer.probabilities).reduce(
        (acc, [index, p]) => acc + Number(index) * p,
        0,
      );
      return expected || answer.score;
    }
    if (answer.type === "choice") {
      const index = Object.keys(answer.probabilities).indexOf(answer.choice);
      return index >= 0 ? index : 0;
    }
    return answer.noul;
  }

  private markDegraded(id: string): void {
    this.degradedCount++;
    const last = this.entries[this.entries.length - 1];
    if (last) (last.degraded ??= []).push(id);
  }

  private addUsage(usage: DecisionUsage): void {
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    this.totals.requests += usage.requests;
    if (usage.costUsd !== null) this.totals.costUsd = (this.totals.costUsd ?? 0) + usage.costUsd;
  }
}

function defaults(questions: Record<string, Question>): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") out[id] = { type: "noul", noul: 0.5 };
    else if (question.type === "choice") {
      const first = Object.keys(question.criteria)[0] ?? "";
      out[id] = { type: "choice", choice: first, probabilities: {}, confidence: 0 };
    } else {
      out[id] = {
        type: "score",
        score: 0,
        legend: {},
        probabilities: {},
        confidence: 0,
      };
    }
  }
  return out;
}

// --- engine factory ---------------------------------------------------------

let shared: DecisionService | null = null;
let sharedCache: TtlCache<Record<string, Answer>> | null = null;

export function createDecisionService(engine: DecisionEngine): DecisionService {
  if (config().DECISION_CACHE) {
    sharedCache ??= new TtlCache<Record<string, Answer>>(
      config().DECISION_CACHE_TTL_S * 1000,
      50_000,
    );
    return new DecisionService(engine, sharedCache);
  }
  return new DecisionService(engine, null);
}

/** Process-wide service. The cache is shared, the usage counters are not. */
export function decision(): DecisionService {
  const engine = defaultEngine();
  shared ??= createDecisionService(engine);
  return new DecisionService(engine, sharedCache);
}

let engineInstance: DecisionEngine | null = null;
function defaultEngine(): DecisionEngine {
  // The factory already handles every branch, including the keyless fallbacks.
  engineInstance ??= createEngine();
  return engineInstance;
}

export function setDecisionEngine(engine: DecisionEngine): void {
  engineInstance = engine;
  shared = null;
}

export function decisionCacheSize(): number {
  return sharedCache?.size ?? 0;
}
