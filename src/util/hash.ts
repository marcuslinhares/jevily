import { createHash } from "node:crypto";

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Short, stable id for a result or a trace. */
export function shortId(prefix = "", len = 12): string {
  const s = createHash("sha256")
    .update(`${Date.now().toString(36)}:${Math.random()}`)
    .digest("hex")
    .slice(0, len);
  return prefix ? `${prefix}_${s}` : s;
}

/** Stable cache key from any JSON-serializable value, with key order normalized. */
export function stableKey(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
