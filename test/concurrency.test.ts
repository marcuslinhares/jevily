/**
 * Two crawlers, one queue.
 *
 * `claimQueue` reads the pending rows and then marks them claimed, and those are two
 * separate statements. Two claimants that read the same rows before either writes will
 * both believe they own them, so a page gets fetched and re-indexed twice — which
 * costs politeness budget on somebody else's server, and is exactly the kind of bug
 * that only shows up in production.
 *
 * These tests use separate processes rather than two handles in one test, because
 * node:sqlite calls are synchronous: two async calls in one process never interleave
 * inside a statement, so an in-process test would pass no matter how broken the claim
 * is. An earlier version of this file did exactly that and proved nothing.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";

const run = promisify(execFile);
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "helpers", "claim-worker.ts");
const TSX = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "tsx");

let dir: string;
let store: Store;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevily-conc-"));
  store = new Store(dir);
  dbPath = join(dir, "jevily.db");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function claimInProcess(batch: number, iterations: number): Promise<string[]> {
  const { stdout } = await run(TSX, [WORKER, dbPath, String(batch), String(iterations)], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("crawl queue under real parallelism", () => {
  it("hands each url to exactly one claimant across processes", async () => {
    const total = 60;
    store.enqueue(Array.from({ length: total }, (_, i) => ({ url: `https://q.test/${i}`, priority: 1 })));

    const [a, b, c] = await Promise.all([
      claimInProcess(5, 40),
      claimInProcess(5, 40),
      claimInProcess(5, 40),
    ]);

    const claimed = [...a, ...b, ...c];
    expect(new Set(claimed).size, "a url was handed to more than one process").toBe(total);
    expect(claimed.length, "a url was claimed more than once").toBe(total);
  });

  it("leaves nothing pending once the workers stop claiming", async () => {
    store.enqueue(Array.from({ length: 30 }, (_, i) => ({ url: `https://q.test/${i}` })));
    await Promise.all([claimInProcess(4, 30), claimInProcess(4, 30)]);
    expect(store.pendingCount()).toBe(0);
  });

  it("does not create a second row when two crawlers discover the same url", async () => {
    // The normal case in a crawl: both workers reach the same frontier item.
    store.enqueue([{ url: "https://q.test/1", priority: 1 }]);
    store.enqueue([{ url: "https://q.test/1", priority: 5 }]);
    const [a, b] = await Promise.all([claimInProcess(1, 1), claimInProcess(1, 1)]);
    expect(a.length + b.length).toBe(1);
  });

  it("respects priority when several urls are pending", async () => {
    store.enqueue([
      { url: "https://q.test/low", priority: 0 },
      { url: "https://q.test/high", priority: 10 },
    ]);
    const claimed = await claimInProcess(1, 1);
    expect(claimed).toEqual(["https://q.test/high"]);
  });
});

describe("shared state across processes", () => {
  it("sees another handle's documents and cache", async () => {
    store.upsertDoc({
      url: "https://x.test/a",
      domain: "x.test",
      title: "A",
      lang: "en",
      markdown: "# A",
      text: "# A",
      publishedDate: null,
      fetchedAt: Date.now(),
      etag: null,
      lastModified: null,
      status: "ok",
      contentHash: "h",
    });
    const other = new Store(dir);
    try {
      expect(other.getDoc("https://x.test/a")?.title).toBe("A");
      other.cacheSet("k", { v: 1 }, 60_000);
      expect(store.cacheGet<{ v: number }>("k")).toEqual({ v: 1 });
    } finally {
      other.close();
    }
  });
});
