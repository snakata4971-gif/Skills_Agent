import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { all, get, insert, parseJson, run, tx, update } from "../db.ts";
import { bumpVersion, compareVersions, nowIso } from "../util.ts";
import { LAYERS, type AppliesTo, type Layer, parseSkill, SkillFormatError, type SkillInfo, withVersion } from "./format.ts";

export interface SkillRow {
  id: string;
  layer: Layer;
  name: string;
  title: string;
  description: string;
  applies_to: string;
  meta: string;
  current_version_id: number | null;
  status: "active" | "deprecated";
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: number;
  skill_id: string;
  version: string;
  status: "draft" | "approved" | "superseded" | "rejected";
  content: string;
  change_note: string;
  source: string;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

export interface SkillSummary {
  id: string;
  layer: Layer;
  name: string;
  title: string;
  description: string;
  appliesTo: AppliesTo;
  owner: string;
  status: SkillRow["status"];
  currentVersionId: number | null;
  currentVersion: string | null;
  approvedAt: string | null;
  draftCount: number;
  usageCount: number;
  updatedAt: string;
}

export class LibraryError extends Error {}

export const skillIdOf = (layer: string, name: string) => `${layer}/${name}`;

function summarize(row: SkillRow): SkillSummary {
  const current = row.current_version_id
    ? get<VersionRow>("SELECT * FROM skill_versions WHERE id = ?", row.current_version_id)
    : undefined;
  const drafts = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id = ? AND status = 'draft'",
    row.id,
  )!.n;
  const usage = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM inspections WHERE skills LIKE ?",
    `%"id":"${row.id}"%`,
  )!.n;
  const meta = parseJson<Record<string, unknown>>(row.meta, {});
  return {
    id: row.id,
    layer: row.layer,
    name: row.name,
    title: row.title,
    description: row.description,
    appliesTo: parseJson<AppliesTo>(row.applies_to, {}),
    owner: String(meta.owner ?? ""),
    status: row.status,
    currentVersionId: row.current_version_id,
    currentVersion: current?.version ?? null,
    approvedAt: current?.approved_at ?? null,
    draftCount: drafts,
    usageCount: usage,
    updatedAt: row.updated_at,
  };
}

export function listSkills(filter: { layer?: string; q?: string; includeDeprecated?: boolean } = {}): SkillSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.layer) {
    where.push("s.layer = ?");
    params.push(filter.layer);
  }
  if (!filter.includeDeprecated) where.push("s.status = 'active'");
  if (filter.q) {
    where.push(
      "(s.title LIKE ? OR s.description LIKE ? OR s.id LIKE ? OR EXISTS (SELECT 1 FROM skill_versions v WHERE v.id = s.current_version_id AND v.content LIKE ?))",
    );
    const like = `%${filter.q}%`;
    params.push(like, like, like, like);
  }
  const rows = all<SkillRow>(
    `SELECT s.* FROM skills s ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY s.layer, s.id`,
    ...params,
  );
  const order = new Map(LAYERS.map((l, i) => [l, i]));
  return rows.map(summarize).sort((a, b) => (order.get(a.layer)! - order.get(b.layer)!) || a.id.localeCompare(b.id));
}

export function getSkillRow(id: string): SkillRow | undefined {
  return get<SkillRow>("SELECT * FROM skills WHERE id = ?", id);
}

export function getSkill(id: string) {
  const row = getSkillRow(id);
  if (!row) return undefined;
  const versions = all<VersionRow>("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY id DESC", id);
  return { ...summarize(row), meta: parseJson<Record<string, unknown>>(row.meta, {}), versions };
}

export function getVersion(versionId: number): VersionRow | undefined {
  return get<VersionRow>("SELECT * FROM skill_versions WHERE id = ?", versionId);
}

export function getApprovedVersion(skillId: string): VersionRow | undefined {
  const row = getSkillRow(skillId);
  if (!row?.current_version_id) return undefined;
  return getVersion(row.current_version_id);
}

