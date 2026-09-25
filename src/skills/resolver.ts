import { selectSkillsWithAi } from "../ai/selector.ts";
import { INSPECTION_LAYERS, type Layer, type SkillInfo } from "./format.ts";
import { approvedSkills } from "./library.ts";

export interface ResolvedSkill {
  id: string;
  versionId: number;
  version: string;
  layer: Layer;
  title: string;
  content: string;
  info: SkillInfo;
}

export interface Resolution {
  skills: ResolvedSkill[];
  method: "key" | "ai" | "keyword" | "common-only";
  notes: string[];
  missingCategory: boolean;
}

export interface ResolveContext {
  customerId: string;
  category: string;
  itemNames: string[];
}

export const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();

function toResolved(entry: ReturnType<typeof approvedSkills>[number]): ResolvedSkill {
  return {
    id: entry.row.id,
    versionId: entry.version.id,
    version: entry.version.version,
    layer: entry.row.layer,
    title: entry.info.title,
    content: entry.version.content,
    info: entry.info,
  };
}

const tokens = (s: string) =>
  s
    .split(/[\s、,・/（）()「」]+/)
    .map(normalize)
    .filter((w) => w.length >= 2);

/**
 * How well a skill fits a shipment whose category had no exact match. Words from item names
 * count more than the category word, and hits on the skill's declared categories count more
 * than hits in its free-text description.
 */
function keywordScore(ctx: ResolveContext, info: SkillInfo): number {
  const cats = (info.appliesTo.categories ?? []).map(normalize).filter((c) => c !== "*");
  const text = normalize(`${info.title} ${info.description}`);
  const hitsCategory = (w: string) => cats.some((c) => c.includes(w) || w.includes(c));
  let score = 0;
  for (const w of tokens(ctx.category)) score += hitsCategory(w) ? 3 : text.includes(w) ? 1 : 0;
  for (const w of ctx.itemNames.flatMap(tokens)) score += hitsCategory(w) ? 4 : text.includes(w) ? 2 : 0;
  return score;
}

/** Below this, a keyword match is too weak to trust; the shipment goes to the common skill only. */
const MIN_KEYWORD_SCORE = 2;

/**
 * Picks the inspection skills for a shipment. Keys from the barcode scan (customer, category)
 * decide deterministically; search is only a fallback when no category skill matches.
 */
export async function resolveInspectionSkills(ctx: ResolveContext, opts: { allowAi: boolean }): Promise<Resolution> {
  const pool = approvedSkills(INSPECTION_LAYERS);
  const notes: string[] = [];
  const common = pool.filter((s) => s.row.layer === "common");
  const categoryPool = pool.filter((s) => s.row.layer === "category");
  const cat = normalize(ctx.category);
  let categorySkills = categoryPool.filter((s) =>
    (s.info.appliesTo.categories ?? []).some((c) => c === "*" || normalize(c) === cat),
  );
  const customerSkills = pool.filter(
    (s) =>
      s.row.layer === "customer" &&
      (s.info.appliesTo.customers ?? []).some((c) => normalize(c) === normalize(ctx.customerId)),
  );

  let method: Resolution["method"] = "key";
  let missingCategory = false;

  if (categorySkills.length === 0 && categoryPool.length > 0) {
    if (opts.allowAi) {
      const picked = await selectSkillsWithAi(
        ctx,
        categoryPool.map((s) => ({ id: s.row.id, title: s.info.title, description: s.info.description })),
      );
      categorySkills = categoryPool.filter((s) => picked.ids.includes(s.row.id));
      if (categorySkills.length) {
        method = "ai";
        notes.push(`カテゴリ「${ctx.category}」に直接対応するスキルがないため、AIが近いスキルを選びました: ${picked.reason}`);
      }
    } else {
      const scored = categoryPool
        .map((s) => ({ s, score: keywordScore(ctx, s.info) }))
        .filter((x) => x.score >= MIN_KEYWORD_SCORE)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        categorySkills = [scored[0].s];
        method = "keyword";
        notes.push(`カテゴリ「${ctx.category}」に直接対応するスキルがないため、キーワードが近いスキルを使います`);
      }
    }
    if (categorySkills.length === 0) {
      method = "common-only";
      missingCategory = true;
      notes.push(`カテゴリ「${ctx.category}」の専用スキルがありません。共通スキルだけで判定し、スキル作成依頼を登録しました`);
    }
  }
  if (customerSkills.length) notes.push(`顧客 ${ctx.customerId} の固有ルールを最優先で適用します`);

  return {
    skills: [...common, ...categorySkills, ...customerSkills].map(toResolved),
    method,
    notes,
    missingCategory,
  };
}

export function resolveBy(layer: Layer, key: "instructions" | "purposes" | "systems", value: string): ResolvedSkill | undefined {
  const match = approvedSkills([layer]).find((s) => {
    const list = (s.info.appliesTo as Record<string, unknown>)[key];
    return Array.isArray(list) && list.includes(value);
  });
  return match ? toResolved(match) : undefined;
}
