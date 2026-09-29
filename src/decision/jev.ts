/**
 * The System One client: POST {baseUrl}/v1/systemone.
 *
 * This is the calibrated path. Every answer is a distribution over options we
 * defined, and `confidence` is meaningful, so thresholds in the pipeline are
 * defensible numbers rather than vibes.
 *
 * Two providers speak this protocol with the same request and response shape:
 *
 *   TypeSafe    https://api.typesafe.ai/v1/systemone
 *   OpenRouter  https://openrouter.ai/api/v1/systemone
 *
 * OpenRouter's is reached with an OpenRouter key and a `typesafe/…` model id, and
 * it reports real cost in `usage.cost` rather than making us estimate it. Both are
 * the same model from the same provider, so both are calibrated.
 */

import { config } from "../config.js";
import { log } from "../util/log.js";
import { sleep } from "../util/async.js";
import {
  DecisionError,
  type Answer,
  type DecisionEngine,
  type DecisionRequest,
  type DecisionResult,
  type Question,
} from "./types.js";

const PATH = "/v1/systemone";

/** Last-resort price when a provider reports no cost. TypeSafe's published rate. */
const FALLBACK_PRICE_PER_MTOK = 0.042;

interface RawResponse {
  id?: string;
  model?: string;
  provider?: string;
  answers?: Record<string, Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

export class SystemOneEngine implements DecisionEngine {
  readonly calibrated = true;
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = config().DECISION_BASE_URL,
    private readonly defaultModel: string = config().DECISION_MODEL,
  ) {
    this.name = hostLabel(baseUrl);
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const model = request.model ?? this.defaultModel;
    const body = { state: request.state, model, questions: request.questions };
    const started = Date.now();
    const { payload, attempts } = await this.post(body, request.signal);

    const answers: Record<string, Answer> = {};
    for (const [id, raw] of Object.entries(payload.answers ?? {})) {
      answers[id] = normalizeAnswer(raw);
    }

    const inputTokens = payload.usage?.input_tokens ?? 0;
    return {
      engine: this.name,
      model: payload.model ?? model,
      answers,
      usage: {
        inputTokens,
        outputTokens: payload.usage?.output_tokens ?? 0,
        // Prefer the provider's own figure. A real invoice beats an estimate.
        costUsd: payload.usage?.cost ?? (inputTokens / 1_000_000) * FALLBACK_PRICE_PER_MTOK,
        requests: attempts,
      },
      latencyMs: Date.now() - started,
    };
  }

  private async post(body: unknown, signal: AbortSignal | undefined): Promise<{ payload: RawResponse; attempts: number }> {
    const maxRetries = config().DECISION_MAX_RETRIES;
    const timeoutMs = config().DECISION_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status === 429 || res.status === 529 || res.status >= 500) {
          throw new DecisionError(`systemone ${res.status}`, await safeText(res));
        }
        if (!res.ok) {
          throw new DecisionError(`systemone ${res.status}: ${(await safeText(res)).slice(0, 300)}`);
        }
        return { payload: (await res.json()) as RawResponse, attempts: attempt };
      } catch (err) {
        lastError = err;
        // 402 and 401 are the operator's problem, not a transient blip; retrying
        // them just burns the budget before failing the same way.
        const retryable =
          err instanceof DecisionError &&
          !/systemone (400|401|402|403|404|422)/.test(err.message);
        if (!retryable || attempt === maxRetries) break;
        const wait = Math.min(4_000, 250 * 2 ** (attempt - 1));
        log.warn("systemone retry", { attempt, wait, err: String(err) });
        await sleep(wait, signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    // The reason belongs in the message, not only in `cause`: an operator reading a
    // log needs to see "401" without having to walk the error chain.
    throw new DecisionError(`systemone request failed: ${describe(lastError)}`, lastError);
  }
}

function describe(err: unknown): string {
  if (err instanceof DecisionError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Kept as an alias so existing imports keep working. */
export const JevEngine = SystemOneEngine;

function normalizeAnswer(raw: Record<string, unknown>): Answer {
  const type = String(raw.type ?? "noul");
  if (type === "choice") {
    return {
      type: "choice",
      choice: String(raw.choice ?? ""),
      probabilities: (raw.probabilities as Record<string, number>) ?? {},
      confidence: Number(raw.confidence ?? 0),
    };
  }
  if (type === "score") {
    return {
      type: "score",
      score: Number(raw.score ?? 0),
      legend: (raw.legend as Record<string, string>) ?? {},
      probabilities: (raw.probabilities as Record<string, number>) ?? {},
      confidence: Number(raw.confidence ?? 0),
    };
  }
  return { type: "noul", noul: Number(raw.noul ?? 0) };
}

function hostLabel(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    if (host.includes("openrouter")) return "jev/openrouter";
    return "jev";
  } catch {
    return "jev";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}

export type { Question };
