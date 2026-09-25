import fs from "node:fs";
import path from "node:path";
import { aiMode } from "./ai/client.ts";
import {
  type BuilderTarget,
  type Draft,
  generateDraftDemo,
  generateDraftLive,
  guessFromWords,
  type Question,
  refineDraftDemo,
  refineDraftLive,
} from "./ai/builder.ts";
import { config } from "./config.ts";
import { all, get, insert, nextId, parseJson, update } from "./db.ts";
import { deleteMaterialFiles, formatTime, type Material, MaterialError, processUpload, readMaterialText } from "./materials.ts";
import { LAYERS, type Layer, parseSkill, skillTemplate, SkillFormatError, splitFrontmatter } from "./skills/format.ts";
import { createDraft, createSkill, getApprovedVersion, getSkillRow, skillIdOf } from "./skills/library.ts";
import { getSkillRequest, setSkillRequestStatus } from "./skillRequests.ts";
import { errorMessage, nowIso, runInBackground } from "./util.ts";

export class BuilderError extends Error {}

interface SessionRow {
  id: string;
  title: string;
  target: string;
  materials: string;
  notes: string;
  status: "new" | "generating" | "ready" | "error" | "saved";
  mode: string | null;
  draft: string;
  questions: string;
  answers: string;
  history: string;
  error: string | null;
  saved_version_id: number | null;
  request_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface UploadedFile {
  path: string;
  originalname: string;
  mimetype: string;
}

export function suggestSlug(category: string): string {
  return guessFromWords([category])?.name ?? `category-${Date.now().toString(36)}`;
}

function sessionDir(id: string) {
  return path.join(config.paths.uploads, "builder", id);
}

function fileUrl(sessionId: string, file: string | undefined) {
  if (!file) return null;
  return `/files/builder/${sessionId}/${path.relative(sessionDir(sessionId), file).split(path.sep).join("/")}`;
}

function touch(id: string, patch: Record<string, unknown>) {
  update("builder_sessions", "id", id, { ...patch, updated_at: nowIso() });
}

function requireSession(id: string): SessionRow {
  const row = get<SessionRow>("SELECT * FROM builder_sessions WHERE id = ?", id);
  if (!row) throw new BuilderError(`作成セッション ${id} が見つかりません`);
  return row;
}

/** Sessions saved before materials had previews/timestamps still load. */
function loadMaterials(row: SessionRow): Material[] {
  return parseJson<Array<Material & { frames?: unknown }>>(row.materials, []).map((m) => {
    const frames = Array.isArray(m.frames) ? m.frames.map((f) => (typeof f === "string" ? { file: f, t: 0 } : f)) : undefined;
    return {
      ...m,
      format: m.format ?? (path.extname(m.name).slice(1).toLowerCase() || m.kind),
      size: m.size ?? (fs.existsSync(m.file) ? fs.statSync(m.file).size : 0),
      description: m.description ?? "",
      preview: m.preview ?? (m.kind === "image" ? m.file : frames?.[0]?.file),
      textFile: m.textFile ?? (m.kind === "text" ? m.file : undefined),
      frames,
    } as Material;
  });
}

function materialView(sessionId: string, m: Material) {
  const text = m.textFile ? readMaterialText(m) : "";
  return {
    id: m.id,
    kind: m.kind,
    format: m.format,
    name: m.name,
    size: m.size,
    description: m.description,
    url: fileUrl(sessionId, m.file),
    preview: fileUrl(sessionId, m.preview),
    frames: (m.frames ?? []).map((f) => ({ url: fileUrl(sessionId, f.file), t: f.t, label: formatTime(f.t) })),
    duration: m.duration ?? null,
    images: (m.images ?? []).map((i) => ({ url: fileUrl(sessionId, i.file), label: i.label })),
    units: m.units ?? null,
    textChars: m.textChars ?? (text ? text.length : null),
    textPreview: text ? text.slice(0, 4000) : "",
    notes: m.notes ?? [],
  };
}

export function sessionView(row: SessionRow) {
  const materials = loadMaterials(row);
  let validation: string | null = null;
  if (row.draft) {
    try {
      parseSkill(row.draft);
    } catch (e) {
      validation = e instanceof SkillFormatError ? e.message : errorMessage(e);
    }
  }
  return {
    id: row.id,
    title: row.title,
    target: parseJson<BuilderTarget>(row.target, {} as BuilderTarget),
    materials: materials.map((m) => materialView(row.id, m)),
    notes: row.notes,
    status: row.status,
    mode: row.mode,
    draft: row.draft,
    validation,
    questions: parseJson<Question[]>(row.questions, []),
    answers: parseJson<Record<string, string>>(row.answers, {}),
    history: parseJson<Array<{ at: string; action: string; note: string }>>(row.history, []),
    error: row.error,
    savedVersionId: row.saved_version_id,
    requestId: row.request_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSessions() {
  return all<SessionRow>("SELECT * FROM builder_sessions ORDER BY updated_at DESC LIMIT 50").map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    target: parseJson<BuilderTarget>(r.target, {} as BuilderTarget),
    materialCount: parseJson<unknown[]>(r.materials, []).length,
    updatedAt: r.updated_at,
  }));
}

