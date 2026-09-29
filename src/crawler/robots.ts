/**
 * robots.txt parsing and per-host politeness.
 *
 * Hand-rolled rather than a dependency: the rules that matter are longest-match
 * path precedence, `*`/`$` wildcards, and Crawl-delay, and the pipeline needs
 * Crawl-delay as a *number* to feed the scheduler.
 */

import { log } from "../util/log.js";
import type { Config } from "../config.js";

interface Rule {
  pattern: string;
  allow: boolean;
  regex: RegExp;
  length: number;
}

interface HostPolicy {
  rules: Rule[];
  crawlDelayMs: number;
  fetchedAt: number;
  status: number | null;
}

const TTL_MS = 6 * 60 * 60 * 1000;

export class RobotsCache {
  private hosts = new Map<string, HostPolicy>();
  private inflight = new Map<string, Promise<HostPolicy>>();

  constructor(private readonly cfg: Config) {}

  async isAllowed(url: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.cfg.CRAWL_RESPECT_ROBOTS) return true;
    const parsed = safeUrl(url);
    if (!parsed) return false;
    const policy = await this.policyFor(parsed, signal);
    if (policy.status === null && policy.rules.length === 0) return true; // no robots.txt => allowed
    const path = parsed.pathname + parsed.search;
    let best: Rule | null = null;
    for (const rule of policy.rules) {
      if (!rule.regex.test(path)) continue;
      if (!best || rule.length > best.length) best = rule;
    }
    if (!best) return true;
    return best.allow;
  }

  /** Politeness delay for a host: its Crawl-delay, else the configured default. */
  delayFor(url: string): number {
    const parsed = safeUrl(url);
    if (!parsed) return this.cfg.CRAWL_DELAY_MS;
    const policy = this.hosts.get(parsed.host);
    if (!policy || policy.crawlDelayMs <= 0) return this.cfg.CRAWL_DELAY_MS;
    return Math.max(this.cfg.CRAWL_DELAY_MS, policy.crawlDelayMs);
  }

  /** Rules that name this agent specifically, so a crawler can extract a sitemap url. */
  async sitemapsFor(url: string, signal?: AbortSignal): Promise<string[]> {
    const parsed = safeUrl(url);
    if (!parsed) return [];
    const origin = parsed.origin;
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { "User-Agent": this.cfg.CRAWL_USER_AGENT },
        signal,
      });
      if (!res.ok) return [];
      const text = await res.text();
      return parseSitemaps(text, this.cfg.CRAWL_USER_AGENT);
    } catch {
      return [];
    }
  }

  private async policyFor(url: URL, signal?: AbortSignal): Promise<HostPolicy> {
    const key = url.host;
    const cached = this.hosts.get(key);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached;
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const promise = (async (): Promise<HostPolicy> => {
      const policy: HostPolicy = { rules: [], crawlDelayMs: 0, fetchedAt: Date.now(), status: null };
      try {
        const res = await fetch(`${url.origin}/robots.txt`, {
          headers: { "User-Agent": this.cfg.CRAWL_USER_AGENT },
          signal,
        });
        policy.status = res.status;
        if (res.ok) {
          const text = await res.text();
          const parsed = parseRobots(text, this.cfg.CRAWL_USER_AGENT);
          policy.rules = parsed.rules;
          policy.crawlDelayMs = parsed.crawlDelayMs;
        }
      } catch (err) {
        // A missing or unreachable robots.txt is not a licence to hammer the host.
        log.debug("robots fetch failed", { host: key, err: String(err) });
        policy.rules = [];
        policy.crawlDelayMs = 0;
        policy.status = null;
      }
      this.hosts.set(key, policy);
      this.inflight.delete(key);
      return policy;
    })();
    this.inflight.set(key, promise);
    return promise;
  }
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function parseRobots(
  text: string,
  userAgent: string,
): { rules: Rule[]; crawlDelayMs: number } {
  const agent = userAgent.toLowerCase().split("/")[0] ?? "*";
  const groups: { agents: string[]; rules: Rule[]; crawlDelay: number }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if (field === "disallow" || field === "allow") {
      if (value === "" && field === "disallow") continue; // "Disallow:" means allow all
      const regex = patternToRegex(value);
      if (regex) current.rules.push({ pattern: value, allow: field === "allow", regex, length: value.length });
    } else if (field === "crawl-delay") {
      const seconds = Number(value.replace(",", "."));
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds * 1000;
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = specific.length > 0 ? specific : wildcard;
  const rules = chosen.flatMap((g) => g.rules);
  const crawlDelayMs = chosen.reduce((max, g) => Math.max(max, g.crawlDelay), 0);
  return { rules, crawlDelayMs };
}

function patternToRegex(pattern: string): RegExp | null {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "$") source += "$";
    else source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  // A trailing $ was consumed above as an anchor; anything after it is literal.
  try {
    return new RegExp(`^${source}`);
  } catch {
    return null;
  }
}

export function parseSitemaps(text: string, userAgent: string): string[] {
  const agent = userAgent.toLowerCase().split("/")[0] ?? "*";
  const out: string[] = [];
  let applies = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      const a = value.toLowerCase();
      applies = a === "*" || agent.includes(a);
    } else if (field === "sitemap" && applies) {
      if (safeUrl(value)) out.push(value);
    }
  }
  return [...new Set(out)];
}
