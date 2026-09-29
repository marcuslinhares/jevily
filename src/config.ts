/**
 * Runtime configuration.
 *
 * Hand-rolled rather than schema-driven: the env surface is flat, the coercions
 * are trivial, and a hand-written reader keeps the types exact and the failure
 * messages pointed at the variable you actually have to fix.
 *
 * Defaults are chosen so the server boots and serves traffic with zero secrets
 * configured (mock decision engine, no generator, no embeddings) — degraded, but
 * never crashing.
 */

export type DecisionEngineName = "auto" | "systemone" | "openrouter" | "mock";
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/**
 * Providers that speak the System One protocol at `{base}/v1/systemone`.
 *
 * Both entries use the *bare* `jev-latest` on purpose. OpenRouter maps bare System
 * One ids onto the `typesafe/` namespace itself, and `typesafe/jev-latest` is not a
 * real model id — only `typesafe/jev-1.13` is, which is what the alias resolves to.
 * The trace records the pinned build the provider actually served, so relying on the
 * alias costs nothing in observability.
 */
export const SYSTEMONE_PROVIDERS = {
  typesafe: { baseUrl: "https://api.typesafe.ai", model: "jev-latest" },
  openrouter: { baseUrl: "https://openrouter.ai/api", model: "jev-latest" },
} as const;

export interface Config {
  // server
  PORT: number;
  HOST: string;
  LOG_LEVEL: LogLevel;
  DATA_DIR: string;
  BODY_LIMIT_BYTES: number;
  API_KEYS: string[] | undefined;

  // decision engine
  DECISION_ENGINE: DecisionEngineName;
  /** Key for the System One endpoint. TypeSafe's own key, or an OpenRouter key. */
  DECISION_API_KEY: string | undefined;
  /** Host serving `/v1/systemone`, with no trailing `/v1`. */
  DECISION_BASE_URL: string;
  /** `typesafe/…` when routed through OpenRouter, bare when calling TypeSafe. */
  DECISION_MODEL: string;
  DECISION_CONCURRENCY: number;
  DECISION_TIMEOUT_MS: number;
  DECISION_MAX_RETRIES: number;
  DECISION_CACHE: boolean;
  DECISION_CACHE_TTL_S: number;
  /** Only for the uncalibrated `openrouter` engine (chat + json_schema). */
  DECISION_CHAT_MODEL: string;

  OPENROUTER_API_KEY: string | undefined;
  OPENROUTER_BASE_URL: string;

  // generation
  GENERATOR_PROVIDER: "openrouter" | "none";
  GENERATOR_MODEL: string;
  GENERATOR_TIMEOUT_MS: number;
  GENERATOR_MAX_TOKENS: number;

  // retrieval
  EMBEDDING_PROVIDER: "openrouter" | "none";
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMS: number;
  HYBRID_ENABLED: boolean;
  FUSION_RRF_K: number;

  // crawler
  CRAWL_CONCURRENCY: number;
  CRAWL_DELAY_MS: number;
  CRAWL_TIMEOUT_MS: number;
  CRAWL_MAX_BYTES: number;
  CRAWL_RESPECT_ROBOTS: boolean;
  CRAWL_MAX_PAGES_PER_HOST: number;
  CRAWL_USER_AGENT: string;

  // pipeline
  DEFAULT_MAX_RESULTS: number;
  DEFAULT_CANDIDATE_POOL: number;
  DEFAULT_CANDIDATES_RERANKED: number;
  ABSTAIN_ENABLED: boolean;
  VERIFY_CITATIONS: boolean;
}

class EnvError extends Error {}

