import { z } from "zod";
import { aiMode, callStructured, text } from "./client.ts";

const SelectionSchema = z.object({
  ids: z.array(z.string()).describe("適用すべきスキルのid（該当なしなら空）"),
  reason: z.string().describe("選んだ理由、または該当なしの理由（1文）"),
});

/**
 * Fallback when no category skill matches the scanned category: the model sees only the
 * catalog (id, title, description) and picks the closest skills — never their full text.
 */
export async function selectSkillsWithAi(
  ctx: { category: string; itemNames: string[] },
  catalog: Array<{ id: string; title: string; description: string }>,
): Promise<{ ids: string[]; reason: string }> {
  if (aiMode() !== "live" || catalog.length === 0) return { ids: [], reason: "" };
  try {
    const { data } = await callStructured({
      purpose: "skill_selection",
      schema: SelectionSchema,
      effort: "low",
      maxTokens: 4000,
      system: [
        {
          type: "text",
          text: "あなたは検品スキルの選定係です。商品のカテゴリと品名から、カタログの中で検品基準として使えるスキルを選びます。明らかに合うものだけを選び、無理に選ばないでください。",
        },
      ],
      content: [
        text(
          `商品カテゴリ: ${ctx.category}\n品名: ${ctx.itemNames.join("、")}\n\nスキルのカタログ:\n${catalog
            .map((c) => `- id: ${c.id}\n  名前: ${c.title}\n  説明: ${c.description}`)
            .join("\n")}`,
        ),
      ],
    });
    const valid = new Set(catalog.map((c) => c.id));
    return { ids: data.ids.filter((id) => valid.has(id)), reason: data.reason };
  } catch {
    return { ids: [], reason: "" };
  }
}
