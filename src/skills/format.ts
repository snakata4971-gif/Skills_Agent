import YAML from "yaml";
import { z } from "zod";

export const LAYERS = ["common", "category", "customer", "operation", "communication", "disposition"] as const;
export type Layer = (typeof LAYERS)[number];

export const LAYER_LABELS: Record<Layer, string> = {
  common: "共通",
  category: "カテゴリ別",
  customer: "顧客別",
  operation: "端末・システム操作",
  communication: "連絡",
  disposition: "処理",
};

/** Layers whose skills are used to judge an inspection, in ascending priority. */
export const INSPECTION_LAYERS: Layer[] = ["common", "category", "customer"];

const AppliesToSchema = z
  .object({
    categories: z.array(z.string()).optional(),
    customers: z.array(z.string()).optional(),
    purposes: z.array(z.string()).optional(),
    instructions: z.array(z.string()).optional(),
    systems: z.array(z.string()).optional(),
  })
  .passthrough();

const MetaSchema = z
  .object({
    layer: z.enum(LAYERS, { message: `metadata.layer は ${LAYERS.join(" / ")} のいずれかにしてください` }),
    title: z.string().optional(),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, "metadata.version は 1.0.0 の形式にしてください")
      .optional(),
    owner: z.string().optional(),
    applies_to: AppliesToSchema.optional(),
    requires_approval: z.boolean().optional(),
    wms_status: z.string().optional(),
    worker_instruction: z.string().optional(),
  })
  .passthrough();

const FrontmatterSchema = z.object({
  name: z
    .string({ message: "name がありません" })
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "name は半角英小文字・数字・ハイフンにしてください（例: trading-cards）"),
  description: z.string({ message: "description がありません" }).min(10, "description は10文字以上で書いてください"),
  metadata: MetaSchema,
});

export type AppliesTo = z.infer<typeof AppliesToSchema>;

export interface SkillInfo {
  name: string;
  description: string;
  layer: Layer;
  title: string;
  version: string;
  owner: string;
  appliesTo: AppliesTo;
  requiresApproval: boolean;
  wmsStatus: string;
  workerInstruction: string;
  body: string;
}

export class SkillFormatError extends Error {}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function splitFrontmatter(content: string): { yaml: string; body: string } {
  const m = FRONTMATTER_RE.exec(content.replace(/^﻿/, ""));
  if (!m) throw new SkillFormatError("先頭に --- で囲んだ設定（frontmatter）がありません");
  return { yaml: m[1], body: m[2] };
}

export function parseSkill(content: string): SkillInfo {
  const { yaml, body } = splitFrontmatter(content);
  let data: unknown;
  try {
    data = YAML.parse(yaml);
  } catch (e) {
    throw new SkillFormatError(`frontmatter のYAMLが読めません: ${(e as Error).message}`);
  }
  const parsed = FrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new SkillFormatError(parsed.error.issues.map((i) => i.message).join(" / "));
  }
  const { name, description, metadata } = parsed.data;
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    name,
    description: description.trim(),
    layer: metadata.layer,
    title: metadata.title?.trim() || h1 || name,
    version: metadata.version ?? "1.0.0",
    owner: metadata.owner ?? "",
    appliesTo: metadata.applies_to ?? {},
    requiresApproval: metadata.requires_approval ?? false,
    wmsStatus: metadata.wms_status ?? "",
    workerInstruction: metadata.worker_instruction ?? "",
    body,
  };
}

/** Rewrites metadata.version while keeping the rest of the frontmatter as written. */
export function withVersion(content: string, version: string): string {
  const { yaml, body } = splitFrontmatter(content);
  const doc = YAML.parseDocument(yaml);
  doc.setIn(["metadata", "version"], version);
  return `---\n${doc.toString().trimEnd()}\n---\n${body}`;
}

/** Text under a "## heading" (matched by prefix) up to the next heading of the same or higher level. */
export function extractSection(body: string, headingPrefix: string): string {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, "").startsWith(headingPrefix));
  if (start < 0) return "";
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

export function extractListItems(section: string): string[] {
  return section
    .split(/\r?\n/)
    .map((l) => /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => Boolean(x));
}

export function extractPhotoInstructions(body: string): string[] {
  return extractListItems(extractSection(body, "撮影指示"));
}

const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/;

export function extractJsonBlock(body: string): Record<string, string> | null {
  const m = JSON_BLOCK_RE.exec(body);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function replaceJsonBlock(content: string, obj: Record<string, string>): string {
  const json = JSON.stringify(obj, null, 2);
  if (JSON_BLOCK_RE.test(content)) return content.replace(JSON_BLOCK_RE, "```json\n" + json + "\n```");
  return `${content.trimEnd()}\n\n## セレクター\n\`\`\`json\n${json}\n\`\`\`\n`;
}

/** A blank skill in the house template, used by the builder when AI is not connected. */
export function skillTemplate(opts: {
  name: string;
  description: string;
  layer: Layer;
  title: string;
  owner: string;
  categories?: string[];
  customers?: string[];
  body: string;
}): string {
  const appliesTo: Record<string, string[]> = {};
  if (opts.categories?.length) appliesTo.categories = opts.categories;
  if (opts.customers?.length) appliesTo.customers = opts.customers;
  const front = {
    name: opts.name,
    description: opts.description,
    metadata: {
      layer: opts.layer,
      title: opts.title,
      version: "1.0.0",
      owner: opts.owner,
      applies_to: appliesTo,
    },
  };
  return `---\n${YAML.stringify(front).trimEnd()}\n---\n${opts.body.trimStart()}`;
}