export function getSession(id: string) {
  return sessionView(requireSession(id));
}

const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/[,、\s]+/)).map((x) => String(x).trim()).filter(Boolean);

function validateTarget(t: Partial<BuilderTarget>): BuilderTarget {
  const layer = (LAYERS as readonly string[]).includes(String(t.layer)) ? (t.layer as Layer) : null;
  if (!layer) throw new BuilderError("スキルの種類を選んでください");
  const title = String(t.title ?? "").trim();
  if (!title) throw new BuilderError("スキルの名前を入力してください");
  const name = String(t.name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new BuilderError("識別名は半角英小文字・数字・ハイフンで入力してください（例: sneakers）");
  const target: BuilderTarget = {
    layer,
    name,
    title,
    categories: list(t.categories),
    customers: list(t.customers),
    owner: String(t.owner ?? "").trim(),
    auto: Boolean(t.auto),
  };
  const existing = getSkillRow(skillIdOf(layer, name));
  if (existing) target.skillId = existing.id;
  return target;
}

export function createSession(input: { target: Partial<BuilderTarget>; notes?: string; createdBy: string; requestId?: string }) {
  const target = validateTarget(input.target);
  const id = nextId("BLD", 4);
  const now = nowIso();
  insert("builder_sessions", {
    id,
    title: target.title,
    target,
    notes: input.notes ?? "",
    status: "new",
    request_id: input.requestId ?? null,
    history: [{ at: now, action: "作成", note: target.skillId ? `既存スキル ${target.skillId} の改訂` : "新規スキル" }],
    created_by: input.createdBy,
    created_at: now,
    updated_at: now,
  });
  if (input.requestId) setSkillRequestStatus(input.requestId, "in_progress", id);
  return getSession(id);
}

/**
 * Quick start: files first. The name and categories stay provisional until the model (or the
 * person) sets them; words like 「スニーカー」 in file names give a first guess.
 */
export async function quickCreate(files: UploadedFile[], createdBy: string, notes = "") {
  if (files.length === 0) throw new BuilderError("資料を1つ以上選んでください");
  const guess = guessFromWords(files.map((f) => f.originalname));
  const stamp = new Date().toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  const session = createSession({
    target: {
      layer: "category",
      title: guess ? `${guess.categories[0]}検品` : `資料から作るスキル（${stamp}）`,
      name: `draft-${Date.now().toString(36)}`,
      categories: guess?.categories ?? [],
      customers: [],
      owner: createdBy === "未設定" ? "" : createdBy,
      auto: true,
    },
    notes,
    createdBy,
  });
  return addMaterials(session.id, files);
}

export function updateTarget(id: string, patch: Partial<BuilderTarget>) {
  const row = requireSession(id);
  if (row.status === "saved" || row.status === "generating") throw new BuilderError("保存済み・作成中のセッションは変更できません");
  const current = parseJson<BuilderTarget>(row.target, {} as BuilderTarget);
  const target = validateTarget({ ...current, ...patch, auto: false });
  let draft = row.draft;
  if (draft.trim()) {
    const { body } = splitFrontmatter(draft);
    draft = assemble(target, { ...emptyDraft(), body_markdown: body, description: descriptionOf(draft) });
  }
  touch(id, { target, title: target.title, draft });
  return getSession(id);
}

const emptyDraft = (): Draft => ({ title: "", description: "", body_markdown: "", questions: [], summary: "", suggested_name: "", suggested_categories: [] });

export function createSessionFromRequest(requestId: string, createdBy: string) {
  const req = getSkillRequest(requestId);
  if (!req) throw new BuilderError("作成依頼が見つかりません");
  if (req.session_id) {
    const s = get<SessionRow>("SELECT * FROM builder_sessions WHERE id = ?", req.session_id);
    if (s) return sessionView(s);
  }
  const example = parseJson<{ items?: Array<{ name: string }> }>(req.example, {});
  const gaps = req.inspection_id
    ? (parseJson<{ skill_gaps?: string[] } | null>(
        get<{ ai_result: string | null }>("SELECT ai_result FROM inspections WHERE id = ?", req.inspection_id)?.ai_result,
        null,
      )?.skill_gaps ?? [])
    : [];
  const session = createSession({
    target: { layer: "category", title: `${req.category}検品`, name: suggestSlug(req.category), categories: [req.category], owner: "" },
    notes: [
      example.items?.length ? `該当した商品: ${example.items.map((i) => i.name).join("、")}` : "",
      gaps.length ? `AIが判断に迷った点:\n${gaps.map((g) => `- ${g}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    createdBy,
    requestId,
  });
  if (req.inspection_id) copyInspectionPhotos(session.id, req.inspection_id);
  return getSession(session.id);
}

function copyInspectionPhotos(sessionId: string, inspectionId: string) {
  const rows = all<{ file: string; kind: string; seq: number }>("SELECT file, kind, seq FROM photos WHERE inspection_id = ? ORDER BY kind, seq", inspectionId);
  const row = requireSession(sessionId);
  const materials = loadMaterials(row);
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  for (const p of rows) {
    const src = path.join(config.paths.uploads, inspectionId, p.file);
    if (!fs.existsSync(src)) continue;
    const id = `m${materials.length + 1}`;
    const dest = path.join(dir, `${id}${path.extname(p.file)}`);
    fs.copyFileSync(src, dest);
    const label = `${p.kind === "customer" ? "顧客写真" : "現物写真"}${p.seq}`;
    materials.push({
      id,
      kind: "image",
      format: path.extname(p.file).slice(1),
      name: `${label}（${inspectionId}）`,
      file: dest,
      preview: dest,
      size: fs.statSync(dest).size,
      description: `検品 ${inspectionId} の${label}`,
    });
  }
  touch(sessionId, { materials });
}

export async function addMaterials(id: string, files: UploadedFile[], notes?: string) {
  const row = requireSession(id);
  if (row.status === "generating") throw new BuilderError("AIが下書きを作成中です。完了してから追加してください");
  if (row.status === "saved") throw new BuilderError("ライブラリーに保存済みのセッションには追加できません。新しく作成してください");
  const materials = loadMaterials(row);
  const dir = sessionDir(id);
  const rejected: Array<{ name: string; reason: string }> = [];
  for (const f of files) {
    const next = Math.max(0, ...materials.map((m) => Number(m.id.replace(/^m/, "")) || 0)) + 1;
    try {
      materials.push(await processUpload({ dir, id: `m${next}`, name: f.originalname, mime: f.mimetype, src: f.path }));
    } catch (e) {
      fs.rmSync(f.path, { force: true });
      rejected.push({ name: f.originalname, reason: e instanceof MaterialError ? e.message : errorMessage(e) });
    }
  }
  touch(id, { materials, ...(notes !== undefined ? { notes } : {}) });
  return { session: getSession(id), rejected };
}

export function updateMaterial(id: string, materialId: string, patch: { description?: string }) {
  const row = requireSession(id);
  const materials = loadMaterials(row);
  const m = materials.find((x) => x.id === materialId);
  if (!m) throw new BuilderError("資料が見つかりません");
  if (patch.description !== undefined) m.description = patch.description.slice(0, 500);
  touch(id, { materials });
  return getSession(id);
}

export function removeMaterial(id: string, materialId: string) {
  const row = requireSession(id);
  if (row.status === "generating") throw new BuilderError("AIが下書きを作成中のため削除できません");
  const materials = loadMaterials(row);
  const m = materials.find((x) => x.id === materialId);
  if (m) deleteMaterialFiles(m);
  touch(id, { materials: materials.filter((x) => x.id !== materialId) });
  return getSession(id);
}

export function updateNotes(id: string, notes: string) {
  requireSession(id);
  touch(id, { notes });
  return getSession(id);
}

/** Applies the model's name/category proposal while the target is still provisional. */
function applySuggestions(target: BuilderTarget, draft: Draft): BuilderTarget {
  if (!target.auto) return target;
  const next = { ...target };
  if (draft.title.trim()) next.title = draft.title.trim().slice(0, 60);
  const slug = draft.suggested_name.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) && !slug.startsWith("draft-")) {
    let candidate = slug;
    for (let i = 2; getSkillRow(skillIdOf(next.layer, candidate)); i++) candidate = `${slug}-${i}`;
    next.name = candidate;
    next.auto = false;
  }
  const cats = draft.suggested_categories.map((c) => c.trim()).filter(Boolean);
  if (cats.length) next.categories = [...new Set(cats)].slice(0, 8);
  next.skillId = undefined;
  return next;
}

