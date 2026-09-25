import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { get, run, tx } from "../db.ts";
import { seedSkillsFromDisk } from "../skills/library.ts";
import { log } from "../util.ts";
import { seedMockWms } from "../wms/mock/store.ts";

/** First start: load the bundled skills and the mock WMS demo data. */
export function seedAll() {
  const count = get<{ n: number }>("SELECT COUNT(*) AS n FROM skills")!.n;
  if (count === 0) {
    const added = seedSkillsFromDisk(config.paths.seedSkills);
    log("seed", `初期スキルを ${added} 件登録しました`);
  }
  const extra = seedSkillsFromDisk(config.paths.skills);
  if (extra) log("seed", `skills/ フォルダから追加のスキルを ${extra} 件登録しました`);
  seedMockWms();
}

const APP_TABLES = [
  "case_events",
  "cases",
  "photos",
  "inspections",
  "builder_sessions",
  "skill_requests",
  "proposals",
  "operation_errors",
  "ai_calls",
  "skill_versions",
  "skills",
  "counters",
];

/** Wipes demo data (settings are kept) and loads the bundled data again. */
export function resetAll() {
  tx(() => {
    for (const t of APP_TABLES) run(`DELETE FROM ${t}`);
  });
  fs.rmSync(config.paths.uploads, { recursive: true, force: true });
  fs.mkdirSync(config.paths.uploads, { recursive: true });
  for (const entry of fs.readdirSync(config.paths.skills)) {
    fs.rmSync(path.join(config.paths.skills, entry), { recursive: true, force: true });
  }
  seedSkillsFromDisk(config.paths.seedSkills);
  seedMockWms(true);
  log("seed", "デモデータを初期化しました");
}
