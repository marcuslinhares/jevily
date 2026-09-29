/**
 * Rate limiting.
 *
 * A public search API with no limit is a denial-of-service tool pointed at your own
 * budget: every request can cost a decision call, and the crawl endpoints can cost
 * real traffic to someone else's server. So the limiter is per API key rather than
 * per IP — the key is the unit of account, and it is already the thing callers
 * present.
 *
 * A fixed window, not a sliding one. A sliding window is more accurate and needs a
 * queue per key; a fixed window can over-admit by up to 2x at a boundary. For a
 * guardrail that exists to stop runaway spend, that trade is right, and the window
 * boundaries are honest enough to document.
 */

export interface RateLimitOptions {
  /** Requests allowed per window, per key. */
  limit: number;
  windowMs: number;
  /** Cap on tracked keys, so an attacker rotating keys cannot grow memory forever. */
  maxKeys?: number;
  /** Injectable clock, so tests do not have to sleep. */
  now?: () => number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets. Always at least 1. */
  resetSeconds: number;
  /** Seconds the caller should wait, present only when rejected. */
  retryAfterSeconds?: number;
}

interface Window {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Records a request against `key` and says whether it may proceed. */
  take(key: string): RateLimitVerdict {
    const t = this.now();
    const existing = this.windows.get(key);

    // No window, or the current one elapsed: start a fresh window.
    if (!existing || t - existing.windowStart >= this.windowMs) {
      this.evictIfFull();
      this.windows.set(key, { count: 1, windowStart: t });
      return {
        allowed: true,
        limit: this.limit,
        remaining: Math.max(0, this.limit - 1),
        resetSeconds: this.resetSeconds(t, t),
      };
    }

    existing.count += 1;
    const allowed = existing.count <= this.limit;
    const reset = this.resetSeconds(existing.windowStart, t);
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - existing.count),
      resetSeconds: reset,
      ...(allowed ? {} : { retryAfterSeconds: reset }),
    };
  }

  /** Reads the current state without consuming budget. */
  peek(key: string): RateLimitVerdict {
    const t = this.now();
    const window = this.windows.get(key);
    if (!window) {
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit,
        resetSeconds: this.resetSeconds(t, t),
      };
    }
    return {
      allowed: window.count < this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - window.count),
      resetSeconds: this.resetSeconds(window.windowStart, t),
    };
  }

  reset(key?: string): void {
    if (key === undefined) this.windows.clear();
    else this.windows.delete(key);
  }

  get trackedKeys(): number {
    return this.windows.size;
  }

  /**
   * Drops the oldest window when the key count is over the cap. Map preserves
   * insertion order, so the first key is the oldest; it is the one most likely to
   * be a caller who has already rotated away.
   */
  /** Seconds until the window that started at `windowStart` rolls over. */
  private resetSeconds(windowStart: number, t: number): number {
    const remainingMs = Math.max(0, windowStart + this.windowMs - t);
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  private evictIfFull(): void {
    if (this.windows.size < this.maxKeys) return;
    const oldest = this.windows.keys().next();
    if (!oldest.done) this.windows.delete(oldest.value);
  }
}
