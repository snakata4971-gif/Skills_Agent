import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { makeDocx, makeXlsx } from "./fixtures.ts";
import { client, prepareEnv, waitFor } from "./setup.ts";

const env = prepareEnv();
const { createApp } = await import("../src/app.ts");
const server = createApp().listen(env.port);
await new Promise((resolve) => server.once("listening", resolve));
after(() => server.close());

const worker = client(env.base, "佐藤（検品）");
const manager = client(env.base, "山田（センター長）");
const wmsShipment = async (id: string) =>
  (await fetch(`${env.base}/wms/api/shipments/${id}`, { headers: { "X-WMS-API-Key": "test-key" } })).json() as Promise<any>;

async function judged(shipmentId: string) {
  const insp = await worker("POST", "/api/inspections", { shipmentId });
  await worker("POST", `/api/inspections/${insp.id}/sample-photos`);
  await worker("POST", `/api/inspections/${insp.id}/judge`);
  return waitFor(() => worker("GET", `/api/inspections/${insp.id}`), (v) => v.status === "judged");
}

let caseId = "";

test("検品: スキャン → 写真 → AI判定（デモ） → NGで確定 → WMS登録", async () => {
  const lookup = await worker("GET", "/api/station/lookup?code=C-1001");
  assert.equal(lookup.shipments.length, 2, "顧客IDのスキャンでは納品を選ぶ");

  const insp = await worker("POST", "/api/inspections", { shipmentId: "N-260923-004" });
  assert.deepEqual(insp.skills.map((s: any) => s.id), ["common/basic-inspection", "category/apparel"]);
  assert.equal(insp.photos.filter((p: any) => p.kind === "customer").length, 1, "顧客写真をWMSから取得する");
  assert.ok(insp.photoInstructions.length > 0, "スキルの撮影指示を表示する");
  await assert.rejects(worker("POST", `/api/inspections/${insp.id}/judge`), /現物写真/);

  await worker("POST", `/api/inspections/${insp.id}/sample-photos`);
  await worker("POST", `/api/inspections/${insp.id}/judge`);
  const j = await waitFor(() => worker("GET", `/api/inspections/${insp.id}`), (v) => v.status === "judged");
  assert.equal(j.ai.overall, "NG");
  assert.equal(j.routing, "human_review");

  await assert.rejects(worker("POST", `/api/inspections/${insp.id}/confirm`, { overall: "OK", note: "" }), /理由/);
  const confirmed = await worker("POST", `/api/inspections/${insp.id}/confirm`, { overall: "NG", note: "" });
  assert.ok(confirmed.wms.registeredAt, "WMSに登録される");
  assert.ok(confirmed.caseId, "NGは顧客確認ケースになる");
  caseId = confirmed.caseId;

  const w = await wmsShipment("N-260923-004");
  assert.equal(w.inspection.result, "NG");
  assert.equal(w.evidence_photos.length, 1, "現物写真が証跡としてWMSに保存される");
});

