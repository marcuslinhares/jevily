import { MockDecisionEngine } from "../src/decision/mock.js";
import { DecisionService, createDecisionService } from "../src/decision/service.js";
import { route, applyDomainDiversity, evidenceScore } from "../src/pipeline/gate.js";
import { resolvePolicy, constraintPenalty } from "../src/pipeline/policy.js";
import { citationQuestions, gateQuestions, queryUnderstandingQuestions, rerankQuestions } from "../src/decision/questions.js";
import { buildAnswerSchemaForTest, type TypedSchema } from "./helpers/schema.js";

/** Reads one field out of a generated answer schema without a pile of casts. */
function field(schema: TypedSchema, question: string, name: string) {
  const answer = schema.properties.answers.properties[question];
  const value = answer?.properties?.[name];
  if (!value) throw new Error(`schema has no ${question}.${name}`);
  return value;
}
import { searchBodySchema, normalizeSearchRequest } from "../src/domain/schema.js";

describe("question library", () => {
  it("every question type is well formed", () => {
    for (const batch of [queryUnderstandingQuestions(), rerankQuestions(), gateQuestions(), citationQuestions()]) {
      for (const [id, question] of Object.entries(batch)) {
        expect(id, `question ${id} has an id`).toBeTruthy();
        expect(question.type, `question ${id} has a type`).toMatch(/noul|choice|score/);
        expect(question.instructions, `question ${id} has instructions`).toBeTruthy();
        if (question.type === "choice") {
          expect(Object.keys(question.criteria).length, `${id} has options`).toBeGreaterThan(1);
          expect(Object.keys(question.criteria).length, `${id} within the 255 cap`).toBeLessThanOrEqual(255);
        }
        if (question.type === "score") {
          expect(question.criteria.length, `${id} has at least two levels`).toBeGreaterThanOrEqual(2);
          expect(question.criteria.length, `${id} within the 10 level cap`).toBeLessThanOrEqual(10);
        }
        if (question.type === "noul" && question.criteria) {
          expect(question.criteria.true, `${id} defines true`).toBeTruthy();
          expect(question.criteria.false, `${id} defines false`).toBeTruthy();
        }
      }
    }
  });

  it("defines both sides of every gate question, because the routing depends on them", () => {
    for (const [id, question] of Object.entries(gateQuestions())) {
      expect(question.type, `${id} is a noul`).toBe("noul");
      const criteria = question.criteria as { true?: unknown; false?: unknown } | undefined;
      expect(criteria?.true, `${id}.true`).toBeTruthy();
      expect(criteria?.false, `${id}.false`).toBeTruthy();
    }
  });
});

describe("mock decision engine", () => {
  const engine = new MockDecisionEngine(0);

  it("is deterministic for the same state and questions", async () => {
    const questions = rerankQuestions();
    const state = { query: "backpressure node streams", candidate: { text: "backpressure in node streams" } };
    const a = await engine.evaluate({ state, questions });
    const b = await engine.evaluate({ state, questions });
    expect(a.answers).toEqual(b.answers);
  });

  it("scores an overlapping passage above an unrelated one", async () => {
    const query = "how does node stream backpressure work";
    const questions = { relevant: rerankQuestions().relevance! };
    const good = await engine.evaluate({ state: { query, candidate: { text: query } }, questions });
    const bad = await engine.evaluate({ state: { query, candidate: { text: "sourdough starter maintenance" } }, questions });
    const goodScore = (good.answers.relevant as { noul: number }).noul;
    const badScore = (bad.answers.relevant as { noul: number }).noul;
    expect(goodScore).toBeGreaterThan(badScore);
    expect(goodScore).toBeGreaterThan(0.5);
  });

  it("reports itself as uncalibrated so thresholds widen", () => {
    expect(engine.calibrated).toBe(false);
  });

  it("returns every requested answer", async () => {
    const result = await engine.evaluate({ state: "x", questions: queryUnderstandingQuestions() });
    expect(Object.keys(result.answers).sort()).toEqual(Object.keys(queryUnderstandingQuestions()).sort());
  });
});

