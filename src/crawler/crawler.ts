/**
 * The crawler: polite fetching, conditional re-fetches, sitemaps, and frontier work.
 *
 * It is the "own index" half of the product. Everything downstream assumes chunks
 * exist for a URL, so this module's job is to make that true cheaply and safely.
 */

import { config } from "../config.js";
import { log } from "../util/log.js";
import { mapPool, sleep } from "../util/async.js";
import { sha256 } from "../util/hash.js";
import { detectLanguage } from "../util/text.js";
import { extract, normalizeDate } from "./extract.js";
import { RobotsCache, safeUrl } from "./robots.js";
import { IndexManager, chunkDocument } from "../store/indexer.js";
import { isHttpUrl, type Store } from "../store/db.js";

export interface FetchResult {
  url: string;
  status: number;
  notModified: boolean;
  contentType: string;
  bytes: number;
  elapsedMs: number;
}

export interface CrawlOutcome {
  url: string;
  status: "indexed" | "unchanged" | "skipped" | "error" | "not_html";
  reason?: string;
  chunks?: number;
  discovered?: number;
  elapsedMs: number;
}

export interface CrawlerOptions {
  followInternalLinks?: boolean;
  maxDepth?: number;
  /** Stop after this many pages have been attempted. Not a response limit: the
   *  frontier is left intact so a later drain resumes where this one stopped. */
  maxPages?: number;
  /** Confines the crawl to a path prefix. See {@link scopeOf}. */
  scope?: string | null;
  signal?: AbortSignal;
  onProgress?: (outcome: CrawlOutcome) => void;
}

/**
 * The path prefix a seed confines its crawl to, or null for the whole host.
 *
 * Sitemaps are published per host, so seeding `https://nodejs.org/en/learn` and
 * filtering only by hostname yields every post on the site — nodejs.org publishes
 * 1651 URLs, of which 88 are the section that was asked for. Beyond being wasteful,
 * it makes the first N pages crawled whatever the sitemap happened to list first,
 * so a bounded crawl silently indexes the wrong subject. A root seed, or a seed that
 * names a file, keeps whole-host behaviour: there is no section to confine to.
 */
export function scopeOf(seed: URL): string | null {
  const path = seed.pathname;
  if (path === "" || path === "/") return null;
  if (/\.[a-z0-9]{1,8}$/i.test(path)) return null;
  return `${path.replace(/\/+$/, "")}/`;
}

