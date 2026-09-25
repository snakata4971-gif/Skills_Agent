import crypto from "node:crypto";

export const nowIso = () => new Date().toISOString();

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export const sha256 = (data: Uint8Array | string) =>
  crypto.createHash("sha256").update(data).digest("hex");

export const randomToken = (bytes = 18) => crypto.randomBytes(bytes).toString("base64url");

export function log(scope: string, message: string, extra?: unknown) {
  const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  if (extra === undefined) console.log(`[${time}] [${scope}] ${message}`);
  else console.log(`[${time}] [${scope}] ${message}`, extra);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Runs async work without awaiting it, reporting failures to a handler instead of crashing. */
export function runInBackground(label: string, fn: () => Promise<void>, onError?: (e: unknown) => void) {
  fn().catch((e) => {
    log("background", `${label} failed: ${errorMessage(e)}`);
    try {
      onError?.(e);
    } catch (inner) {
      log("background", `${label} error handler failed: ${errorMessage(inner)}`);
    }
  });
}

/** Simple FIFO queue that runs at most `concurrency` tasks at once. */
export class TaskQueue {
  private running = 0;
  private waiting: Array<() => void> = [];
  constructor(public concurrency: number) {}

  get size() {
    return this.waiting.length;
  }
  get active() {
    return this.running;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

export function clamp01(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(1, v));
}

export function bumpVersion(version: string, part: "major" | "minor" | "patch" = "minor"): string {
  const [maj, min, pat] = version.split(".").map((x) => Number.parseInt(x, 10) || 0);
  if (part === "major") return `${maj + 1}.0.0`;
  if (part === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
