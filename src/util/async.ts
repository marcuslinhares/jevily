/** Bounded-concurrency map that preserves input order and never rejects. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Delays honoring an AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): Error {
  return new Error("aborted");
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "aborted");
}

/** Simple TTL cache with a size ceiling and stale-while-error semantics off. */
export class TtlCache<T> {
  private map = new Map<string, { value: T; expires: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.map.size >= this.maxEntries) {
      // cheap eviction: drop the oldest insertion
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
