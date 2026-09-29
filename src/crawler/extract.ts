/**
 * HTML -> clean markdown + metadata.
 *
 * Readability picks the main content when it can, and we fall back to a
 * density-based main-content heuristic when it cannot. The output is what gets
 * chunked and indexed, so its quality is the recall ceiling for the whole system.
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { collapseWhitespace, detectLanguage } from "../util/text.js";

/** linkedom's DOM, not the browser one, is what actually shows up at runtime. */
type Doc = ReturnType<typeof parseHTML>["document"];
type El = ReturnType<Doc["querySelector"]>;

export interface Extracted {
  title: string;
  markdown: string;
  text: string;
  lang: string;
  publishedDate: string | null;
  description: string;
  canonicalUrl: string | null;
  images: { url: string; alt: string }[];
  favicon: string | null;
  links: string[];
  /** Which strategy produced the body. Useful when a page extracts badly. */
  strategy: "readability" | "density";
}

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

turndown.addRule("stripEmptyLinks", {
  filter(node) {
    return node.nodeName === "A" && !node.textContent?.trim();
  },
  replacement() {
    return "";
  },
});

/**
 * Chrome that is never the answer: page furniture, not content.
 *
 * Removed from the DOM *before* extraction, so Readability cannot mistake a nav for
 * an article. On a short docs page the navigation can easily outweigh the real
 * content, and a reader that keeps it indexes menu labels instead of prose.
 */
const CHROME_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "[role=navigation]",
  "[role=banner]",
  "[role=contentinfo]",
  "[role=search]",
  "[aria-hidden=true]",
  ".nav",
  ".navbar",
  ".navigation",
  ".sidebar",
  ".menu",
  ".breadcrumb",
  ".breadcrumbs",
  ".cookie",
  ".cookie-banner",
  ".newsletter",
  ".subscribe",
  ".social",
  ".share",
  ".advert",
  ".advertisement",
  ".ads",
  ".related",
  ".recommended",
  ".comments",
  "#comments",
  ".skip-link",
  ".screen-reader-text",
  ".sr-only",
  ".visually-hidden",
];

function stripChrome(doc: Doc): void {
  for (const selector of CHROME_SELECTORS) {
    for (const node of Array.from(doc.querySelectorAll(selector))) {
      node.parentNode?.removeChild(node);
    }
  }
}

export function extract(html: string, url: string): Extracted {
  if (!html || html.trim().length === 0) return empty(url);
  const meta = readMeta(parseHTML(html).document, url);

  let bodyHtml: string | null = null;
  let strategy: Extracted["strategy"] = "density";

  try {
    // Readability mutates the document, so it gets its own copy of the DOM.
    const { document: clone } = parseHTML(html);
    stripChrome(clone);
    const article = new Readability(clone as unknown as Document, { charThreshold: 200 }).parse() as
      | { content?: string; textContent?: string; title?: string | null }
      | null;
    if (article?.content && article.textContent && article.textContent.length > 400) {
      bodyHtml = article.content;
      strategy = "readability";
      if (article.title && !meta.title) meta.title = article.title;
    }
  } catch {
    // fall through to the density heuristic
  }

  if (!bodyHtml) {
    const { document } = parseHTML(html);
    stripChrome(document);
    bodyHtml = mainContentByDensity(document);
  }

  const rawMarkdown = turndown.turndown(bodyHtml ?? "");
  // Readability lifts the page's H1 out of the body (it becomes `title`), so a
  // chunked page can lose its top heading. Restore it: heading context is what
  // lets the re-ranker tell two same-named sections apart.
  const markdown = withTitle(cleanupMarkdown(rawMarkdown), meta.title);
  const text = collapseWhitespace(stripMarkdown(markdown));

  return {
    title: meta.title,
    markdown,
    text,
    lang: meta.lang || detectLanguage(`${meta.title} ${text.slice(0, 500)}`),
    publishedDate: meta.publishedDate,
    description: meta.description,
    canonicalUrl: meta.canonicalUrl,
    images: meta.images,
    favicon: meta.favicon,
    links: meta.links,
    strategy,
  };
}

interface Meta {
  title: string;
  lang: string;
  description: string;
  publishedDate: string | null;
  canonicalUrl: string | null;
  images: { url: string; alt: string }[];
  favicon: string | null;
  links: string[];
}

