/**
 * Engine factory.
 *
 * `auto` prefers the real System One model — reachable with either a TypeSafe key
 * or an OpenRouter key, since OpenRouter proxies the same `/v1/systemone` path —
 * and only falls back to approximating it when no key is configured.
 *
 * The `openrouter` engine below is the approximation: a chat model with a strict
 * JSON schema. It is deliberately the second choice, not the first.
 */

import { config, resolveDecisionEngine } from "../config.js";
import { log } from "../util/log.js";
import { SystemOneEngine } from "./jev.js";
import { OpenRouterDecisionEngine } from "./openrouter.js";
import { MockDecisionEngine } from "./mock.js";
import type { DecisionEngine } from "./types.js";

export function createEngine(): DecisionEngine {
  const c = config();
  const selected = resolveDecisionEngine(c);

  if (selected === "systemone") {
    if (!c.DECISION_API_KEY) {
      log.warn("DECISION_API_KEY missing, falling back to the mock decision engine");
      return new MockDecisionEngine();
    }
    return new SystemOneEngine(c.DECISION_API_KEY);
  }
  if (selected === "openrouter") {
    if (!c.OPENROUTER_API_KEY) {
      log.warn("OPENROUTER_API_KEY missing, falling back to the mock decision engine");
      return new MockDecisionEngine();
    }
    return new OpenRouterDecisionEngine(c.OPENROUTER_API_KEY);
  }
  return new MockDecisionEngine();
}

export * from "./types.js";
export { SystemOneEngine, JevEngine } from "./jev.js";
export { OpenRouterDecisionEngine } from "./openrouter.js";
export { MockDecisionEngine } from "./mock.js";
export { DecisionService, createDecisionService, decision, setDecisionEngine, decisionCacheSize } from "./service.js";
