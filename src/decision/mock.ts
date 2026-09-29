/**
 * Deterministic decision engine for local dev and tests.
 *
 * It is not a model, and nothing here is calibrated. What it *is* is a competent
 * stand-in: lexical affinity, a source-authority prior, a length-and-structure
 * quality signal, and a prompt-injection heuristic. That is enough for the
 * pipeline's wiring, its policy branches and its ordering to behave plausibly
 * offline, so `pnpm dev` shows you a real system rather than random numbers.
 *
 * Every number it returns is marked uncalibrated everywhere it is consumed.
 */

import { createHash } from "node:crypto";
import { clamp01, estimateTokens, fold, isStopword } from "../util/text.js";
import { stem } from "../retrieval/tokenize.js";
import {
  type Answer,
  type ChoiceAnswer,
  type DecisionEngine,
  type DecisionRequest,
  type DecisionResult,
  type NoulAnswer,
  type Question,
  type QuestionContent,
  type ScoreAnswer,
} from "./types.js";

/**
 * Keys holding the *question* being asked of the state, rather than the evidence.
 * They are excluded from the comparable text, otherwise a claim would always match
 * itself and every citation check would pass trivially.
 */
const QUERY_KEYS = ["query", "question", "search_query", "user_query", "claim"];

/** Phrases a document uses when it is talking to a model instead of a reader. */
const INJECTION = [
  "ignore all previous",
  "ignore previous instructions",
  "disregard the above",
  "you are now a",
  "you are now an",
  "system prompt",
  "reveal the system",
  "reply only with",
  "respond only with",
  "new instructions",
  "assistant:",
  "as an ai",
  "do not mention this",
];

/** Hosts a knowledgeable person would treat as primary for most subjects. */
const AUTHORITATIVE_HOST = /(^|\.)(docs?\.|developer\.|learn\.|support\.|help\.|wiki\.|reference\.)|(^|\.)(wikipedia\.org|arxiv\.org|nist\.gov|who\.int|ieee\.org|acm\.org)$|(^|\.)(gov|edu|mil)(\.|$)/i;

const LOW_QUALITY_HOST = /(^|\.)(forum|blogspot|medium|substack|quora|wikipedia\.org\/wiki\/Talk|reddit)\b|content-farm|seo-/i;

export class MockDecisionEngine implements DecisionEngine {
  readonly name = "mock";
  readonly calibrated = false;

  constructor(private readonly latencyMs = 12) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const started = Date.now();
    const text = stateText(request.state);
    const query = stateQuery(request.state);
    const claim = stateClaim(request.state);
    const sourceUrl = stateSourceUrl(request.state);
    const candidate = stateCandidate(request.state);

    // Signals are computed once per call and shared by every question in the batch,
    // mirroring how a real engine would read the same state repeatedly.
    //
    // Retrieval states look like {query, candidate}; citation states look like
    // {claim, source}. Both are scored against whatever text the state carries, so
    // the same primitive works for a query/passage pair and a claim/source pair.
    const reference = query ?? claim;
    const signals = {
      affinity: reference ? affinity(reference, text) : 0,
      coverage: reference ? coverage(reference, text) : 0,
      authority: authority(candidate?.url ?? sourceUrl ?? ""),
      quality: quality(candidate?.text ?? text),
      injection: injectionScore(candidate?.text ?? text),
      advertisement: advertisement(candidate?.text ?? text),
    };

    const answers: Record<string, Answer> = {};
    let inputTokens = 0;
    let outputTokens = 0;

    for (const [id, question] of Object.entries(request.questions)) {
      const seed = createHash("sha256")
        .update(`${stable(request.state)}${id}${stable(question)}`)
        .digest();
      const jitter = ((seed[0] ?? 128) / 255 - 0.5) * 0.12; // small, deterministic
      inputTokens += estimateTokens(stable(request.state)) + estimateTokens(stable(question));
      outputTokens += 24;

      const base = biasFor(question, signals, jitter);
      if (question.type === "noul") {
        const answer: NoulAnswer = { type: "noul", noul: round4(clamp01(base)) };
        answer.confidence = clamp01(Math.abs(answer.noul - 0.5) * 2);
        answers[id] = answer;
      } else if (question.type === "choice") {
        const options = Object.keys(question.criteria);
        const byIndex = spread(options.length, base);
        const probabilities: Record<string, number> = {};
        options.forEach((option, i) => {
          probabilities[option] = byIndex[String(i)] ?? 0;
        });
        const answer: ChoiceAnswer = {
          type: "choice",
          choice: argmax(probabilities) ?? (options[0] as string),
          probabilities,
          confidence: entropyConfidence(probabilities),
        };
        answers[id] = answer;
      } else {
        const levels = question.criteria.length;
        const probabilities = spread(levels, base);
        let expected = 0;
        for (const [index, p] of Object.entries(probabilities)) expected += Number(index) * p;
        const answer: ScoreAnswer = {
          type: "score",
          score: round4(expected),
          legend: Object.fromEntries(
            (question.criteria as QuestionContent[]).map((level, i) => [String(i), stringifyLevel(level)]),
          ),
          probabilities,
          confidence: entropyConfidence(probabilities),
        };
        answers[id] = answer;
      }
    }