/** Builds SKILL.md from the model's draft: frontmatter comes from the target, not from the model. */
function assemble(target: BuilderTarget, draft: Draft): string {
  if (target.skillId) {
    const current = getApprovedVersion(target.skillId);
    if (current) {
      const { yaml } = splitFrontmatter(current.content);
      return `---\n${yaml.trimEnd()}\n---\n${draft.body_markdown.trimStart()}`;
    }
  }
  return skillTemplate({
    name: target.name,
    description: draft.description.trim() || `${target.title}のスキル`,
    layer: target.layer,
    title: target.title,
    owner: target.owner,
    categories: target.categories,
    customers: target.customers,
    body: draft.body_markdown,
  });
}

function pushHistory(row: SessionRow, action: string, note: string) {
  return [...parseJson<Array<{ at: string; action: string; note: string }>>(row.history, []), { at: nowIso(), action, note }];
}

export function generate(id: string) {
  const row = requireSession(id);
  if (row.status === "generating") throw new BuilderError("作成中です");
  if (row.status === "saved") throw new BuilderError("ライブラリーに保存済みです");
  const target = parseJson<BuilderTarget>(row.target, {} as BuilderTarget);
  const materials = loadMaterials(row);
  if (materials.length === 0 && !row.notes.trim()) throw new BuilderError("資料をアップロードするか、メモを入力してください");
  const live = aiMode() === "live";
  touch(id, { status: "generating", error: null, mode: live ? "live" : "demo" });
  runInBackground(
    `builder generate ${id}`,
    async () => {
      let draft: Draft;
      let prepNotes: string[] = [];
      if (live) {
        const r = await generateDraftLive(target, materials, row.notes);
        draft = r.draft;
        prepNotes = r.notes;
      } else {
        draft = generateDraftDemo(target, materials, row.notes);
      }
      const nextTarget = applySuggestions(target, draft);
      touch(id, {
        status: "ready",
        target: nextTarget,
        title: nextTarget.title,
        materials,
        draft: assemble(nextTarget, draft),
        questions: draft.questions,
        answers: {},
        history: pushHistory(row, "下書き生成", [draft.summary, ...prepNotes].join(" ")),
      });
    },
    (e) => touch(id, { status: "error", error: errorMessage(e) }),
  );
  return getSession(id);
}

