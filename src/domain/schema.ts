/**
 * Request validation.
 *
 * Tavily's `/search` body is accepted as-is, plus a handful of jevily-only knobs
 * that are all namespaced or clearly opt-in. Unknown fields are stripped rather
 * than rejected, so a Tavily client sending a field we do not implement still works.
 */

import { z } from "zod";
import { config } from "../config.js";
import type { AnswerMode, RawContentFormat, SearchRequest } from "./types.js";

const depth = z.enum(["fast", "basic", "advanced"]);
const topic = z.enum(["general", "news", "finance"]);
const timeRange = z.enum(["day", "week", "month", "year"]);
const domains = z.array(z.string().min(1).max(253)).max(300);

export const searchBodySchema = z
  .object({
    query: z.string().min(1).max(8_000),

    search_depth: depth.optional(),
    chunks_per_source: z.number().int().min(1).max(3).optional(),
    max_results: z.number().int().min(0).max(20).optional(),
    topic: topic.optional(),
    time_range: timeRange.nullish(),
    start_date: z.iso.date().optional(),
    end_date: z.iso.date().optional(),
    include_published_date: z.boolean().optional(),
    filter_by_published_date: z.boolean().optional(),
    include_answer: z.union([z.boolean(), z.enum(["basic", "advanced"])]).optional(),
    include_raw_content: z.union([z.boolean(), z.enum(["markdown", "text"])]).optional(),
    include_images: z.boolean().optional(),
    include_image_descriptions: z.boolean().optional(),
    include_favicon: z.boolean().optional(),
    include_domains: domains.optional(),
    exclude_domains: domains.optional(),
    include_domains_mode: z.enum(["restrict", "prefer"]).optional(),
    country: z.string().max(64).optional(),
    language: z.string().max(32).optional(),
    filter_by_language: z.boolean().optional(),
    exact_match: z.boolean().optional(),
    auto_parameters: z.boolean().optional(),
    safe_search: z.boolean().optional(),
    include_usage: z.boolean().optional(),
    include_trace: z.boolean().optional(),

    // jevily
    candidate_pool: z.number().int().min(10).max(200).optional(),
    max_rounds: z.number().int().min(1).max(3).optional(),
    verify_citations: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.include_domains?.length && value.include_domains_mode === undefined) {
      // Tavily defaults to restrict; we accept the omission.
    }
    if (value.filter_by_language && !value.language) {
      ctx.addIssue({
        code: "custom",
        path: ["filter_by_language"],
        message: "filter_by_language requires language",
      });
    }
    if (value.include_domains_mode && !value.include_domains?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["include_domains_mode"],
        message: "include_domains_mode requires include_domains",
      });
    }
    if (value.start_date && value.end_date && value.start_date > value.end_date) {
      ctx.addIssue({ code: "custom", path: ["start_date"], message: "start_date must be before end_date" });
    }
    if (value.time_range && (value.start_date || value.end_date)) {
      ctx.addIssue({
        code: "custom",
        path: ["time_range"],
        message: "time_range cannot be combined with start_date or end_date",
      });
    }
  });

export const extractBodySchema = z
  .object({
    urls: z.union([z.string().url(), z.array(z.string().url()).min(1).max(20)]),
    include_images: z.boolean().optional(),
    extract_depth: z.enum(["basic", "advanced"]).optional(),
    format: z.enum(["markdown", "text"]).optional(),
  })
  .strict();

export const crawlBodySchema = z
  .object({
    url: z.string().url(),
    mode: z.enum(["page", "site", "queue"]).default("page"),
    max_depth: z.number().int().min(0).max(6).optional(),
    max_pages: z.number().int().min(1).max(500).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export const indexBodySchema = z
  .object({
    urls: z.union([z.string().url(), z.array(z.string().url()).min(1).max(50)]),
    mode: z.enum(["page", "site"]).default("page"),
    force: z.boolean().optional(),
  })
  .strict();

export const evaluateBodySchema = z
  .object({
    state: z.unknown(),
    questions: z
      .record(
        z.string(),
        z.union([
          z.object({ type: z.literal("noul"), instructions: z.unknown(), criteria: z.unknown().optional() }),
          z.object({ type: z.literal("choice"), instructions: z.unknown(), criteria: z.record(z.string(), z.unknown().nullable()) }),
          z.object({ type: z.literal("score"), instructions: z.unknown(), criteria: z.array(z.unknown()) }),
        ]),
      )
      .refine((q) => Object.keys(q).length > 0, "at least one question"),
    model: z.string().optional(),
  })
  .strict();

/** Tavily lets `true` mean "basic" / "markdown". Keep the same shorthand. */
function normalizeAnswerMode(value: boolean | "basic" | "advanced" | undefined): AnswerMode {
  if (value === undefined || value === false) return false;
  return value === true ? "basic" : value;
}

function normalizeRawFormat(value: boolean | "markdown" | "text" | undefined): RawContentFormat {
  if (value === undefined || value === false) return false;
  return value === true ? "markdown" : value;
}

export function normalizeSearchRequest(input: z.infer<typeof searchBodySchema>): SearchRequest {
  const c = config();
  return {
    query: input.query,
    search_depth: input.search_depth ?? "basic",
    max_results: input.max_results ?? c.DEFAULT_MAX_RESULTS,
    topic: input.topic ?? "general",
    time_range: input.time_range ?? null,
    ...(input.start_date ? { start_date: input.start_date } : {}),
    ...(input.end_date ? { end_date: input.end_date } : {}),
    include_answer: normalizeAnswerMode(input.include_answer),
    include_raw_content: normalizeRawFormat(input.include_raw_content),
    include_published_date: input.include_published_date ?? false,
    filter_by_published_date: input.filter_by_published_date ?? false,
    ...(input.include_domains ? { include_domains: input.include_domains } : {}),
    ...(input.exclude_domains ? { exclude_domains: input.exclude_domains } : {}),
    ...(input.include_domains_mode ? { include_domains_mode: input.include_domains_mode } : {}),
    ...(input.country ? { country: input.country } : {}),
    ...(input.language ? { language: input.language } : {}),
    filter_by_language: input.filter_by_language ?? false,
    exact_match: input.exact_match ?? false,
    auto_parameters: input.auto_parameters ?? false,
    safe_search: input.safe_search ?? false,
    ...(input.candidate_pool ? { candidate_pool: input.candidate_pool } : {}),
    ...(input.max_rounds !== undefined ? { max_rounds: input.max_rounds } : {}),
    ...(input.include_trace !== undefined ? { include_trace: input.include_trace } : {}),
    ...(input.verify_citations !== undefined ? { verify_citations: input.verify_citations } : {}),
  };
}
