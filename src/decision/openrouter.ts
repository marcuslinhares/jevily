/**
 * OpenRouter chat + `json_schema` adapter.
 *
 * This is the *approximation* of a decision engine, not the real one: it produces
 * the same typed answer shape, but the probabilities are written by a chat model
 * about itself, so they are not calibrated. Kept as an explicit opt-in for people
 * with no System One access who still want typed answers; `auto` never picks it
 * when a key for the real model is available.
 *
 * Two deliberate differences from the System One engine:
 *   1. `calibrated = false`, so the pipeline widens every threshold (see policy.ts).
 *   2. `confidence` is derived from the returned distribution's normalized entropy
 *      rather than read off a field the model wrote about its own certainty.
 */

import { config } from "../config.js";
import { log } from "../util/log.js";
import { sleep } from "../util/async.js";
import {
  DecisionError,
  type Answer,
  type ChoiceAnswer,
  type DecisionEngine,
  type DecisionRequest,
  type DecisionResult,
  type NoulAnswer,
  type Question,
  type ScoreAnswer,
} from "./types.js";

export class OpenRouterDecisionEngine implements DecisionEngine {
  readonly name = "openrouter-chat";
  readonly calibrated = false;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = config().OPENROUTER_BASE_URL,
    private readonly defaultModel: string = config().DECISION_CHAT_MODEL,
  ) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const model = request.model ?? this.defaultModel;
    const started = Date.now();
    const schema = buildAnswerSchema(request.questions);
    const body = {
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are a decision engine. You receive a state and a set of typed questions. " +
            "Answer every question independently and exclusively from the state. " +
            "Never invent information that is not in the state. " +
            "For probability questions return a number between 0 and 1 expressing your genuine belief. " +
            "Return only the requested JSON object.",
        },
        { role: "user", content: renderPrompt(request.state, request.questions) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "decisions", strict: true, schema },
      },
      // Only route to endpoints that actually support structured outputs.
      provider: { require_parameters: ["response_format"] },
      usage: { include: true },
    };

    const { payload, attempts } = await this.post(body, request.signal);
    const content = extractJson(payload);
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const raw = content.answers?.[id];
      if (raw === undefined) continue;
      answers[id] = normalize(question, raw);
    }
    return {
      engine: this.name,
      model: payload.model ?? model,
      answers,
      usage: {
        inputTokens: num(payload.usage?.prompt_tokens),
        outputTokens: num(payload.usage?.completion_tokens),
        costUsd: typeof payload.usage?.cost === "number" ? payload.usage.cost : null,
        requests: attempts,
      },
      latencyMs: Date.now() - started,
    };
  }

  private async post(body: unknown, signal: AbortSignal | undefined) {
    const maxRetries = config().DECISION_MAX_RETRIES;
    const timeoutMs = config().DECISION_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "X-Title": "jevily",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new DecisionError(`openrouter ${res.status}: ${text.slice(0, 300)}`);
        }
        return { payload: (await res.json()) as ChatResponse, attempts: attempt };
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries) break;
        const wait = Math.min(4_000, 300 * 2 ** (attempt - 1));
        log.warn("openrouter decision retry", { attempt, wait, err: String(err) });
        await sleep(wait, signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw new DecisionError("openrouter decision request failed", lastError);
  }
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

function extractJson(payload: ChatResponse): { answers?: Record<string, unknown> } {
  const raw = payload.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new DecisionError("openrouter returned an empty message");
  }
  try {
    return JSON.parse(raw) as { answers?: Record<string, unknown> };
  } catch {
    // Some providers still fence JSON even under strict schemas.
    const match = raw.match(/\{[\s\S]*\}/);
    if (match?.[0]) return JSON.parse(match[0]) as { answers?: Record<string, unknown> };
    throw new DecisionError("openrouter returned unparseable JSON", raw.slice(0, 200));
  }
}

