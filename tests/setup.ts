import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Points the app at a throwaway data directory and forces demo mode.
 * Must run before any src/ module is imported (they read the environment on load),
 * so test files import src/ dynamically after calling this.
 */
export function prepareEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qa-skill-test-"));
  const port = 41000 + Math.floor(Math.random() * 4000);
  Object.assign(process.env, {
    QA_DATA_DIR: path.join(tmp, "data"),
    QA_SKILLS_DIR: path.join(tmp, "skills"),
    QA_SKIP_ENV_FILE: "1",
    QA_FORCE_DEMO: "1",
    PORT: String(port),
    WMS_MODE: "api",
    WMS_BASE_URL: `http://127.0.0.1:${port}/wms`,
    WMS_API_KEY: "test-key",
    APP_BASE_URL: `http://127.0.0.1:${port}`,
  });
  return { tmp, port, base: `http://127.0.0.1:${port}` };
}

export function client(base: string, actor = "テスト担当") {
  return async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", "X-Actor": encodeURIComponent(actor) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data.error ?? ""}`);
    return data as T;
  };
}

export async function waitFor<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 10000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() > until) throw new Error(`条件を満たしませんでした: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