describe("decision service", () => {
  it("degrades to neutral defaults when the engine throws", async () => {
    const broken = {
      name: "broken",
      calibrated: true,
      evaluate: async () => {
        throw new Error("boom");
      },
    };
    const service = new DecisionService(broken as never, null);
    const answers = await service.evaluate("test", "state", {
      is_yes: { type: "noul", instructions: "is it?" },
      which: { type: "choice", instructions: "which?", criteria: { a: "a", b: "b" } },
    });
    expect(service.noul(answers, "is_yes")).toBe(0.5);
    expect(service.choice(answers, "which", "a").choice).toBe("a");
    expect(service.degraded).toBeGreaterThan(0);
  });

  it("serves a repeated batch from cache without calling the engine again", async () => {
    let calls = 0;
    const counting = {
      name: "counting",
      calibrated: true,
      evaluate: async () => {
        calls++;
        return {
          engine: "counting",
          model: "m",
          answers: { q: { type: "noul", noul: 0.9 } },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: null, requests: 1 },
          latencyMs: 1,
        };
      },
    };
    const service = createDecisionService(counting as never);
    const questions = { q: { type: "noul", instructions: "is it?" } as const };
    await service.evaluate("a", "same state", questions);
    await service.evaluate("b", "same state", questions);
    expect(calls).toBe(1);
  });

  it("computes an expected level from a score distribution", async () => {
    const engine = new MockDecisionEngine(0);
    const service = new DecisionService(engine, null);
    const answers = await service.evaluate("s", "some text about cooking", {
      level: { type: "score", instructions: "how technical", criteria: ["simple", "medium", "hard"] },
    });
    const level = service.expectedLevel(answers, "level", 3);
    expect(level).toBeGreaterThanOrEqual(0);
    expect(level).toBeLessThanOrEqual(2);
  });
});

describe("policy", () => {
  it("makes inclusion harder and exclusion easier when uncalibrated", () => {
    const calibrated = resolvePolicy(true);
    const uncalibrated = resolvePolicy(false);
    expect(uncalibrated.gate.evidenceMin).toBeGreaterThan(calibrated.gate.evidenceMin);
    expect(uncalibrated.gate.injectionMax).toBeLessThan(calibrated.gate.injectionMax);
    expect(uncalibrated.rerank.keepAbove).toBeGreaterThan(calibrated.rerank.keepAbove);
    expect(uncalibrated.abstain.minTopScore).toBeGreaterThan(calibrated.abstain.minTopScore);
  });

  it("penalizes a violated constraint harder when the engine is uncalibrated", () => {
    expect(constraintPenalty(true, resolvePolicy(true))).toBeLessThan(constraintPenalty(true, resolvePolicy(false)));
  });
});

describe("gating routes", () => {
  const policy = resolvePolicy(true);

  it("excludes an injection regardless of relevance", () => {
    const signals = { relevant: 0.95, usable_evidence: 0.95, contradicts_premise: 0.1, prompt_injection: 0.99, advertisement: 0.1 };
    expect(route(signals, policy)).toBe("exclude");
  });

  it("routes a premise contradiction to the conflict block even when it is relevant", () => {
    const signals = { relevant: 0.9, usable_evidence: 0.9, contradicts_premise: 0.92, prompt_injection: 0.1, advertisement: 0.1 };
    expect(route(signals, policy)).toBe("conflicting");
  });

  it("includes a clean, relevant, evidence-bearing passage", () => {
    const signals = { relevant: 0.9, usable_evidence: 0.9, contradicts_premise: 0.05, prompt_injection: 0.1, advertisement: 0.1 };
    expect(route(signals, policy)).toBe("include");
  });

  it("drops an off-topic passage", () => {
    const signals = { relevant: 0.1, usable_evidence: 0.8, contradicts_premise: 0.05, prompt_injection: 0.1, advertisement: 0.1 };
    expect(route(signals, policy)).toBe("exclude");
  });

  it("drops an advertisement", () => {
    const signals = { relevant: 0.9, usable_evidence: 0.9, contradicts_premise: 0.05, prompt_injection: 0.1, advertisement: 0.95 };
    expect(route(signals, policy)).toBe("exclude");
  });
});

describe("domain diversity", () => {
  const candidate = (id: string, domain: string, composite: number) =>
    ({ chunk: { id, url: `https://${domain}/${id}` }, doc: { domain }, composite, route: "include" }) as never;

  it("caps results per domain and defers the overflow", () => {
    const input = [
      candidate("1", "a.test", 0.9),
      candidate("2", "a.test", 0.88),
      candidate("3", "a.test", 0.86),
      candidate("4", "b.test", 0.7),
    ];
    const { kept, deferred } = applyDomainDiversity(input, 2, 1);
    expect(kept.map((k) => k.chunk.id)).toEqual(["1", "2", "4"]);
    expect(deferred.map((d) => d.chunk.id)).toEqual(["3"]);
  });

  it("does not over-cap when diversity would otherwise be impossible", () => {
    const input = [candidate("1", "a.test", 0.9), candidate("2", "a.test", 0.88), candidate("3", "a.test", 0.86)];
    const { kept } = applyDomainDiversity(input, 1, 2);
    expect(kept).toHaveLength(2);
  });
});

