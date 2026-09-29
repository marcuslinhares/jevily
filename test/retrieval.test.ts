import { Bm25Index } from "../src/retrieval/bm25.js";
import { docTokens, queryTokens, stem, detectLanguage, extractQuotedPhrases } from "../src/retrieval/tokenize.js";
import { chunkDocument, simhash64, hamming, simhashSimilarity, splitByHeadings } from "../src/store/indexer.js";
import { parseRobots, parseSitemaps } from "../src/crawler/robots.js";
import { splitSentences, fold } from "../src/util/text.js";
import { normalizeDate } from "../src/crawler/extract.js";

describe("tokenizer", () => {
  it("folds case and diacritics so accented and unaccented spellings collide", () => {
    expect(fold("Saúde")).toBe("saude");
    expect(docTokens("A saúde é essencial")).toContain("saude");
  });

  it("folds inflections that reliably collide", () => {
    expect(stem("queries")).toBe("query");
    expect(stem("indexing")).toBe("index");
    expect(stem("indexes")).toBe("index");
    expect(stem("publicacoes")).toBe("publicacao");
    expect(stem("rapidamente")).toBe("rapida");
    expect(stem("claramente")).toBe("clara");
  });

  it("leaves words alone rather than collapsing distinct ones", () => {
    expect(stem("business")).toBe("business");
    expect(stem("class")).toBe("class");
    expect(stem("is")).toBe("is");
    expect(stem("status")).toBe("status");
  });

  it("drops stopwords on the query side", () => {
    const tokens = queryTokens("what is the meaning of life in a database");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("of");
    expect(tokens).toContain("meaning");
  });

  it("keeps quoted phrases out of the loose token stream", () => {
    const phrase = extractQuotedPhrases('who said "to be or not to be"');
    expect(phrase).toEqual(["to be or not to be"]);
  });

  it("detects pt and en", () => {
    expect(detectLanguage("qual o melhor banco de dados para uma aplicação web")).toBe("pt");
    expect(detectLanguage("what is the best database for a web application")).toBe("en");
  });
});

