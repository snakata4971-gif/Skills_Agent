/**
 * Live-mode AI calls against a local stand-in for the Claude API: checks what the app sends
 * (model, beta header, fallbacks, thinking, structured-output schema, images, cached skills)
 * and that responses — including refusals — are read correctly. No real API key is used.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, test } from "node:test";
import { makeDocx, makeVideo } from "./fixtures.ts";
import { prepareEnv } from "./setup.ts";

prepareEnv();
interface Captured {
  headers: http.IncomingHttpHeaders;
  body: any;
}
const captured: Captured[] = [];
let nextStopReason = "end_turn";

function cannedFor(schema: any): unknown {
  const props = Object.keys(schema?.properties ?? {});
  if (props.includes("overall")) {
    return {
      overall: "OK",
      summary: "色が違います",
      checks: [
        { item: "色", result: "NG", confidence: 0.92, reason: "紺ではなく赤", evidence: ["顧客写真1", "現物写真1"] },
        { item: "サイズ", result: "OK", confidence: 0.9, reason: "M", evidence: ["現物写真1"] },
      ],
      issues: [{ type: "色違い", detail: "Tシャツが赤", photo: "現物写真1" }],
      observed_quantity: 1,
      additional_photos: [],
      skill_gaps: ["色見本カードの基準がない"],
    };
  }
  if (props.includes("body_markdown")) {
    return {
      title: "スニーカー検品",
      description: "スニーカーの検品。サイズ表記とソールの状態を確認する。",
      body_markdown: "# スニーカー検品\n\n## 撮影指示\n- 側面\n\n## 判定項目と基準\n### サイズ\n- タグのcm表記を確認\n",
      questions: [{ id: "q1", question: "ソールの汚れの許容範囲は？", why: "OK/NGの境目" }],
      summary: "POPから撮影手順を読み取りました",
      suggested_name: "sneakers",
      suggested_categories: ["スニーカー", "靴"],
    };
  }
  if (props.includes("subject")) return { subject: "【ご確認のお願い】検品結果について", body: "本文 {{REPLY_URL}} 期限 {{DUE_DATE}}" };
  if (props.includes("instruction")) return { instruction: "return", confidence: 0.93, summary: "返品を希望", needs_human: false, extra_requests: [] };
  if (props.includes("revised_body")) return { revised_body: "# 改善版\n\n## 判定項目と基準\n- 追記\n", change_summary: "- 追記", rationale: "人の判定に合わせた" };
  if (props.includes("fixes")) return { fixes: [{ key: "scan_input", selector: "#barcode-input", reason: "名前が一致" }], rationale: "画面から特定" };
  if (props.includes("ids")) return { ids: ["category/toys"], reason: "フィギュアのため" };
  throw new Error(`unknown schema: ${props.join(",")}`);
}

const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    captured.push({ headers: req.headers, body });
    const stop = nextStopReason;
    nextStopReason = "end_turn";
    const message = {
      id: `msg_${captured.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: stop === "refusal" ? [] : [{ type: "text", text: JSON.stringify(cannedFor(body.output_config?.format?.schema)) }],
      stop_reason: stop,
      stop_sequence: null,
      stop_details: stop === "refusal" ? { type: "refusal", category: null, explanation: "テスト用の拒否" } : null,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    };
    res.writeHead(200, { "Content-Type": "application/json", "request-id": `req_${captured.length}` });
    res.end(JSON.stringify(message));
  });
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const addr = fake.address() as { port: number };
process.env.QA_FORCE_DEMO = "";
process.env.ANTHROPIC_API_KEY = "test-key-for-local-fake-server";
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${addr.port}`;
after(() => fake.close());

const { aiMode, AiError } = await import("../src/ai/client.ts");
const { judgeLive } = await import("../src/ai/judge.ts");
const { generateDraftLive } = await import("../src/ai/builder.ts");
const { draftEmailLive, classifyReplyLive } = await import("../src/ai/mailer.ts");
const { proposeInspectionLive, proposeSelectorFixLive } = await import("../src/ai/improver.ts");
const { selectSkillsWithAi } = await import("../src/ai/selector.ts");
const { seedSkillsFromDisk } = await import("../src/skills/library.ts");
const { resolveInspectionSkills } = await import("../src/skills/resolver.ts");
const { config } = await import("../src/config.ts");
const { all } = await import("../src/db.ts");
const { processUpload } = await import("../src/materials.ts");

seedSkillsFromDisk(config.paths.seedSkills);
const customerPhoto = path.join(config.paths.seed, "images/customer/N-260923-004-1.jpg");
const workerPhoto = path.join(config.paths.samples, "現物写真/N-260923-004/現物-1.jpg");

test("APIキーがあればライブモードになる", () => {
  assert.equal(aiMode(), "live");
});

test("検品判定のリクエスト内容と、応答の読み取り・安全ルール", async () => {
  const { skills } = await resolveInspectionSkills({ customerId: "C-1005", category: "アパレル", itemNames: ["ロゴTシャツ"] }, { allowAi: true });
  const { judgment, usage, model } = await judgeLive(
    {
      shipmentId: "N-260923-004",
      customerId: "C-1005",
      category: "アパレル",
      declaredValue: 8900,
      items: [{ name: "ロゴTシャツ", qty: 1, color: "ネイビー", size: "M", note: "" }],
      customerPhotos: [{ label: "顧客写真1", path: customerPhoto }],
      workerPhotos: [{ label: "現物写真1", path: workerPhoto }],
      skills,
    },
    800,
  );
  const req = captured.at(-1)!;
  assert.equal(req.body.model, "claude-opus-5");
  assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
  assert.equal(req.body.fallbacks, "default");
  assert.deepEqual(req.body.thinking, { type: "adaptive" });
  assert.equal(req.body.output_config.effort, "high");
  assert.equal(req.body.output_config.format.type, "json_schema");
  assert.ok(req.body.output_config.format.schema.properties.checks, "判定の出力形式（JSONスキーマ）を渡す");
  assert.equal(req.body.system.length, 2);
  assert.deepEqual(req.body.system[1].cache_control, { type: "ephemeral" }, "スキル部分はキャッシュ対象");
  assert.ok(req.body.system[1].text.includes('<skill id="category/apparel"'));
  const content = req.body.messages[0].content;
  const images = content.filter((b: any) => b.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0].source.media_type, "image/jpeg");
  assert.ok(content.some((b: any) => b.type === "text" && b.text === "顧客写真1:"), "写真にラベルを付けて渡す");
  assert.ok(content[0].text.includes("申告額: 8,900円"));

  assert.equal(model, "claude-opus-5");
  assert.equal(judgment.overall, "NG", "項目にNGがあるので総合もNGに補正");
  assert.equal(judgment.corrections.length, 1);
  assert.equal(usage.input_tokens, 1200);
  assert.ok(usage.estimated_usd && usage.estimated_usd > 0);
});

test("AIが回答を控えた場合は日本語のエラーになり、利用記録に残る", async () => {
  nextStopReason = "refusal";
  await assert.rejects(classifyReplyLive("送ったメール", "返信"), (e: unknown) => e instanceof AiError && /回答を控えました/.test(e.message));
  const last = all<{ ok: number; error: string }>("SELECT ok, error FROM ai_calls ORDER BY id DESC LIMIT 1")[0];
  assert.equal(last.ok, 0);
  assert.match(last.error, /回答を控えました/);
});

test("カテゴリが一致しないときは、AIがカタログ（名前と説明だけ）から選ぶ", async () => {
  const r = await selectSkillsWithAi({ category: "雑貨", itemNames: ["フィギュア"] }, [
    { id: "category/toys", title: "おもちゃ・ホビー検品", description: "フィギュアなど" },
    { id: "category/apparel", title: "アパレル検品", description: "衣類" },
  ]);
  assert.deepEqual(r.ids, ["category/toys"]);
  const text = captured.at(-1)!.body.messages[0].content[0].text as string;
  assert.ok(text.includes("id: category/toys") && !text.includes("## 判定項目"), "本文ではなくカタログだけを渡す");
});

test("スキルビルダー: 写真・文書・動画を、説明と時刻つきでAIに渡す", async () => {
  const work = path.join(config.paths.data, "ai-materials");
  fs.mkdirSync(work, { recursive: true });
  let n = 0;
  const upload = async (file: string, name: string, mime: string) => {
    const src = path.join(work, `src-${++n}`);
    fs.copyFileSync(file, src);
    return processUpload({ dir: work, id: `m${n}`, name, mime, src });
  };
  const note = path.join(work, "pop.txt");
  fs.writeFileSync(note, "POP: 靴は左右を並べて撮影する");
  const materials = [
    await upload(workerPhoto, "POP写真.jpg", "image/jpeg"),
    await upload(note, "pop.txt", "text/plain"),
    await upload(await makeDocx(path.join(work, "手順書.docx")), "手順書.docx", ""),
  ];
  materials[0].description = "検品台の横に貼ってあるPOP";
  const video = makeVideo(path.join(work, "作業動画.mp4"));
  if (video) materials.push(await upload(video, "作業動画.mp4", "video/mp4"));

  const { draft } = await generateDraftLive(
    { layer: "category", name: "draft-x", title: "資料から作るスキル", categories: [], customers: [], owner: "", auto: true },
    materials,
    "ソールの汚れに注意",
  );
  const req = captured.at(-1)!;
  assert.ok(req.body.output_config.format.schema.properties.suggested_name, "名前とカテゴリの提案も求める");
  assert.match(req.body.system[0].text, /名前と対象カテゴリはまだ仮です/);
  const texts: string[] = req.body.messages[0].content.filter((b: any) => b.type === "text").map((b: any) => b.text as string);
  assert.ok(texts.some((t) => t.includes("資料1「POP写真.jpg」（写真）\n説明: 検品台の横に貼ってあるPOP")), "資料の説明を添える");
  assert.ok(texts.some((t) => t.includes("<document>") && t.includes("| サイズ | タグのcm表記 |")), "Wordの表は文章として渡す");
  assert.ok(texts.includes("資料3の文書内の図1:"), "文書の中の図も画像で渡す");
  if (video) {
    assert.ok(texts.some((t) => /長さ 0:06 の動画から切り出した \d+ コマ/.test(t)));
    assert.ok(texts.includes("コマ1（0:00）:"), "動画のコマに時刻をつける");
  }
  const images = req.body.messages[0].content.filter((b: any) => b.type === "image");
  assert.ok(images.length >= 2 + (video ? 3 : 0));
  assert.equal(draft.suggested_name, "sneakers");
});

test("メールの下書き・返信の読み取り・改善案・セレクター修正の各呼び出し", async () => {
  const email = await draftEmailLive({ customerName: "テスト", shipmentId: "N-1", itemsText: "- A", summary: "色違い", issues: [{ type: "色違い", detail: "赤" }] }, undefined);
  assert.match(email.body, /\{\{REPLY_URL\}\}/);
  const reply = await classifyReplyLive("送ったメール", "返品でお願いします");
  assert.equal(reply.instruction, "return");
  assert.ok(captured.at(-1)!.body.messages[0].content[0].text.includes("<customer_reply>"), "顧客の返信は data として囲む");
  const proposal = await proposeInspectionLive("# 現在\n", [], ["基準がない"]);
  assert.match(proposal.revised_body, /改善版/);
  const fix = await proposeSelectorFixLive({ scan_input: "#scan-code" }, [{ operation: "lookup", step: "s", selectorKey: "scan_input", selector: "#scan-code", message: "m" }], "<input id='barcode-input'>");
  assert.equal(fix.fixes[0].selector, "#barcode-input");
});

test("モデルを Haiku にすると thinking・effort・fallbacks を送らない", async () => {
  const { updateSettings } = await import("../src/settings.ts");
  updateSettings({ model: "claude-haiku-4-5" });
  await classifyReplyLive("メール", "そのまま出荷してください");
  const req = captured.at(-1)!;
  assert.equal(req.body.model, "claude-haiku-4-5");
  assert.equal(req.body.thinking, undefined);
  assert.equal(req.body.fallbacks, undefined);
  assert.equal(req.body.output_config.effort, undefined);
  updateSettings({ model: "claude-opus-5" });
});
