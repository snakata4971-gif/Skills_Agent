import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile) && !process.env.QA_SKIP_ENV_FILE) {
  process.loadEnvFile(envFile);
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

const DATA_DIR = path.resolve(env("QA_DATA_DIR", path.join(ROOT, "data")));

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

function parseEffort(v: string): Effort {
  return (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as Effort) : "high";
}

const port = Number(env("PORT", "3000"));

export const config = {
  port,
  appBaseUrl: env("APP_BASE_URL", `http://localhost:${port}`),
  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  anthropicAuthToken: env("ANTHROPIC_AUTH_TOKEN"),
  model: env("QA_MODEL", "claude-opus-5"),
  effort: parseEffort(env("QA_EFFORT", "high")),
  imageMaxPx: Number(env("QA_IMAGE_MAX_PX", "1280")),
  forceDemo: env("QA_FORCE_DEMO") === "1",
  wms: {
    mode: (env("WMS_MODE", "api") === "browser" ? "browser" : "api") as "api" | "browser",
    baseUrl: env("WMS_BASE_URL", `http://localhost:${port}/wms`),
    apiKey: env("WMS_API_KEY", "demo-wms-key"),
    chromePath: env("CHROME_PATH"),
  },
  paths: {
    root: ROOT,
    data: DATA_DIR,
    db: path.join(DATA_DIR, "qa.sqlite"),
    uploads: path.join(DATA_DIR, "uploads"),
    wmsFiles: path.join(DATA_DIR, "wms-files"),
    skills: path.resolve(env("QA_SKILLS_DIR", path.join(ROOT, "skills"))),
    seed: path.join(ROOT, "seed"),
    seedSkills: path.join(ROOT, "seed", "skills"),
    samples: path.join(ROOT, "samples"),
    public: path.join(ROOT, "public"),
  },
};

for (const dir of [config.paths.data, config.paths.uploads, config.paths.wmsFiles, config.paths.skills]) {
  fs.mkdirSync(dir, { recursive: true });
}