describe("bm25", () => {
  const docs: [string, string][] = [
    ["a", "Node.js streams and backpressure in production systems"],
    ["b", "PostgreSQL indexes: btree versus hash index selection"],
    ["c", "Cooking pasta: al dente timings and salted water"],
    ["d", "Backpressure in stream processing with Node.js"],
  ];

  it("ranks the term-dense document first", () => {
    const index = new Bm25Index();
    for (const [id, text] of docs) index.add(id, text);
    const hits = index.search("node streams backpressure", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(["a", "d"]).toContain(hits[0]!.id);
  });

  it("ignores terms that are not in the corpus", () => {
    const index = new Bm25Index();
    for (const [id, text] of docs) index.add(id, text);
    expect(index.search("quantum chromodynamics lattice", 3)).toEqual([]);
  });

  it("removes a document and stops returning it", () => {
    const index = new Bm25Index();
    for (const [id, text] of docs) index.add(id, text);
    index.remove("a");
    expect(index.search("node streams backpressure", 4).map((h) => h.id)).not.toContain("a");
    expect(index.size).toBe(3);
  });

  it("survives a compact after deletions", () => {
    const index = new Bm25Index();
    for (const [id, text] of docs) index.add(id, text);
    index.remove("a");
    index.remove("b");
    index.compact();
    expect(index.size).toBe(2);
    expect(index.search("al dente pasta", 2)[0]?.id).toBe("c");
  });

  it("replaces rather than duplicates when the same id is added twice", () => {
    const index = new Bm25Index();
    index.add("x", "the original text about widgets");
    index.add("x", "a replacement text about sprockets");
    expect(index.size).toBe(1);
    expect(index.search("sprockets", 1)[0]?.id).toBe("x");
    expect(index.search("widgets", 1)).toEqual([]);
  });
});

describe("chunking", () => {
  const markdown = [
    "# Sessions",
    "A session is created when a user signs in.",
    "## Lifetime",
    "A session ends on sign-out or after the inactivity timeout elapses.",
    "### Rotation",
    "Refresh tokens are single use and rotate on every refresh.",
  ].join("\n");

  it("splits on headings and carries the heading path into each chunk", () => {
    const sections = splitByHeadings(markdown);
    expect(sections.map((s) => s.heading.length)).toEqual([1, 2, 3]);
    const chunks = chunkDocument({ url: "https://x.test/a", title: "Auth", markdown });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.headingPath[0]).toBe("Auth");
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("keeps a subsection with its parent rather than emitting a context-free stub", () => {
    const chunks = chunkDocument({ url: "https://x.test/a", title: "Auth", markdown });
    // Three headings, one unit of meaning: a page's ## section is the retrieval unit.
    expect(chunks.length).toBeLessThanOrEqual(2);
    // The subsection's own heading must survive, inline.
    const merged = chunks.map((c) => c.text).join(" ");
    expect(merged).toContain("Rotation");
    expect(merged).toContain("Refresh tokens are single use");
  });

  it("does not repeat the page title inside its own heading path", () => {
    const chunks = chunkDocument({
      url: "https://x.test/a",
      title: "Auth",
      markdown: "# Auth\n\nIntro paragraph with enough words to be a real section.\n\n## Details\n\nMore detail here.",
    });
    for (const chunk of chunks) {
      expect(chunk.headingPath.join(" > ")).not.toBe("Auth > Auth");
    }
  });

  it("never emits a chunk with no content", () => {
    const chunks = chunkDocument({
      url: "https://x.test/a",
      title: "Empty",
      markdown: "# Empty\n\n## Nothing\n\n### Here either",
    });
    for (const chunk of chunks) expect(chunk.text.trim().length).toBeGreaterThan(0);
  });

  it("produces stable ids so a re-crawl replaces chunks instead of duplicating them", () => {
    const a = chunkDocument({ url: "https://x.test/a", title: "Auth", markdown });
    const b = chunkDocument({ url: "https://x.test/a", title: "Auth", markdown });
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it("never lets a fence's # lines become headings", () => {
    const fenced = "# Title\n```\n# not a heading\n```\nreal body text that is long enough to matter";
    const sections = splitByHeadings(fenced);
    expect(sections).toHaveLength(1);
  });
});

describe("simhash", () => {
  it("calls syndicated near-copies similar and unrelated text distant", () => {
    const a = simhash64("The central bank raised rates by 25 basis points on Tuesday afternoon.");
    const b = simhash64("The central bank raised rates by 25 basis points on Tuesday afternoon, per a statement.");
    const c = simhash64("A recipe for sourdough bread requires starter, flour, water and patience.");
    expect(simhashSimilarity(a, b)).toBeGreaterThan(0.85);
    expect(simhashSimilarity(a, c)).toBeLessThan(0.7);
    expect(hamming(a, a)).toBe(0);
  });
});

describe("robots.txt", () => {
  const UA = "jevily-bot/0.1";

  it("uses the most specific matching group", () => {
    const text = ["User-agent: *", "Disallow: /private", "Allow: /private/public", "", "User-agent: jevily-bot", "Disallow: /nope", "Crawl-delay: 2"].join("\n");
    const { rules, crawlDelayMs } = parseRobots(text, UA);
    expect(rules.length).toBe(1);
    expect(crawlDelayMs).toBe(2000);
  });

  it("treats an empty Disallow as allow-all", () => {
    const { rules } = parseRobots("User-agent: *\nDisallow:", UA);
    expect(rules).toHaveLength(0);
  });

  it("compiles wildcards and end anchors", () => {
    const { rules } = parseRobots("User-agent: *\nDisallow: /*.pdf$", UA);
    const rule = rules[0]!;
    expect(rule.regex.test("/a/b.pdf")).toBe(true);
    expect(rule.regex.test("/a/b.pdf.html")).toBe(false);
  });

  it("extracts sitemaps for our agent", () => {
    const text = "User-agent: *\nSitemap: https://x.test/sitemap.xml";
    expect(parseSitemaps(text, UA)).toEqual(["https://x.test/sitemap.xml"]);
  });
});

describe("text utilities", () => {
  it("splits sentences without breaking on decimals or abbreviations", () => {
    const parts = splitSentences("Version 1.2 shipped. See Dr. Smith for details. Costs 3.5 usd.");
    expect(parts.length).toBe(3);
  });

  it("normalizes dates to ISO and rejects nonsense", () => {
    expect(normalizeDate("2025-02-09")).toBe("2025-02-09T00:00:00.000Z");
    expect(normalizeDate("whenever")).toBeNull();
  });
});
