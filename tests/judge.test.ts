import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareEnv } from "./setup.ts";

prepareEnv();
const { finalize, decideRouting } = await import("../src/ai/judge.ts");
const { defaultSettings } = await import("../src/settings.ts");
const { proposeSelectorFixDemo } = await import("../src/ai/improver.ts");
const { classifyReplyDemo, fillPlaceholders } = await import("../src/ai/mailer.ts");
const views = await import("../src/wms/mock/views.ts");

const raw = (over: Record<string, unknown> = {}) => ({
  overall: "OK" as const,
  summary: "問題なし",
  checks: [
    { item: "色", result: "OK" as const, confidence: 0.95, reason: "一致", evidence: ["現物写真1"] },
    { item: "数量", result: "OK" as const, confidence: 0.97, reason: "一致", evidence: ["現物写真1"] },
  ],
  issues: [],
  observed_quantity: 1,
  additional_photos: [],
  skill_gaps: [],
  ...over,
});

test("項目にNGがあれば総合判定もNGに補正される", () => {
  const j = finalize(raw({ checks: [{ item: "色", result: "NG", confidence: 0.9, reason: "赤", evidence: [] }] }) as never);
  assert.equal(j.overall, "NG");
  assert.equal(j.corrections.length, 1);
});

test("問題の記載があるのに OK の場合は要確認になる", () => {
  const j = finalize(raw({ issues: [{ type: "汚破損", detail: "傷", photo: "現物写真1" }] }) as never);
  assert.equal(j.overall, "要確認");
});

test("想定外の判定値は要確認として扱い、OK にはしない", () => {
  const j = finalize(
    raw({
      overall: "たぶんOK",
      checks: [{ item: "色", result: "NG（色違い）", confidence: 0.9, reason: "", evidence: [] }],
      issues: [{ type: "色の違い", detail: "赤", photo: "現物写真1" }],
    }) as never,
  );
  assert.equal(j.checks[0].result, "要確認");
  assert.equal(j.overall, "要確認");
  assert.equal(j.issues[0].type, "その他");
  assert.ok(j.corrections.length >= 2);
});

test("確信度は 0〜1 に収め、最低値を記録する", () => {
  const j = finalize(raw({ checks: [{ item: "色", result: "OK", confidence: 1.7, reason: "", evidence: [] }, { item: "数量", result: "OK", confidence: 0.6, reason: "", evidence: [] }] }) as never);
  assert.equal(j.checks[0].confidence, 1);
  assert.equal(j.min_confidence, 0.6);
});

test("並走運用中は OK でも人の確認に回る", () => {
  const d = decideRouting(finalize(raw() as never), 1000, { ...defaultSettings(), shadow_mode: true });
  assert.equal(d.routing, "human_review");
});

test("並走運用OFF・高確信度・高額でない OK だけが自動OKになる", () => {
  const settings = { ...defaultSettings(), shadow_mode: false };
  assert.equal(decideRouting(finalize(raw() as never), 1000, settings).routing, "auto_ok");
  assert.equal(decideRouting(finalize(raw() as never), 80000, settings).routing, "human_review", "高額品");
  const low = finalize(raw({ checks: [{ item: "色", result: "OK", confidence: 0.7, reason: "", evidence: [] }] }) as never);
  assert.equal(decideRouting(low, 1000, settings).routing, "human_review", "低い確信度");
});

test("返信本文のキーワードで指示を読み取り、曖昧なら判断できないにする（デモ）", () => {
  assert.equal(classifyReplyDemo("お手数ですが返品してください").instruction, "return");
  assert.equal(classifyReplyDemo("そのまま出荷してください").instruction, "ship_as_is");
  assert.equal(classifyReplyDemo("返品か廃棄か迷っています").instruction, "unclear");
});

test("返信用URLが本文になければ追記される", () => {
  const body = fillPlaceholders("本文のみ", "http://x/reply/abc", "2026年9月30日");
  assert.ok(body.includes("http://x/reply/abc"));
});

test("WMSの画面更新（v2）で変わった要素のセレクターを推定できる（デモの簡易推定）", () => {
  const shipment = {
    id: "N-1",
    customer: { id: "C-1", name: "テスト", email: "t@example.com" },
    category: "トレカ",
    declared_value: 1000,
    status: "入荷済み（検品待ち）",
    created_at: "",
    items: [{ name: "カード", qty: 1, color: "", size: "", note: "" }],
    customer_photos: ["customer/a.jpg"],
    evidence_photos: [],
    inspection: null,
    history: [],
  };
  const html = views.topPage("v2") + views.shipmentPage("v2", shipment);
  const keys = ["scan_input", "scan_submit", "result_select", "note_input", "register_button", "status_select", "status_button", "evidence_input", "evidence_button", "customer_photos", "status"];
  const fix = proposeSelectorFixDemo(keys.map((k) => ({ operation: "t", step: "t", selectorKey: k, selector: "", message: "" })), html);
  const got = Object.fromEntries(fix.fixes.map((f) => [f.key, f.selector]));
  assert.equal(got.scan_input, "#barcode-input");
  assert.equal(got.result_select, "#result-select");
  assert.equal(got.note_input, "#result-memo");
  assert.equal(got.register_button, 'button[data-action="register-result"]');
  assert.equal(got.status_select, "#next-status");
  assert.equal(got.customer_photos, "img.photo--customer");
  assert.equal(got.status, "#status-label");
});