function readMeta(doc: Doc, url: string): Meta {
  const q = <T extends El>(selector: string): T | null => doc.querySelector(selector) as T | null;
  const title = (q("title")?.textContent ?? "").trim();

  const canonical = q('link[rel="canonical"]')?.getAttribute("href") ?? null;

  const publishedDate =
    firstNonEmpty([
      metaContent(doc, 'meta[property="article:published_time"]'),
      metaContent(doc, 'meta[name="date"]'),
      metaContent(doc, 'meta[name="pubdate"]'),
      metaContent(doc, 'meta[name="publish-date"]'),
      metaContent(doc, 'meta[itemprop="datePublished"]'),
      q("time[datetime]")?.getAttribute("datetime"),
      q("time")?.textContent ?? null,
    ])?.trim() ?? null;

  const images: { url: string; alt: string }[] = [];
  const ogImage = metaContent(doc, 'meta[property="og:image"]');
  const ogTitle = metaContent(doc, 'meta[property="og:title"]') ?? "";
  if (ogImage) images.push({ url: absolute(ogImage, url), alt: ogTitle });
  for (const img of Array.from(doc.querySelectorAll("article img, main img")).slice(0, 12)) {
    const src = img.getAttribute("src") ?? img.getAttribute("data-src");
    if (!src) continue;
    images.push({ url: absolute(src, url), alt: (img.getAttribute("alt") ?? "").slice(0, 300) });
  }

  const links: string[] = [];
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href");
    if (href) links.push(absolute(href, url));
  }

  return {
    title: (title || ogTitle).slice(0, 300),
    lang: doc.documentElement?.getAttribute("lang") ?? "",
    description: (
      metaContent(doc, 'meta[name="description"]') ??
      metaContent(doc, 'meta[property="og:description"]') ??
      ""
    ).slice(0, 600),
    publishedDate: publishedDate ? normalizeDate(publishedDate) : null,
    canonicalUrl: canonical ? absolute(canonical, url) : null,
    images: images.filter((i) => i.url.startsWith("http")).slice(0, 12),
    favicon: null,
    links: links.filter((l) => l.startsWith("http")).slice(0, 2_000),
  };
}

function metaContent(doc: Doc, selector: string): string | null {
  return doc.querySelector(selector)?.getAttribute("content") ?? null;
}

/**
 * Fallback main-content detection: score block elements by text length, discount
 * link density, take the best subtree. Crude, but far better than indexing a nav.
 */
function mainContentByDensity(doc: Doc): string {
  // Scored breadth-first from the most specific selectors outwards, so a wrapper
  // that merely *contains* an <article> never wins on raw text length alone.
  const SELECTORS = [
    "article",
    "main",
    "[role=main]",
    "#content",
    ".content",
    ".post",
    ".entry-content",
    "#main",
    ".markdown-body",
    ".prose",
    "body",
  ];
  const candidates: NonNullable<El>[] = [];
  for (const selector of SELECTORS) {
    for (const node of Array.from(doc.querySelectorAll(selector))) {
      if (!node) continue;
      // A candidate nested inside a better-ranked one adds nothing.
      if (candidates.some((existing) => existing.contains?.(node))) continue;
      candidates.push(node);
    }
  }

  let best: { node: El; score: number } | null = null;
  for (const node of candidates) {
    if (!node) continue;
    const text = node.textContent ?? "";
    if (text.length < 200) continue;
    const linkLength = Array.from(node.querySelectorAll("a")).reduce(
      (sum, a) => sum + (a.textContent?.length ?? 0),
      0,
    );
    const linkDensity = linkLength / Math.max(1, text.length);
    const paragraphs = node.querySelectorAll("p").length;
    const score = text.length * (1 - Math.min(0.9, linkDensity)) + paragraphs * 120;
    if (!best || score > best.score) best = { node, score };
  }
  return (best?.node ?? doc.body)?.innerHTML ?? "";
}

function cleanupMarkdown(markdown: string): string {
  return (
    markdown
      // data: URIs are inline assets, not sources. They only bloat the index and
      // can carry megabytes of noise per page.
      .replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\(\s*\)\s*/g, "$1")
      .replace(/^\s*\|[\s|:-]*\|\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]{2,}/g, " ").trimEnd())
      .join("\n")
      .trim()
  );
}

/** Re-adds the page title as an H1 when extraction did not preserve one. */
function withTitle(markdown: string, title: string): string {
  if (!title) return markdown;
  if (/^#\s+\S/m.test(markdown.split("\n\n")[0] ?? "")) return markdown;
  return `# ${title}\n\n${markdown}`;
}

function empty(url: string): Extracted {
  return {
    title: url,
    markdown: "",
    text: "",
    lang: "und",
    publishedDate: null,
    description: "",
    canonicalUrl: null,
    images: [],
    favicon: null,
    links: [],
    strategy: "density",
  };
}

function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[>#*\-|:\s]+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function firstNonEmpty(values: (string | null | undefined)[]): string | null {
  for (const value of values) if (value && value.trim()) return value;
  return null;
}

/** Best-effort ISO date. Returns null when the value cannot be parsed. */
export function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const ym = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (ym) return new Date(Date.UTC(Number(ym[1]), Number(ym[2]) - 1, 1)).toISOString();
  const y = /^\d{4}$/.exec(trimmed);
  if (y) return new Date(Date.UTC(Number(y[0]), 0, 1)).toISOString();
  return null;
}
