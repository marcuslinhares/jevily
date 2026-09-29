/**
 * Domain types for the public API.
 *
 * The request/response shape is a superset of Tavily's `/search`, so an existing
 * Tavily client works against jevily unchanged. Everything jevily adds is either
 * opt-in or sits under a namespaced key (`trace`, `diagnostics`, `citations`) so a
 * drop-in client never trips over it.
 */

export type SearchDepth = "fast" | "basic" | "advanced";
export type Topic = "general" | "news" | "finance";
export type TimeRange = "day" | "week" | "month" | "year" | null;
export type RawContentFormat = "markdown" | "text" | false;
export type AnswerMode = false | "basic" | "advanced";

export interface SearchRequest {
  query: string;
  search_depth?: SearchDepth;
  max_results?: number;
  topic?: Topic;
  time_range?: TimeRange;
  start_date?: string;
  end_date?: string;
  include_answer?: AnswerMode;
  include_raw_content?: RawContentFormat;
  include_published_date?: boolean;
  filter_by_published_date?: boolean;
  include_domains?: string[];
  exclude_domains?: string[];
  include_domains_mode?: "restrict" | "prefer";
  country?: string;
  language?: string;
  filter_by_language?: boolean;
  exact_match?: boolean;
  safe_search?: boolean;
  /** Allow the decision engine to override derived parameters. */
  auto_parameters?: boolean;
  /** jevily: cap the candidate pool the decision engine reranks. */
  candidate_pool?: number;
  /** jevily: ask for a multi-round search when the plan calls for it. */
  max_rounds?: number;
  /** jevily: return the full decision trace. */
  include_trace?: boolean;
  /** jevily: verify each claim against its source. */
  verify_citations?: boolean;
}

export interface Citation {
  /** Index into `results`, plus the quoted span. */
  result_id: string;
  url: string;
  quote: string;
  /** P(the source supports the claim). From the decision engine. */
  support: number;
  /** The engine's own confidence in that support number. */
  confidence: number;
  verified: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  content: string;
  score: number;
  /** Component scores, for debugging ranking. Omitted unless include_trace. */
  raw_content?: string | null;
  published_date?: string | null;
  /** How the decision engine treated this passage. */
  route?: "include" | "conflicting" | "excluded";
  diagnostics?: ResultDiagnostics;
}

export interface ResultDiagnostics {
  rerank: Record<string, number>;
  lexical: number;
  dense: number | null;
  fused: number;
  composite: number;
  gate?: Record<string, number>;
}

export interface SearchResponse {
  query: string;
  answer: string | null;
  /** True when evidence was too weak to write an answer. `answer` is then null. */
  abstained: boolean;
  results: SearchResult[];
  response_time: number;
  /** How the pipeline decided to search, before it searched. */
  plan?: QueryPlanEcho;
  citations?: Citation[];
  trace?: unknown;
  request_id: string;
  usage?: { decision_input_tokens: number; decision_output_tokens: number; decision_requests: number };
}

export interface QueryPlanEcho {
  intent: string;
  topic: string;
  answer_shape: string;
  search_depth: SearchDepth;
  candidate_pool: number;
  rounds: number;
  time_horizon: number;
  complexity: number;
  ambiguity: number;
  expand_query: boolean;
  requires_exact_phrase: boolean;
  engine: string;
  calibrated: boolean;
}