/** Approved, active skills with their parsed content, optionally limited to some layers. */
export function approvedSkills(layers?: Layer[]): Array<{ row: SkillRow; version: VersionRow; info: SkillInfo }> {
  const rows = all<SkillRow>(
    "SELECT * FROM skills WHERE status = 'active' AND current_version_id IS NOT NULL ORDER BY id",
  ).filter((r) => !layers || layers.includes(r.layer));
  return rows.flatMap((row) => {
    const version = getVersion(row.current_version_id!);
    if (!version) return [];
    try {
      return [{ row, version, info: parseSkill(version.content) }];
    } catch {
      return [];
    }
  });
}

function latestVersionString(skillId: string): string {
  const versions = all<{ version: string }>("SELECT version FROM skill_versions WHERE skill_id = ?", skillId);
  return versions.map((v) => v.version).sort(compareVersions).at(-1) ?? "0.0.0";
}

function validate(content: string): SkillInfo {
  try {
    return parseSkill(content);
  } catch (e) {
    if (e instanceof SkillFormatError) throw new LibraryError(`スキルの形式に誤りがあります: ${e.message}`);
    throw e;
  }
}

interface DraftOptions {
  source: "seed" | "builder" | "improvement" | "manual" | "rollback";
  createdBy: string;
  changeNote: string;
}

/** Creates a brand-new skill whose first version is a draft (or approved, for seeding). */
export function createSkill(content: string, opts: DraftOptions & { approve?: boolean }): { skillId: string; versionId: number } {
  const info = validate(content);
  const id = skillIdOf(info.layer, info.name);
  if (getSkillRow(id)) throw new LibraryError(`同じ名前のスキル（${id}）がすでにあります。既存スキルの新しい版として保存してください`);
  const now = nowIso();
  return tx(() => {
    insert("skills", {
      id,
      layer: info.layer,
      name: info.name,
      title: info.title,
      description: info.description,
      applies_to: info.appliesTo,
      meta: metaOf(info),
      current_version_id: null,
      status: "active",
      created_at: now,
      updated_at: now,
    });
    const versionId = Number(
      insert("skill_versions", {
        skill_id: id,
        version: info.version,
        status: "draft",
        content: withVersion(content, info.version),
        change_note: opts.changeNote,
        source: opts.source,
        created_by: opts.createdBy,
        created_at: now,
      }).lastInsertRowid,
    );
    if (opts.approve) approveVersion(versionId, opts.createdBy || "system");
    return { skillId: id, versionId };
  });
}

/** Saves a new draft version of an existing skill. The version number is bumped automatically. */
export function createDraft(skillId: string, content: string, opts: DraftOptions): VersionRow {
  const row = getSkillRow(skillId);
  if (!row) throw new LibraryError(`スキル ${skillId} が見つかりません`);
  const info = validate(content);
  if (skillIdOf(info.layer, info.name) !== skillId) {
    throw new LibraryError(
      `name と metadata.layer は変更できません（このスキルは ${row.layer} / ${row.name} です）`,
    );
  }
  const version = bumpVersion(latestVersionString(skillId), "minor");
  const id = Number(
    insert("skill_versions", {
      skill_id: skillId,
      version,
      status: "draft",
      content: withVersion(content, version),
      change_note: opts.changeNote,
      source: opts.source,
      created_by: opts.createdBy,
      created_at: nowIso(),
    }).lastInsertRowid,
  );
  update("skills", "id", skillId, { updated_at: nowIso() });
  return getVersion(id)!;
}

function metaOf(info: SkillInfo) {
  return {
    owner: info.owner,
    requires_approval: info.requiresApproval,
    wms_status: info.wmsStatus,
    worker_instruction: info.workerInstruction,
  };
}

