/**
 * Persistence on `node:sqlite` (bundled with Node, no native build step).
 *
 * SQLite here is the durable store — documents, chunks, crawl queue, response
 * cache — not the search engine. Lexical retrieval lives in the in-memory BM25
 * index; this file is the source of truth it is rebuilt from.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { log } from "../util/log.js";
import type { Chunk } from "./indexer.js";

export interface StoredDoc {
  url: string;
  domain: string;
  title: string;
  lang: string;
  markdown: string;
  text: string;
  publishedDate: string | null;
  fetchedAt: number;
  etag: string | null;
  lastModified: string | null;
  status: string;
  contentHash: string;
  /** Set when the document was a 304: the body was not re-fetched. */
  stale: number;
}

export interface StoredChunk {
  id: string;
  url: string;
  ord: number;
  headingPath: string[];
  text: string;
  tokens: number;
  simhash: string;
  contentHash: string;
  vector: Float32Array | null;
}

export interface QueueItem {
  url: string;
  depth: number;
  status: "pending" | "active" | "done" | "error" | "skipped";
  priority: number;
  discoveredAt: number;
  attempts: number;
  error: string | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- Concurrent writers must wait for the lock rather than fail. Without a busy
-- timeout SQLite returns SQLITE_BUSY the moment two connections reach for the
-- write lock at the same time, which turns an ordinary multi-process deployment
-- into intermittent "database is locked" errors. 5s is long enough for a short
-- crawl write and well under any request timeout.
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS docs (
  url           TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,
  title         TEXT NOT NULL,
  lang          TEXT,
  markdown      TEXT NOT NULL,
  text          TEXT NOT NULL,
  published_date TEXT,
  fetched_at    INTEGER NOT NULL,
  etag          TEXT,
  last_modified TEXT,
  status        TEXT NOT NULL DEFAULT 'ok',
  content_hash  TEXT NOT NULL,
  stale         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS docs_domain ON docs(domain);
CREATE INDEX IF NOT EXISTS docs_fetched ON docs(fetched_at);

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL REFERENCES docs(url) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  heading_path TEXT NOT NULL,
  text         TEXT NOT NULL,
  tokens       INTEGER NOT NULL,
  simhash      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector       BLOB
);
CREATE INDEX IF NOT EXISTS chunks_url ON chunks(url);

-- Redirect aliases. A site that 301s /en/x -> /x is one page, not two, so the
-- alias keeps a re-crawl from creating a duplicate document.
CREATE TABLE IF NOT EXISTS aliases (
  from_url TEXT PRIMARY KEY,
  to_url   TEXT NOT NULL,
  seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
  url           TEXT PRIMARY KEY,
  depth         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  priority      REAL NOT NULL DEFAULT 0,
  discovered_at INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS queue_status ON queue(status, priority DESC);

CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expires ON cache(expires_at);

CREATE TABLE IF NOT EXISTS traces (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  payload    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_created ON traces(created_at);
`;

export class Store {
  private db: DatabaseSync;
  readonly file: string;

  /**
   * Accepts either a directory or a file path.
   *
   * Guessing wrong here is nasty: appending "jevily.db" to a path that already
   * points at a file tries to `mkdir` a directory named after the database, and
   * fails with EEXIST naming a file nobody thought was a directory.
   */
  constructor(path?: string) {
    const given = path ?? process.env.DATA_DIR ?? config().DATA_DIR;
    const looksLikeFile = /\.db(-wal|-shm)?$/i.test(given);
    this.file = looksLikeFile ? resolve(given) : resolve(given, "jevily.db");
    mkdirSync(dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec(SCHEMA);
    log.debug("store open", { file: this.file });
  }

  close(): void {
    this.db.close();
  }

  // --- documents -----------------------------------------------------------

  upsertDoc(doc: Omit<StoredDoc, "stale"> & { stale?: number }): void {
    this.db
      .prepare(
        `INSERT INTO docs (url, domain, title, lang, markdown, text, published_date, fetched_at, etag, last_modified, status, content_hash, stale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           domain = excluded.domain, title = excluded.title, lang = excluded.lang,
           markdown = excluded.markdown, text = excluded.text, published_date = excluded.published_date,
           fetched_at = excluded.fetched_at, etag = excluded.etag, last_modified = excluded.last_modified,
           status = excluded.status, content_hash = excluded.content_hash, stale = excluded.stale`,
      )
      .run(
        doc.url,
        doc.domain,
        doc.title,
        doc.lang,
        doc.markdown,
        doc.text,
        doc.publishedDate,
        doc.fetchedAt,
        doc.etag,
        doc.lastModified,
        doc.status,
        doc.contentHash,
        doc.stale ?? 0,
      );
  }

  getDoc(url: string): StoredDoc | null {
    const row = this.db.prepare(`SELECT * FROM docs WHERE url = ?`).get(url) as unknown as DocRow | undefined;
    return row ? toDoc(row) : null;
  }

  /** Re-records fetch metadata after a 304 without touching the body. */
  touchDoc(url: string, fetchedAt: number, etag: string | null, lastModified: string | null): void {
    this.db
      .prepare(`UPDATE docs SET fetched_at = ?, etag = ?, last_modified = ?, stale = 1 WHERE url = ?`)
      .run(fetchedAt, etag, lastModified, url);
  }

  deleteDoc(url: string): void {
    // Chunks go with the document (ON DELETE CASCADE), and any alias pointing at it
    // is dropped so nothing resolves to a URL that no longer exists.
    this.db.prepare(`DELETE FROM docs WHERE url = ?`).run(url);
    this.db.prepare(`DELETE FROM aliases WHERE to_url = ?`).run(url);
  }

  allDocs(): StoredDoc[] {
    const rows = this.db.prepare(`SELECT * FROM docs`).all() as unknown as DocRow[];
    return rows.map(toDoc);
  }

  countDocs(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM docs`).get() as unknown as { n: number };
    return row.n;
  }

  domainOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  // --- redirect aliases ----------------------------------------------------

  /**
   * Records that `from` redirects to `to` and returns the target.
   *
   * Without this, a site that serves the same page at `/en/x` and `/x` gets indexed
   * twice: the crawler follows the redirect, stores under the final URL, and the
   * next crawl of the other spelling starts from scratch and stores it again. The
   * alias collapses the spellings so a re-crawl updates one document.
   */
  resolveAlias(url: string): string {
    let current = url;
    // Bounded walk, so a redirect loop cannot spin.
    for (let hop = 0; hop < 5; hop++) {
      const row = this.db.prepare(`SELECT to_url FROM aliases WHERE from_url = ?`).get(current) as
        | { to_url: string }
        | undefined;
      if (!row || row.to_url === current) break;
      current = row.to_url;
    }
    return current;
  }

  putAlias(fromUrl: string, toUrl: string): void {
    if (fromUrl === toUrl) return;
    this.db
      .prepare(
        `INSERT INTO aliases (from_url, to_url, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(from_url) DO UPDATE SET to_url = excluded.to_url, seen_at = excluded.seen_at`,
      )
      .run(fromUrl, toUrl, Date.now());
  }

  /** Removes aliases pointing at a document that no longer exists. */
  pruneAliases(): number {
    const result = this.db
      .prepare(
        `DELETE FROM aliases WHERE to_url NOT IN (SELECT url FROM docs)
         AND to_url NOT IN (SELECT to_url FROM aliases)`,
      )
      .run();
    return Number(result.changes);
  }

  // --- chunks --------------------------------------------------------------

  replaceChunks(url: string, chunks: Chunk[], vectors?: Map<string, Float32Array>): void {
    const existing = this.db.prepare(`SELECT id FROM chunks WHERE url = ?`).all(url) as unknown as { id: string }[];
    const insert = this.db.prepare(
      `INSERT INTO chunks (id, url, ord, heading_path, text, tokens, simhash, content_hash, vector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         heading_path = excluded.heading_path, text = excluded.text, tokens = excluded.tokens,
         simhash = excluded.simhash, content_hash = excluded.content_hash`,
    );
    const drop = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const keep = new Set(chunks.map((c) => c.id));
    for (const row of existing) if (!keep.has(row.id)) drop.run(row.id);
    for (const chunk of chunks) {
      const vector = vectors?.get(chunk.id);
      insert.run(
        chunk.id,
        url,
        chunk.ord,
        chunk.headingPath.join(" > "),
        chunk.text,
        chunk.tokens,
        chunk.simhash,
        chunk.contentHash,
        vector ? Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) : null,
      );
    }
  }