test("顧客確認: 下書き → 送信 → 回答ページ → 承認 → 処理の実行", async () => {
  const draft = await waitFor(() => worker("GET", `/api/cases/${caseId}`), (v) => v.status === "draft_ready");
  assert.match(draft.email_body, /\/reply\//, "返信用URLが入る");
  assert.match(draft.email_subject, /N-260923-004/);
  await worker("POST", `/api/cases/${caseId}/send`);

  const replyPage = await fetch(`${env.base}/reply/${draft.reply_token}`);
  assert.equal(replyPage.status, 200);
  const answer = (choice: string) =>
    fetch(`${env.base}/reply/${draft.reply_token}`, { method: "POST", body: new URLSearchParams({ choice, comment: "" }), redirect: "manual" });
  assert.equal((await answer("dispose")).status, 303);

  let c = await worker("GET", `/api/cases/${caseId}`);
  assert.equal(c.status, "instruction_received");
  assert.equal(c.instruction, "dispose");
  const second = await answer("return");
  assert.match(decodeURIComponent(second.headers.get("location") ?? ""), /すでに受け付けています/, "回答は1回だけ");

  c = await worker("POST", `/api/cases/${caseId}/instruction`, { instruction: "dispose" });
  assert.equal(c.status, "awaiting_approval", "廃棄は承認が必要");
  await assert.rejects(worker("POST", `/api/cases/${caseId}/execute`), /承認待ち/);

  c = await manager("POST", `/api/cases/${caseId}/approve`);
  assert.equal(c.approved_by, "山田（センター長）");
  c = await worker("POST", `/api/cases/${caseId}/execute`);
  assert.equal(c.status, "executed");
  assert.equal(c.wms_status, "廃棄予定");
  assert.match(c.worker_instruction, /廃棄待ちエリア/);
  assert.equal((await wmsShipment("N-260923-004")).status, "廃棄予定");

  c = await worker("POST", `/api/cases/${caseId}/close`);
  assert.equal(c.status, "closed");
});

test("メールで届いた返信を読み取って処理する（デモのキーワード判定）", async () => {
  const j = await judged("N-260923-002");
  assert.equal(j.ai.overall, "NG");
  const confirmed = await worker("POST", `/api/inspections/${j.id}/confirm`, { overall: "NG", note: "" });
  await waitFor(() => worker("GET", `/api/cases/${confirmed.caseId}`), (v) => v.status === "draft_ready");
  await worker("POST", `/api/cases/${confirmed.caseId}/send`);
  let c = await worker("POST", `/api/cases/${confirmed.caseId}/reply-text`, { text: "不足分は追加で送るので、届くまで待ってください。" });
  assert.equal(c.instruction, "wait_missing");
  c = await worker("POST", `/api/cases/${confirmed.caseId}/instruction`, { instruction: "wait_missing" });
  assert.equal(c.status, "ready", "過不足待ちは承認なしで実行できる");
  c = await worker("POST", `/api/cases/${confirmed.caseId}/execute`);
  assert.equal(c.wms_status, "保留（不足品待ち）");
});

test("学習: AIと違う判断 → 改善案 → テスト → 承認でスキルの版が上がる", async () => {
  const j = await judged("N-260923-006");
  assert.ok(j.skills.some((s: any) => s.id === "customer/c-1002-hobby-shop"), "顧客別ルールも適用される");
  await worker("POST", `/api/inspections/${j.id}/confirm`, { overall: "OK", note: "つぶれは輸送用の外箱で、商品の箱は無傷" });

  const cases = await worker("GET", "/api/learning/cases");
  assert.equal(cases[0].kind, "過検出");
  const m = await worker("GET", "/api/learning/metrics");
  assert.equal(m.overall.falseAlarm, 1);
  assert.equal(m.overall.miss, 0);

  const p = await worker("POST", "/api/learning/proposals", { skillId: "category/toys" });
  const proposed = await waitFor(() => worker("GET", `/api/learning/proposals/${p.id}`), (v) => v.status === "proposed");
  assert.ok(proposed.draft.content.includes("商品の箱は無傷"), "人のメモが基準に反映される");
  assert.ok(proposed.diff.some((l: any) => l.type === "add"));
  await assert.rejects(worker("POST", "/api/learning/proposals", { skillId: "category/toys" }), /未処理の改善案/);

  await worker("POST", `/api/learning/proposals/${p.id}/test`);
  const tested = await waitFor(() => worker("GET", `/api/learning/proposals/${p.id}`), (v) => v.status === "tested");
  assert.equal(tested.test_result.skipped, true, "デモモードでは再判定しない");

  await manager("POST", `/api/learning/proposals/${p.id}/approve`);
  const skill = await worker("GET", "/api/skills/category/toys");
  assert.equal(skill.currentVersion, "1.1.0");
});

test("スキルビルダー: 作成依頼 → 下書き → 回答 → 保存 → 承認で検品に使われる", async () => {
  const insp = await worker("POST", "/api/inspections", { shipmentId: "N-260923-008" });
  assert.equal(insp.resolution.missingCategory, true);
  const req = (await worker("GET", "/api/builder/requests")).find((r: any) => r.category === "スニーカー");
  assert.ok(req, "スキルがない商品は作成依頼になる");

  const s = await worker("POST", `/api/builder/requests/${req.id}/session`);
  assert.equal(s.target.name, "sneakers");
  assert.ok(s.materials.length >= 1, "検品の写真が資料として引き継がれる");
  await worker("POST", `/api/builder/sessions/${s.id}/generate`);
  const ready = await waitFor(() => worker("GET", `/api/builder/sessions/${s.id}`), (v) => v.status === "ready");
  assert.equal(ready.validation, null);
  assert.ok(ready.questions.length > 0, "ベテランへの質問が作られる");

  await worker("POST", `/api/builder/sessions/${s.id}/answers`, { answers: { [ready.questions[0].id]: "ソールの黒ずみは5mm未満ならOK" } });
  await waitFor(() => worker("GET", `/api/builder/sessions/${s.id}`), (v) => v.status === "ready" && v.draft.includes("5mm未満"));
  const saved = await worker("POST", `/api/builder/sessions/${s.id}/save`);
  assert.equal(saved.skillId, "category/sneakers");

  const before = await worker("POST", `/api/inspections/${insp.id}/reresolve`);
  assert.ok(!before.skills.some((x: any) => x.id === "category/sneakers"), "承認前の下書きは使われない");
  await manager("POST", `/api/skill-versions/${saved.versionId}/approve`);
  const afterApproval = await worker("POST", `/api/inspections/${insp.id}/reresolve`);
  assert.ok(afterApproval.skills.some((x: any) => x.id === "category/sneakers"));
  assert.equal((await worker("GET", "/api/builder/requests")).find((r: any) => r.id === req.id).status, "done");
});

test("スキルビルダー: 資料をまとめてアップロード → 下書き → 名前を決めて保存", async () => {
  const dir = path.join(env.tmp, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const form = new FormData();
  for (const f of [await makeDocx(path.join(dir, "手順書.docx")), makeXlsx(path.join(dir, "チェック表.xlsx"))]) {
    form.append("files", new Blob([fs.readFileSync(f)]), path.basename(f));
  }
  form.append("files", new Blob(["legacy"]), "古い手順書.doc");
  const res = await fetch(`${env.base}/api/builder/quick`, { method: "POST", body: form, headers: { "X-Actor": encodeURIComponent("鈴木") } });
  assert.equal(res.status, 200);
  const { session: s, rejected } = (await res.json()) as any;
  assert.equal(s.materials.length, 2);
  assert.equal(rejected[0].name, "古い手順書.doc", "読めない形式は理由つきで返す");
  assert.ok(s.target.auto, "名前とカテゴリは仮");
  assert.match(s.materials[0].textPreview, /スニーカー検品の手順/);
  assert.equal(s.materials[1].units, 1);

  await worker("PUT", `/api/builder/sessions/${s.id}/materials/${s.materials[0].id}`, { description: "現場の検品手順書" });
  await worker("POST", `/api/builder/sessions/${s.id}/generate`);
  const ready = await waitFor(() => worker("GET", `/api/builder/sessions/${s.id}`), (v) => v.status === "ready");
  assert.match(ready.draft, /## 資料から抜き出した内容/);
  assert.match(ready.draft, /ソールの黒ずみは5mm未満ならOK/, "文書の文章が下書きに入る");
  assert.match(ready.draft, /手順書\.docx（docx・/);

  await assert.rejects(worker("POST", `/api/builder/sessions/${s.id}/save`), /仮のまま/);
  const updated = await worker("PUT", `/api/builder/sessions/${s.id}/target`, { layer: "category", title: "スニーカー検品（手順書版）", name: "sneaker-manual", categories: "スニーカー, 靴" });
  assert.match(updated.draft, /name: sneaker-manual/, "対象を変えると下書きの設定も変わる");
  assert.match(updated.draft, /ソールの黒ずみ/, "本文はそのまま");
  const saved = await worker("POST", `/api/builder/sessions/${s.id}/save`);
  assert.equal(saved.skillId, "category/sneaker-manual");
});

test("設定の不正な値は拒否される", async () => {
  await assert.rejects(worker("PUT", "/api/settings", { auto_ok_threshold: 3 }), /400/);
  const s = await worker("PUT", "/api/settings", { shadow_mode: false });
  assert.equal(s.shadow_mode, false);
});