function renderPrompt(state: unknown, questions: Record<string, Question>): string {
  const lines: string[] = ["<state>", stringify(state), "</state>", "", "<questions>"];
  for (const [id, question] of Object.entries(questions)) {
    lines.push(`<question id="${id}" type="${question.type}">`);
    lines.push(`<instructions>${stringify(question.instructions)}</instructions>`);
    if (question.type === "noul" && question.criteria) {
      lines.push(`<criteria.true>${stringify(question.criteria.true ?? "")}</criteria.true>`);
      lines.push(`<criteria.false>${stringify(question.criteria.false ?? "")}</criteria.false>`);
    } else if (question.type === "choice") {
      for (const [option, rubric] of Object.entries(question.criteria)) {
        lines.push(`<option name="${option}">${stringify(rubric ?? "")}</option>`);
      }
    } else if (question.type === "score") {
      question.criteria.forEach((level, i) => {
        lines.push(`<level index="${i}">${stringify(level)}</level>`);
      });
    }
    lines.push("</question>");
  }
  lines.push("</questions>");
  return lines.join("\n");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "null";
}

/** Strict JSON Schema covering the exact answer shapes, keyed by question id. */
export function buildAnswerSchema(questions: Record<string, Question>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [id, question] of Object.entries(questions)) {
    properties[id] = answerSchema(question);
    required.push(id);
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      answers: { type: "object", additionalProperties: false, properties, required },
    },
    required: ["answers"],
  };
}

function answerSchema(question: Question): Record<string, unknown> {
  if (question.type === "noul") {
    return {
      type: "object",
      additionalProperties: false,
      properties: { type: { type: "string", enum: ["noul"] }, noul: { type: "number", minimum: 0, maximum: 1 } },
      required: ["type", "noul"],
    };
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: ["choice"] },
        choice: { type: "string", enum: options },
        probabilities: distributionSchema(options),
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["type", "choice", "probabilities", "confidence"],
    };
  }
  const levels = question.criteria.map((_, i) => String(i));
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["score"] },
      score: { type: "number", minimum: 0, maximum: levels.length - 1 },
      probabilities: distributionSchema(levels),
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["type", "score", "probabilities", "confidence"],
  };
}

function distributionSchema(keys: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of keys) properties[key] = { type: "number", minimum: 0, maximum: 1 };
  return { type: "object", additionalProperties: false, properties, required: keys };
}

function normalize(question: Question, raw: unknown): Answer {
  const obj = (raw ?? {}) as Record<string, unknown>;
  if (question.type === "noul") {
    const noul = clamp01(num(obj.noul, 0.5));
    const answer: NoulAnswer = { type: "noul", noul };
    answer.confidence = proxyConfidence(noul);
    return answer;
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    const probabilities = renorm(pick(obj.probabilities, options));
    const choice = options.includes(String(obj.choice))
      ? (String(obj.choice) as string)
      : (argmax(probabilities) ?? (options[0] as string));
    const answer: ChoiceAnswer = {
      type: "choice",
      choice,
      probabilities,
      confidence: entropyConfidence(probabilities),
    };
    return answer;
  }
  const levels = question.criteria.map((_, i) => String(i));
  const probabilities = renorm(pick(obj.probabilities, levels));
  const rawScore = num(obj.score, Number(argmax(probabilities) ?? 0));
  const answer: ScoreAnswer = {
    type: "score",
    score: Math.min(Math.max(rawScore, 0), levels.length - 1),
    legend: Object.fromEntries(levels.map((l, i) => [l, stringify(question.criteria[i])])),
    probabilities,
    confidence: entropyConfidence(probabilities),
  };
  return answer;
}

function pick(source: unknown, keys: string[]): Record<string, number> {
  const obj = (source ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = num(obj[key], 0);
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (total === 0) for (const key of keys) out[key] = 1 / keys.length;
  return out;
}

function renorm(values: Record<string, number>): Record<string, number> {
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  if (total <= 0) return values;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v / total;
  return out;
}

function entropyConfidence(probabilities: Record<string, number>): number {
  const keys = Object.keys(probabilities);
  if (keys.length <= 1) return 1;
  let h = 0;
  for (const p of Object.values(probabilities)) {
    if (p > 0) h -= p * Math.log(p);
  }
  return clamp01(1 - h / Math.log(keys.length));
}

function argmax(values: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestValue = -Infinity;
  for (const [k, v] of Object.entries(values)) {
    if (v > bestValue) {
      bestValue = v;
      best = k;
    }
  }
  return best;
}

/** No distribution exists for a noul, so use distance from the decision boundary. */
function proxyConfidence(noul: number): number {
  return clamp01(Math.abs(noul - 0.5) * 2);
}

function num(v: unknown, def = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
