import { describe, expect, it } from "vitest";
import { loadConfig, resolveDecisionEngine } from "../src/config.js";

/** The host a key has to reach, so a mismatch is visible without a network call. */
function host(config: ReturnType<typeof loadConfig>): string {
  return config.DECISION_BASE_URL.replace("https://", "").split("/")[0] ?? "";
}

const TYPESAFE_KEY = "tsk-not-a-real-key";
const OPENROUTER_KEY = "sk-or-v1-not-a-real-key";

describe("decision engine configuration", () => {
  it("sends an OpenRouter key to OpenRouter", () => {
    const c = loadConfig({ OPENROUTER_API_KEY: OPENROUTER_KEY } as NodeJS.ProcessEnv);
    expect(c.DECISION_API_KEY).toBe(OPENROUTER_KEY);
    expect(host(c)).toBe("openrouter.ai");
  });

  it("sends a TypeSafe key to TypeSafe", () => {
    const c = loadConfig({ DECISION_API_KEY: TYPESAFE_KEY } as NodeJS.ProcessEnv);
    expect(c.DECISION_API_KEY).toBe(TYPESAFE_KEY);
    expect(host(c)).toBe("api.typesafe.ai");
  });

  it("pairs the key with the host it belongs to when both providers are configured", () => {
    // This one sent a TypeSafe key to OpenRouter, which answered 401. Every judgement
    // in the pipeline then degraded to its default while the response still came back
    // complete and plausible — a whole measurement run looked like a result.
    const c = loadConfig({
      DECISION_API_KEY: TYPESAFE_KEY,
      OPENROUTER_API_KEY: OPENROUTER_KEY,
    } as NodeJS.ProcessEnv);
    expect(c.DECISION_API_KEY).toBe(TYPESAFE_KEY);
    expect(host(c)).toBe("api.typesafe.ai");
  });

  it("recognises an OpenRouter key passed as DECISION_API_KEY", () => {
    const c = loadConfig({ DECISION_API_KEY: OPENROUTER_KEY } as NodeJS.ProcessEnv);
    expect(host(c)).toBe("openrouter.ai");
  });

  it("lets an explicit base URL win over the derived one", () => {
    const c = loadConfig({
      DECISION_API_KEY: TYPESAFE_KEY,
      OPENROUTER_API_KEY: OPENROUTER_KEY,
      DECISION_BASE_URL: "https://api.typesafe.ai",
    } as NodeJS.ProcessEnv);
    expect(host(c)).toBe("api.typesafe.ai");
  });

  it("routes to systemone when a key is present and to the mock when none is", () => {
    expect(resolveDecisionEngine(loadConfig({ OPENROUTER_API_KEY: OPENROUTER_KEY } as NodeJS.ProcessEnv))).toBe(
      "systemone",
    );
    expect(resolveDecisionEngine(loadConfig({} as NodeJS.ProcessEnv))).toBe("mock");
  });
});