function str(env: NodeJS.ProcessEnv, key: string, def: string): string {
  const value = env[key];
  return value === undefined || value === "" ? def : value;
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new EnvError(`${key} must be a number, got ${JSON.stringify(raw)}`);
  if (value < min || value > max) throw new EnvError(`${key} must be between ${min} and ${max}, got ${value}`);
  return value;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], def: T): T {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  if (!allowed.includes(raw as T)) {
    throw new EnvError(`${key} must be one of ${allowed.join(", ")}, got ${JSON.stringify(raw)}`);
  }
  return raw as T;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    const openrouterKey = optional(env, "OPENROUTER_API_KEY");
    // A System One key may be either provider's. If the host is OpenRouter, the
    // model id has to carry the `typesafe/` namespace, so both are derived together.
    const baseUrl = str(env, "DECISION_BASE_URL", openrouterKey ? SYSTEMONE_PROVIDERS.openrouter.baseUrl : SYSTEMONE_PROVIDERS.typesafe.baseUrl);
    const defaultModel = str(
      env,
      "DECISION_MODEL",
      baseUrl.includes("openrouter") ? SYSTEMONE_PROVIDERS.openrouter.model : SYSTEMONE_PROVIDERS.typesafe.model,
    );

    return {
      PORT: num(env, "PORT", 8787, 1, 65_535),
      HOST: str(env, "HOST", "0.0.0.0"),
      LOG_LEVEL: oneOf(env, "LOG_LEVEL", ["debug", "info", "warn", "error", "silent"] as const, "info"),
      DATA_DIR: str(env, "DATA_DIR", "./data"),
      BODY_LIMIT_BYTES: num(env, "BODY_LIMIT_BYTES", 1_048_576),
      API_KEYS: env.API_KEYS
        ? env.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean)
        : undefined,

      DECISION_ENGINE: oneOf(env, "DECISION_ENGINE", ["auto", "systemone", "openrouter", "mock"] as const, "auto"),
      DECISION_API_KEY: optional(env, "DECISION_API_KEY") ?? openrouterKey,
      DECISION_BASE_URL: baseUrl.replace(/\/$/, ""),
      DECISION_MODEL: defaultModel,
      DECISION_CONCURRENCY: num(env, "DECISION_CONCURRENCY", 8, 1, 64),
      DECISION_TIMEOUT_MS: num(env, "DECISION_TIMEOUT_MS", 30_000, 100),
      DECISION_MAX_RETRIES: num(env, "DECISION_MAX_RETRIES", 3, 1, 10),
      DECISION_CACHE: bool(env, "DECISION_CACHE", true),
      DECISION_CACHE_TTL_S: num(env, "DECISION_CACHE_TTL_S", 86_400),
      DECISION_CHAT_MODEL: str(env, "DECISION_CHAT_MODEL", "openai/gpt-4.1-mini"),

      OPENROUTER_API_KEY: openrouterKey,
      OPENROUTER_BASE_URL: str(env, "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),

      GENERATOR_PROVIDER: oneOf(env, "GENERATOR_PROVIDER", ["openrouter", "none"] as const, "none"),
      GENERATOR_MODEL: str(env, "GENERATOR_MODEL", "openai/gpt-4.1-mini"),
      GENERATOR_TIMEOUT_MS: num(env, "GENERATOR_TIMEOUT_MS", 60_000, 100),
      GENERATOR_MAX_TOKENS: num(env, "GENERATOR_MAX_TOKENS", 1_200, 64),

      EMBEDDING_PROVIDER: oneOf(env, "EMBEDDING_PROVIDER", ["openrouter", "none"] as const, "none"),
      EMBEDDING_MODEL: str(env, "EMBEDDING_MODEL", "openai/text-embedding-3-small"),
      EMBEDDING_DIMS: num(env, "EMBEDDING_DIMS", 512, 32, 4_096),
      HYBRID_ENABLED: bool(env, "HYBRID_ENABLED", true),
      FUSION_RRF_K: num(env, "FUSION_RRF_K", 60, 1, 1_000),

      CRAWL_CONCURRENCY: num(env, "CRAWL_CONCURRENCY", 4, 1, 32),
      CRAWL_DELAY_MS: num(env, "CRAWL_DELAY_MS", 1_000, 0),
      CRAWL_TIMEOUT_MS: num(env, "CRAWL_TIMEOUT_MS", 20_000, 100),
      CRAWL_MAX_BYTES: num(env, "CRAWL_MAX_BYTES", 3_000_000, 1_024),
      CRAWL_RESPECT_ROBOTS: bool(env, "CRAWL_RESPECT_ROBOTS", true),
      CRAWL_MAX_PAGES_PER_HOST: num(env, "CRAWL_MAX_PAGES_PER_HOST", 500, 1),
      CRAWL_USER_AGENT: str(env, "CRAWL_USER_AGENT", "jevily-bot/0.1 (+https://github.com/jevily)"),

      DEFAULT_MAX_RESULTS: num(env, "DEFAULT_MAX_RESULTS", 10, 1, 20),
      DEFAULT_CANDIDATE_POOL: num(env, "DEFAULT_CANDIDATE_POOL", 60, 10, 200),
      DEFAULT_CANDIDATES_RERANKED: num(env, "DEFAULT_CANDIDATES_RERANKED", 24, 4, 200),
      ABSTAIN_ENABLED: bool(env, "ABSTAIN_ENABLED", true),
      VERIFY_CITATIONS: bool(env, "VERIFY_CITATIONS", true),
    };
  } catch (err) {
    if (err instanceof EnvError) throw new Error(`Invalid environment: ${err.message}`);
    throw err;
  }
}

/**
 * Resolves `auto`.
 *
 * An OpenRouter key alone is enough for the calibrated engine: OpenRouter proxies
 * Jev at the same `/v1/systemone` path, so `auto` prefers the real decision model
 * over approximating it with structured outputs on a chat model.
 */
export function resolveDecisionEngine(c: Config): Exclude<DecisionEngineName, "auto"> {
  if (c.DECISION_ENGINE !== "auto") return c.DECISION_ENGINE;
  if (c.DECISION_API_KEY) return "systemone";
  return "mock";
}

let cached: Config | null = null;
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
