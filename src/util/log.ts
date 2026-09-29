import { config } from "../config.js";

type Level = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function threshold(): number {
  return ORDER[config().LOG_LEVEL];
}

function emit(level: Exclude<Level, "silent">, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line, replacer) + "\n");
}

function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
  if (typeof v === "bigint") return v.toString();
  return v;
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
