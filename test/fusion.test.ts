import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/retrieval/fusion.js";

describe("rank fusion", () => {
  it("prefers a document both channels rank near the top", () => {
    // b is 2nd lexically but 1st densely, so it should beat a, which is the reverse.
    const fused = reciprocalRankFusion([
      { channel: "lexical", ranked: [{ id: "a", score: 9 }, { id: "b", score: 8 }, { id: "c", score: 1 }] },
      { channel: "dense", ranked: [{ id: "b", score: 0.9 }, { id: "c", score: 0.5 }, { id: "a", score: 0.2 }] },
    ]);
    expect(fused[0]!.id).toBe("b");
    expect(fused[0]!.channels).toBe(2);
  });

  it("records cross-channel agreement, which is a real precision signal", () => {
    // "both" appears in each channel; "lex-only" and "dense-only" appear in one.
    const fused = reciprocalRankFusion([
      {
        channel: "lexical",
        ranked: [
          { id: "lex-only", score: 10 },
          { id: "both", score: 5 },
        ],
      },
      {
        channel: "dense",
        ranked: [
          { id: "dense-only", score: 0.9 },
          { id: "both", score: 0.4 },
        ],
      },
    ]);
    expect(fused.find((f) => f.id === "both")!.channels).toBe(2);
    expect(fused.find((f) => f.id === "lex-only")!.channels).toBe(1);
    expect(fused.find((f) => f.id === "dense-only")!.channels).toBe(1);
  });

  it("weights a channel explicitly when one is trusted more", () => {
    const fused = reciprocalRankFusion([
      { channel: "lexical", ranked: [{ id: "a", score: 9 }] },
      { channel: "dense", ranked: [{ id: "b", score: 0.9 }], weight: 5 },
    ]);
    expect(fused[0]!.id).toBe("b");
  });

  it("returns nothing when there is nothing to fuse", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ channel: "lexical", ranked: [] }])).toEqual([]);
  });

  it("honours the limit", () => {
    const ranked = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, score: 50 - i }));
    const fused = reciprocalRankFusion([{ channel: "lexical", ranked }], 60, 10);
    expect(fused).toHaveLength(10);
    expect(fused[0]!.id).toBe("d0");
  });
});
