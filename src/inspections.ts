import fs from "node:fs";
import path from "node:path";
import { aiMode } from "./ai/client.ts";
import { judgeDemo } from "./ai/demoJudge.ts";
import { decideRouting, type JudgeInput, type Judgment, judgeLive, type Verdict } from "./ai/judge.ts";
import { normalizeUpload } from "./ai/images.ts";
import { createCaseFromInspection } from "./cases.ts";
import { config } from "./config.ts";
import { all, get, insert, nextId, parseJson, run, update } from "./db.ts";
import { getSettings } from "./settings.ts";
import { extractPhotoInstructions, parseSkill } from "./skills/format.ts";
import { getVersion } from "./skills/library.ts";
import { type Resolution, resolveInspectionSkills, type ResolvedSkill } from "./skills/resolver.ts";
import { createSkillRequest } from "./skillRequests.ts";
import { errorMessage, log, nowIso, runInBackground, sha256, TaskQueue } from "./util.ts";
import { getWms } from "./wms/adapter.ts";
import type { InspectionResult, WmsShipment } from "./wms/types.ts";

export type InspectionStatus = "capturing" | "queued" | "judging" | "judged" | "confirmed" | "error";
export type HumanVerdict = "OK" | "NG" | "保留";

export interface InspectionRow {
  id: string;
  shipment_id: string;
  customer_id: string;
  customer_name: string;
  category: string;
  shipment: string;
  skills: string;
  resolution: string;
  status: InspectionStatus;
  ai_mode: string | null;
  ai_model: string | null;
  ai_result: string | null;
  ai_overall: Verdict | null;
  ai_min_confidence: number | null;
  ai_usage: string | null;
  ai_error: string | null;
  ai_started_at: string | null;
  ai_finished_at: string | null;
  routing: "auto_ok" | "human_review" | null;
  human_overall: HumanVerdict | null;
  human_note: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  wms_registered_at: string | null;
  wms_error: string | null;
  case_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface PhotoRow {
  id: number;
  inspection_id: string;
  kind: "customer" | "worker";
  seq: number;
  file: string;
  mime: string;
  sha256: string;
  original_name: string;
  source_url: string | null;
  created_at: string;
}

export interface SkillRef {
  id: string;
  versionId: number;
  version: string;
  layer: string;
  title: string;
}

export class InspectionError extends Error {}

const queue = new TaskQueue(getSettings().concurrency);

const photoUrl = (p: PhotoRow) => `/files/${p.inspection_id}/${p.file}`;
const labelOf = (p: PhotoRow) => `${p.kind === "customer" ? "顧客写真" : "現物写真"}${p.seq}`;

export function getRow(id: string): InspectionRow | undefined {
  return get<InspectionRow>("SELECT * FROM inspections WHERE id = ?", id);
}

function photos(id: string): PhotoRow[] {
  return all<PhotoRow>("SELECT * FROM photos WHERE inspection_id = ? ORDER BY kind, seq", id);
}

export function view(row: InspectionRow) {
  const ph = photos(row.id);
  const shipment = parseJson<WmsShipment>(row.shipment, {} as WmsShipment);
  const skills = parseJson<SkillRef[]>(row.skills, []);
  const photoInstructions = skills.flatMap((s) => {
    const v = getVersion(s.versionId);
    if (!v) return [];
    try {
      return extractPhotoInstructions(parseSkill(v.content).body).map((text) => ({ skill: s.title, text }));
    } catch {
      return [];
    }
  });
  return {
    id: row.id,
    shipmentId: row.shipment_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    category: row.category,
    shipment,
    skills,
    resolution: parseJson<Omit<Resolution, "skills">>(row.resolution, { method: "key", notes: [], missingCategory: false }),
    photoInstructions,
    status: row.status,
    ai: {
      mode: row.ai_mode,
      model: row.ai_model,
      result: parseJson<(Judgment & { routing_reasons?: string[] }) | null>(row.ai_result, null),
      overall: row.ai_overall,
      minConfidence: row.ai_min_confidence,
      usage: parseJson(row.ai_usage, null),
      error: row.ai_error,
      startedAt: row.ai_started_at,
      finishedAt: row.ai_finished_at,
    },
    routing: row.routing,
    human: row.human_overall
      ? { overall: row.human_overall, note: row.human_note ?? "", by: row.confirmed_by ?? "", at: row.confirmed_at ?? "" }
      : null,
    wms: { registeredAt: row.wms_registered_at, error: row.wms_error },
    caseId: row.case_id,
    photos: ph.map((p) => ({ id: p.id, kind: p.kind, seq: p.seq, label: labelOf(p), url: photoUrl(p), name: p.original_name })),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listInspections(opts: { limit?: number; status?: string } = {}) {
  const rows = opts.status
    ? all<InspectionRow>("SELECT * FROM inspections WHERE status = ? ORDER BY created_at DESC LIMIT ?", opts.status, opts.limit ?? 50)
    : all<InspectionRow>("SELECT * FROM inspections ORDER BY created_at DESC LIMIT ?", opts.limit ?? 50);
  return rows.map((row) => {
    const first = get<PhotoRow>("SELECT * FROM photos WHERE inspection_id = ? AND kind = 'worker' ORDER BY seq LIMIT 1", row.id);
    return {
      id: row.id,
      shipmentId: row.shipment_id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      category: row.category,
      status: row.status,
      aiOverall: row.ai_overall,
      aiError: row.ai_error,
      routing: row.routing,
      humanOverall: row.human_overall,
      caseId: row.case_id,
      thumb: first ? photoUrl(first) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

function touch(id: string, patch: Record<string, unknown>) {
  update("inspections", "id", id, { ...patch, updated_at: nowIso() });
}

async function storePhoto(id: string, kind: "customer" | "worker", buffer: Buffer, originalName: string, sourceUrl?: string) {
  const { buffer: data, mime, ext } = await normalizeUpload(buffer);
  const seq = (get<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM photos WHERE inspection_id = ? AND kind = ?", id, kind)!.n ?? 0) + 1;
  const file = `${kind}-${seq}.${ext}`;
  const dir = path.join(config.paths.uploads, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), data);
  insert("photos", {
    inspection_id: id,
    kind,
    seq,
    file,
    mime,
    sha256: sha256(data),
    original_name: originalName,
    source_url: sourceUrl ?? null,
    created_at: nowIso(),
  });
}

/** Starts an inspection for a shipment: snapshots WMS data, picks skills, copies customer photos. */
export async function startInspection(shipmentId: string, createdBy: string) {
  const open = get<InspectionRow>(
    "SELECT * FROM inspections WHERE shipment_id = ? AND status IN ('capturing','queued','judging','judged','error') ORDER BY created_at DESC LIMIT 1",
    shipmentId,
  );
  if (open) return view(open);

  const wms = getWms();
  const shipment = await wms.getShipment(shipmentId);
  const resolution = await resolveInspectionSkills(
    { customerId: shipment.customer.id, category: shipment.category, itemNames: shipment.items.map((i) => i.name) },
    { allowAi: aiMode() === "live" },
  );
  const id = nextId("INSP");
  const now = nowIso();
  const skillRefs: SkillRef[] = resolution.skills.map((s) => ({ id: s.id, versionId: s.versionId, version: s.version, layer: s.layer, title: s.title }));
  insert("inspections", {
    id,
    shipment_id: shipment.id,
    customer_id: shipment.customer.id,
    customer_name: shipment.customer.name,
    category: shipment.category,
    shipment,
    skills: skillRefs,
    resolution: { method: resolution.method, notes: resolution.notes, missingCategory: resolution.missingCategory },
    status: "capturing",
    created_by: createdBy,
    created_at: now,
    updated_at: now,
  });
  for (const [i, url] of shipment.customerPhotoUrls.entries()) {
    try {
      await storePhoto(id, "customer", await wms.downloadPhoto(url), `顧客写真${i + 1}`, url);
    } catch (e) {
      log("inspection", `${id}: 顧客写真を取得できませんでした (${url}): ${errorMessage(e)}`);
    }
  }
  if (resolution.missingCategory) {
    createSkillRequest({
      reason: `カテゴリ「${shipment.category}」の検品スキルがありません`,
      category: shipment.category,
      customerId: shipment.customer.id,
      inspectionId: id,
      example: { items: shipment.items },
    });
  }
  return view(getRow(id)!);
}

/** Picks skills again for an unconfirmed inspection (e.g. after a missing skill was published). */
export async function reresolveSkills(id: string) {
  const row = requireRow(id);
  if (!["capturing", "judged", "error"].includes(row.status)) throw new InspectionError("判定中・確定済みの検品はスキルを選び直せません");
  const shipment = parseJson<WmsShipment>(row.shipment, {} as WmsShipment);
  const resolution = await resolveInspectionSkills(
    { customerId: row.customer_id, category: row.category, itemNames: (shipment.items ?? []).map((i) => i.name) },
    { allowAi: aiMode() === "live" },
  );
  touch(id, {
    skills: resolution.skills.map((s) => ({ id: s.id, versionId: s.versionId, version: s.version, layer: s.layer, title: s.title })),
    resolution: { method: resolution.method, notes: resolution.notes, missingCategory: resolution.missingCategory },
    status: row.status === "judged" ? "capturing" : row.status,
  });
  if (resolution.missingCategory) {
    createSkillRequest({
      reason: `カテゴリ「${row.category}」の検品スキルがありません`,
      category: row.category,
      customerId: row.customer_id,
      inspectionId: id,
      example: { items: shipment.items },
    });
  }
  return view(getRow(id)!);
}

function requireRow(id: string): InspectionRow {
  const row = getRow(id);
  if (!row) throw new InspectionError(`検品 ${id} が見つかりません`);
  return row;
}

export async function addWorkerPhotos(id: string, files: Array<{ buffer: Buffer; originalname: string }>) {
  const row = requireRow(id);
  if (row.status === "confirmed") throw new InspectionError("確定済みの検品には写真を追加できません");
  let added = 0;
  const failed: string[] = [];
  for (const f of files) {
    try {
      await storePhoto(id, "worker", f.buffer, f.originalname);
      added++;
    } catch {
      failed.push(f.originalname);
    }
  }
  if (added && (row.status === "judged" || row.status === "error")) touch(id, { status: "capturing" });
  else touch(id, {});
  return { added, failed, inspection: view(getRow(id)!) };
}

/** Demo helper: attaches the bundled "received" sample photos for this shipment. */
export async function addSamplePhotos(id: string) {
  const row = requireRow(id);
  const dir = path.join(config.paths.samples, "現物写真", row.shipment_id);
  if (!fs.existsSync(dir)) throw new InspectionError("この納品にはサンプル写真がありません");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map((f) => ({ buffer: fs.readFileSync(path.join(dir, f)), originalname: f }));
  return addWorkerPhotos(id, files);
}

export function removePhoto(id: string, photoId: number) {
  const row = requireRow(id);
  if (row.status === "confirmed") throw new InspectionError("確定済みの検品の写真は削除できません");
  const p = get<PhotoRow>("SELECT * FROM photos WHERE id = ? AND inspection_id = ?", photoId, id);
  if (!p || p.kind !== "worker") throw new InspectionError("削除できる写真が見つかりません");
  fs.rmSync(path.join(config.paths.uploads, id, p.file), { force: true });
  run("DELETE FROM photos WHERE id = ?", photoId);
  touch(id, { status: row.status === "judged" ? "capturing" : row.status });
  return view(getRow(id)!);
}

export function requestJudgment(id: string) {
  const row = requireRow(id);
  if (!["capturing", "judged", "error"].includes(row.status)) throw new InspectionError("この検品はいまAI判定を開始できません");
  const workers = all<PhotoRow>("SELECT * FROM photos WHERE inspection_id = ? AND kind = 'worker'", id);
  if (workers.length === 0) throw new InspectionError("現物写真を1枚以上追加してください");
  touch(id, { status: "queued", ai_error: null });
  queue.concurrency = getSettings().concurrency;
  runInBackground(`judge ${id}`, () => queue.run(() => runJudgment(id)), (e) => {
    touch(id, { status: "error", ai_error: errorMessage(e) });
  });
  return view(getRow(id)!);
}

function loadSkills(refs: SkillRef[], override?: { skillId: string; content: string }): ResolvedSkill[] {
  return refs.flatMap((r) => {
    const content = override && override.skillId === r.id ? override.content : getVersion(r.versionId)?.content;
    if (!content) return [];
    const info = parseSkill(content);
    return [{ id: r.id, versionId: r.versionId, version: r.version, layer: info.layer, title: info.title, content, info }];
  });
}

export function judgeInput(row: InspectionRow, override?: { skillId: string; content: string }): JudgeInput {
  const shipment = parseJson<WmsShipment>(row.shipment, {} as WmsShipment);
  const ph = photos(row.id);
  const ref = (p: PhotoRow) => ({ label: labelOf(p), path: path.join(config.paths.uploads, row.id, p.file) });
  return {
    shipmentId: row.shipment_id,
    customerId: row.customer_id,
    category: row.category,
    declaredValue: shipment.declaredValue ?? 0,
    items: shipment.items ?? [],
    customerPhotos: ph.filter((p) => p.kind === "customer").map(ref),
    workerPhotos: ph.filter((p) => p.kind === "worker").map(ref),
    skills: loadSkills(parseJson<SkillRef[]>(row.skills, []), override),
  };
}

/** Runs the model (or the demo stand-in) on an inspection. Used by live judging and regression tests. */
export async function judge(row: InspectionRow, override?: { skillId: string; content: string }) {
  const input = judgeInput(row, override);
  if (aiMode() === "live") return { ...(await judgeLive(input, config.imageMaxPx)), mode: "live" as const };
  return { judgment: judgeDemo(input), usage: null, model: "demo", mode: "demo" as const };
}

async function runJudgment(id: string) {
  const row = requireRow(id);
  touch(id, { status: "judging", ai_started_at: nowIso() });
  const { judgment, usage, model, mode } = await judge(row);
  const shipment = parseJson<WmsShipment>(row.shipment, {} as WmsShipment);
  const decision = decideRouting(judgment, shipment.declaredValue ?? 0);
  touch(id, {
    status: "judged",
    ai_mode: mode,
    ai_model: model,
    ai_result: { ...judgment, routing_reasons: decision.reasons },
    ai_overall: judgment.overall,
    ai_min_confidence: judgment.min_confidence,
    ai_usage: usage,
    ai_finished_at: nowIso(),
    routing: decision.routing,
  });
  log("inspection", `${id}: AI判定 ${judgment.overall}（${decision.routing === "auto_ok" ? "自動OK" : "人の確認へ"}）`);
  if (decision.routing === "auto_ok") {
    await confirmInspection(id, { overall: "OK", note: "AIが自動でOKと判定（確信度・金額の基準を満たしたため）", actor: "AI（自動確定）" });
  }
}

const TO_WMS: Record<HumanVerdict, InspectionResult> = { OK: "OK", NG: "NG", 保留: "保留" };

/** A person (or the auto-OK rule) fixes the result; the WMS is updated and NG opens a customer case. */
export async function confirmInspection(id: string, input: { overall: HumanVerdict; note: string; actor: string }) {
  const row = requireRow(id);
  if (!["capturing", "judged", "error"].includes(row.status)) throw new InspectionError("この検品はいま確定できません");
  if (!["OK", "NG", "保留"].includes(input.overall)) throw new InspectionError("判定は OK / NG / 保留 から選んでください");
  const aiDecided = row.ai_overall === "OK" || row.ai_overall === "NG";
  if (aiDecided && row.ai_overall !== input.overall && !input.note.trim()) {
    throw new InspectionError("AIの判定と違う結果にする場合は、理由をメモに書いてください（スキル改善に使います）");
  }
  const workerCount = get<{ n: number }>("SELECT COUNT(*) AS n FROM photos WHERE inspection_id = ? AND kind = 'worker'", id)!.n;
  if (workerCount === 0) throw new InspectionError("現物写真がない検品は確定できません（証跡として1枚以上必要です）");

  touch(id, {
    status: "confirmed",
    human_overall: input.overall,
    human_note: input.note.trim(),
    confirmed_by: input.actor,
    confirmed_at: nowIso(),
  });
  await registerToWms(id);
  if (input.overall === "NG") {
    const caseId = createCaseFromInspection(id);
    touch(id, { case_id: caseId });
  }
  return view(getRow(id)!);
}

export async function registerToWms(id: string) {
  const row = requireRow(id);
  if (!row.human_overall) throw new InspectionError("確定前の検品はWMSに登録できません");
  const wms = getWms();
  const result = parseJson<Judgment | null>(row.ai_result, null);
  const note = [row.human_note, result?.summary ? `AI: ${result.summary}` : ""].filter(Boolean).join(" / ");
  try {
    const workers = photos(id).filter((p) => p.kind === "worker");
    await wms.uploadEvidence(
      row.shipment_id,
      workers.map((p) => ({ name: `${row.id}-${p.file}`, buffer: fs.readFileSync(path.join(config.paths.uploads, id, p.file)), mime: p.mime })),
    );
    await wms.registerInspection(row.shipment_id, TO_WMS[row.human_overall], note, row.confirmed_by ?? "");
    touch(id, { wms_registered_at: nowIso(), wms_error: null });
  } catch (e) {
    touch(id, { wms_error: errorMessage(e) });
    log("inspection", `${id}: WMS登録に失敗: ${errorMessage(e)}`);
  }
  return view(getRow(id)!);
}
