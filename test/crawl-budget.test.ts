import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Crawler, scopeOf } from "../src/crawler/crawler.js";
import { IndexManager } from "../src/store/indexer.js";
import { Store } from "../src/store/db.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stands in for a site: every URL is a real page with a body, so the crawler reaches
 * the frontier-growth and claim logic rather than bailing out on a fetch error.
 */
function fakeSite(host: string, paths: string[]): { requests: string[] } {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/robots.txt")) {
      return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    }
    const path = new URL(url).pathname;
    const body = `<!doctype html><html lang="en"><head><title>${path}</title></head>
      <body><article><h1>${path}</h1><p>${path} ${"substantive prose about the topic ".repeat(40)}</p>
      ${paths.slice(0, 3).map((p) => `<a href="${p}">link</a>`).join("")}</article></body></html>`;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  void host;
  return { requests };
}

function withStore<T>(fn: (store: Store, index: IndexManager) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "jevily-budget-"));
  const store = new Store(dir);
  const index = new IndexManager(store);
  return fn(store, index).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("crawl scope", () => {
  it("confines a section seed to its own path prefix", () => {
    // Sitemaps are published per host, so a section seed that filters only by
    // hostname crawls the whole site. nodejs.org publishes 1651 URLs for 88 in
    // /en/learn, and a bounded crawl then spends its budget on the wrong subject.
    expect(scopeOf(new URL("https://nodejs.org/en/learn"))).toBe("/en/learn/");
    expect(scopeOf(new URL("https://nodejs.org/en/learn/"))).toBe("/en/learn/");
    expect(scopeOf(new URL("https://x.test/docs/api/v2"))).toBe("/docs/api/v2/");
  });

  it("leaves a root or file seed unscoped", () => {
    expect(scopeOf(new URL("https://nodejs.org/"))).toBeNull();
    expect(scopeOf(new URL("https://nodejs.org"))).toBeNull();
    expect(scopeOf(new URL("https://nodejs.org/en/blog/index.html"))).toBeNull();
  });

  it("indexes only the seeded section of a site", async () => {
    const sitemap = `<?xml version="1.0"?><urlset>
      <url><loc>https://scope.test/en/learn/streams</loc></url>
      <url><loc>https://scope.test/en/learn/async</loc></url>
      <url><loc>https://scope.test/en/blog/2015-02-06</loc></url>
      <url><loc>https://scope.test/en/download</loc></url>
      <url><loc>https://other.test/en/learn/streams</loc></url>
    </urlset>`;

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) {
        return new Response("User-agent: *\nSitemap: https://scope.test/sitemap.xml\n", { status: 200 });
      }
      if (url.endsWith("sitemap.xml")) return new Response(sitemap, { status: 200 });
      const path = new URL(url).pathname;
      const body = `<!doctype html><html lang="en"><head><title>${path}</title></head>
        <body><article><h1>${path}</h1><p>${path} ${"substantive prose ".repeat(40)}</p></article></body></html>`;
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    await withStore(async (store, index) => {
      const crawler = new Crawler(store, index);
      const result = await crawler.crawlSite("https://scope.test/en/learn", { followInternalLinks: false });

      const urls = store.allDocs().map((d) => d.url);
      expect(urls).toContain("https://scope.test/en/learn/streams");
      expect(urls).toContain("https://scope.test/en/learn/async");
      // The seed itself, and nothing from the rest of the host.
      expect(urls).toContain("https://scope.test/en/learn");
      expect(urls).not.toContain("https://scope.test/en/blog/2015-02-06");
      expect(urls).not.toContain("https://scope.test/en/download");
      expect(urls).not.toContain("https://other.test/en/learn/streams");
      // 2 in scope + the seed: the other three were never even queued.
      expect(result.discovered).toBe(2);
    });
  });

  it("keeps link following inside the scope too", async () => {
    // Otherwise the sitemap scoping is undone the moment a page yields a link.
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("robots.txt")) return new Response("User-agent: *\n", { status: 200 });
      const path = new URL(url).pathname;
      const body = `<!doctype html><html lang="en"><head><title>${path}</title></head><body><article>
        <h1>${path}</h1><p>${"substantive prose about the section ".repeat(30)}</p>
        <a href="https://scope2.test/en/guide/inside">inside</a>
        <a href="https://scope2.test/en/blog/outside">outside</a>
        <a href="https://elsewhere.test/en/guide/inside">other host</a>
      </article></body></html>`;
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;

    await withStore(async (store, index) => {
      const crawler = new Crawler(store, index);
      await crawler.crawlSite("https://scope2.test/en/guide");

      const urls = store.allDocs().map((d) => d.url);
      expect(urls).toContain("https://scope2.test/en/guide/inside");
      expect(urls).not.toContain("https://scope2.test/en/blog/outside");
      expect(urls).not.toContain("https://elsewhere.test/en/guide/inside");
    });
  });
});

