import fs from "node:fs";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { config, type Effort } from "../config.ts";
import { insert } from "../db.ts";
import { getSettings } from "../settings.ts";
import { errorMessage, nowIso } from "../util.ts";

export type AiMode = "live" | "demo";

export function aiMode(): AiMode {
  if (config.forceDemo) return "demo";
  return config.anthropicApiKey || config.anthropicAuthToken ? "live" : "demo";
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 3 });
  return client;
}

export class AiError extends Error {}

/** Models that accept the server-side refusal fallback parameter. */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-opus-5-5", "claude-fable-5", "claude-fable-5-1"]);

function capabilities(model: string) {
  const legacy = model.startsWith("claude-haiku") || /claude-(sonnet|opus)-4-[0-5]\b/.test(model);
  return { adaptiveThinking: !legacy, effort: !legacy, fallbacks: FALLBACK_MODELS.has(model) };
}

/** USD per 1M tokens (input, output). Used only for the rough cost display. */
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  estimated_usd: number | null;
}

export function estimateUsd(model: string, u: Omit<UsageSummary, "estimated_usd">): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const [inp, out] = price;
  return (
    (u.input_tokens * inp + u.cache_read_tokens * inp * 0.1 + u.cache_write_tokens * inp * 1.25 + u.output_tokens * out) /
    1_000_000
  );
}

export type SystemBlock = Anthropic.Beta.BetaTextBlockParam;
export type ContentBlock = Anthropic.Beta.BetaContentBlockParam;

export interface StructuredCall<S extends z.ZodType> {
  purpose: string;
  schema: S;
  system: SystemBlock[];
  content: ContentBlock[];
  maxTokens?: number;
  effort?: Effort;
}

/**
 * One Claude call that must return JSON matching `schema`.
 * Refusals, truncation and unparseable output surface as AiError with a Japanese message.
 */
export async function callStructured<S extends z.ZodType>(call: StructuredCall<S>): Promise<{
  data: z.infer<S>;
  usage: UsageSummary;
  model: string;
}> {
  if (aiMode() !== "live") throw new AiError("AIが接続されていません（APIキー未設定）");
  const settings = getSettings();
  const model = settings.model;
  const caps = capabilities(model);
  const started = Date.now();
  let usage: UsageSummary | null = null;
  try {
    const response = await getClient().beta.messages.parse({
      model,
      max_tokens: call.maxTokens ?? 16000,
      ...(caps.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      ...(caps.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: {
        ...(caps.effort ? { effort: call.effort ?? settings.effort } : {}),
        format: betaZodOutputFormat(call.schema),
      },
      system: call.system,
      messages: [{ role: "user", content: call.content }],
    });
    const u = response.usage;
    const base = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    };
    usage = { ...base, estimated_usd: estimateUsd(response.model, base) };

    if (response.stop_reason === "refusal") {
      const why = response.stop_details?.explanation ?? "";
      throw new AiError(`AIが回答を控えました${why ? `（${why}）` : ""}。人が確認してください`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiError("AIの出力が上限に達して途中で切れました。写真の枚数を減らすか、再実行してください");
    }
    const data = response.parsed_output;
    if (data === null || data === undefined) throw new AiError("AIの出力を読み取れませんでした");
    recordCall(call.purpose, response.model, usage, Date.now() - started, null);
    return { data: data as z.infer<S>, usage, model: response.model };
  } catch (e) {
    const message = describeError(e);
    recordCall(call.purpose, model, usage, Date.now() - started, message);
    throw e instanceof AiError ? e : new AiError(message);
  }
}

function describeError(e: unknown): string {
  if (e instanceof AiError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "APIキーが無効です。.env の ANTHROPIC_API_KEY を確認してください";
  if (e instanceof Anthropic.PermissionDeniedError) return "このAPIキーでは指定のモデルを利用できません";
  if (e instanceof Anthropic.NotFoundError) return "指定のモデルが見つかりません。設定のモデル名を確認してください";
  if (e instanceof Anthropic.RateLimitError) return "AIの利用上限（レート制限）に達しました。少し待って再実行してください";
  if (e instanceof Anthropic.BadRequestError) return `AIへのリクエストが不正です: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "AIサービスに接続できません。ネットワークを確認してください";
  if (e instanceof Anthropic.APIError) return `AIサービスのエラー（${e.status ?? "不明"}）: ${e.message}`;
  return errorMessage(e);
}

function recordCall(purpose: string, model: string, usage: UsageSummary | null, ms: number, error: string | null) {
  try {
    insert("ai_calls", {
      purpose,
      model,
      input_tokens: usage?.input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
      cache_read_tokens: usage?.cache_read_tokens ?? null,
      cache_write_tokens: usage?.cache_write_tokens ?? null,
      duration_ms: ms,
      ok: error ? 0 : 1,
      error,
      created_at: nowIso(),
    });
  } catch {
    /* usage logging must never break the call */
  }
}

/**
 * Uploads a large file (e.g. a scanned manual PDF) through the Files API so it does not count
 * against the request size limit. Files expire after a day, so nothing accumulates.
 */
export async function uploadForAi(filePath: string, name: string, mime: string): Promise<{ id: string; expiresAt: string }> {
  if (aiMode() !== "live") throw new AiError("AIが接続されていません（APIキー未設定）");
  try {
    const meta = await getClient().files.upload({
      file: await toFile(fs.createReadStream(filePath), name, { type: mime }),
      expires_in_seconds: 86400,
    });
    return { id: meta.id, expiresAt: new Date(Date.now() + 23 * 3600 * 1000).toISOString() };
  } catch (e) {
    throw new AiError(`資料をAIに送れませんでした: ${describeError(e)}`);
  }
}

export const text = (t: string): ContentBlock => ({ type: "text", text: t });

/** Wraps untrusted text (customer emails, uploaded documents) so the model treats it as data. */
export const quoted = (tag: string, body: string) => `<${tag}>\n${body.replaceAll(`</${tag}>`, "")}\n</${tag}>`;
