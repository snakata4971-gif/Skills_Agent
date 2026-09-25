import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { prepareEnv } from "./setup.ts";

prepareEnv();
const format = await import("../src/skills/format.ts");
const library = await import("../src/skills/library.ts");
const { resolveInspectionSkills } = await import("../src/skills/resolver.ts");
const { config } = await import("../src/config.ts");

library.seedSkillsFromDisk(config.paths.seedSkills);

const minimal = (name: string, layer = "category", extra = "") => `---
name: ${name}
description: テスト用のスキルです。検品の基準を書きます。
metadata:
  layer: ${layer}
  version: 1.0.0
  applies_to:
    categories: ["テスト"]${extra}
---
# テスト用スキル

## 撮影指示
- 正面
- 1. 背面

## 判定項目と基準
- 違えば NG
`;

test("SKILL.md の frontmatter と撮影指示を読み取れる", () => {
  const info = format.parseSkill(minimal("test-skill"));
  assert.equal(info.name, "test-skill");
  assert.equal(info.layer, "category");
  assert.equal(info.title, "テスト用スキル");
  assert.deepEqual(info.appliesTo.categories, ["テスト"]);
  assert.deepEqual(format.extractPhotoInstructions(info.body), ["正面", "1. 背面"]);
});

test("形式の誤りは日本語のエラーになる", () => {
  assert.throws(() => format.parseSkill("# frontmatterなし"), /frontmatter/);
  assert.throws(() => format.parseSkill(minimal("Bad Name")), /name は半角英小文字/);
  assert.throws(() => format.parseSkill(minimal("x", "unknown")), /metadata.layer/);
});

test("版番号の書き換えは他の設定を保つ", () => {
  const out = format.withVersion(minimal("test-skill"), "1.4.0");
  const info = format.parseSkill(out);
  assert.equal(info.version, "1.4.0");
  assert.deepEqual(info.appliesTo.categories, ["テスト"]);
});

test("操作スキルのセレクター表を読み書きできる", () => {
  const seed = fs.readFileSync(path.join(config.paths.seedSkills, "operation/wms-browser-operation/SKILL.md"), "utf8");
  const selectors = format.extractJsonBlock(seed)!;
  assert.equal(selectors.scan_input, "#scan-code");
  const updated = format.replaceJsonBlock(seed, { ...selectors, scan_input: "#barcode-input" });
  assert.equal(format.extractJsonBlock(updated)!.scan_input, "#barcode-input");
});

test("初期スキルがすべて承認済みで登録される", () => {
  const all = library.listSkills();
  assert.equal(all.length, 11);
  assert.ok(all.every((s) => s.currentVersion === "1.0.0"));
  assert.ok(fs.existsSync(path.join(config.paths.skills, "category/toys/SKILL.md")), "承認済みのスキルは skills/ に書き出される");
});

test("下書き → 承認で版が上がり、前の版は過去の版になる", () => {
  const before = library.getApprovedVersion("category/toys")!;
  const draft = library.createDraft("category/toys", before.content.replace("# おもちゃ・ホビー検品", "# おもちゃ・ホビー検品\n\n追記"), {
    source: "manual",
    createdBy: "テスト",
    changeNote: "追記",
  });
  assert.equal(draft.version, "1.1.0");
  assert.equal(library.getApprovedVersion("category/toys")!.id, before.id, "承認前は前の版が使われる");
  library.approveVersion(draft.id, "承認者");
  assert.equal(library.getApprovedVersion("category/toys")!.version, "1.1.0");
  assert.equal(library.getVersion(before.id)!.status, "superseded");
  const diff = library.diffVersions(before.id, draft.id);
  assert.ok(diff.some((l) => l.type === "add" && l.text === "追記"));
});

test("前の版に戻すと新しい版として公開される", () => {
  const v1 = library.getSkill("category/toys")!.versions.find((v) => v.version === "1.0.0")!;
  const rolled = library.rollbackTo("category/toys", v1.id, "テスト");
  assert.equal(rolled.version, "1.2.0");
  assert.equal(rolled.status, "approved");
  assert.equal(library.getApprovedVersion("category/toys")!.content.includes("追記"), false);
});

test("name・layer を変える下書きは拒否される", () => {
  const content = library.getApprovedVersion("category/toys")!.content.replace("name: toys", "name: toys2");
  assert.throws(() => library.createDraft("category/toys", content, { source: "manual", createdBy: "t", changeNote: "" }), /変更できません/);
});

test("スキャンのキーでスキルが確定的に選ばれる（共通 → カテゴリ → 顧客）", async () => {
  const r = await resolveInspectionSkills({ customerId: "C-1002", category: "おもちゃ", itemNames: ["ROBO"] }, { allowAi: false });
  assert.equal(r.method, "key");
  assert.deepEqual(
    r.skills.map((s) => s.id),
    ["common/basic-inspection", "category/toys", "customer/c-1002-hobby-shop"],
  );
});

test("カテゴリの別名でも同じスキルが選ばれる", async () => {
  const r = await resolveInspectionSkills({ customerId: "C-9", category: "トレーディングカード", itemNames: [] }, { allowAi: false });
  assert.ok(r.skills.some((s) => s.id === "category/trading-cards"));
});

test("専用スキルがないカテゴリは共通スキルだけになり、作成依頼の対象になる", async () => {
  const r = await resolveInspectionSkills({ customerId: "C-1008", category: "スニーカー", itemNames: ["ランニングシューズ"] }, { allowAi: false });
  assert.equal(r.method, "common-only");
  assert.equal(r.missingCategory, true);
  assert.deepEqual(r.skills.map((s) => s.id), ["common/basic-inspection"]);
});

test("カテゴリが一致しなくても品名のキーワードで近いスキルを選べる", async () => {
  const r = await resolveInspectionSkills({ customerId: "C-9", category: "雑貨", itemNames: ["フィギュア 限定版"] }, { allowAi: false });
  assert.equal(r.method, "keyword");
  assert.ok(r.skills.some((s) => s.id === "category/toys"));
});