  chunksOf(url: string): StoredChunk[] {
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE url = ? ORDER BY ord`)
      .all(url) as unknown as ChunkRow[];
    return rows.map(toChunk);
  }

  getChunk(id: string): StoredChunk | null {
    const row = this.db.prepare(`SELECT * FROM chunks WHERE id = ?`).get(id) as unknown as ChunkRow | undefined;
    return row ? toChunk(row) : null;
  }

  countChunks(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as unknown as { n: number };
    return row.n;
  }

  chunksMissingVector(limit: number): StoredChunk[] {
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE vector IS NULL LIMIT ?`)
      .all(limit) as unknown as ChunkRow[];
    return rows.map(toChunk);
  }

  setVector(id: string, vector: Float32Array): void {
    this.db
      .prepare(`UPDATE chunks SET vector = ? WHERE id = ?`)
      .run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), id);
  }

  // --- crawl queue ---------------------------------------------------------

  enqueue(items: { url: string; depth?: number; priority?: number }[]): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO queue (url, depth, status, priority, discovered_at, attempts, error)
       VALUES (?, ?, 'pending', ?, ?, 0, NULL)
       ON CONFLICT(url) DO UPDATE SET
         depth = MIN(queue.depth, excluded.depth),
         priority = MAX(queue.priority, excluded.priority),
         status = CASE WHEN queue.status IN ('done','error') THEN 'pending' ELSE queue.status END`,
    );
    let count = 0;
    for (const item of items) {
      if (!isHttpUrl(item.url)) continue;
      stmt.run(item.url, item.depth ?? 0, item.priority ?? 0, now);
      count++;
    }
    return count;
  }

  /**
   * Claims up to `limit` pending urls for one worker.
   *
   * One statement, not a SELECT followed by an UPDATE. The two-statement version has
   * a window between the read and the write in which a second worker selects the same
   * rows and believes it owns them, and a page gets crawled twice — which spends
   * politeness budget on someone else's server. A single statement has no window.
   *
   * `RETURNING` needs SQLite 3.35+; node:sqlite ships far newer.
   */
  claimQueue(limit: number): QueueItem[] {
    const rows = this.db
      .prepare(
        `UPDATE queue
            SET status = 'active', attempts = attempts + 1
          WHERE url IN (
            SELECT url FROM queue
             WHERE status = 'pending'
             ORDER BY priority DESC, discovered_at
             LIMIT ?
          )
         RETURNING url, depth, status, priority, discovered_at, attempts, error`,
      )
      .all(limit) as unknown as QueueRow[];
    return rows.map(toQueue);
  }

  completeQueue(url: string, status: QueueItem["status"], error?: string): void {
    this.db.prepare(`UPDATE queue SET status = ?, error = ? WHERE url = ?`).run(status, error ?? null, url);
  }

  pendingCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM queue WHERE status = 'pending'`).get() as unknown as { n: number };
    return row.n;
  }

  /**
   * Items claimed but never completed. Should be zero outside an in-flight crawl: a
   * truncated response or a batch claimed past a budget would strand these as
   * 'active' with nobody left to resolve them.
   */
  activeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM queue WHERE status = 'active'`)
      .get() as unknown as { n: number };
    return row.n;
  }

  // --- response cache ------------------------------------------------------

  cacheGet<T>(key: string): T | null {
    const row = this.db.prepare(`SELECT value, expires_at FROM cache WHERE key = ?`).get(key) as
      | { value: string; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.db.prepare(`DELETE FROM cache WHERE key = ?`).run(key);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  cacheSet(key: string, value: unknown, ttlMs: number): void {
    this.db
      .prepare(
        `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(value), Date.now() + ttlMs);
  }

  cacheSweep(): number {
    const result = this.db.prepare(`DELETE FROM cache WHERE expires_at < ?`).run(Date.now());
    return Number(result.changes);
  }

  // --- traces --------------------------------------------------------------

  saveTrace(id: string, payload: unknown): void {
    this.db
      .prepare(`INSERT INTO traces (id, created_at, payload) VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`)
      .run(id, Date.now(), JSON.stringify(payload));
  }

  getTrace(id: string): unknown | null {
    const row = this.db.prepare(`SELECT payload FROM traces WHERE id = ?`).get(id) as
      | { payload: string }
      | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  stats(): { docs: number; chunks: number; queuePending: number } {
    return {
      docs: this.countDocs(),
      chunks: this.countChunks(),
      queuePending: this.pendingCount(),
    };
  }
}

