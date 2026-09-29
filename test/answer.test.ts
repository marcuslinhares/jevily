/**
 * The answer stage, exercised without a network.
 *
 * The generator is a scripted stub: it returns exactly what a test tells it to, so
 * these tests isolate the *decision* logic — when to abstain, and which claims get
 * dropped — from the quality of any particular model.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerStage } from "../src/pipeline/answer.js";
import { resolvePolicy } from "../src/pipeline/policy.js";
import { DecisionService, createDecisionService } from "../src/decision/service.js";
import { MockDecisionEngine } from "../src/decision/mock.js";
import type { GatedCandidate } from "../src/pipeline/gate.js";
import type { SearchRequest } from "../src/domain/types.js";
import { createGenerator, type Generator } from "../src/llm/generator.js";
process.env.DECISION_ENGINE = "mock";
process.env.LOG_LEVEL = "silent";

/** A generator stub that returns a scripted answer and claim list. */
function stubGenerator(
  answers: { answer: string; claims: { text: string; sources: string[] }[] }[],
): Generator & { calls: number } {
  let calls = 0;
  return {
    name: "stub",
    model: "stub",
    get calls() {
      return calls;
    },
    async json<T>(request: { user: string }): Promise<T | null> {
      calls++;
      const index = Math.min(calls - 1, answers.length - 1);
      return answers[index] as T | null;
    },
    async text(): Promise<string | null> {
      calls++;
      return answers[0]?.answer ?? null;
    },
  };
}

function candidate(id: string, domain: string, composite: number, text: string): GatedCandidate {
  return {
    chunk: {
      id,
      url: `https://${domain}/${id}`,
      ord: 0,
      headingPath: [id],
      text,
      tokens: Math.ceil(text.length / 4),
      simhash: "0",
      contentHash: id,
      vector: null,
    },
    doc: {
      url: `https://${domain}/${id}`,
      domain,
      title: id,
      lang: "en",
      markdown: text,
      text,
      publishedDate: null,
      fetchedAt: 0,
      etag: null,
      lastModified: null,
      status: "ok",
      contentHash: id,
      stale: 0,
    },
    lexical: 1,
    dense: null,
    fused: 1,
    channels: 1,
    exactPhraseHit: false,
    composite,
    signals: {},
    keep: true,
    reasons: [],
    route: "include",
    gateSignals: {},
  };
}

const request: SearchRequest = {
  query: "what is backpressure",
  search_depth: "basic",
  max_results: 5,
  topic: "general",
  time_range: null,
  include_answer: "basic",
  include_raw_content: false,
  include_published_date: false,
  filter_by_published_date: false,
  filter_by_language: false,
  exact_match: false,
  auto_parameters: false,
  safe_search: false,
};

const plan = {
  intent: "factual_lookup" as const,
  topic: "general" as const,
  answerShape: "short_paragraph" as const,
  synthesisNeed: 0.3,
  timeHorizon: 1,
  complexity: 1,
  ambiguity: 0.2,
  requiresExactPhrase: false,
  expandQuery: false,
  expansionStrategy: "none" as const,
  multiRound: false,
  language: "en",
};

const policy = resolvePolicy(false);
const decisions = () => new DecisionService(new MockDecisionEngine(0), null);

const evidence = [
  candidate("a", "nodejs.org", 0.8, "Backpressure is the signal that tells a producer to stop when its consumer cannot keep up."),
  candidate("b", "sqlite.org", 0.7, "A queue that grows without bound is a memory leak waiting to happen."),
];

async function run(overrides: Partial<Parameters<typeof answerStage>[0]> = {}, generator: Generator | null = null) {
  return answerStage({
    query: request.query,
    plan,
    request,
    policy,
    calibrated: false,
    engineName: "mock",
    gated: evidence,
    evidenceLimit: 4,
    generator,
    decisions: decisions(),
    ...overrides,
  });
}

describe("generator request shape", () => {
  it("sends require_parameters as a boolean, not a list of names", async () => {
    // The array form is a 400 from OpenRouter, and it failed the whole answer stage
    // with nothing but a log line to show for it.
    const calls: { body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return {
        ok: true,
        status: 200,
        statusText: "200",
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ answer: "x", claims: [] }) } }] }),
        text: async () => "{}",
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const generator = createGenerator();
      if (!generator) {
        // No key configured: the shape is asserted in the probe script instead.
        return;
      }
      await generator.json({ system: "s", user: "u", schema: { type: "object" } });
    } finally {
      globalThis.fetch = realFetch;
    }

    const provider = calls[0]?.body.provider as { require_parameters?: unknown } | undefined;
    expect(provider).toBeDefined();
    expect(typeof provider!.require_parameters).toBe("boolean");
  });
});

