import { z } from "zod";
import { getSettings, type Settings } from "../settings.ts";
import type { ResolvedSkill } from "../skills/resolver.ts";
import { LAYER_LABELS } from "../skills/format.ts";
import { clamp01 } from "../util.ts";
import { callStructured, type ContentBlock, type SystemBlock, text, type UsageSummary } from "./client.ts";
import { imageBlock } from "./images.ts";

export const VERDICTS = ["OK", "NG", "要確認"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const ISSUE_TYPES = ["色違い", "数量不足", "数量超過", "汚破損", "別商品", "付属品欠品", "その他"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

// The SDK turns enum constraints into description hints when it builds the output schema, so
// verdicts arrive as plain strings and are normalized in finalize() (unknown values → safe side).
export const JudgmentSchema = z.object({
  overall: z.string().describe("総合判定。OK / NG / 要確認 のいずれか"),
  summary: z.string().describe("作業者向けの1〜2文の要約"),
  checks: z
    .array(
      z.object({
        item: z.string().describe("判定項目（例: 商品の一致, 数量, 色, 形状・汚破損, 付属品, カード番号）"),
        result: z.string().describe("OK / NG / 要確認 のいずれか"),
        confidence: z.number().describe("0〜1の確信度"),
        reason: z.string().describe("作業者が読める短い日本語の理由"),
        evidence: z.array(z.string()).describe("根拠にした写真のラベル（例: 顧客写真1, 現物写真2）"),
      }),
    )
    .describe("スキルの判定項目ごとの結果"),
  issues: z
    .array(
      z.object({
        type: z.string().describe(`問題の種類。${ISSUE_TYPES.join(" / ")} のいずれか`),
        detail: z.string().describe("どの商品の何がどう違うか"),
        photo: z.string().describe("該当する写真のラベル"),
      }),
    )
    .describe("見つかった問題（なければ空）"),
  observed_quantity: z.number().describe("現物写真で数えた数量。数えられない場合は -1"),
  additional_photos: z.array(z.string()).describe("判定のために追加で必要な写真（なければ空）"),
  skill_gaps: z.array(z.string()).describe("スキルに基準がなく判断に迷った点（スキル改善に使う。なければ空）"),
});
export type RawJudgment = z.infer<typeof JudgmentSchema>;

export interface Judgment extends Omit<RawJudgment, "overall" | "checks" | "issues"> {
  overall: Verdict;
  checks: Array<Omit<RawJudgment["checks"][number], "result"> & { result: Verdict }>;
  issues: Array<Omit<RawJudgment["issues"][number], "type"> & { type: IssueType }>;
  min_confidence: number;
  corrections: string[];
}

/** Exact verdicts pass through; anything else is treated as "needs a person" (never as OK). */
export function toVerdict(v: unknown): Verdict {
  const s = String(v ?? "").trim();
  return (VERDICTS as readonly string[]).includes(s) ? (s as Verdict) : "要確認";
}

function toIssueType(v: unknown): IssueType {
  const s = String(v ?? "").trim();
  return (ISSUE_TYPES as readonly string[]).includes(s) ? (s as IssueType) : "その他";
}

export interface PhotoRef {
  label: string;
  path: string;
}

export interface JudgeInput {
  shipmentId: string;
  customerId: string;
  category: string;
  declaredValue: number;
  items: Array<{ name: string; qty: number; color: string; size: string; note: string }>;
  customerPhotos: PhotoRef[];
  workerPhotos: PhotoRef[];
  skills: ResolvedSkill[];
}

const RANK: Record<Verdict, number> = { OK: 0, 要確認: 1, NG: 2 };
const worst = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b);

const INSTRUCTIONS = `あなたは越境物流センターの検品担当AIです。顧客がアップロードした商品写真（顧客写真＝顧客が申告した状態）と、センターに届いた現物を作業者が撮影した写真（現物写真）を比較し、下に示すスキル（検品基準）に従って判定します。

判定の原則:
- 判定はスキルに書かれた基準に従います。スキル同士が食い違う場合は「顧客別 > カテゴリ別 > 共通」の順に優先します。
- 見逃し（本来NGのものをOKにすること）を最も重い失敗として扱います。確信が持てない項目は「要確認」にします。
- 写真から確認できないことを推測で断定しません。確認できない場合は「要確認」とし、必要な追加写真を additional_photos に書きます。
- 照明や撮影角度による見え方の差と、実際の違い（色違い・破損など）を区別します。タグやラベルの文字情報は見た目の色より優先します。
- 顧客写真の時点ですでにある傷や状態は問題にしません。顧客写真になかった違いだけを問題にします。
- checks にはスキルの判定項目ごとに1行ずつ書きます。reason は作業者が読んで分かる短い日本語にし、evidence には根拠にした写真のラベル（例: 顧客写真1、現物写真2）を書きます。
- 問題があれば issues に種類・内容・写真ラベルを書きます。issues が1件以上あれば overall を OK にしません。
- スキルに基準が書かれておらず判断に迷った点は skill_gaps に書きます（スキル改善に使います）。`;

export function buildSystem(skills: ResolvedSkill[]): SystemBlock[] {
  const skillText = skills
    .map(
      (s) =>
        `<skill id="${s.id}" layer="${LAYER_LABELS[s.layer]}" version="${s.version}">\n${s.info.body.trim()}\n</skill>`,
    )
    .join("\n\n");
  return [
    { type: "text", text: INSTRUCTIONS },
    {
      type: "text",
      text: `適用するスキル（優先度の低い順。後のものほど優先）:\n\n${skillText}`,
      cache_control: { type: "ephemeral" },
    },
  ];
}

export function describeShipment(input: JudgeInput): string {
  const lines = input.items.map(
    (it, i) =>
      `${i + 1}. ${it.name} / 数量 ${it.qty}${it.color ? ` / 色 ${it.color}` : ""}${it.size ? ` / サイズ ${it.size}` : ""}${it.note ? ` / 備考 ${it.note}` : ""}`,
  );
  const total = input.items.reduce((n, it) => n + (Number(it.qty) || 0), 0);
  return [
    `納品ID: ${input.shipmentId}`,
    `顧客ID: ${input.customerId}`,
    `カテゴリ: ${input.category}`,
    `申告額: ${input.declaredValue.toLocaleString("ja-JP")}円`,
    `申告内容（合計数量 ${total}）:`,
    ...lines,
  ].join("\n");
}

export async function judgeLive(input: JudgeInput, maxPx: number): Promise<{ judgment: Judgment; usage: UsageSummary; model: string }> {
  const content: ContentBlock[] = [text(`検品対象\n${describeShipment(input)}`), text("顧客写真（顧客がアップロードした写真）:")];
  for (const p of input.customerPhotos) {
    content.push(text(`${p.label}:`), await imageBlock(p.path, maxPx));
  }
  content.push(text("現物写真（センターで作業者が撮影した写真）:"));
  for (const p of input.workerPhotos) {
    content.push(text(`${p.label}:`), await imageBlock(p.path, maxPx));
  }
  content.push(text("スキルの基準に従って、顧客写真と現物写真を比較して判定してください。"));

  const { data, usage, model } = await callStructured({
    purpose: "inspection_judgment",
    schema: JudgmentSchema,
    system: buildSystem(input.skills),
    content,
  });
  return { judgment: finalize(data), usage, model };
}

/** Deterministic safety rules applied on top of the model's answer. */
export function finalize(raw: RawJudgment): Judgment {
  const corrections: string[] = [];
  const checks = raw.checks.map((c) => {
    const result = toVerdict(c.result);
    if (result !== c.result) corrections.push(`「${c.item}」の結果「${c.result}」を ${result} として扱いました`);
    return { ...c, result, confidence: clamp01(c.confidence) };
  });
  const issues = raw.issues.map((i) => ({ ...i, type: toIssueType(i.type) }));
  let overall: Verdict = toVerdict(raw.overall);
  if (overall !== raw.overall) corrections.push(`総合判定「${raw.overall}」を ${overall} として扱いました`);
  const worstCheck = checks.reduce<Verdict>((acc, c) => worst(acc, c.result), "OK");
  if (RANK[worstCheck] > RANK[overall]) {
    corrections.push(`項目別の結果（${worstCheck}）に合わせて総合判定を ${overall} から ${worstCheck} に変更しました`);
    overall = worstCheck;
  }
  if (overall === "OK" && issues.length > 0) {
    corrections.push("問題の記載があるため総合判定を OK から 要確認 に変更しました");
    overall = "要確認";
  }
  if (overall === "OK" && checks.length === 0) {
    corrections.push("判定項目がないため 要確認 にしました");
    overall = "要確認";
  }
  const min_confidence = checks.length ? Math.min(...checks.map((c) => c.confidence)) : 0;
  return { ...raw, overall, checks, issues, min_confidence, corrections };
}

export interface RoutingDecision {
  routing: "auto_ok" | "human_review";
  reasons: string[];
}

export function decideRouting(j: Judgment, declaredValue: number, settings: Settings = getSettings()): RoutingDecision {
  const reasons: string[] = [];
  if (j.overall !== "OK") reasons.push(`AI判定が ${j.overall} のため`);
  if (j.min_confidence < settings.auto_ok_threshold) {
    reasons.push(`確信度 ${j.min_confidence.toFixed(2)} が基準 ${settings.auto_ok_threshold} 未満のため`);
  }
  if (declaredValue >= settings.high_value_yen) {
    reasons.push(`申告額 ${declaredValue.toLocaleString("ja-JP")}円 が高額品の基準以上のため`);
  }
  if (settings.shadow_mode) reasons.push("並走運用中のため（AIの判定は参考。人が確定）");
  return { routing: reasons.length === 0 ? "auto_ok" : "human_review", reasons };
}