interface DocRow {
  url: string;
  domain: string;
  title: string;
  lang: string;
  markdown: string;
  text: string;
  published_date: string | null;
  fetched_at: number;
  etag: string | null;
  last_modified: string | null;
  status: string;
  content_hash: string;
  stale: number;
}

interface ChunkRow {
  id: string;
  url: string;
  ord: number;
  heading_path: string;
  text: string;
  tokens: number;
  simhash: string;
  content_hash: string;
  vector: Uint8Array | null;
}

interface QueueRow {
  url: string;
  depth: number;
  status: QueueItem["status"];
  priority: number;
  discovered_at: number;
  attempts: number;
  error: string | null;
}

function toDoc(row: DocRow): StoredDoc {
  return {
    url: row.url,
    domain: row.domain,
    title: row.title,
    lang: row.lang,
    markdown: row.markdown,
    text: row.text,
    publishedDate: row.published_date,
    fetchedAt: row.fetched_at,
    etag: row.etag,
    lastModified: row.last_modified,
    status: row.status,
    contentHash: row.content_hash,
    stale: row.stale,
  };
}

function toChunk(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    url: row.url,
    ord: row.ord,
    headingPath: row.heading_path ? row.heading_path.split(" > ") : [],
    text: row.text,
    tokens: row.tokens,
    simhash: row.simhash,
    contentHash: row.content_hash,
    vector: row.vector
      ? new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4)
      : null,
  };
}

function toQueue(row: QueueRow): QueueItem {
  return {
    url: row.url,
    depth: row.depth,
    status: row.status,
    priority: row.priority,
    discoveredAt: row.discovered_at,
    attempts: row.attempts,
    error: row.error,
  };
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