    return {
      engine: this.name,
      model: "mock",
      answers,
      usage: { inputTokens, outputTokens, costUsd: 0, requests: 1 },
      latencyMs: Date.now() - started,
    };
  }
}

interface Signals {
  affinity: number;
  coverage: number;
  authority: number;
  quality: number;
  injection: number;
  advertisement: number;
}

function biasFor(question: Question, s: Signals, jitter: number): number {
  const ask = flattenInstructions(question).toLowerCase();
  let base: number;

  if (ask.includes("injection") || ask.includes("automated system") || ask.includes("control")) {
    base = 0.12 + s.injection * 0.8;
  } else if (ask.includes("advert") || ask.includes("solicit") || ask.includes("promot")) {
    base = 0.12 + s.advertisement * 0.8;
  } else if (ask.includes("authoritative") || ask.includes("primary") || ask.includes("origin")) {
    base = 0.15 + s.authority * 0.8;
  } else if (
    ask.includes("substantive") ||
    ask.includes("padding") ||
    ask.includes("filler") ||
    ask.includes("specific and free")
  ) {
    base = 0.15 + s.quality * 0.8;
  } else if (ask.includes("self-contained") || ask.includes("direct")) {
    base = 0.3 + s.quality * 0.5;
  } else if (ask.includes("constraint") || ask.includes("satisf")) {
    base = 0.2 + s.coverage * 0.7;
  } else if (ask.includes("supported") || ask.includes("entail") || ask.includes("actually state")) {
    // Citation check: does the source state the claim? A claim whose substance is
    // present in the source is supported; a merely related one is not.
    base = 0.12 + s.affinity * 0.85;
  } else if (ask.includes("contradict") || ask.includes("conflict") || ask.includes("disagree")) {
    base = 0.1 + (1 - s.coverage) * 0.3;
  } else if (ask.includes("sufficient") || ask.includes("completely")) {
    base = 0.2 + s.coverage * 0.75;
  } else if (ask.includes("relevant") || ask.includes("about the subject") || ask.includes("same subject")) {
    base = 0.15 + s.affinity * 0.8;
  } else if (ask.includes("answer") || ask.includes("evidence") || ask.includes("usable") || ask.includes("citable")) {
    base = 0.15 + s.affinity * 0.7 + s.coverage * 0.15;
  } else if (ask.includes("recency") || ask.includes("current")) {
    base = 0.5;
  } else {
    // No recognizable intent: a mildly-informative default.
    base = 0.4 + s.affinity * 0.2;
  }
  return clamp01(base + jitter);
}

/** How many of the query's content words appear in the document at all. */
function coverage(query: string, doc: string): number {
  const q = contentWords(query);
  if (q.length === 0) return 0;
  const d = new Set(contentWords(doc));
  let hits = 0;
  for (const w of q) if (d.has(w)) hits++;
  return hits / q.length;
}

/** How heavily the document leans on the query's terms, discounted by its own length. */
function affinity(query: string, doc: string): number {
  const q = contentWords(query);
  if (q.length === 0 || doc.length < 20) return 0;
  const d = contentWords(doc);
  if (d.length === 0) return 0;
  const dSet = new Set(d);
  let hits = 0;
  for (const w of q) if (dSet.has(w)) hits++;
  const density = (hits / q.length) * Math.min(1, 220 / Math.max(60, d.length));
  // 0.5 means most query terms appear and the passage is not a wall of unrelated text.
  return clamp01(density / 0.5);
}

function authority(url: string): number {
  if (!url) return 0.5;
  const host = safeHost(url);
  if (AUTHORITATIVE_HOST.test(host)) return 0.92;
  if (LOW_QUALITY_HOST.test(host)) return 0.15;
  if (/\.(gov|edu|mil|int|org)(\.[a-z]{2})?$/i.test(host)) return 0.75;
  return 0.5;
}

