import { aiMode, estimateUsd } from "./ai/client.ts";
import {
  type Disagreement,
  type OperationFailure,
  proposeInspectionDemo,
  proposeInspectionLive,
  proposeSelectorFixDemo,
  proposeSelectorFixLive,
} from "./ai/improver.ts";
import type { Judgment } from "./ai/judge.ts";
import { all, get, insert, nextId, parseJson, run, update } from "./db.ts";
import { getRow, judge, type SkillRef } from "./inspections.ts";
import { getSettings } from "./settings.ts";
import { extractJsonBlock, INSPECTION_LAYERS, replaceJsonBlock, splitFrontmatter } from "./skills/format.ts";
import { approveVersion, createDraft, diffLines, getApprovedVersion, getSkillRow, getVersion, rejectVersion } from "./skills/library.ts";
import { errorMessage, nowIso, runInBackground } from "./util.ts";
import { BrowserWmsAdapter, OPERATION_SKILL_ID } from "./wms/browserAdapter.ts";
import type { WmsShipment } from "./wms/types.ts";

interface InspRow {
  id: string;
  shipment_id: string;
  category: string;
  shipment: string;
  skills: string;
  ai_overall: string | null;
  ai_result: string | null;
  human_overall: string | null;
  human_note: string | null;
  routing: string | null;
  status: string;
  confirmed_at: string | null;
}

type Kind = "見逃し" | "過検出" | "AIが要確認→人が判断";

function classify(r: InspRow): Kind | null {
  const ai = r.ai_overall;
  const human = r.human_overall;
  if (!ai || !human) return null;
  if (ai === "OK" && human === "NG") return "見逃し";
  if (ai === "NG" && human === "OK") return "過検出";
  if (ai === "要確認" && (human === "OK" || human === "NG") && (r.human_note ?? "").trim()) return "AIが要確認→人が判断";
  return null;
}

const usesSkill = (r: InspRow, skillId: string) => parseJson<SkillRef[]>(r.skills, []).some((s) => s.id === skillId);

function emptyStats() {
  return { judged: 0, confirmed: 0, compared: 0, agree: 0, miss: 0, falseAlarm: 0, aiUnsure: 0, autoOk: 0 };
}

function accumulate(stats: ReturnType<typeof emptyStats>, r: InspRow) {
  if (r.ai_overall) stats.judged++;
  if (r.human_overall) stats.confirmed++;
  if (r.routing === "auto_ok") stats.autoOk++;
  const ai = r.ai_overall;
  const human = r.human_overall;
  if ((ai === "OK" || ai === "NG") && (human === "OK" || human === "NG")) {
    stats.compared++;
    if (ai === human) stats.agree++;
    if (ai === "OK" && human === "NG") stats.miss++;
    if (ai === "NG" && human === "OK") stats.falseAlarm++;
  }
  if (ai === "要確認" && human) stats.aiUnsure++;
}

export function metrics() {
  const rows = all<InspRow>("SELECT * FROM inspections");
  const overall = emptyStats();
  const perSkill = new Map<string, { id: string; title: string; version: string; stats: ReturnType<typeof emptyStats> }>();
  for (const r of rows) {
    accumulate(overall, r);
    for (const s of parseJson<SkillRef[]>(r.skills, [])) {
      if (!perSkill.has(s.id)) perSkill.set(s.id, { id: s.id, title: s.title, version: s.version, stats: emptyStats() });
      accumulate(perSkill.get(s.id)!.stats, r);
    }
  }
  const calls = all<{
    purpose: string;
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    ok: number;
  }>("SELECT * FROM ai_calls");
  const cost = new Map<string, { purpose: string; calls: number; errors: number; usd: number; tokens: number }>();
  for (const c of calls) {
    const e = cost.get(c.purpose) ?? { purpose: c.purpose, calls: 0, errors: 0, usd: 0, tokens: 0 };
    e.calls++;
    if (!c.ok) e.errors++;
    const u = {
      input_tokens: c.input_tokens ?? 0,
      output_tokens: c.output_tokens ?? 0,
      cache_read_tokens: c.cache_read_tokens ?? 0,
      cache_write_tokens: c.cache_write_tokens ?? 0,
    };
    e.tokens += u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens;
    e.usd += estimateUsd(c.model, u) ?? 0;
    cost.set(c.purpose, e);
  }
  const openErrors = get<{ n: number }>("SELECT COUNT(*) AS n FROM operation_errors WHERE resolved = 0")!.n;
  return {
    total: rows.length,
    overall,
    perSkill: [...perSkill.values()].sort((a, b) => b.stats.judged - a.stats.judged),
    cost: [...cost.values()],
    openOperationErrors: openErrors,
  };
}

