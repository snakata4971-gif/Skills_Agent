import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { sha256 } from "../util.ts";
import { finalize, type JudgeInput, type Judgment, type RawJudgment } from "./judge.ts";

export interface SampleManifest {
  images: Record<string, { scenario: string; role: "customer" | "received"; file: string }>;
  scenarios: Record<string, { title: string; judgment: RawJudgment }>;
}

let cached: SampleManifest | null = null;
export function loadManifest(): SampleManifest {
  if (cached) return cached;
  const file = path.join(config.paths.seed, "samples-manifest.json");
  cached = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as SampleManifest)
    : { images: {}, scenarios: {} };
  return cached;
}

const unknownResult = (reason: string): RawJudgment => ({
  overall: "要確認",
  summary: `デモモード（AI未接続）のため自動判定できません。${reason}`,
  checks: [
    {
      item: "AI判定",
      result: "要確認",
      confidence: 0,
      reason: "AIが接続されていないため、人が写真を見比べて判定してください",
      evidence: [],
    },
  ],
  issues: [],
  observed_quantity: -1,
  additional_photos: [],
  skill_gaps: [],
});

/**
 * Stand-in for the model when no API key is set: recognises the bundled sample photos and
 * returns the judgment prepared for that scenario. Any other photo is sent to a human.
 */
export function judgeDemo(input: JudgeInput): Judgment {
  const manifest = loadManifest();
  const scenarios = new Set<string>();
  for (const p of input.workerPhotos) {
    const hit = manifest.images[sha256(fs.readFileSync(p.path))];
    if (hit?.role === "received") scenarios.add(hit.scenario);
  }
  if (scenarios.size === 0) {
    return finalize(unknownResult("同梱のサンプル写真以外は、人が確認してください。"));
  }
  if (scenarios.size > 1 || !scenarios.has(input.shipmentId)) {
    return finalize(unknownResult("別の納品のサンプル写真が含まれています。"));
  }
  const scenario = manifest.scenarios[input.shipmentId];
  if (!scenario) return finalize(unknownResult("このサンプルの模擬判定がありません。"));
  return finalize(structuredClone(scenario.judgment));
}