describe("answer stage", () => {
  it("withholds the answer when no evidence passed the gate", async () => {
    const out = await run({ gated: [] });
    expect(out.answer).toBeNull();
    expect(out.abstained).toBe(true);
    expect(out.abstainedReason).toBe("no_evidence");
  });

  it("withholds the answer when the decision engine says the evidence is insufficient", async () => {
    // Force insufficiency by making the sufficiency noul unusable.
    const broken = {
      name: "broken",
      calibrated: false,
      evaluate: async (req: { questions: Record<string, { type?: string }> }) => {
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries(req.questions)) {
          answers[id] = question.type === "noul" ? { type: "noul", noul: 0.01 } : { type: "choice", choice: "", probabilities: {}, confidence: 0 };
        }
        return {
          engine: "broken",
          model: "m",
          answers,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: null, requests: 1 },
          latencyMs: 1,
        };
      },
    };
    const out = await run({ decisions: new DecisionService(broken as never, null) });
    expect(out.answer).toBeNull();
    expect(out.abstained).toBe(true);
  });

  it("does not write prose when the caller did not ask for an answer", async () => {
    const out = await run({ request: { ...request, include_answer: false } });
    expect(out.answer).toBeNull();
    // Not an abstention: the user never wanted an answer in the first place.
    expect(out.abstained).toBe(false);
  });

  it("returns null with a reason when no generator is configured", async () => {
    const out = await run({ generator: null });
    expect(out.answer).toBeNull();
    expect(out.abstainedReason).toBe("no_generator");
  });

  it("keeps a claim the source supports and drops one it does not", async () => {
    // No generator on the retry, so the surviving answer carries the omission notice.
    const generator = stubGenerator([
      {
        answer: "Backpressure is the signal a producer receives. Also, backpressure was invented in 1997.",
        claims: [
          { text: "Backpressure is the signal a producer receives", sources: ["a"] },
          { text: "Backpressure was invented in 1997", sources: ["b"] },
        ],
      },
    ]);
    const out = await run({ generator });

    expect(out.verification.claims).toBe(2);
    // The mock scores support by lexical overlap with the source, so the claim whose
    // wording is in source "a" survives and the invented one does not.
    expect(out.verification.kept).toBe(1);
    expect(out.verification.dropped).toBe(1);
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0]?.url).toContain("nodejs.org");
  });

  it("discloses the omission when it cannot rewrite", async () => {
    // A generator that returns nothing on the retry leaves the first draft in place,
    // so the answer must say that material was removed rather than imply it was not.
    let calls = 0;
    const flaky: Generator = {
      name: "flaky",
      model: "flaky",
      async json<T>(): Promise<T | null> {
        calls++;
        if (calls > 1) return null;
        return {
          answer: "First draft with a bad claim.",
          claims: [
            { text: "Backpressure is the signal a producer receives", sources: ["a"] },
            { text: "Something nowhere in the evidence", sources: ["b"] },
          ],
        } as T;
      },
      async text(): Promise<string | null> {
        return null;
      },
    };
    const out = await run({ generator: flaky });
    expect(calls).toBe(2);
    expect(out.verification.kept).toBe(1);
    expect(out.answer).toContain("omitted");
  });

  it("rewrites the answer against the surviving evidence when something was dropped", async () => {
    const generator = stubGenerator([
      {
        answer: "First draft with a bad claim.",
        claims: [
          { text: "Backpressure is the signal a producer receives", sources: ["a"] },
          { text: "Something nowhere in the evidence", sources: ["b"] },
        ],
      },
      { answer: "Second draft, evidence narrowed.", claims: [{ text: "Backpressure is the signal a producer receives", sources: ["a"] }] },
    ]);
    const out = await run({ generator });
    expect(generator.calls).toBe(2);
    expect(out.verification.regenerateAttempted).toBe(true);
    expect(out.answer).toBe("Second draft, evidence narrowed.");
  });

  it("never reports a claim as verified when its source is not in the evidence", async () => {
    const generator = stubGenerator([
      {
        answer: "Citing something that was never retrieved.",
        claims: [{ text: "A claim citing a missing source", sources: ["nonexistent"] }],
      },
    ]);
    const out = await run({ generator });
    expect(out.citations).toEqual([]);
    expect(out.verification.kept).toBe(0);
  });

  it("reports the sufficiency and conflict verdicts it decided on", async () => {
    const out = await run();
    expect(out.sufficiency.sufficient).toBeTypeOf("number");
    expect(out.sufficiency.conflicting).toBeTypeOf("number");
  });

  /** A decision engine that returns a fixed noul for every question. */
  function fixedEngine(noul: number, name: string) {
    return {
      name,
      calibrated: true,
      evaluate: async (req: { questions: Record<string, { type?: string }> }) => {
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(req.questions)) {
          answers[id] =
            q.type === "noul" ? { type: "noul", noul } : { type: "choice", choice: "", probabilities: {}, confidence: 0 };
        }
        return {
          engine: name,
          model: "m",
          answers,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: null, requests: 1 },
          latencyMs: 1,
        };
      },
    };
  }

  it("answers from one authoritative source when the engine is confident", async () => {
    // The count floors must not veto a confident sufficiency verdict. "What does the
    // high water mark do" is answered completely by one page, and blocking it for
    // want of a second source is abstention working against itself.
    const out = await run({
      gated: [evidence[0]!],
      decisions: new DecisionService(fixedEngine(0.9, "confident") as never, null),
      generator: stubGenerator([
        {
          answer: "It is a threshold on the internal buffer.",
          claims: [{ text: "It is a threshold on the internal buffer.", sources: ["a"] }],
        },
      ]),
    });
    expect(out.abstained).toBe(false);
    expect(out.answer).toBeTruthy();
  });

  it("still withholds a single source when the engine is not confident", async () => {
    // The floor exists for exactly this: one thin passage and a hesitant engine.
    const out = await run({
      gated: [evidence[0]!],
      decisions: new DecisionService(fixedEngine(0.3, "hesitant") as never, null),
    });
    expect(out.abstained).toBe(true);
    expect(out.abstainedReason).toBe("insufficient_evidence");
  });

  it("withholds on zero evidence however sure the engine sounds", async () => {
    // Zero evidence is zero evidence. Confidence is not a substitute for having read
    // anything.
    const out = await run({
      gated: [],
      decisions: new DecisionService(fixedEngine(0.99, "confident") as never, null),
    });
    expect(out.abstained).toBe(true);
    expect(out.abstainedReason).toBe("no_evidence");
  });
});
