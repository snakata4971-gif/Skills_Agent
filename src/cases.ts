import { aiMode } from "./ai/client.ts";
import type { Judgment } from "./ai/judge.ts";
import {
  classifyReplyDemo,
  classifyReplyLive,
  draftEmailDemo,
  draftEmailLive,
  fillPlaceholders,
  INSTRUCTION_LABELS,
  INSTRUCTIONS,
  type Instruction,
} from "./ai/mailer.ts";
import { config } from "./config.ts";
import { all, get, insert, nextId, parseJson, update } from "./db.ts";
import { getSettings } from "./settings.ts";
import { resolveBy } from "./skills/resolver.ts";
import { addDays, errorMessage, log, nowIso, randomToken, runInBackground } from "./util.ts";
import { getWms } from "./wms/adapter.ts";
import type { WmsShipment } from "./wms/types.ts";

export type CaseStatus =
  | "drafting"
  | "draft_ready"
  | "awaiting_reply"
  | "instruction_received"
  | "awaiting_approval"
  | "ready"
  | "executed"
  | "closed";

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  drafting: "メール作成中",
  draft_ready: "メール確認待ち",
  awaiting_reply: "顧客の返信待ち",
  instruction_received: "指示の確認待ち",
  awaiting_approval: "責任者の承認待ち",
  ready: "処理の実行待ち",
  executed: "作業指示済み",
  closed: "完了",
};

export interface CaseRow {
  id: string;
  inspection_id: string;
  shipment_id: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  status: CaseStatus;
  issue_summary: string;
  issues: string;
  email_subject: string;
  email_body: string;
  email_mode: string | null;
  email_sent_at: string | null;
  email_sent_by: string | null;
  reply_token: string;
  reply_due_at: string | null;
  reply_choice: string | null;
  reply_text: string | null;
  reply_received_at: string | null;
  reply_channel: string | null;
  instruction: Instruction | "unclear" | null;
  instruction_source: string | null;
  instruction_confidence: number | null;
  instruction_summary: string | null;
  requires_approval: number;
  approved_by: string | null;
  approved_at: string | null;
  disposition_skill: string | null;
  worker_instruction: string | null;
  wms_status: string | null;
  executed_at: string | null;
  closed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class CaseError extends Error {}

const replyUrl = (token: string) => `${config.appBaseUrl.replace(/\/$/, "")}/reply/${token}`;

function event(caseId: string, actor: string, type: string, message: string, data: unknown = {}) {
  insert("case_events", { case_id: caseId, actor, type, message, data, created_at: nowIso() });
}

function touch(id: string, patch: Record<string, unknown>) {
  update("cases", "id", id, { ...patch, updated_at: nowIso() });
}

export function getCaseRow(id: string) {
  return get<CaseRow>("SELECT * FROM cases WHERE id = ?", id);
}

function requireCase(id: string, allowed?: CaseStatus[]): CaseRow {
  const row = getCaseRow(id);
  if (!row) throw new CaseError(`ケース ${id} が見つかりません`);
  if (allowed && !allowed.includes(row.status)) {
    throw new CaseError(`ケースが「${CASE_STATUS_LABELS[row.status]}」の状態のため、この操作はできません`);
  }
  return row;
}

export function caseView(row: CaseRow) {
  return {
    ...row,
    statusLabel: CASE_STATUS_LABELS[row.status],
    issues: parseJson<Array<{ type: string; detail: string }>>(row.issues, []),
    instructionLabel: row.instruction ? INSTRUCTION_LABELS[row.instruction] : null,
    requiresApproval: Boolean(row.requires_approval),
    replyUrl: replyUrl(row.reply_token),
    events: all("SELECT * FROM case_events WHERE case_id = ? ORDER BY id", row.id).map((e) => ({ ...e, data: parseJson((e as { data: string }).data, {}) })),
  };
}

export function listCases(status?: string) {
  const rows = status
    ? all<CaseRow>("SELECT * FROM cases WHERE status = ? ORDER BY updated_at DESC", status)
    : all<CaseRow>("SELECT * FROM cases ORDER BY status = 'closed', updated_at DESC");
  return rows.map((r) => ({
    id: r.id,
    shipmentId: r.shipment_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    status: r.status,
    statusLabel: CASE_STATUS_LABELS[r.status],
    issueSummary: r.issue_summary,
    instructionLabel: r.instruction ? INSTRUCTION_LABELS[r.instruction] : null,
    requiresApproval: Boolean(r.requires_approval),
    replyDueAt: r.reply_due_at,
    error: r.error,
    updatedAt: r.updated_at,
  }));
}

export function caseCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM cases GROUP BY status")) out[r.status] = r.n;
  return out;
}