export function answerQuestions(id: string, answers: Record<string, string>) {
  const row = requireSession(id);
  if (row.status !== "ready") throw new BuilderError("下書きができてから回答してください");
  const questions = parseJson<Question[]>(row.questions, []);
  const qa = questions.map((q) => ({ id: q.id, question: q.question, answer: String(answers[q.id] ?? "").trim() }));
  if (!qa.some((x) => x.answer)) throw new BuilderError("1つ以上の質問に回答してください");
  const target = parseJson<BuilderTarget>(row.target, {} as BuilderTarget);
  const { body } = splitFrontmatter(row.draft);
  const live = aiMode() === "live";
  touch(id, { status: "generating", answers, error: null });
  runInBackground(
    `builder refine ${id}`,
    async () => {
      const draft = live ? (await refineDraftLive(target, body, qa, row.notes)).draft : refineDraftDemo(body, qa);
      const assembled = assemble({ ...target, auto: false }, { ...draft, description: draft.description || descriptionOf(row.draft) });
      touch(id, {
        status: "ready",
        draft: assembled,
        questions: draft.questions,
        answers: {},
        history: pushHistory(row, "回答を反映", draft.summary),
      });
    },
    (e) => touch(id, { status: "ready", error: errorMessage(e) }),
  );
  return getSession(id);
}

function descriptionOf(content: string): string {
  try {
    return parseSkill(content).description;
  } catch {
    return "";
  }
}

export function updateDraft(id: string, draft: string) {
  const row = requireSession(id);
  if (row.status === "generating") throw new BuilderError("AIが作成中のため編集できません");
  touch(id, { draft, history: pushHistory(row, "手で編集", "") });
  return getSession(id);
}

/** Stores the draft in the library as a draft version; publishing happens after review there. */
export function saveToLibrary(id: string, actor: string) {
  const row = requireSession(id);
  if (!row.draft.trim()) throw new BuilderError("保存する下書きがありません");
  const target = parseJson<BuilderTarget>(row.target, {} as BuilderTarget);
  let info;
  try {
    info = parseSkill(row.draft);
  } catch (e) {
    throw new BuilderError(`下書きの形式に誤りがあります: ${errorMessage(e)}`);
  }
  if (info.name.startsWith("draft-")) {
    throw new BuilderError("スキルの名前と識別名がまだ仮のままです。「対象を編集」で決めてから保存してください");
  }
  const skillId = skillIdOf(info.layer, info.name);
  const note = `スキルビルダー ${id} で作成`;
  const versionId = getSkillRow(skillId)
    ? createDraft(skillId, row.draft, { source: "builder", createdBy: actor, changeNote: note }).id
    : createSkill(row.draft, { source: "builder", createdBy: actor, changeNote: note }).versionId;
  touch(id, { status: "saved", saved_version_id: versionId, target: { ...target, skillId, auto: false }, history: pushHistory(row, "ライブラリーに保存", `${skillId}（下書き）`) });
  if (row.request_id) setSkillRequestStatus(row.request_id, "done", id);
  return { session: getSession(id), skillId, versionId };
}
