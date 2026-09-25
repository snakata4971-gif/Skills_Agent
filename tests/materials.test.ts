import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeDocx, makeHeic, makePptx, makeVideo, makeXlsx, pngBytes, shiftJisCsv } from "./fixtures.ts";
import { prepareEnv } from "./setup.ts";

const env = prepareEnv();
const { processUpload, readMaterialText, MaterialError } = await import("../src/materials.ts");

const work = path.join(env.tmp, "work");
const out = path.join(env.tmp, "materials");
fs.mkdirSync(work, { recursive: true });
let seq = 0;

/** processUpload moves its source, so each call gets a fresh copy. */
async function upload(file: string, name = path.basename(file), mime = "application/octet-stream") {
  const src = path.join(work, `upload-${++seq}`);
  fs.copyFileSync(file, src);
  return processUpload({ dir: out, id: `m${seq}`, name, mime, src });
}

test("Word: 本文・箇条書き・タブ・表・図を取り出す", async () => {
  const m = await upload(await makeDocx(path.join(work, "手順書.docx")));
  assert.equal(m.kind, "document");
  assert.equal(m.format, "docx");
  const text = readMaterialText(m);
  assert.match(text, /スニーカー検品の手順/);
  assert.match(text, /^- ソールの黒ずみは5mm未満ならOK$/m);
  assert.match(text, /タブの前\tタブの後 & 記号/);
  assert.match(text, /\| 確認項目 \| 基準 \|/);
  assert.match(text, /\| サイズ \| タグのcm表記 \|/);
  assert.equal(m.images?.length, 1);
  assert.equal(m.images?.[0].label, "文書内の図1");
  assert.ok(m.preview && fs.existsSync(m.preview));
});

test("PowerPoint: 表示順のスライド・発表者ノート・スライドの画像を取り出す", async () => {
  const m = await upload(await makePptx(path.join(work, "研修資料.pptx")));
  const text = readMaterialText(m);
  assert.equal(m.units, 2);
  assert.ok(text.indexOf("1枚目: 開梱と撮影") < text.indexOf("2枚目: 付属品の確認"), "ファイル番号ではなく表示順");
  assert.match(text, /## スライド1\n1枚目: 開梱と撮影\n箱の角4か所を撮る\n\[発表者ノート\]\nベテランのコツ: 角は光に当てて確認/);
  assert.doesNotMatch(text, /^1$/m, "ノートのスライド番号は除く");
  assert.equal(m.images?.[0].label, "スライド1の画像");
});

test("Excel: シートを行ごとのタブ区切りにする（共有文字列・数値・インライン文字列・空の列）", async () => {
  const m = await upload(makeXlsx(path.join(work, "チェック表.xlsx")));
  const text = readMaterialText(m);
  assert.equal(m.units, 1);
  assert.match(text, /## シート「検品手順」\n工程\t確認内容\n1\t箱の角のつぶれ\t\t要確認/);
});

test("Shift_JIS の CSV も文字化けせずに読める", async () => {
  const m = await upload(shiftJisCsv(path.join(work, "基準.csv")), "基準.csv", "text/csv");
  assert.equal(m.kind, "text");
  assert.equal(readMaterialText(m).trim(), "工程,基準\n箱,つぶれはNG");
});

test("写真は向きを直した JPEG のプレビューを作る", async () => {
  const png = path.join(work, "pop.png");
  fs.writeFileSync(png, await pngBytes());
  const m = await upload(png, "POP.png", "image/png");
  assert.equal(m.kind, "image");
  assert.ok(m.preview?.endsWith(".jpg") && fs.existsSync(m.preview));
});

test("iPhone の HEIC 写真を JPEG に変換する", async (t) => {
  const heic = await makeHeic(path.join(work, "IMG_0001.HEIC"));
  if (!heic) return t.skip("HEIC を作れない環境（macOS の sips が必要）");
  const m = await upload(heic, "IMG_0001.HEIC", "image/heic");
  assert.equal(m.kind, "image");
  assert.ok(m.preview && fs.existsSync(m.preview));
  const { format } = await (await import("sharp")).default(m.preview).metadata();
  assert.equal(format, "jpeg");
});

test("作業動画から、最初のコマと場面が変わったところを時刻付きで切り出す", async (t) => {
  const video = makeVideo(path.join(work, "作業動画.mp4"));
  if (!video) return t.skip("ffmpeg がない環境");
  const m = await upload(video, "作業動画.mp4", "video/mp4");
  assert.equal(m.kind, "video");
  assert.ok(Math.abs((m.duration ?? 0) - 6) < 0.5, `長さ ${m.duration}`);
  const times = (m.frames ?? []).map((f) => f.t);
  assert.equal(times[0], 0);
  assert.ok(times.some((t) => Math.abs(t - 2) < 0.3), `2秒の場面の変化（赤→青）: ${times.join(", ")}`);
  assert.ok(times.some((t) => Math.abs(t - 4) < 0.3), `4秒の場面の変化（青→緑）: ${times.join(", ")}`);
  assert.ok(times.length >= 4, "変わり目が少ない動画は等間隔のコマで補う");
  assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]), "時系列順");
  assert.ok((m.frames ?? []).every((f) => fs.existsSync(f.file)));
});

test("PDF はページ数を数えて、そのまま渡す", async () => {
  const pdf = path.join(work, "manual.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
  const m = await upload(pdf, "manual.pdf", "application/pdf");
  assert.equal(m.kind, "pdf");
  assert.equal(m.units, 1);
});

test("読めない形式は理由つきで断る（元ファイルは残さない）", async () => {
  const doc = path.join(work, "古い手順書.doc");
  fs.writeFileSync(doc, "legacy");
  await assert.rejects(upload(doc), (e: unknown) => e instanceof MaterialError && /\.docx/.test(e.message));
  const broken = path.join(work, "壊れた.docx");
  fs.writeFileSync(broken, "not a zip");
  await assert.rejects(upload(broken), (e: unknown) => e instanceof MaterialError && /開けませんでした/.test(e.message));
  const exe = path.join(work, "tool.exe");
  fs.writeFileSync(exe, "x");
  await assert.rejects(upload(exe), (e: unknown) => e instanceof MaterialError && /読み込めません/.test(e.message));
  assert.ok(!fs.readdirSync(out).some((f) => f.endsWith(".exe") || f.endsWith(".doc")));
});