/** Opens a customer-confirmation case for an inspection a person confirmed as NG. */
export function createCaseFromInspection(inspectionId: string): string {
  const insp = get<Record<string, string | null>>("SELECT * FROM inspections WHERE id = ?", inspectionId);
  if (!insp) throw new CaseError(`検品 ${inspectionId} が見つかりません`);
  const existing = get<{ id: string }>("SELECT id FROM cases WHERE inspection_id = ?", inspectionId);
  if (existing) return existing.id;
  const shipment = parseJson<WmsShipment>(insp.shipment, {} as WmsShipment);
  const ai = parseJson<Judgment | null>(insp.ai_result, null);
  const humanNote = (insp.human_note ?? "").trim();
  const issues =
    ai && ai.issues.length && insp.ai_overall === "NG"
      ? ai.issues.map((i) => ({ type: i.type, detail: i.detail }))
      : [{ type: "その他", detail: humanNote || "検品で問題が見つかりました" }];
  const id = nextId("CASE", 5);
  const now = nowIso();
  insert("cases", {
    id,
    inspection_id: inspectionId,
    shipment_id: insp.shipment_id,
    customer_id: insp.customer_id,
    customer_name: insp.customer_name,
    customer_email: shipment.customer?.email ?? "",
    status: "drafting",
    issue_summary: humanNote || ai?.summary || "",
    issues,
    reply_token: randomToken(),
    reply_due_at: addDays(now, getSettings().reply_due_days),
    created_at: now,
    updated_at: now,
  });
  event(id, insp.confirmed_by ?? "作業者", "created", `検品 ${inspectionId} がNGで確定され、ケースを作成しました`);
  runInBackground(`draft email ${id}`, () => draftEmail(id, "AI"), (e) => {
    touch(id, { status: "draft_ready", error: `メールの下書き作成に失敗しました: ${errorMessage(e)}` });
  });
  return id;
}

function itemsText(inspectionId: string): string {
  const insp = get<{ shipment: string }>("SELECT shipment FROM inspections WHERE id = ?", inspectionId);
  const shipment = parseJson<WmsShipment>(insp?.shipment, {} as WmsShipment);
  return (shipment.items ?? [])
    .map((it) => `- ${it.name} ×${it.qty}${it.color ? ` / ${it.color}` : ""}${it.size ? ` / ${it.size}` : ""}`)
    .join("\n");
}

export async function draftEmail(id: string, actor: string) {
  const row = requireCase(id, ["drafting", "draft_ready"]);
  touch(id, { status: "drafting", error: null });
  const ctx = {
    customerName: row.customer_name,
    shipmentId: row.shipment_id,
    itemsText: itemsText(row.inspection_id),
    summary: row.issue_summary,
    issues: parseJson<Array<{ type: string; detail: string }>>(row.issues, []),
  };
  const due = new Date(row.reply_due_at ?? addDays(nowIso(), 7)).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
  const live = aiMode() === "live";
  const skill = resolveBy("communication", "purposes", "ng_confirmation");
  const draft = live ? await draftEmailLive(ctx, skill) : draftEmailDemo(ctx);
  touch(id, {
    status: "draft_ready",
    email_subject: draft.subject,
    email_body: fillPlaceholders(draft.body, replyUrl(row.reply_token), due),
    email_mode: live ? "live" : "demo",
  });
  event(
    id,
    actor,
    "email_drafted",
    live
      ? `確認メールの下書きを作成しました${skill ? `（スキル ${skill.id} v${skill.version}）` : ""}`
      : "確認メールの下書きを作成しました（デモモード: 固定のテンプレート）",
  );
}

export function regenerateEmail(id: string, actor: string) {
  requireCase(id, ["draft_ready"]);
  touch(id, { status: "drafting" });
  runInBackground(`draft email ${id}`, () => draftEmail(id, actor), (e) => {
    touch(id, { status: "draft_ready", error: `メールの下書き作成に失敗しました: ${errorMessage(e)}` });
  });
}

export function updateEmail(id: string, subject: string, body: string, actor: string) {
  requireCase(id, ["draft_ready"]);
  if (!subject.trim() || !body.trim()) throw new CaseError("件名と本文を入力してください");
  touch(id, { email_subject: subject.trim(), email_body: body });
  event(id, actor, "email_edited", "メールの下書きを編集しました");
}

/** Sending is simulated: the message is recorded, and the customer answers on the reply page. */
export function sendEmail(id: string, actor: string) {
  const row = requireCase(id, ["draft_ready"]);
  if (!row.email_body.trim()) throw new CaseError("メール本文がありません");
  touch(id, { status: "awaiting_reply", email_sent_at: nowIso(), email_sent_by: actor, error: null });
  event(id, actor, "email_sent", `確認メールを送信しました（模擬送信: ${row.customer_email || "宛先未設定"}）`, {
    to: row.customer_email,
    subject: row.email_subject,
  });
  log("case", `${id}: 確認メールを送信（模擬）`);
}

export function getCaseByToken(token: string) {
  return get<CaseRow>("SELECT * FROM cases WHERE reply_token = ?", token);
}

const isInstruction = (v: string): v is Instruction => (INSTRUCTIONS as readonly string[]).includes(v);

