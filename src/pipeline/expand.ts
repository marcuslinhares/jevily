/**
 * Query expansion.
 *
 * The decision engine decides *whether* to expand and *what kind*; a generator
 * model writes the actual strings. Keeping those two roles apart is the whole
 * point: the expensive, judgement-heavy call is a typed decision, and the
 * generative call is a plain, replaceable completion.
 */

import type { QueryPlan } from "../decision/questions.js";
import type { Generator } from "../llm/generator.js";
import { expandQuery } from "../llm/generator.js";

export type ExpansionStrategy = QueryPlan["expansionStrategy"];

/** The plan plus the code-detected language, which no model needs to supply. */
export interface QueryPlanLike extends QueryPlan {
  language: string;
}

export async function buildQueries(
  generator: Generator | null,
  query: string,
  plan: QueryPlanLike,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!plan.expandQuery || plan.expansionStrategy === "none") return [query];
  const expanded = await expandQuery(generator, query, plan.expansionStrategy, plan.language, signal);
  return dedupe(expanded);
}

/** Second-round queries are derived from what the first round actually found. */
export function followUpQueries(query: string, evidenceTitles: string[], max = 2): string[] {
  const out: string[] = [];
  for (const title of evidenceTitles) {
    const trimmed = title.replace(/\s*[|—–-]\s*[^|—–-]{0,40}$/, "").trim();
    if (trimmed.length < 8 || trimmed.length > 120) continue;
    if (trimmed.toLowerCase() === query.toLowerCase()) continue;
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return dedupe(out);
}

function dedupe(queries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of queries) {
    const key = q.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q.trim());
  }
  return out;
}
