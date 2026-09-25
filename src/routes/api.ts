import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { aiMode, AiError } from "../ai/client.ts";
import * as builder from "../builderService.ts";
import * as cases from "../cases.ts";
import { config } from "../config.ts";
import { get } from "../db.ts";
import * as inspections from "../inspections.ts";
import * as learning from "../learning.ts";
import { SCENARIOS } from "../seed/scenarios.ts";
import { resetAll } from "../seed/seed.ts";
import { getSettings, SettingsSchema, updateSettings } from "../settings.ts";
import * as library from "../skills/library.ts";
import { resolveInspectionSkills } from "../skills/resolver.ts";
import { listSkillRequests } from "../skillRequests.ts";
import { getWms } from "../wms/adapter.ts";
import { ApiWmsAdapter } from "../wms/apiAdapter.ts";
import { BrowserWmsAdapter } from "../wms/browserAdapter.ts";
import { WmsError } from "../wms/types.ts";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  defParamCharset: "utf8",
});

/** Skill-building materials can be long work videos, so they stream to disk instead of memory. */
const tmpDir = path.join(config.paths.data, "tmp");
fs.mkdirSync(tmpDir, { recursive: true });
const diskUpload = multer({
  storage: multer.diskStorage({
    destination: tmpDir,
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 20 },
  defParamCharset: "utf8",
});

const uploadedFiles = (req: Request) =>
  ((req.files as Express.Multer.File[]) ?? []).map((f) => ({ path: f.path, originalname: f.originalname, mimetype: f.mimetype }));

/** Who is operating (sent by the browser as a URL-encoded header; there is no login in this prototype). */
function actor(req: Request): string {
  const raw = req.get("X-Actor");
  if (!raw) return "未設定";
  try {
    return decodeURIComponent(raw).trim().slice(0, 40) || "未設定";
  } catch {
    return "未設定";
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function skillId(req: Request) {
  return library.skillIdOf(String(req.params.layer), String(req.params.name));
}

export function apiRouter() {
  const r = express.Router();

  // ---------------------------------------------------------------- status & settings
  r.get("/status", (_req, res) => {
    const settings = getSettings();
    const awaitingReview = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM inspections WHERE status IN ('judged','error') AND human_overall IS NULL",
    )!.n;
    res.json({
      ai: { mode: aiMode(), model: settings.model, effort: settings.effort },
      wms: { mode: settings.wms_mode, baseUrl: config.wms.baseUrl },
      settings,
      counts: {
        awaitingReview,
        judging: get<{ n: number }>("SELECT COUNT(*) AS n FROM inspections WHERE status IN ('queued','judging')")!.n,
        cases: cases.caseCounts(),
        drafts: get<{ n: number }>("SELECT COUNT(*) AS n FROM skill_versions WHERE status = 'draft'")!.n,
        openRequests: get<{ n: number }>("SELECT COUNT(*) AS n FROM skill_requests WHERE status != 'done'")!.n,
        openOperationErrors: get<{ n: number }>("SELECT COUNT(*) AS n FROM operation_errors WHERE resolved = 0")!.n,
      },
    });
  });

  r.get("/guide/samples", (_req, res) => {
    res.json(
      SCENARIOS.map((s) => ({
        shipmentId: s.shipmentId,
        customerId: s.customer.id,
        customerName: s.customer.name,
        category: s.category,
        title: s.title,
        expected: s.demo.overall,
      })),
    );
  });

  r.get("/settings", (_req, res) => {
    res.json(getSettings());
  });

  r.put("/settings", (req, res) => {
    const patch = SettingsSchema.partial().parse(req.body ?? {});
    res.json(updateSettings(patch));
  });

  r.post("/settings/wms-test", async (req, res) => {
    const mode = req.body?.mode === "browser" ? "browser" : req.body?.mode === "api" ? "api" : getSettings().wms_mode;
    const adapter = mode === "browser" ? new BrowserWmsAdapter({ recordErrors: false }) : new ApiWmsAdapter();
    res.json({ mode, ...(await adapter.health()) });
  });

  r.post("/admin/reset", (req, res) => {
    if (req.body?.confirm !== "初期化") {
      res.status(400).json({ error: "確認の文字列が一致しません" });
      return;
    }
    resetAll();
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- inspection station
  r.get("/station/lookup", async (req, res) => {
    const code = str(req.query.code).trim();
    if (!code) {
      res.status(400).json({ error: "顧客IDまたは納品IDをスキャンしてください" });
      return;
    }
    res.json(await getWms().lookup(code));
  });

  r.get("/inspections", (req, res) => {
    res.json(inspections.listInspections({ limit: Number(req.query.limit) || 50, status: str(req.query.status) || undefined }));
  });

  r.post("/inspections", async (req, res) => {
    const shipmentId = str(req.body?.shipmentId).trim();
    if (!shipmentId) {
      res.status(400).json({ error: "納品IDがありません" });
      return;
    }
    res.json(await inspections.startInspection(shipmentId, actor(req)));
  });

  r.get("/inspections/:id", (req, res) => {
    const row = inspections.getRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "検品が見つかりません" });
      return;
    }
    res.json(inspections.view(row));
  });

  r.post("/inspections/:id/photos", upload.array("files", 20), async (req, res) => {
    const files = ((req.files as Express.Multer.File[]) ?? []).map((f) => ({ buffer: f.buffer, originalname: f.originalname }));
    if (files.length === 0) {
      res.status(400).json({ error: "写真を選んでください" });
      return;
    }
    res.json(await inspections.addWorkerPhotos(String(req.params.id), files));
  });

  r.post("/inspections/:id/sample-photos", async (req, res) => {
    res.json(await inspections.addSamplePhotos(req.params.id));
  });

  r.delete("/inspections/:id/photos/:photoId", (req, res) => {
    res.json(inspections.removePhoto(req.params.id, Number(req.params.photoId)));
  });

  r.post("/inspections/:id/reresolve", async (req, res) => {
    res.json(await inspections.reresolveSkills(req.params.id));
  });

  r.post("/inspections/:id/judge", (req, res) => {
    res.json(inspections.requestJudgment(req.params.id));
  });

  r.post("/inspections/:id/confirm", async (req, res) => {
    const body = z.object({ overall: z.enum(["OK", "NG", "保留"]), note: z.string().default("") }).parse(req.body ?? {});
    res.json(await inspections.confirmInspection(req.params.id, { ...body, actor: actor(req) }));
  });

  r.post("/inspections/:id/register", async (req, res) => {
    res.json(await inspections.registerToWms(req.params.id));
  });

  // ---------------------------------------------------------------- skill library
  r.get("/skills", (req, res) => {
    res.json(library.listSkills({ layer: str(req.query.layer) || undefined, q: str(req.query.q).trim() || undefined, includeDeprecated: req.query.all === "1" }));
  });

  r.get("/skills/resolve", async (req, res) => {
    const resolution = await resolveInspectionSkills(
      {
        customerId: str(req.query.customerId).trim(),
        category: str(req.query.category).trim(),
        itemNames: str(req.query.items).split(/[,、\n]/).map((s) => s.trim()).filter(Boolean),
      },
      { allowAi: false },
    );
    res.json({
      method: resolution.method,
      notes: resolution.notes,
      missingCategory: resolution.missingCategory,
      skills: resolution.skills.map((s) => ({ id: s.id, title: s.title, version: s.version, layer: s.layer })),
    });
  });

  r.get("/skills/:layer/:name", (req, res) => {
    const skill = library.getSkill(skillId(req));
    if (!skill) {
      res.status(404).json({ error: "スキルが見つかりません" });
      return;
    }
    res.json(skill);
  });

  r.post("/skills/:layer/:name/drafts", (req, res) => {
    const body = z.object({ content: z.string().min(1), changeNote: z.string().default("") }).parse(req.body ?? {});
    res.json(library.createDraft(skillId(req), body.content, { source: "manual", createdBy: actor(req), changeNote: body.changeNote || "手で編集" }));
  });

  r.post("/skills/:layer/:name/rollback", (req, res) => {
    res.json(library.rollbackTo(skillId(req), Number(req.body?.versionId), actor(req)));
  });

  r.post("/skills/:layer/:name/status", (req, res) => {
    const status = req.body?.status === "deprecated" ? "deprecated" : "active";
    library.setSkillStatus(skillId(req), status);
    res.json(library.getSkill(skillId(req)));
  });

  r.get("/skill-versions/:id", (req, res) => {
    const v = library.getVersion(Number(req.params.id));
    if (!v) {
      res.status(404).json({ error: "版が見つかりません" });
      return;
    }
    res.json(v);
  });

  r.get("/skill-versions/:id/diff", (req, res) => {
    const v = library.getVersion(Number(req.params.id));
    if (!v) {
      res.status(404).json({ error: "版が見つかりません" });
      return;
    }
    const against = Number(req.query.against) || library.getSkillRow(v.skill_id)?.current_version_id || v.id;
    res.json({ from: against, to: v.id, lines: library.diffVersions(against, v.id) });
  });

  r.post("/skill-versions/:id/approve", (req, res) => {
    res.json(library.approveVersion(Number(req.params.id), actor(req)));
  });

  r.post("/skill-versions/:id/reject", (req, res) => {
    res.json(library.rejectVersion(Number(req.params.id), actor(req), str(req.body?.reason)));
  });

  // ---------------------------------------------------------------- skill builder
  r.get("/builder/sessions", (_req, res) => {
    res.json(builder.listSessions());
  });

  r.post("/builder/sessions", (req, res) => {
    res.json(builder.createSession({ target: req.body?.target ?? {}, notes: str(req.body?.notes), createdBy: actor(req) }));
  });

  r.get("/builder/requests", (_req, res) => {
    res.json(listSkillRequests());
  });

  r.post("/builder/requests/:id/session", (req, res) => {
    res.json(builder.createSessionFromRequest(req.params.id, actor(req)));
  });

  r.get("/builder/sessions/:id", (req, res) => {
    res.json(builder.getSession(req.params.id));
  });

  r.post("/builder/quick", diskUpload.array("files", 20), async (req, res) => {
    const r2 = await builder.quickCreate(uploadedFiles(req), actor(req), str(req.body?.notes));
    res.json(r2);
  });

  r.post("/builder/sessions/:id/materials", diskUpload.array("files", 20), async (req, res) => {
    const files = uploadedFiles(req);
    if (files.length === 0) {
      res.status(400).json({ error: "資料を選んでください" });
      return;
    }
    res.json(await builder.addMaterials(String(req.params.id), files, typeof req.body?.notes === "string" ? req.body.notes : undefined));
  });

  r.put("/builder/sessions/:id/materials/:mid", (req, res) => {
    res.json(builder.updateMaterial(req.params.id, req.params.mid, { description: str(req.body?.description) }));
  });

  r.delete("/builder/sessions/:id/materials/:mid", (req, res) => {
    res.json(builder.removeMaterial(req.params.id, req.params.mid));
  });

  r.put("/builder/sessions/:id/target", (req, res) => {
    res.json(builder.updateTarget(req.params.id, req.body ?? {}));
  });

  r.put("/builder/sessions/:id/notes", (req, res) => {
    res.json(builder.updateNotes(req.params.id, str(req.body?.notes)));
  });

  r.post("/builder/sessions/:id/generate", (req, res) => {
    res.json(builder.generate(req.params.id));
  });

  r.post("/builder/sessions/:id/answers", (req, res) => {
    const answers = z.record(z.string(), z.string()).parse(req.body?.answers ?? {});
    res.json(builder.answerQuestions(req.params.id, answers));
  });

  r.put("/builder/sessions/:id/draft", (req, res) => {
    res.json(builder.updateDraft(req.params.id, str(req.body?.draft)));
  });

  r.post("/builder/sessions/:id/save", (req, res) => {
    res.json(builder.saveToLibrary(req.params.id, actor(req)));
  });

  // ---------------------------------------------------------------- cases
  r.get("/cases", (req, res) => {
    res.json(cases.listCases(str(req.query.status) || undefined));
  });

  r.get("/cases/:id", (req, res) => {
    const row = cases.getCaseRow(req.params.id);
    if (!row) {
      res.status(404).json({ error: "ケースが見つかりません" });
      return;
    }
    const insp = inspections.getRow(row.inspection_id);
    res.json({ ...cases.caseView(row), inspection: insp ? inspections.view(insp) : null });
  });

  r.put("/cases/:id/email", (req, res) => {
    cases.updateEmail(req.params.id, str(req.body?.subject), str(req.body?.body), actor(req));
    res.json({ ok: true });
  });

  r.post("/cases/:id/email/regenerate", (req, res) => {
    cases.regenerateEmail(req.params.id, actor(req));
    res.json({ ok: true });
  });

  r.post("/cases/:id/send", (req, res) => {
    cases.sendEmail(req.params.id, actor(req));
    res.json({ ok: true });
  });

  r.post("/cases/:id/reply-text", async (req, res) => {
    res.json(await cases.classifyEmailReply(req.params.id, str(req.body?.text), actor(req)));
  });

  r.post("/cases/:id/instruction", (req, res) => {
    res.json(cases.confirmInstruction(req.params.id, str(req.body?.instruction), actor(req), str(req.body?.note)));
  });

  r.post("/cases/:id/approve", (req, res) => {
    res.json(cases.approveCase(req.params.id, actor(req) === "未設定" ? "" : actor(req)));
  });

  r.post("/cases/:id/execute", async (req, res) => {
    res.json(await cases.executeCase(req.params.id, actor(req)));
  });

  r.post("/cases/:id/close", (req, res) => {
    res.json(cases.closeCase(req.params.id, actor(req)));
  });

  // ---------------------------------------------------------------- learning
  r.get("/learning/metrics", (_req, res) => {
    res.json(learning.metrics());
  });

  r.get("/learning/cases", (req, res) => {
    res.json(learning.learningCases(str(req.query.skillId) || undefined));
  });

  r.get("/learning/gaps", (req, res) => {
    res.json(learning.skillGaps(str(req.query.skillId) || undefined));
  });

  r.get("/learning/operation-errors", (_req, res) => {
    res.json(learning.operationErrors());
  });

  r.get("/learning/proposals", (_req, res) => {
    res.json(learning.listProposals());
  });

  r.post("/learning/proposals", (req, res) => {
    const id = learning.createProposal(str(req.body?.skillId), actor(req));
    res.json(learning.getProposal(id));
  });

  r.get("/learning/proposals/:id", (req, res) => {
    const p = learning.getProposal(req.params.id);
    if (!p) {
      res.status(404).json({ error: "改善案が見つかりません" });
      return;
    }
    res.json(p);
  });

  r.post("/learning/proposals/:id/test", (req, res) => {
    learning.testProposal(req.params.id);
    res.json(learning.getProposal(req.params.id));
  });

  r.post("/learning/proposals/:id/approve", (req, res) => {
    res.json(learning.approveProposal(req.params.id, actor(req) === "未設定" ? "" : actor(req)));
  });

  r.post("/learning/proposals/:id/reject", (req, res) => {
    res.json(learning.rejectProposal(req.params.id, actor(req), str(req.body?.reason)));
  });

  r.use((_req, res) => {
    res.status(404).json({ error: "APIが見つかりません" });
  });

  r.use(apiErrorHandler);
  return r;
}

const DOMAIN_ERRORS = [
  inspections.InspectionError,
  cases.CaseError,
  library.LibraryError,
  builder.BuilderError,
  learning.LearningError,
];

export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: `入力内容に誤りがあります: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / ")}` });
    return;
  }
  if (err instanceof WmsError) {
    res.status(err.kind === "not_found" ? 404 : err.kind === "invalid" ? 400 : 502).json({ error: err.message, kind: err.kind });
    return;
  }
  if (err instanceof AiError) {
    res.status(502).json({ error: err.message });
    return;
  }
  if (DOMAIN_ERRORS.some((C) => err instanceof C)) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  if (err instanceof multer.MulterError) {
    res.status(400).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "ファイルが大きすぎます（検品写真は1枚50MBまで、スキル作成の資料は1ファイル1GBまで）"
          : err.code === "LIMIT_FILE_COUNT"
            ? "一度にアップロードできるのは20ファイルまでです"
            : `アップロードに失敗しました: ${err.message}`,
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "システムエラーが発生しました。ログを確認してください" });
}