export function receiveFormReply(token: string, choice: string, comment: string) {
  const row = getCaseByToken(token);
  if (!row) throw new CaseError("回答ページが見つかりません");
  if (row.status !== "awaiting_reply") throw new CaseError("このお問い合わせへのご回答はすでに受け付けています");
  if (!isInstruction(choice)) throw new CaseError("対応方法を選んでください");
  touch(row.id, {
    status: "instruction_received",
    reply_choice: choice,
    reply_text: comment.trim().slice(0, 2000),
    reply_received_at: nowIso(),
    reply_channel: "form",
    instruction: choice,
    instruction_source: "form",
    instruction_confidence: 1,
    instruction_summary: `回答ページで「${INSTRUCTION_LABELS[choice]}」を選択${comment.trim() ? "（コメントあり）" : ""}`,
  });
  event(row.id, "顧客", "reply_received", `顧客が回答ページで「${INSTRUCTION_LABELS[choice]}」を選びました`, { comment: comment.trim() });
}

/** For replies that arrive as ordinary email: the model (or keywords in demo) reads the instruction. */
export async function classifyEmailReply(id: string, text: string, actor: string) {
  const row = requireCase(id, ["awaiting_reply", "instruction_received"]);
  if (!text.trim()) throw new CaseError("返信メールの本文を貼り付けてください");
  const live = aiMode() === "live";
  const result = live ? await classifyReplyLive(row.email_body, text) : classifyReplyDemo(text);
  touch(id, {
    status: "instruction_received",
    reply_text: text.slice(0, 5000),
    reply_received_at: nowIso(),
    reply_channel: "email",
    instruction: result.instruction,
    instruction_source: live ? "ai" : "keyword",
    instruction_confidence: result.confidence,
    instruction_summary: [result.summary, ...result.extra_requests.map((r) => `要望: ${r}`)].join(" / "),
  });
  event(id, actor, "reply_classified", `返信メールを読み取りました: ${INSTRUCTION_LABELS[result.instruction]}（${live ? "AI" : "キーワード判定"}）${result.needs_human ? " ※人の確認が必要" : ""}`, result);
  return caseView(getCaseRow(id)!);
}

export function confirmInstruction(id: string, instruction: string, actor: string, note = "") {
  requireCase(id, ["awaiting_reply", "instruction_received"]);
  if (!isInstruction(instruction)) throw new CaseError("対応方法を選んでください");
  const skill = resolveBy("disposition", "instructions", instruction);
  if (!skill) throw new CaseError(`「${INSTRUCTION_LABELS[instruction]}」の処理スキルがありません。スキルライブラリーで作成してください`);
  const needsApproval = skill.info.requiresApproval;
  touch(id, {
    status: needsApproval ? "awaiting_approval" : "ready",
    instruction,
    disposition_skill: skill.id,
    requires_approval: needsApproval,
  });
  event(
    id,
    actor,
    "instruction_confirmed",
    `対応方法を「${INSTRUCTION_LABELS[instruction]}」に決定しました（処理スキル ${skill.id} v${skill.version}）${needsApproval ? "。取り消せない処理のため責任者の承認が必要です" : ""}`,
    { note },
  );
  return caseView(getCaseRow(id)!);
}

export function approveCase(id: string, actor: string) {
  requireCase(id, ["awaiting_approval"]);
  if (!actor.trim()) throw new CaseError("承認者名を入力してください");
  touch(id, { status: "ready", approved_by: actor, approved_at: nowIso() });
  event(id, actor, "approved", "責任者が処理を承認しました");
  return caseView(getCaseRow(id)!);
}

/** Runs the disposition skill: WMS status update plus the instruction shown to workers. */
export async function executeCase(id: string, actor: string) {
  const row = requireCase(id, ["ready"]);
  if (!row.instruction || row.instruction === "unclear") throw new CaseError("対応方法が決まっていません");
  const skill = resolveBy("disposition", "instructions", row.instruction);
  if (!skill) throw new CaseError("処理スキルが見つかりません");
  if (skill.info.requiresApproval && !row.approved_by) throw new CaseError("責任者の承認が必要です");
  const status = skill.info.wmsStatus || INSTRUCTION_LABELS[row.instruction];
  try {
    await getWms().updateStatus(row.shipment_id, status, `ケース ${id}: ${INSTRUCTION_LABELS[row.instruction]}`);
  } catch (e) {
    touch(id, { error: `WMSの更新に失敗しました: ${errorMessage(e)}` });
    event(id, "システム", "execute_failed", `WMSの更新に失敗しました: ${errorMessage(e)}`);
    throw new CaseError(`WMSの更新に失敗しました: ${errorMessage(e)}`);
  }
  touch(id, {
    status: "executed",
    wms_status: status,
    worker_instruction: skill.info.workerInstruction,
    executed_at: nowIso(),
    error: null,
  });
  event(id, actor, "executed", `処理を実行しました: WMSのステータスを「${status}」に更新し、作業者へ指示を出しました（スキル ${skill.id} v${skill.version}）`);
  return caseView(getCaseRow(id)!);
}

export function closeCase(id: string, actor: string) {
  requireCase(id, ["executed"]);
  touch(id, { status: "closed", closed_at: nowIso() });
  event(id, actor, "closed", "作業完了としてケースを閉じました");
  return caseView(getCaseRow(id)!);
}