/** Publishes a version: it becomes the one agents use, and SKILL.md on disk is updated. */
export function approveVersion(versionId: number, approver: string): VersionRow {
  const version = getVersion(versionId);
  if (!version) throw new LibraryError("版が見つかりません");
  if (version.status !== "draft") throw new LibraryError("承認できるのは下書きの版だけです");
  const info = validate(version.content);
  const now = nowIso();
  tx(() => {
    run("UPDATE skill_versions SET status = 'superseded' WHERE skill_id = ? AND status = 'approved'", version.skill_id);
    update("skill_versions", "id", versionId, { status: "approved", approved_by: approver, approved_at: now });
    update("skills", "id", version.skill_id, {
      current_version_id: versionId,
      title: info.title,
      description: info.description,
      applies_to: info.appliesTo,
      meta: metaOf(info),
      status: "active",
      updated_at: now,
    });
  });
  writeSkillFile(version.skill_id, version.content);
  return getVersion(versionId)!;
}

export function rejectVersion(versionId: number, by: string, reason = ""): VersionRow {
  const version = getVersion(versionId);
  if (!version) throw new LibraryError("版が見つかりません");
  if (version.status !== "draft") throw new LibraryError("却下できるのは下書きの版だけです");
  update("skill_versions", "id", versionId, {
    status: "rejected",
    change_note: reason ? `${version.change_note}\n[却下: ${by}] ${reason}`.trim() : version.change_note,
  });
  return getVersion(versionId)!;
}

/** Re-publishes an older version's content as a new version (history is never rewritten). */
export function rollbackTo(skillId: string, versionId: number, by: string): VersionRow {
  const old = getVersion(versionId);
  if (!old || old.skill_id !== skillId) throw new LibraryError("戻し先の版が見つかりません");
  const draft = createDraft(skillId, old.content, {
    source: "rollback",
    createdBy: by,
    changeNote: `版 ${old.version} の内容に戻しました`,
  });
  return approveVersion(draft.id, by);
}

export function setSkillStatus(skillId: string, status: "active" | "deprecated") {
  if (!getSkillRow(skillId)) throw new LibraryError(`スキル ${skillId} が見つかりません`);
  update("skills", "id", skillId, { status, updated_at: nowIso() });
}

export function writeSkillFile(skillId: string, content: string) {
  const [layer, name] = skillId.split("/");
  if (!layer || !name || !/^[a-z0-9-]+$/.test(name)) return;
  const dir = path.join(config.paths.skills, layer, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content.endsWith("\n") ? content : content + "\n");
}

/** Loads SKILL.md folders into the library (only skills not yet in the database). */
export function seedSkillsFromDisk(dir = config.paths.skills): number {
  let added = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const layer of fs.readdirSync(dir)) {
    const layerDir = path.join(dir, layer);
    if (!fs.statSync(layerDir).isDirectory()) continue;
    for (const name of fs.readdirSync(layerDir)) {
      const file = path.join(layerDir, name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      try {
        const info = parseSkill(content);
        if (getSkillRow(skillIdOf(info.layer, info.name))) continue;
        createSkill(content, { source: "seed", createdBy: "初期データ", changeNote: "初期スキル", approve: true });
        added++;
      } catch (e) {
        console.warn(`[skills] ${file} を読み込めませんでした: ${(e as Error).message}`);
      }
    }
  }
  return added;
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Line-based diff (LCS). Skill files are small, so O(n*m) is fine. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split(/\r?\n/);
  const y = b.split(/\r?\n/);
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ type: "same", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: x[i++] });
    } else {
      out.push({ type: "add", text: y[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: x[i++] });
  while (j < m) out.push({ type: "add", text: y[j++] });
  return out;
}

export function diffVersions(fromId: number, toId: number): DiffLine[] {
  const from = getVersion(fromId);
  const to = getVersion(toId);
  if (!from || !to) throw new LibraryError("比較する版が見つかりません");
  return diffLines(from.content, to.content);
}