describe("crawl budget", () => {
  it("stops at max_pages instead of crawling the whole frontier", async () => {
    // 40 seeds plus the links they expose is a frontier far larger than the budget.
    const seeds = Array.from({ length: 40 }, (_, i) => `/p${i}`);
    const { requests } = fakeSite("budget.test", seeds);

    await withStore(async (store, index) => {
      const crawler = new Crawler(store, index);
      store.enqueue(seeds.map((url) => ({ url: `https://budget.test${url}`, depth: 0, priority: 1 })));

      const outcomes = await crawler.drain({ maxPages: 5 });

      expect(outcomes).toHaveLength(5);
      expect(store.allDocs().length).toBe(5);
      // robots.txt is the only extra request: a budget that did not stop the crawl
      // would have fetched dozens of pages.
      expect(requests.filter((u) => !u.endsWith("robots.txt")).length).toBe(5);
    });
  });

  it("leaves the rest of the frontier pending, so a later drain resumes it", async () => {
    const seeds = Array.from({ length: 30 }, (_, i) => `/p${i}`);
    fakeSite("budget.test", seeds);

    await withStore(async (store, index) => {
      const crawler = new Crawler(store, index);
      store.enqueue(seeds.map((url) => ({ url: `https://budget.test${url}`, depth: 0, priority: 1 })));

      await crawler.drain({ maxPages: 4 });
      const pending = store.pendingCount();
      // Truncating a response would have marked the surplus 'active' and lost it.
      expect(pending).toBeGreaterThan(0);

      const more = await crawler.drain({ maxPages: 4 });
      expect(more).toHaveLength(4);
      expect(new Set([...Array(8)].map((_, i) => i)).size).toBe(8);
      expect(store.allDocs().length).toBe(8);
    });
  });

  it("never strands a claimed item as active, whatever the budget and concurrency", async () => {
    // A budget smaller than the concurrency is where an off-by-one would mark the
    // rest of the claimed batch as in-flight forever.
    for (const maxPages of [1, 2, 3]) {
      await withStore(async (store, index) => {
        const seeds = Array.from({ length: 20 }, (_, i) => `/p${i}`);
        fakeSite("budget.test", seeds);
        const crawler = new Crawler(store, index);
        store.enqueue(seeds.map((url) => ({ url: `https://budget.test${url}`, depth: 0, priority: 1 })));

        const outcomes = await crawler.drain({ maxPages });

        expect(outcomes).toHaveLength(maxPages);
        expect(store.pendingCount()).toBe(20 - maxPages);
        expect(store.activeCount()).toBe(0);
      });
    }
  });

  it("drains the whole frontier when no budget is given", async () => {
    const seeds = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    fakeSite("budget.test", seeds);

    await withStore(async (store, index) => {
      const crawler = new Crawler(store, index);
      store.enqueue(seeds.map((url) => ({ url: `https://budget.test${url}`, depth: 0, priority: 1 })));

      const outcomes = await crawler.drain();

      // All 12 seeds, plus the three links each of them exposes — but those links are
      // the seeds themselves here, so the frontier closes at 12 documents.
      expect(outcomes.length).toBeGreaterThanOrEqual(12);
      expect(store.activeCount()).toBe(0);
    });
  });
});