function quality(text: string): number {
  const chars = text.trim().length;
  if (chars < 120) return 0.2;
  const words = text.split(/\s+/).length;
  // Punchy filler: lots of short sentences and no concrete detail.
  const sentences = text.split(/[.!?]\s+/).filter((s) => s.trim().length > 0);
  const avgSentence = words / Math.max(1, sentences.length);
  const hasDetail = /\d|\b\d{4}\b|[A-Z][a-z]+\.[A-Za-z]/.test(text);
  let score = 0.35;
  if (chars > 400) score += 0.25;
  if (avgSentence > 12 && avgSentence < 45) score += 0.2;
  if (hasDetail) score += 0.2;
  if (/\b(delve|leverage|in today|in the realm|it's important to note)\b/i.test(text)) score -= 0.3;
  return clamp01(score);
}

function injectionScore(text: string): number {
  const lower = fold(text);
  let hits = 0;
  for (const phrase of INJECTION) if (lower.includes(phrase)) hits++;
  if (hits === 0) return 0.05;
  return clamp01(0.55 + 0.2 * hits);
}

function advertisement(text: string): number {
  const lower = fold(text);
  let score = 0.05;
  for (const phrase of ["buy now", "sign up", "limited time", "subscribe", "promo code", "discount", "get started today"]) {
    if (lower.includes(phrase)) score += 0.2;
  }
  return clamp01(score);
}

function spread(n: number, peak: number): Record<string, number> {
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const distance = Math.abs(i / Math.max(1, n - 1) - clamp01(peak));
    weights.push(Math.max(0.02, (1 - distance) ** 2));
  }
  const total = weights.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  weights.forEach((w, i) => {
    out[String(i)] = w / total;
  });
  return out;
}

function flattenInstructions(question: Question): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 3) return;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(question.instructions);
  if (question.type === "noul") {
    walk(question.criteria?.true);
    walk(question.criteria?.false);
  } else if (question.type === "choice") {
    Object.values(question.criteria).forEach((x) => walk(x));
  } else {
    (question.criteria as QuestionContent[]).forEach((x) => walk(x));
  }
  return parts.join(" ");
}

interface CandidateView {
  url?: string;
  text?: string;
  title?: string;
}

function stateQuery(state: unknown): string | null {
  if (typeof state === "string") return state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const obj = state as Record<string, unknown>;
    for (const key of QUERY_KEYS) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

function stateClaim(state: unknown): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const claim = (state as Record<string, unknown>).claim;
  return typeof claim === "string" && claim.trim() ? claim : null;
}

function stateSourceUrl(state: unknown): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const source = (state as Record<string, unknown>).source;
  if (!source || typeof source !== "object") return null;
  const url = (source as Record<string, unknown>).url;
  return typeof url === "string" ? url : null;
}

function stateCandidate(state: unknown): CandidateView | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const candidate = (state as Record<string, unknown>).candidate;
  if (!candidate || typeof candidate !== "object") return null;
  const obj = candidate as Record<string, unknown>;
  return {
    url: typeof obj.url === "string" ? obj.url : undefined,
    text: typeof obj.text === "string" ? obj.text : undefined,
    title: typeof obj.title === "string" ? obj.title : undefined,
  };
}

/** Everything in the state except the query itself, flattened to text. */
function stateText(state: unknown): string {
  if (typeof state === "string") return state;
  const parts: string[] = [];
  const walk = (v: unknown, depth: number, key: string) => {
    if (depth > 4) return;
    if (QUERY_KEYS.includes(key)) return;
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1, key));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, depth + 1, k);
    }
  };
  walk(state, 0, "");
  return parts.join(" ");
}

/**
 * Content words, stemmed.
 *
 * Stemming matters here: a query saying "buffer grows" has to match a passage
 * saying "buffers ... growing", which is exactly the paraphrase gap a lexical
 * retriever cannot close on its own and a judgement model exists to close.
 */
function contentWords(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !isStopword(w))
    .map((w) => stem(w));
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function stringifyLevel(level: QuestionContent): string {
  return typeof level === "string" ? level : JSON.stringify(level);
}

function stable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "null";
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
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

function entropyConfidence(probabilities: Record<string, number>): number {
  const keys = Object.keys(probabilities);
  if (keys.length <= 1) return 1;
  let h = 0;
  for (const p of Object.values(probabilities)) if (p > 0) h -= p * Math.log(p);
  return clamp01(1 - h / Math.log(keys.length));
}
