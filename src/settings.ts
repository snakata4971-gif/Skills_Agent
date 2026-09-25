import { z } from "zod";
import { config, EFFORT_LEVELS } from "./config.ts";
import { all, run } from "./db.ts";

export const SettingsSchema = z.object({
  /** 並走運用: AIの判定は参考表示のみで、必ず人が確定する */
  shadow_mode: z.boolean(),
  /** 自動OKにする確信度の下限（並走運用OFFのとき有効） */
  auto_ok_threshold: z.number().min(0.5).max(1),
  /** この申告額（円）以上は判定に関わらず人が確認 */
  high_value_yen: z.number().int().min(0),
  wms_mode: z.enum(["api", "browser"]),
  model: z.string().min(1),
  effort: z.enum(EFFORT_LEVELS),
  concurrency: z.number().int().min(1).max(16),
  reply_due_days: z.number().int().min(1).max(60),
  regression_sample_size: z.number().int().min(1).max(50),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): Settings {
  return {
    shadow_mode: true,
    auto_ok_threshold: 0.9,
    high_value_yen: 50000,
    wms_mode: config.wms.mode,
    model: config.model,
    effort: config.effort,
    concurrency: 4,
    reply_due_days: 7,
    regression_sample_size: 8,
  };
}

export function getSettings(): Settings {
  const merged: Record<string, unknown> = { ...defaultSettings() };
  for (const row of all<{ key: string; value: string }>("SELECT key, value FROM settings")) {
    try {
      merged[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore corrupt value; default stays */
    }
  }
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultSettings();
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = SettingsSchema.parse({ ...getSettings(), ...patch });
  for (const key of Object.keys(patch)) {
    if (!(key in next)) continue;
    run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify((next as Record<string, unknown>)[key]),
    );
  }
  return next;
}
