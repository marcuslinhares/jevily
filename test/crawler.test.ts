import { describe, expect, it } from "vitest";
import { extract, normalizeDate } from "../src/crawler/extract.js";

const page = (body: string, head = "") => `<!doctype html>
<html lang="en"><head>${head}</head><body>${body}</body></html>`;

describe("html extraction", () => {
  it("prefers the article over the navigation chrome around it", () => {
    const html = page(
      `<nav><a href="/a">Home</a><a href="/b">Docs</a><a href="/c">Blog</a><a href="/d">Pricing</a></nav>
       <article>
         <h1>Write-ahead logging</h1>
         ${"WAL lets readers and a writer proceed concurrently. ".repeat(12)}
       </article>
       <footer>Copyright</footer>`,
      "<title>Write-ahead logging</title>",
    );
    const out = extract(html, "https://sqlite.test/wal");
    expect(out.title).toBe("Write-ahead logging");
    expect(out.text).toContain("WAL lets readers");
    expect(out.text).not.toContain("Pricing");
    expect(out.markdown).toContain("# Write-ahead logging");
  });

  it("reads the published date from the usual meta tags, preferring the article one", () => {
    const html = page(
      "<p>body</p>",
      `<title>T</title>
       <meta property="article:published_time" content="2024-03-11T09:30:00Z">
       <meta name="date" content="1999-01-01">`,
    );
    expect(extract(html, "https://x.test/").publishedDate).toBe("2024-03-11T09:30:00.000Z");
  });

  it("falls back to a time element when no meta date exists", () => {
    const html = page(`<article><time datetime="2023-05-04">May 2023</time>${"content ".repeat(80)}</article>`);
    expect(extract(html, "https://x.test/").publishedDate).toBe("2023-05-04T00:00:00.000Z");
  });

  it("resolves the canonical url, images and language", () => {
    const html = page(
      `<article><img src="/diagram.png" alt="architecture">${"text ".repeat(120)}</article>`,
      `<link rel="canonical" href="https://x.test/final">
       <meta property="og:image" content="https://x.test/og.png">
       <meta name="description" content="A description.">`,
    );
    const out = extract(html, "https://x.test/draft?v=2");
    expect(out.canonicalUrl).toBe("https://x.test/final");
    expect(out.lang).toBe("en");
    expect(out.images.some((i) => i.url === "https://x.test/diagram.png")).toBe(true);
    expect(out.images.some((i) => i.url === "https://x.test/og.png")).toBe(true);
  });

  it("keeps a real URL in the markdown but strips images that only exist as base64 noise", () => {
    const html = page(
      `<article><p>See the <a href="https://other.test/x">docs</a>.</p>
       <p><img src="data:image/gif;base64,R0lGOD" alt="tracking pixel"></p>
       ${"body text ".repeat(60)}</article>`,
    );
    const out = extract(html, "https://x.test/");
    expect(out.markdown).toContain("https://other.test/x");
    expect(out.markdown).not.toContain("base64");
  });

  it("survives a page with no article at all", () => {
    const html = page(`<div>${"plain content that is long enough to be scored. ".repeat(10)}</div>`);
    const out = extract(html, "https://x.test/");
    expect(out.text.length).toBeGreaterThan(100);
  });

  it("does not throw on malformed input", () => {
    expect(() => extract("<html><body><p>unclosed", "https://x.test/")).not.toThrow();
    expect(() => extract("", "https://x.test/")).not.toThrow();
  });

  it("reports which strategy won, so a bad extraction is diagnosable", () => {
    const long = `<article>${"substantive prose ".repeat(60)}</article>`;
    expect(extract(page(long), "https://x.test/").strategy).toBe("readability");
    const thin = page("<p>too short</p>");
    expect(["readability", "density"]).toContain(extract(thin, "https://x.test/").strategy);
  });
});

describe("date normalization", () => {
  it("parses the formats that actually appear in meta tags", () => {
    expect(normalizeDate("2025-02-09")).toBe("2025-02-09T00:00:00.000Z");
    expect(normalizeDate("Mon, 09 Feb 2025 17:00:00 GMT")).toBe("2025-02-09T17:00:00.000Z");
    expect(normalizeDate("2025-02")).toBe("2025-02-01T00:00:00.000Z");
    expect(normalizeDate("2025")).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns null rather than a wrong date", () => {
    expect(normalizeDate("sometime last week")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });
});
