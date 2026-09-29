/**
 * The rate limiter's own arithmetic, on a clock the test controls.
 *
 * A real sleep would make this suite slow and still be racy at the boundary. The
 * limiter takes an injected clock precisely so the window edge can be tested
 * exactly, which is where a fixed-window limiter either over- or under-admits.
 */

import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/util/rate-limit.js";

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("rate limiter", () => {
  it("allows exactly the limit and then refuses", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    expect([limiter.take("k").allowed, limiter.take("k").allowed, limiter.take("k").allowed]).toEqual([
      true,
      true,
      true,
    ]);
    const refused = limiter.take("k");
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it("counts down the remaining budget", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });
    expect(limiter.take("k").remaining).toBe(2);
    expect(limiter.take("k").remaining).toBe(1);
    expect(limiter.take("k").remaining).toBe(0);
    expect(limiter.take("k").remaining).toBe(0);
  });

  it("keeps separate budgets per key", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("b").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
  });

  it("opens a fresh window once the old one elapses", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });
    limiter.take("k");
    limiter.take("k");
    expect(limiter.take("k").allowed).toBe(false);

    clock.advance(59_999);
    expect(limiter.take("k").allowed, "one ms before the boundary is still the old window").toBe(false);

    clock.advance(1);
    expect(limiter.take("k").allowed, "the window rolled over").toBe(true);
    expect(limiter.take("k").remaining).toBe(0);
  });

  it("always reports a retry delay of at least one second", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 250, now: clock.now });
    limiter.take("k");
    const refused = limiter.take("k");
    // A sub-second window must not advertise "retry in 0s", which invites a hot loop.
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it("does not consume budget when peeking", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, now: clock.now });
    limiter.take("k");
    expect(limiter.peek("k").remaining).toBe(1);
    expect(limiter.peek("k").remaining).toBe(1);
    expect(limiter.take("k").allowed).toBe(true);
  });

  it("reports an unknown key as fully available", () => {
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, now: () => 0 });
    expect(limiter.peek("never-seen")).toMatchObject({ allowed: true, remaining: 5 });
  });

  it("clears one key or all of them", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });
    limiter.take("a");
    limiter.take("b");
    expect(limiter.peek("a").allowed).toBe(false);
    limiter.reset("a");
    expect(limiter.peek("a").allowed).toBe(true);
    expect(limiter.peek("b").allowed).toBe(false);
    limiter.reset();
    expect(limiter.peek("b").allowed).toBe(true);
  });

  it("caps tracked keys so rotating keys cannot grow memory forever", () => {
    const limiter = new RateLimiter({ limit: 10, windowMs: 60_000, maxKeys: 5, now: () => 0 });
    for (let i = 0; i < 50; i++) limiter.take(`key-${i}`);
    expect(limiter.trackedKeys).toBeLessThanOrEqual(5);
  });

  it("evicts the oldest key first, since Map preserves insertion order", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: clock.now });
    limiter.take("oldest");
    limiter.take("middle");
    expect(limiter.trackedKeys).toBe(2);

    limiter.take("newest");
    expect(limiter.trackedKeys).toBe(2);
    // The oldest is the one dropped, so it starts fresh rather than keeping its
    // spent window. That is the intended trade: a caller that has rotated away
    // costs less to forget than one that is still spending.
    expect(limiter.peek("oldest").allowed).toBe(true);
    expect(limiter.peek("newest").allowed, "the newest key kept its spent window").toBe(false);
  });
});
