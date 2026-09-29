/**
 * Store-level behaviour: aliasing, conditional re-crawl bookkeeping, and the
 * chunk/vector round trip. Uses a real on-disk database in a temp directory.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { chunkDocument, IndexManager } from "../src/store/indexer.js";
import { sha256 } from "../src/util/hash.js";

let dir: string;
let store: Store;

const doc = {
  url: "https://x.test/a",
  title: "A",
  markdown: ["# A", "First paragraph with plenty of words to matter to the index.", "## B", "Second paragraph, also long enough to survive chunking."].join("\n\n"),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevily-store-"));
  store = new Store(dir);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(url = doc.url, markdown = doc.markdown) {
  store.upsertDoc({
    url,
    domain: new URL(url).hostname,
    title: "A",
    lang: "en",
    markdown,
    text: markdown,
    publishedDate: null,
    fetchedAt: Date.now(),
    etag: '"abc"',
    lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
    status: "ok",
    contentHash: sha256(markdown),
  });
  store.replaceChunks(url, chunkDocument({ url, title: "A", markdown }));
}

describe("redirect aliases", () => {
  it("resolves a known redirect to its target", () => {
    store.putAlias("https://x.test/en/a", "https://x.test/a");
    expect(store.resolveAlias("https://x.test/en/a")).toBe("https://x.test/a");
  });

  it("follows a chain of redirects without looping forever", () => {
    store.putAlias("https://x.test/1", "https://x.test/2");
    store.putAlias("https://x.test/2", "https://x.test/3");
    expect(store.resolveAlias("https://x.test/1")).toBe("https://x.test/3");
  });

  it("terminates on a redirect cycle instead of spinning", () => {
    store.putAlias("https://x.test/a", "https://x.test/b");
    store.putAlias("https://x.test/b", "https://x.test/a");
    // A cycle has no correct answer; what matters is that the walk is bounded.
    expect(["https://x.test/a", "https://x.test/b"]).toContain(
      store.resolveAlias("https://x.test/a"),
    );
  });

  it("returns an unknown url unchanged", () => {
    expect(store.resolveAlias("https://x.test/never-seen")).toBe("https://x.test/never-seen");
  });

  it("does not alias a url to itself", () => {
    store.putAlias("https://x.test/a", "https://x.test/a");
    expect(store.resolveAlias("https://x.test/a")).toBe("https://x.test/a");
  });

  it("drops aliases when their target document is deleted", () => {
    seed("https://x.test/a");
    store.putAlias("https://x.test/en/a", "https://x.test/a");
    store.deleteDoc("https://x.test/a");
    // The alias row is gone with the document, so nothing dangles.
    expect(store.resolveAlias("https://x.test/en/a")).toBe("https://x.test/en/a");
  });
});

describe("documents and chunks", () => {
  it("round-trips a document and its chunks", () => {
    seed();
    const stored = store.getDoc(doc.url);
    expect(stored?.title).toBe("A");
    const chunks = store.chunksOf(doc.url);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.headingPath.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.text.trim().length > 0)).toBe(true);
  });

  it("replaces chunks rather than accumulating them on re-index", () => {
    seed();
    const first = store.chunksOf(doc.url).map((c) => c.id);
    seed();
    const second = store.chunksOf(doc.url).map((c) => c.id);
    expect(second).toEqual(first);
    expect(store.countChunks()).toBe(first.length);
  });

  it("keeps chunk ids stable across a re-index, so a rebuild is idempotent", async () => {
    seed();
    const index = new IndexManager(store);
    await index.rebuild();
    const before = index.stats();
    seed();
    await index.rebuild();
    expect(index.stats()).toEqual(before);
  });

  it("removes a document's chunks from the index when it is deleted", async () => {
    seed();
    const index = new IndexManager(store);
    await index.rebuild();
    expect(index.bm25.search("paragraph", 5).length).toBeGreaterThan(0);
    await index.removeDocument(doc.url);
    store.deleteDoc(doc.url);
    expect(index.bm25.search("paragraph", 5).length).toBe(0);
  });

  it("round-trips a vector", () => {
    seed();
    const chunk = store.chunksOf(doc.url)[0]!;
    expect(store.getChunk(chunk.id)?.vector).toBeNull();
    const vector = Float32Array.from([0.1, -0.2, 0.3]);
    store.setVector(chunk.id, vector);
    // Float32 storage is lossy, so compare within the format's precision.
    const stored = Array.from(store.getChunk(chunk.id)!.vector!);
    stored.forEach((value, i) => expect(value).toBeCloseTo([0.1, -0.2, 0.3][i] as number, 6));
  });

  it("lists chunks that still need an embedding", () => {
    seed();
    expect(store.chunksMissingVector(10).length).toBeGreaterThan(0);
    const chunk = store.chunksOf(doc.url)[0]!;
    store.setVector(chunk.id, Float32Array.from([1, 2, 3]));
    expect(store.chunksMissingVector(10).map((c) => c.id)).not.toContain(chunk.id);
  });
});

describe("conditional re-crawl bookkeeping", () => {
  it("marks a document stale on 304 and keeps the body", () => {
    seed();
    store.touchDoc(doc.url, Date.now(), '"new"', "Thu, 02 Jan 2025 00:00:00 GMT");
    const updated = store.getDoc(doc.url);
    expect(updated?.stale).toBe(1);
    expect(updated?.etag).toBe('"new"');
    // The body survives: a 304 means we never re-downloaded it.
    expect(updated?.text).toContain("First paragraph");
  });
});

describe("crawl queue", () => {
  it("enqueues, claims, and completes", () => {
    expect(store.enqueue([{ url: "https://q.test/1", priority: 1 }])).toBe(1);
    expect(store.enqueue([{ url: "not a url" }])).toBe(0);
    const claimed = store.claimQueue(10);
    expect(claimed).toHaveLength(1);
    // A claimed item is no longer pending, so it is not handed out twice.
    expect(store.claimQueue(10)).toHaveLength(0);
    store.completeQueue(claimed[0]!.url, "done");
    expect(store.pendingCount()).toBe(0);
  });

  it("requeues a previously finished item when it is discovered again", () => {
    store.enqueue([{ url: "https://q.test/1" }]);
    const first = store.claimQueue(1)[0]!;
    store.completeQueue(first.url, "done");
    store.enqueue([{ url: "https://q.test/1" }]);
    expect(store.pendingCount()).toBe(1);
  });

  it("accepts a directory or a file path", () => {
    // A file path used to append a second "jevily.db" and then try to mkdir a
    // directory named after the database, failing with EEXIST.
    const byDir = new Store(dir);
    const byFile = new Store(join(dir, "jevily.db"));
    try {
      expect(byDir.file).toBe(join(dir, "jevily.db"));
      expect(byFile.file).toBe(join(dir, "jevily.db"));
      expect(byFile.getDoc("https://nope.test/x")).toBeNull();
    } finally {
      byDir.close();
      byFile.close();
    }
  });
});

describe("response cache", () => {
  it("round-trips a value and expires it", () => {
    store.cacheSet("k", { a: 1 }, 60_000);
    expect(store.cacheGet<{ a: number }>("k")).toEqual({ a: 1 });
    store.cacheSet("expired", { a: 1 }, -1);
    // Reading an expired key removes it, so it is already gone by the time we sweep.
    expect(store.cacheGet("expired")).toBeNull();
    store.cacheSet("stale", { a: 1 }, -1);
    expect(store.cacheSweep()).toBe(1);
    expect(store.cacheGet("k")).toEqual({ a: 1 });
  });
});