describe("evidence score", () => {
  it("is zero with no evidence and rises with depth and top score", () => {
    expect(evidenceScore([])).toBe(0);
    const one = [{ composite: 0.9 }] as never;
    const many = [{ composite: 0.9 }, { composite: 0.5 }, { composite: 0.5 }, { composite: 0.5 }] as never;
    expect(evidenceScore(many)).toBeGreaterThan(evidenceScore(one));
  });
});

describe("request validation", () => {
  it("accepts a Tavily-shaped body", () => {
    const parsed = searchBodySchema.parse({
      query: "who is Leo Messi?",
      search_depth: "advanced",
      max_results: 5,
      include_answer: "advanced",
      include_raw_content: "markdown",
      include_domains: ["britannica.com"],
    });
    const normalized = normalizeSearchRequest(parsed);
    expect(normalized.query).toBe("who is Leo Messi?");
    expect(normalized.include_answer).toBe("advanced");
    expect(normalized.include_raw_content).toBe("markdown");
  });

  it("maps the boolean shorthand the way Tavily does", () => {
    expect(normalizeSearchRequest(searchBodySchema.parse({ query: "x", include_answer: true })).include_answer).toBe("basic");
    expect(normalizeSearchRequest(searchBodySchema.parse({ query: "x", include_raw_content: true })).include_raw_content).toBe("markdown");
    expect(normalizeSearchRequest(searchBodySchema.parse({ query: "x" })).include_answer).toBe(false);
  });

  it("rejects combinations that cannot be honoured", () => {
    expect(searchBodySchema.safeParse({ query: "x", filter_by_language: true }).success).toBe(false);
    expect(searchBodySchema.safeParse({ query: "x", include_domains_mode: "restrict" }).success).toBe(false);
    expect(searchBodySchema.safeParse({ query: "x", time_range: "week", start_date: "2025-01-01" }).success).toBe(false);
    expect(searchBodySchema.safeParse({ query: "x", start_date: "2025-05-01", end_date: "2025-01-01" }).success).toBe(false);
  });

  it("keeps jevily-only knobs", () => {
    const normalized = normalizeSearchRequest(
      searchBodySchema.parse({ query: "x", include_trace: true, candidate_pool: 120, max_rounds: 2 }),
    );
    expect(normalized.include_trace).toBe(true);
    expect(normalized.candidate_pool).toBe(120);
    expect(normalized.max_rounds).toBe(2);
  });

  it("requires a query", () => {
    expect(searchBodySchema.safeParse({}).success).toBe(false);
  });
});

describe("openrouter answer schema", () => {
  it("covers exactly the questions asked", () => {
    const questions = rerankQuestions();
    const schema = buildAnswerSchemaForTest(questions);
    expect([...schema.properties.answers.required].sort()).toEqual(Object.keys(questions).sort());
  });

  it("constrains a noul to a number in [0,1]", () => {
    const schema = buildAnswerSchemaForTest(rerankQuestions());
    const noul = field(schema, "relevance", "noul");
    expect(noul.type).toBe("number");
    expect(noul.minimum).toBe(0);
    expect(noul.maximum).toBe(1);
  });

  it("closes the choice option set to the caller's own options", () => {
    const schema = buildAnswerSchemaForTest({
      topic: { type: "choice", instructions: "which topic", criteria: { news: "n", finance: "f" } },
    });
    expect(field(schema, "topic", "choice").enum).toEqual(["news", "finance"]);
  });

  it("closes the score distribution to the level indices", () => {
    const schema = buildAnswerSchemaForTest({
      how_hard: { type: "score", instructions: "how hard", criteria: ["easy", "hard"] },
    });
    const probabilities = field(schema, "how_hard", "probabilities");
    expect(probabilities.properties?.["0"]).toBeDefined();
    expect(probabilities.properties?.["1"]).toBeDefined();
    expect(probabilities.properties?.["2"]).toBeUndefined();
  });

  it("marks nothing as extra, so the model cannot invent an answer key", () => {
    const schema = buildAnswerSchemaForTest({ is_it: { type: "noul", instructions: "is it?" } });
    expect(schema.properties.answers.additionalProperties).toBe(false);
  });
});