/** True when `url` belongs to the crawl: same host, and under the scope if there is one. */
function inScope(url: string, origin: URL, scope: string | null): boolean {
  if (!isHttpUrl(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== origin.hostname) return false;
  return scope === null || parsed.pathname.startsWith(scope);
}

export class Crawler {
  private robots = new RobotsCache(config());
  private lastHitByHost = new Map<string, number>();
  private hostCounts = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly index: IndexManager,
  ) {}

  /**
   * Fetches one URL, extracts, chunks, stores and indexes it.
   * Conditional requests mean a re-crawl of an unchanged page costs one 304.
   */
  async crawlOne(input: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<CrawlOutcome> {
    const started = Date.now();
    const c = config();
    if (!isHttpUrl(input)) {
      return { url: input, status: "skipped", reason: "not a http(s) url", elapsedMs: 0 };
    }

    // A URL we already know redirects elsewhere is the same page: crawl the target,
    // so a re-crawl updates one document instead of adding a duplicate.
    const url = this.store.resolveAlias(input);
    const host = new URL(url).host;
    if ((this.hostCounts.get(host) ?? 0) >= c.CRAWL_MAX_PAGES_PER_HOST && !options.force) {
      return { url, status: "skipped", reason: "per-host page cap", elapsedMs: 0 };
    }
    if (!(await this.robots.isAllowed(url, options.signal))) {
      return { url, status: "skipped", reason: "robots.txt disallow", elapsedMs: 0 };
    }
    await this.waitTurn(host, options.signal);

    const existing = this.store.getDoc(url);
    const response = await this.fetch(url, existing, options);
    this.hostCounts.set(host, (this.hostCounts.get(host) ?? 0) + 1);

    // Remember the redirect so the spelling the caller used resolves here next time.
    if (response.finalUrl !== url) {
      this.store.putAlias(url, response.finalUrl);
      log.debug("redirect recorded", { from: url, to: response.finalUrl });
    }

    if (response.notModified && existing) {
      this.store.touchDoc(url, Date.now(), response.etag, response.lastModified);
      return { url, status: "unchanged", elapsedMs: Date.now() - started };
    }
    if (response.status !== 200) {
      return { url, status: "error", reason: `http ${response.status}`, elapsedMs: Date.now() - started };
    }
    const contentType = response.contentType.toLowerCase();
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      return { url, status: "not_html", reason: contentType || "unknown content type", elapsedMs: Date.now() - started };
    }

    const extracted = extract(response.body, response.finalUrl);
    if (extracted.text.length < 200) {
      return { url, status: "skipped", reason: "too little text after extraction", elapsedMs: Date.now() - started };
    }

    const finalUrl = extracted.canonicalUrl ?? response.finalUrl;
    const domain = new URL(finalUrl).hostname.replace(/^www\./, "");
    const markdown = extracted.markdown;

    // A <link rel=canonical> can point at a different path on the same site. That
    // is another spelling of one page, so alias it and store under the canonical.
    if (finalUrl !== url) this.store.putAlias(url, finalUrl);

    // The canonical target may already be indexed under its own row. Retire that
    // row first, or we would serve two URLs for identical content.
    if (finalUrl !== url && this.store.getDoc(finalUrl) && finalUrl !== response.finalUrl) {
      await this.index.removeDocument(finalUrl);
      this.store.deleteDoc(finalUrl);
    }

    this.store.upsertDoc({
      url: finalUrl,
      domain,
      title: extracted.title || finalUrl,
      lang: extracted.lang || detectLanguage(markdown.slice(0, 800)),
      markdown,
      text: extracted.text,
      publishedDate: extracted.publishedDate,
      fetchedAt: Date.now(),
      etag: response.etag,
      lastModified: response.lastModified,
      status: "ok",
      contentHash: sha256(extracted.text),
    });

    const chunks = chunkDocument({ url: finalUrl, title: extracted.title || finalUrl, markdown });
    this.store.replaceChunks(finalUrl, chunks);
    await this.index.addDocument(finalUrl);

    log.debug("crawled", {
      url: finalUrl,
      strategy: extracted.strategy,
      chunks: chunks.length,
      chars: extracted.text.length,
    });

    return { url: finalUrl, status: "indexed", chunks: chunks.length, elapsedMs: Date.now() - started };
  }

  /** Seeds a host from its sitemaps, then drains the queue. */
  async crawlSite(
    seed: string,
    options: CrawlerOptions = {},
  ): Promise<{ discovered: number; outcomes: CrawlOutcome[] }> {
    const start = new URL(seed);
    const scope = options.scope === undefined ? scopeOf(start) : options.scope;
    const discovered: string[] = [];

    for (const sitemap of await this.robots.sitemapsFor(seed)) {
      discovered.push(...(await readSitemap(sitemap, options.signal)));
    }
    const discoveredCount = this.store.enqueue(
      discovered
        .filter((u) => inScope(u, start, scope))
        .map((u) => ({ url: u, depth: 1, priority: 0.5 })),
    );

    this.store.enqueue([{ url: start.toString(), depth: 0, priority: 1 }]);
    const outcomes = await this.drain({ ...options, scope, maxDepth: options.maxDepth ?? 3 });
    return { discovered: discoveredCount, outcomes };
  }

  /** Drains the persistent queue with bounded concurrency and per-host politeness. */
  async drain(options: CrawlerOptions = {}): Promise<CrawlOutcome[]> {
    const c = config();
    const outcomes: CrawlOutcome[] = [];
    // A site crawl of a sitemap with thousands of URLs must be stoppable, so the
    // budget is enforced on the claim, not reported afterwards. Claiming a batch
    // larger than the remaining budget would strand the surplus as 'active', so the
    // batch is capped instead.
    const budget = options.maxPages && options.maxPages > 0 ? options.maxPages : null;
    for (;;) {
      if (options.signal?.aborted) break;
      const remaining = budget === null ? c.CRAWL_CONCURRENCY : budget - outcomes.length;
      if (remaining <= 0) break;
      const batch = this.store.claimQueue(Math.min(c.CRAWL_CONCURRENCY, remaining));
      if (batch.length === 0) break;
      const results = await mapPool(batch, c.CRAWL_CONCURRENCY, async (item) => {
        const outcome = await this.crawlOne(item.url);
        this.store.completeQueue(item.url, outcome.status === "error" ? "error" : "done", outcome.reason);
        options.onProgress?.(outcome);
        return outcome;
      });
      outcomes.push(...results);

      if (budget !== null && outcomes.length >= budget) break;

      if (options.followInternalLinks !== false) {
        const fresh = results.filter((o) => o.status === "indexed");
        if (fresh.length > 0) {
          const links = fresh.flatMap((o) => this.internalLinks(o.url)).slice(0, c.CRAWL_CONCURRENCY * 20);
          const known = new Set(this.store.allDocs().map((d) => d.url));
          // Links go through the same scope as the sitemap, or link following undoes
          // the scoping a moment after the sitemap applied it. A standalone drain has
          // no scope and keeps whole-host behaviour.
          const scope = options.scope ?? null;
          const origin = safeUrl(fresh[0]!.url);
          const queued = this.store.enqueue(
            links
              .filter((u) => !known.has(u))
              .filter((u) => origin === null || inScope(u, origin, scope))
              .map((u) => ({ url: u, depth: 1, priority: 0.3 })),
          );
          log.debug("frontier grown", { queued });
        }
      }
    }
    return outcomes;
  }

  private internalLinks(url: string): string[] {
    const doc = this.store.getDoc(url);
    if (!doc) return [];
    const markdown = doc.markdown;
    const links: string[] = [];
    for (const match of markdown.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      const href = match[1];
      if (href) links.push(href);
    }
    return links;
  }

  private async waitTurn(host: string, signal?: AbortSignal): Promise<void> {
    const delay = this.robots.delayFor(`https://${host}`);
    const last = this.lastHitByHost.get(host) ?? 0;
    const wait = last + delay - Date.now();
    if (wait > 0) await sleep(wait, signal);
    this.lastHitByHost.set(host, Date.now());
  }

  private async fetch(
    url: string,
    existing: { etag: string | null; lastModified: string | null } | null,
    options: { force?: boolean; signal?: AbortSignal },
  ): Promise<{ status: number; body: string; contentType: string; notModified: boolean; etag: string | null; lastModified: string | null; finalUrl: string }> {
    const c = config();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.CRAWL_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    try {
      const headers: Record<string, string> = {
        "User-Agent": c.CRAWL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en,pt;q=0.9",
      };
      if (existing && !options.force) {
        if (existing.etag) headers["If-None-Match"] = existing.etag;
        if (existing.lastModified) headers["If-Modified-Since"] = existing.lastModified;
      }
      const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      if (res.status === 304) {
        return {
          status: 304,
          body: "",
          contentType: "",
          notModified: true,
          etag,
          lastModified,
          finalUrl: res.url || url,
        };
      }
      const buffer = await readCapped(res, c.CRAWL_MAX_BYTES);
      return {
        status: res.status,
        body: buffer.text,
        contentType: res.headers.get("content-type") ?? "",
        notModified: false,
        etag,
        lastModified,
        finalUrl: res.url || url,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      log.debug("fetch", { url, ms: Date.now() - started });
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: "", bytes: 0 };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    bytes += value.byteLength;
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes };
}

/** Reads a sitemap or sitemap index, following one level of index nesting. */
export async function readSitemap(url: string, signal?: AbortSignal, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": config().CRAWL_USER_AGENT },
      signal,
    });
    if (!res.ok) return [];
    const xml = await res.text();
    if (/<sitemapindex/i.test(xml)) {
      const children = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] as string);
      const nested = await Promise.all(children.slice(0, 10).map((child) => readSitemap(child, signal, depth + 1)));
      return nested.flat();
    }
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
      .map((m) => m[1] as string)
      .filter((u) => isHttpUrl(u));
  } catch {
    return [];
  }
}

export { normalizeDate };
