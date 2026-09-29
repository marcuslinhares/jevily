/**
 * The System One wire contract.
 *
 * These are the tests that would catch a silent break with the real API. The
 * request and response shapes are documented at
 * https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request
 * and served identically by TypeSafe at api.typesafe.ai, so one engine covers both
 * and one set of assertions covers both.
 *
 * The engine is driven against a stubbed `fetch`, never the network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemOneEngine } from "../src/decision/jev.js";
import { gateQuestions, queryUnderstandingQuestions } from "../src/decision/questions.js";
import { loadConfig, resolveDecisionEngine, SYSTEMONE_PROVIDERS } from "../src/config.js";
import type { Question } from "../src/decision/types.js";

const QUESTIONS: Record<string, Question> = {
  is_bug: {
    type: "noul",
    instructions: "Is the customer reporting a software defect?",
    criteria: { true: "Broken or unexpected behaviour.", false: "A question or feature request." },
  },
  team: {
    type: "choice",
    instructions: "Which team should own this ticket?",
    criteria: { account: "Login and permissions.", payments: "Checkout and billing." },
  },
  urgency: {
    type: "score",
    instructions: "How urgent is this ticket?",
    criteria: ["Can wait", "This week", "Blocking revenue"],
  },
};

const RESPONSE = {
  id: "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: {
    is_bug: { type: "noul", noul: 0.96 },
    team: {
      type: "choice",
      choice: "payments",
      probabilities: { account: 0, payments: 0.84 },
      confidence: 0.75,
    },
    urgency: {
      type: "score",
      score: 1.99,
      legend: { "0": "Can wait", "1": "This week", "2": "Blocking revenue" },
      probabilities: { "0": 0, "1": 0.01, "2": 0.99 },
      confidence: 0.99,
    },
  },
  usage: { cost: 0.000019992, input_tokens: 476, output_tokens: 70 },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, init?: { status?: number }) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    const status = init?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
  return calls;
}

describe("System One wire contract", () => {
  it("posts the documented request shape to /v1/systemone", async () => {
    const calls = stubFetch(RESPONSE);
    const engine = new SystemOneEngine("key-123", "https://openrouter.ai/api", "jev-latest");

    await engine.evaluate({ state: { ticket: "checkout shows a blank page" }, questions: QUESTIONS });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/systemone");
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key-123");

    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["model", "questions", "state"]);
    expect(sent.model).toBe("jev-latest");
    expect(sent.questions).toEqual(QUESTIONS);
  });

  it("normalizes every answer type into the typed values the pipeline branches on", async () => {
    stubFetch(RESPONSE);
    const engine = new SystemOneEngine("key-123", "https://openrouter.ai/api", "typesafe/jev-latest");
    const { answers } = await engine.evaluate({ state: "text", questions: QUESTIONS });

    expect(answers.is_bug).toEqual({ type: "noul", noul: 0.96 });
    expect(answers.team).toEqual({
      type: "choice",
      choice: "payments",
      probabilities: { account: 0, payments: 0.84 },
      confidence: 0.75,
    });
    const urgency = answers.urgency as { type: string; score: number; legend: Record<string, string>; confidence: number };
    expect(urgency.type).toBe("score");
    expect(urgency.score).toBeCloseTo(1.99, 5);
    expect(urgency.legend["2"]).toBe("Blocking revenue");
    expect(urgency.confidence).toBe(0.99);
  });

  it("trusts the provider's reported cost instead of estimating it", async () => {
    stubFetch(RESPONSE);
    const engine = new SystemOneEngine("key-123", "https://openrouter.ai/api", "typesafe/jev-latest");
    const { usage } = await engine.evaluate({ state: "text", questions: QUESTIONS });
    expect(usage.costUsd).toBe(0.000019992);
    expect(usage.inputTokens).toBe(476);
  });

  it("falls back to the published price when the provider reports no cost", async () => {
    stubFetch({ ...RESPONSE, usage: { input_tokens: 476, output_tokens: 70 } });
    const engine = new SystemOneEngine("key-123", "https://openrouter.ai/api", "typesafe/jev-latest");
    const { usage } = await engine.evaluate({ state: "text", questions: QUESTIONS });
    expect(usage.costUsd).toBeCloseTo((476 / 1_000_000) * 0.042, 12);
  });

  it("reports the resolved model the provider actually served", async () => {
    stubFetch(RESPONSE);
    const engine = new SystemOneEngine("key-123", "https://openrouter.ai/api", "typesafe/jev-latest");
    const { model } = await engine.evaluate({ state: "text", questions: QUESTIONS });
    // Pinned builds resolve to a dated id; the trace should show what ran.
    expect(model).toBe("typesafe/jev-1.13-20260917");
  });

  it("is calibrated, which is what lets the thresholds be trusted", () => {
    const engine = new SystemOneEngine("key", SYSTEMONE_PROVIDERS.typesafe.baseUrl, SYSTEMONE_PROVIDERS.typesafe.model);
    expect(engine.calibrated).toBe(true);
  });

  it("names the engine after its host so the trace says where it ran", () => {
    expect(new SystemOneEngine("k", SYSTEMONE_PROVIDERS.typesafe.baseUrl, "m").name).toBe("jev");
    expect(new SystemOneEngine("k", SYSTEMONE_PROVIDERS.openrouter.baseUrl, "m").name).toBe("jev/openrouter");
  });

  it("retries a 429 but not a 401", async () => {
    vi.spyOn(globalThis, "fetch");
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      const status = attempts < 3 ? 429 : 200;
      return {
        ok: status === 200,
        status,
        statusText: String(status),
        json: async () => RESPONSE,
        text: async () => "{}",
      } as unknown as Response;
    }) as typeof fetch;

    const engine = new SystemOneEngine("key-123", "https://openrouter.ai/api", "typesafe/jev-latest");
    const { usage } = await engine.evaluate({ state: "t", questions: QUESTIONS });
    expect(attempts).toBe(3);
    expect(usage.requests).toBe(3);
  });

  it("gives up immediately on an auth failure instead of burning the budget", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      return {
        ok: false,
        status: 401,
        statusText: "401",
        json: async () => ({}),
        text: async () => '{"error":{"message":"bad key"}}',
      } as unknown as Response;
    }) as typeof fetch;

    const engine = new SystemOneEngine("key-123", "https://openrouter.ai/api", "typesafe/jev-latest");
    await expect(engine.evaluate({ state: "t", questions: QUESTIONS })).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("question library against the wire format", () => {
  it("serializes the full understand batch without a schema violation", async () => {
    const calls = stubFetch(RESPONSE);
    const engine = new SystemOneEngine("key", SYSTEMONE_PROVIDERS.typesafe.baseUrl, "jev-latest");
    await engine.evaluate({ state: { query: "how does backpressure work" }, questions: queryUnderstandingQuestions() });

    const sent = JSON.parse(String(calls[0]!.init.body)) as { questions: Record<string, { type: string }> };
    const types = new Set(Object.values(sent.questions).map((q) => q.type));
    expect(types).toEqual(new Set(["choice", "noul", "score"]));
  });

  it("sends the gate batch as five nouls, all with both sides defined", async () => {
    const calls = stubFetch({ answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
    const engine = new SystemOneEngine("key", SYSTEMONE_PROVIDERS.typesafe.baseUrl, "jev-latest");
    await engine.evaluate({ state: { query: "q", candidate: { text: "t" } }, questions: gateQuestions() });

    const sent = JSON.parse(String(calls[0]!.init.body)) as {
      questions: Record<string, { type: string; criteria: { true: unknown; false: unknown } }>;
    };
    expect(Object.keys(sent.questions)).toHaveLength(5);
    for (const question of Object.values(sent.questions)) {
      expect(question.type).toBe("noul");
      expect(question.criteria.true).toBeTruthy();
      expect(question.criteria.false).toBeTruthy();
    }
  });
});

describe("engine resolution", () => {
  it("prefers the real decision model whenever any key is present", () => {
    // An OpenRouter key alone is enough: it proxies the same /v1/systemone path.
    expect(resolveDecisionEngine(loadConfig({ OPENROUTER_API_KEY: "sk-or-x" }))).toBe("systemone");
    expect(resolveDecisionEngine(loadConfig({ DECISION_API_KEY: "ts-x" }))).toBe("systemone");
  });

  it("falls back to the mock when there is no key at all", () => {
    expect(resolveDecisionEngine(loadConfig({}))).toBe("mock");
  });

  it("derives the OpenRouter base url and model id together", () => {
    const c = loadConfig({ OPENROUTER_API_KEY: "sk-or-x" });
    expect(c.DECISION_BASE_URL).toBe("https://openrouter.ai/api");
    // Bare on purpose: OpenRouter maps bare System One ids onto the typesafe/
    // namespace itself, and `typesafe/jev-latest` is not a real model id. Only
    // `typesafe/jev-1.13` exists, and that is what the alias resolves to.
    expect(c.DECISION_MODEL).toBe("jev-latest");
    expect(c.DECISION_MODEL).not.toBe("typesafe/jev-latest");
    expect(c.DECISION_API_KEY).toBe("sk-or-x");
  });

  it("defaults to TypeSafe direct when no OpenRouter key is present", () => {
    const c = loadConfig({});
    expect(c.DECISION_BASE_URL).toBe("https://api.typesafe.ai");
    expect(c.DECISION_MODEL).toBe("jev-latest");
  });

  it("honours an explicit base url over the derived default", () => {
    const c = loadConfig({ OPENROUTER_API_KEY: "sk-or-x", DECISION_BASE_URL: "https://proxy.internal/api/" });
    expect(c.DECISION_BASE_URL).toBe("https://proxy.internal/api");
  });
});