export function learningCases(skillId?: string, limit = 50) {
  const rows = all<InspRow>("SELECT * FROM inspections WHERE human_overall IS NOT NULL ORDER BY confirmed_at DESC");
  return rows
    .filter((r) => classify(r) && (!skillId || usesSkill(r, skillId)))
    .slice(0, limit)
    .map((r) => {
      const ai = parseJson<Judgment | null>(r.ai_result, null);
      return {
        inspectionId: r.id,
        shipmentId: r.shipment_id,
        category: r.category,
        kind: classify(r)!,
        aiOverall: r.ai_overall,
        aiSummary: ai?.summary ?? "",
        humanOverall: r.human_overall,
        humanNote: r.human_note ?? "",
        skills: parseJson<SkillRef[]>(r.skills, []).map((s) => ({ id: s.id, title: s.title, version: s.version })),
        confirmedAt: r.confirmed_at,
      };
    });
}

export function skillGaps(skillId?: string) {
  const counts = new Map<string, { gap: string; count: number; inspections: string[] }>();
  for (const r of all<InspRow>("SELECT * FROM inspections WHERE ai_result IS NOT NULL ORDER BY created_at DESC")) {
    if (skillId && !usesSkill(r, skillId)) continue;
    for (const gap of parseJson<Judgment | null>(r.ai_result, null)?.skill_gaps ?? []) {
      const key = gap.trim();
      if (!key) continue;
      const e = counts.get(key) ?? { gap: key, count: 0, inspections: [] };
      e.count++;
      if (e.inspections.length < 5) e.inspections.push(r.id);
      counts.set(key, e);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function operationErrors(onlyOpen = true) {
  return all<Record<string, unknown>>(
    `SELECT id, skill_id, skill_version_id, operation, step, selector_key, selector, missing, message, page_url, resolved, created_at FROM operation_errors ${onlyOpen ? "WHERE resolved = 0" : ""} ORDER BY id DESC LIMIT 100`,
  ).map((e) => ({ ...e, missing: parseJson<string[]>(e.missing, []) }));
}

// ---------------------------------------------------------------- proposals

export interface ProposalRow {
  id: string;
  skill_id: string;
  kind: "inspection" | "operation";
  base_version_id: number | null;
  draft_version_id: number | null;
  status: "generating" | "proposed" | "testing" | "tested" | "approved" | "rejected" | "error";
  mode: string | null;
  rationale: string;
  change_summary: string;
  evidence: string;
  test_result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class LearningError extends Error {}

function touch(id: string, patch: Record<string, unknown>) {
  update("proposals", "id", id, { ...patch, updated_at: nowIso() });
}

export function getProposal(id: string) {
  const p = get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
  if (!p) return undefined;
  const base = p.base_version_id ? getVersion(p.base_version_id) : undefined;
  const draft = p.draft_version_id ? getVersion(p.draft_version_id) : undefined;
  return {
    ...p,
    evidence: parseJson<string[]>(p.evidence, []),
    test_result: parseJson(p.test_result, null),
    skill: getSkillRow(p.skill_id),
    base: base ? { id: base.id, version: base.version } : null,
    draft: draft ? { id: draft.id, version: draft.version, status: draft.status, content: draft.content } : null,
    diff: base && draft ? diffLines(base.content, draft.content) : [],
  };
}

export function listProposals() {
  return all<ProposalRow>("SELECT * FROM proposals ORDER BY created_at DESC LIMIT 100").map((p) => ({
    id: p.id,
    skillId: p.skill_id,
    kind: p.kind,
    status: p.status,
    mode: p.mode,
    changeSummary: p.change_summary,
    error: p.error,
    createdAt: p.created_at,
  }));
}

function replaceBody(content: string, body: string): string {
  const { yaml } = splitFrontmatter(content);
  return `---\n${yaml.trimEnd()}\n---\n${body.trimStart()}`;
}

/** Asks the improvement agent for a new skill version based on what happened on the floor. */
export function createProposal(skillId: string, actor: string): string {
  const skill = getSkillRow(skillId);
  const base = getApprovedVersion(skillId);
  if (!skill || !base) throw new LearningError(`承認済みのスキル ${skillId} が見つかりません`);
  const kind = skill.layer === "operation" ? "operation" : INSPECTION_LAYERS.includes(skill.layer) ? "inspection" : null;
  if (!kind) throw new LearningError("このスキルの改善は、スキルライブラリーで直接編集してください");
  const pending = get<{ id: string }>(
    "SELECT id FROM proposals WHERE skill_id = ? AND status IN ('generating','proposed','testing','tested')",
    skillId,
  );
  if (pending) throw new LearningError(`このスキルには未処理の改善案 ${pending.id} があります`);

  const id = nextId("PRP", 4);
  const now = nowIso();
  insert("proposals", {
    id,
    skill_id: skillId,
    kind,
    base_version_id: base.id,
    status: "generating",
    mode: aiMode(),
    created_at: now,
    updated_at: now,
  });
  runInBackground(
    `proposal ${id}`,
    async () => {
      if (kind === "inspection") await generateInspectionProposal(id, skillId, base.content, actor);
      else await generateOperationProposal(id, skillId, base.content, actor);
    },
    (e) => touch(id, { status: "error", error: errorMessage(e) }),
  );
  return id;
}

async function generateInspectionProposal(id: string, skillId: string, content: string, actor: string) {
  const cases = learningCases(skillId, 20);
  const gaps = skillGaps(skillId)
    .slice(0, 20)
    .map((g) => `${g.gap}（${g.count}件）`);
  if (cases.length === 0 && gaps.length === 0) {
    throw new LearningError("学習材料がありません（人がAIと違う判定をした検品や、AIが迷った点がまだありません）");
  }
  const disagreements: Disagreement[] = cases.map((c) => {
    const row = getRow(c.inspectionId)!;
    const ai = parseJson<Judgment | null>(row.ai_result, null);
    const shipment = parseJson<WmsShipment>(row.shipment, {} as WmsShipment);
    return {
      inspectionId: c.inspectionId,
      category: c.category,
      itemsText: (shipment.items ?? []).map((it) => `${it.name}×${it.qty}`).join("、"),
      aiOverall: c.aiOverall ?? "",
      aiSummary: c.aiSummary,
      aiChecks: (ai?.checks ?? []).map((ch) => `- ${ch.item}: ${ch.result}（${ch.reason}）`).join("\n"),
      humanOverall: c.humanOverall ?? "",
      humanNote: c.humanNote,
    };
  });
  const { body } = splitFrontmatter(content);
  const proposal =
    aiMode() === "live" ? await proposeInspectionLive(body, disagreements, gaps) : proposeInspectionDemo(body, disagreements, gaps);
  const draft = createDraft(skillId, replaceBody(content, proposal.revised_body), {
    source: "improvement",
    createdBy: `改善エージェント（${actor}の依頼）`,
    changeNote: proposal.change_summary,
  });
  touch(id, {
    status: "proposed",
    draft_version_id: draft.id,
    rationale: proposal.rationale,
    change_summary: proposal.change_summary,
    evidence: cases.map((c) => c.inspectionId),
  });
}

function sampleShipmentId(): string {
  return get<{ shipment_id: string }>("SELECT shipment_id FROM inspections ORDER BY created_at DESC LIMIT 1")?.shipment_id ?? "N-260923-001";
}

const MAX_REPAIR_ROUNDS = 4;

/**
 * Repairs the WMS operation skill: propose selectors for the elements that failed, check the
 * screens with the repaired selectors (read-only), and repeat for elements that turn out to be
 * broken on later screens, up to MAX_REPAIR_ROUNDS.
 */
async function generateOperationProposal(id: string, skillId: string, content: string, actor: string) {
  const errors = all<{ id: number; operation: string; step: string; selector_key: string; missing: string; html_snapshot: string | null }>(
    "SELECT * FROM operation_errors WHERE skill_id = ? AND resolved = 0 ORDER BY id DESC LIMIT 10",
    skillId,
  );
  if (errors.length === 0) throw new LearningError("未解決の操作エラーがありません");
  const original = extractJsonBlock(content) ?? {};
  const selectors = { ...original };
  let failures: OperationFailure[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    for (const key of [e.selector_key, ...parseJson<string[]>(e.missing, [])]) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      failures.push({ operation: e.operation, step: e.step, selectorKey: key, selector: selectors[key] ?? "", message: "要素が見つからない" });
    }
  }
  let html = errors.find((e) => e.html_snapshot)?.html_snapshot ?? "";
  const live = aiMode() === "live";
  const applied = new Map<string, { to: string; reason: string }>();
  const rationales: string[] = [];
  const sample = sampleShipmentId();
  let lastTest: Awaited<ReturnType<BrowserWmsAdapter["smokeTest"]>> | null = null;
  let rounds = 0;

  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
    const fix = live ? await proposeSelectorFixLive(selectors, failures, html) : proposeSelectorFixDemo(failures, html);
    const valid = fix.fixes.filter((f) => f.key in original && f.selector.trim() && selectors[f.key] !== f.selector.trim());
    if (valid.length === 0) break;
    rounds = round;
    rationales.push(fix.rationale);
    for (const f of valid) {
      selectors[f.key] = f.selector.trim();
      applied.set(f.key, { to: f.selector.trim(), reason: f.reason });
    }
    try {
      lastTest = await new BrowserWmsAdapter({ selectors, recordErrors: false }).smokeTest(sample);
    } catch {
      lastTest = null;
      break;
    }
    if (lastTest.ok) break;
    failures = lastTest.missing.map((key) => ({ operation: "smokeTest", step: "画面の確認", selectorKey: key, selector: selectors[key] ?? "", message: "要素が見つからない" }));
    html = lastTest.html;
  }
  if (applied.size === 0) throw new LearningError("画面から修正先の要素を見つけられませんでした。操作スキルを直接編集してください");

  const draft = createDraft(skillId, replaceJsonBlock(content, selectors), {
    source: "improvement",
    createdBy: `改善エージェント（${actor}の依頼）`,
    changeNote: [...applied].map(([key, f]) => `- ${key}: ${original[key]} → ${f.to}`).join("\n"),
  });
  touch(id, {
    status: lastTest ? "tested" : "proposed",
    draft_version_id: draft.id,
    rationale: `${[...new Set(rationales)].join(" ")}${rounds > 1 ? `（WMSの画面を確認しながら ${rounds} 回に分けて修正しました）` : ""}`,
    change_summary: [...applied].map(([key, f]) => `- ${key}: \`${original[key]}\` → \`${f.to}\`（${f.reason}）`).join("\n"),
    evidence: errors.map((e) => `ERR-${e.id}`),
    test_result: lastTest ? { type: "smoke", sample, ok: lastTest.ok, missing: lastTest.missing, detail: lastTest.detail } : null,
  });
}

/** Regression test: re-judges past confirmed inspections with the draft (or smoke-tests the WMS screens). */
export function testProposal(id: string) {
  const p = get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
  if (!p) throw new LearningError("改善案が見つかりません");
  if (!["proposed", "tested"].includes(p.status)) throw new LearningError("この改善案はいまテストできません");
  const draft = getVersion(p.draft_version_id!);
  if (!draft) throw new LearningError("改善案の版が見つかりません");
  touch(id, { status: "testing", error: null });
  runInBackground(
    `test proposal ${id}`,
    async () => {
      const result = p.kind === "operation" ? await smokeTestOperation(draft.content, draft.id) : await regressionTest(p.skill_id, draft.content);
      touch(id, { status: "tested", test_result: result });
    },
    (e) => touch(id, { status: "proposed", error: `テストに失敗しました: ${errorMessage(e)}` }),
  );
}

async function smokeTestOperation(content: string, versionId: number) {
  const selectors = extractJsonBlock(content) ?? {};
  const sample = sampleShipmentId();
  const adapter = new BrowserWmsAdapter({ selectors, skillVersionId: versionId, recordErrors: false });
  const r = await adapter.smokeTest(sample);
  return { type: "smoke", sample, ok: r.ok, missing: r.missing, detail: r.detail };
}

async function regressionTest(skillId: string, content: string) {
  const size = getSettings().regression_sample_size;
  const confirmed = all<InspRow>(
    "SELECT * FROM inspections WHERE human_overall IN ('OK','NG') AND ai_overall IS NOT NULL ORDER BY confirmed_at DESC",
  ).filter((r) => usesSkill(r, skillId));
  const learning = confirmed.filter((r) => classify(r));
  const others = confirmed.filter((r) => !classify(r));
  const sample = [...learning, ...others].slice(0, size);
  if (aiMode() !== "live") {
    return {
      type: "regression",
      skipped: true,
      reason: "デモモード（AI未接続）のため、過去の検品での再判定は行いません。スキルの形式チェックのみ行いました。",
      candidates: sample.length,
    };
  }
  if (sample.length === 0) {
    return { type: "regression", skipped: true, reason: "このスキルを使って人が確定した検品がまだないため、再判定できません。", candidates: 0 };
  }
  const results: Array<{ inspectionId: string; human: string; before: string; after: string }> = [];
  for (const r of sample) {
    const row = getRow(r.id)!;
    const { judgment } = await judge(row, { skillId, content });
    results.push({ inspectionId: r.id, human: r.human_overall!, before: r.ai_overall!, after: judgment.overall });
  }
  const score = (key: "before" | "after") => ({
    match: results.filter((x) => x[key] === x.human).length,
    misses: results.filter((x) => x[key] === "OK" && x.human === "NG").length,
    unsure: results.filter((x) => x[key] === "要確認").length,
  });
  return { type: "regression", skipped: false, total: results.length, before: score("before"), after: score("after"), results };
}

export function approveProposal(id: string, actor: string) {
  const p = get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
  if (!p) throw new LearningError("改善案が見つかりません");
  if (!["proposed", "tested"].includes(p.status)) throw new LearningError("この改善案はいま承認できません");
  if (!actor.trim()) throw new LearningError("承認者名を入力してください");
  approveVersion(p.draft_version_id!, actor);
  touch(id, { status: "approved" });
  if (p.kind === "operation" && p.skill_id === OPERATION_SKILL_ID) {
    run("UPDATE operation_errors SET resolved = 1 WHERE skill_id = ? AND resolved = 0", p.skill_id);
  }
  return getProposal(id);
}

export function rejectProposal(id: string, actor: string, reason: string) {
  const p = get<ProposalRow>("SELECT * FROM proposals WHERE id = ?", id);
  if (!p) throw new LearningError("改善案が見つかりません");
  if (!["proposed", "tested", "error"].includes(p.status)) throw new LearningError("この改善案はいま却下できません");
  if (p.draft_version_id) {
    const v = getVersion(p.draft_version_id);
    if (v?.status === "draft") rejectVersion(p.draft_version_id, actor, reason);
  }
  touch(id, { status: "rejected", error: reason ? `却下理由: ${reason}` : null });
  return getProposal(id);
}
