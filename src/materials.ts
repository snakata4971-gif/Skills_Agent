/**
 * Turns uploaded skill-building materials into what the model can read: photos (HEIC included),
 * work videos (frames with timestamps), PDFs, Word / Excel / PowerPoint (text, tables, slide
 * notes and embedded pictures) and plain text / CSV (UTF-8 or Shift_JIS).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import heicConvert from "heic-convert";
import sharp from "sharp";

const exec = promisify(execFile);

export type MaterialKind = "image" | "video" | "pdf" | "document" | "text";

export interface Frame {
  file: string;
  t: number;
}

export interface Material {
  id: string;
  kind: MaterialKind;
  format: string;
  name: string;
  file: string;
  size: number;
  description: string;
  /** JPEG shown in the UI and sent to the model (HEIC and other formats are converted). */
  preview?: string;
  /** Extracted text (documents, text files). */
  textFile?: string;
  textChars?: number;
  /** Pictures found inside a document, with where they came from. */
  images?: Array<{ file: string; label: string }>;
  frames?: Frame[];
  duration?: number;
  /** Pages (PDF), slides (PowerPoint) or sheets (Excel). */
  units?: number;
  notes?: string[];
  /** Files API id for large PDFs, reused until it expires. */
  fileId?: string;
  fileIdExpiresAt?: string;
  /** Legacy field from sessions created before frames had timestamps. */
  frames_legacy?: string[];
}

export class MaterialError extends Error {}

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff"];
const HEIC_EXT = [".heic", ".heif"];
const VIDEO_EXT = [".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv", ".wmv", ".mpg", ".mpeg", ".3gp"];
const TEXT_EXT = [".txt", ".md", ".csv", ".tsv", ".json", ".log"];
const OFFICE_EXT = [".docx", ".xlsx", ".pptx"];
const LEGACY_OFFICE = [".doc", ".xls", ".ppt"];

export const ACCEPT_HINT =
  "写真（JPG・PNG・HEIC など）、動画（MP4・MOV など）、PDF、Word（.docx）、Excel（.xlsx）、PowerPoint（.pptx）、テキスト・CSV";

export const MAX_FRAMES = 16;
const MAX_DOC_IMAGES = 24;
const MAX_TEXT_CHARS = 60_000;

export function classify(name: string, mime: string): { kind: MaterialKind; format: string } {
  const ext = path.extname(name).toLowerCase();
  const format = ext.replace(".", "") || mime.split("/")[1] || "bin";
  if (LEGACY_OFFICE.includes(ext)) {
    throw new MaterialError("古い形式（.doc / .xls / .ppt）は読み込めません。Word・Excel・PowerPoint で .docx / .xlsx / .pptx か PDF に保存し直してください");
  }
  if (IMAGE_EXT.includes(ext) || HEIC_EXT.includes(ext) || (mime.startsWith("image/") && !mime.includes("svg"))) return { kind: "image", format };
  if (VIDEO_EXT.includes(ext) || mime.startsWith("video/")) return { kind: "video", format };
  if (ext === ".pdf" || mime === "application/pdf") return { kind: "pdf", format: "pdf" };
  if (OFFICE_EXT.includes(ext)) return { kind: "document", format };
  if (TEXT_EXT.includes(ext) || mime.startsWith("text/")) return { kind: "text", format };
  throw new MaterialError(`この形式（${ext || mime || "不明"}）は読み込めません。対応形式: ${ACCEPT_HINT}`);
}

// ------------------------------------------------------------------ helpers

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ 　]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decodes text files; Excel-made CSVs in Japan are often Shift_JIS rather than UTF-8. */
export function decodeText(buf: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("shift_jis").decode(buf);
  } catch {
    return utf8;
  }
}

async function toJpeg(input: Uint8Array | string, out: string, maxPx = 1600): Promise<string> {
  await sharp(input).rotate().resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(out);
  return out;
}

type Zip = Record<string, Uint8Array>;

function unzip(buf: Uint8Array, what: string): Zip {
  try {
    return unzipSync(buf);
  } catch {
    throw new MaterialError(`${what}ファイルを開けませんでした（壊れているか、パスワードが設定されている可能性があります）`);
  }
}

const zipText = (zip: Zip, name: string) => (zip[name] ? new TextDecoder("utf-8").decode(zip[name]) : "");

/** Relationship id → target path, resolved against the part's folder. */
function relationships(zip: Zip, relsPath: string, baseDir: string): Map<string, { target: string; type: string }> {
  const map = new Map<string, { target: string; type: string }>();
  for (const m of zipText(zip, relsPath).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
    if (!attrs.Id || !attrs.Target || attrs.TargetMode === "External") continue;
    const target = attrs.Target.startsWith("/") ? attrs.Target.slice(1) : path.posix.normalize(path.posix.join(baseDir, attrs.Target));
    map.set(attrs.Id, { target, type: attrs.Type ?? "" });
  }
  return map;
}

async function saveEmbeddedImages(zip: Zip, entries: Array<{ name: string; label: string }>, outDir: string, prefix: string) {
  const images: Array<{ file: string; label: string }> = [];
  const notes: string[] = [];
  let skipped = 0;
  for (const { name, label } of entries) {
    if (images.length >= MAX_DOC_IMAGES) {
      skipped++;
      continue;
    }
    const data = zip[name];
    if (!data || !/\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(name)) continue;
    try {
      const out = path.join(outDir, `${prefix}-img${images.length + 1}.jpg`);
      await toJpeg(data, out, 1280);
      images.push({ file: out, label });
    } catch {
      /* formats sharp cannot read (e.g. BMP) are left out */
    }
  }
  if (skipped) notes.push(`画像が多いため、${MAX_DOC_IMAGES}枚までを使います（${skipped}枚は省略）`);
  return { images, notes };
}

// ------------------------------------------------------------------ Word

function paragraphText(p: string): string {
  const parts: string[] = [];
  for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>/g)) {
    if (m[1] !== undefined) parts.push(decodeXml(m[1]));
    else if (m[0].startsWith("<w:tab")) parts.push("\t");
    else parts.push("\n");
  }
  const text = parts.join("");
  return /<w:numPr>/.test(p) && text.trim() ? `- ${text}` : text;
}

export function docxText(xml: string): string {
  const body = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (tr) => {
    const cells = [...tr.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) =>
      [...c[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0])).join(" ").trim(),
    );
    return `<w:p><w:r><w:t>| ${cells.join(" | ").replaceAll("<", "&lt;")} |</w:t></w:r></w:p>`;
  });
  return tidy([...body.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:p\/>/g)].map((p) => paragraphText(p[0])).join("\n"));
}

async function readDocx(buf: Uint8Array, outDir: string, id: string) {
  const zip = unzip(buf, "Word");
  const xml = zipText(zip, "word/document.xml");
  if (!xml) throw new MaterialError("Word ファイルの本文が見つかりません");
  const rels = relationships(zip, "word/_rels/document.xml.rels", "word");
  const ids = [...xml.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]);
  const entries = [...new Set(ids)].flatMap((rid, i) => {
    const r = rels.get(rid);
    return r ? [{ name: r.target, label: `文書内の図${i + 1}` }] : [];
  });
  const { images, notes } = await saveEmbeddedImages(zip, entries, outDir, id);
  return { text: docxText(xml), images, units: undefined as number | undefined, notes };
}

// ------------------------------------------------------------------ PowerPoint

function drawingText(xml: string): string {
  return tidy(
    [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>|<a:p\/>/g)]
      .map((p) => [...p[0].matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\/>/g)].map((t) => (t[1] !== undefined ? decodeXml(t[1]) : "\n")).join(""))
      .join("\n"),
  );
}

async function readPptx(buf: Uint8Array, outDir: string, id: string) {
  const zip = unzip(buf, "PowerPoint");
  const pres = zipText(zip, "ppt/presentation.xml");
  const presRels = relationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  let slides = [...pres.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => presRels.get(m[1])?.target).filter((t): t is string => Boolean(t));
  if (slides.length === 0) {
    slides = Object.keys(zip)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }
  if (slides.length === 0) throw new MaterialError("PowerPoint のスライドが見つかりません");
  const sections: string[] = [];
  const imageEntries: Array<{ name: string; label: string }> = [];
  for (const [i, slide] of slides.entries()) {
    const n = i + 1;
    const rels = relationships(zip, slide.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels"), "ppt/slides");
    const text = drawingText(zipText(zip, slide));
    const notesTarget = [...rels.values()].find((r) => r.type.endsWith("/notesSlide"))?.target;
    const notes = notesTarget ? drawingText(zipText(zip, notesTarget)).replace(/^\d+$/gm, "").trim() : "";
    sections.push(`## スライド${n}\n${text || "（文字なし）"}${notes ? `\n[発表者ノート]\n${notes}` : ""}`);
    for (const r of rels.values()) {
      if (r.type.endsWith("/image")) imageEntries.push({ name: r.target, label: `スライド${n}の画像` });
    }
  }
  const unique = imageEntries.filter((e, i, arr) => arr.findIndex((x) => x.name === e.name) === i);
  const { images, notes } = await saveEmbeddedImages(zip, unique, outDir, id);
  return { text: sections.join("\n\n"), images, units: slides.length, notes };
}

// ------------------------------------------------------------------ Excel

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

async function readXlsx(buf: Uint8Array, outDir: string, id: string) {
  const zip = unzip(buf, "Excel");
  const shared = [...zipText(zip, "xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join(""),
  );
  const rels = relationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const sheets = [...zipText(zip, "xl/workbook.xml").matchAll(/<sheet\b([^>]*)\/>/g)].map((m) => {
    const name = decodeXml(/name="([^"]*)"/.exec(m[1])?.[1] ?? "シート");
    const rid = /r:id="([^"]*)"/.exec(m[1])?.[1] ?? "";
    return { name, target: rels.get(rid)?.target ?? "" };
  });
  if (sheets.length === 0) throw new MaterialError("Excel のシートが見つかりません");
  const notes: string[] = [];
  const sections: string[] = [];
  const imageEntries: Array<{ name: string; label: string }> = [];
  for (const sheet of sheets) {
    const xml = zipText(zip, sheet.target);
    const rows: string[][] = [];
    let truncated = false;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= 500) {
        truncated = true;
        break;
      }
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const col = ref ? columnIndex(ref) : cells.length;
        if (col > 40) continue;
        const type = /t="(\w+)"/.exec(attrs)?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join("");
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) value = decodeXml(v);
        cells[col] = value.replace(/\s*\n\s*/g, " ");
      }
      const line = Array.from(cells, (x) => x ?? "");
      while (line.length && !line[line.length - 1]) line.pop();
      if (line.length) rows.push(line);
    }
    if (truncated) notes.push(`シート「${sheet.name}」は先頭500行までを使います`);
    sections.push(`## シート「${sheet.name}」\n${rows.map((r) => r.join("\t")).join("\n") || "（空）"}`);
    const drawingRels = relationships(zip, sheet.target.replace(/worksheets\/(sheet\d+\.xml)$/, "worksheets/_rels/$1.rels"), "xl/worksheets");
    for (const d of drawingRels.values()) {
      if (!d.type.endsWith("/drawing")) continue;
      const dRels = relationships(zip, d.target.replace(/drawings\/(drawing\d+\.xml)$/, "drawings/_rels/$1.rels"), "xl/drawings");
      for (const img of dRels.values()) if (img.type.endsWith("/image")) imageEntries.push({ name: img.target, label: `シート「${sheet.name}」の画像` });
    }
  }
  const { images, notes: imgNotes } = await saveEmbeddedImages(zip, imageEntries, outDir, id);
  return { text: sections.join("\n\n"), images, units: sheets.length, notes: [...notes, ...imgNotes] };
}

// ------------------------------------------------------------------ video

async function toolAvailable(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function videoDuration(file: string): Promise<number> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { timeout: 30000 });
  const d = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new MaterialError("動画の長さを読み取れませんでした");
  return d;
}

/**
 * Times where the picture changes a lot. Only keyframes are decoded, at low resolution, so even
 * an hour-long recording is scanned in seconds.
 */
async function sceneChangeTimes(file: string): Promise<number[]> {
  const { stderr } = await exec(
    "ffmpeg",
    ["-hide_banner", "-skip_frame", "nokey", "-i", file, "-an", "-vf", "scale=320:-2,select=gt(scene\\,0.25),showinfo", "-vsync", "vfr", "-f", "null", "-"],
    { timeout: 300000, maxBuffer: 50 * 1024 * 1024 },
  );
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number.parseFloat(m[1])).filter((t) => Number.isFinite(t));
}

async function frameAt(file: string, t: number, out: string): Promise<boolean> {
  try {
    await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", out], { timeout: 60000 });
    return fs.existsSync(out);
  } catch {
    return false;
  }
}

/**
 * Picks the opening frame and the moments where the scene changes (a new step on the bench,
 * a new screen on the terminal); steady shots fall back to evenly spaced frames.
 */
export async function extractVideoFrames(file: string, outDir: string, id: string): Promise<{ frames: Frame[]; duration: number }> {
  if (!(await toolAvailable("ffmpeg")) || !(await toolAvailable("ffprobe"))) {
    throw new MaterialError("動画からコマを切り出すには ffmpeg が必要です。動画の代わりに、作業の場面ごとの写真をアップロードしてください");
  }
  const duration = await videoDuration(file);
  const scenes = (await sceneChangeTimes(file).catch(() => [] as number[])).filter((t) => t > 0.5 && t < duration - 0.2);
  const slots = MAX_FRAMES - 1;
  let times: number[];
  if (scenes.length >= slots) {
    times = Array.from({ length: slots }, (_, i) => scenes[Math.floor((i * scenes.length) / slots)]);
  } else {
    // Keep every scene change (the most informative moments) and fill the gaps with evenly
    // spaced frames, so a steady shot or a long single step is still covered.
    const target = Math.min(slots, Math.max(4, Math.ceil(duration / 8)));
    const minGap = Math.max(0.8, duration / (target * 2));
    times = [...scenes];
    for (let i = 0; i < target && times.length < slots; i++) {
      const t = (duration * (i + 1)) / (target + 1);
      if ([0, ...times].every((x) => Math.abs(x - t) >= minGap - 1e-6)) times.push(t);
    }
    times.sort((a, b) => a - b);
  }
  const frames: Frame[] = [];
  for (const [i, t] of [0, ...times].entries()) {
    const out = path.join(outDir, `${id}-frame${String(i + 1).padStart(2, "0")}.jpg`);
    if (await frameAt(file, t, out)) frames.push({ file: out, t });
  }
  if (frames.length === 0) throw new MaterialError("動画からコマを切り出せませんでした（ファイルが壊れているか、対応していない形式の可能性があります）");
  return { frames, duration };
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ entry point

function countPdfPages(buf: Uint8Array): number | undefined {
  const head = Buffer.from(buf).toString("latin1");
  const n = (head.match(/\/Type\s*\/Page(?!s)\b/g) ?? []).length;
  return n > 0 ? n : undefined;
}

/**
 * Stores and analyses one upload. `src` is the temporary upload path; the original is moved
 * into `dir`, and derived files (previews, frames, extracted text) are written next to it.
 */
export async function processUpload(input: { dir: string; id: string; name: string; mime: string; src: string }): Promise<Material> {
  const { kind, format } = classify(input.name, input.mime);
  fs.mkdirSync(input.dir, { recursive: true });
  const ext = path.extname(input.name).toLowerCase() || `.${format}`;
  const file = path.join(input.dir, `${input.id}${ext}`);
  fs.renameSync(input.src, file);
  const size = fs.statSync(file).size;
  const m: Material = { id: input.id, kind, format, name: input.name, file, size, description: "" };

  try {
    if (kind === "image") {
      const buf = fs.readFileSync(file);
      const source = HEIC_EXT.includes(ext) || /^....ftyp(heic|heix|mif1|msf1)/.test(Buffer.from(buf.subarray(0, 12)).toString("latin1"))
        ? Buffer.from(await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 }))
        : buf;
      m.preview = await toJpeg(source, path.join(input.dir, `${input.id}-preview.jpg`));
    } else if (kind === "video") {
      const { frames, duration } = await extractVideoFrames(file, input.dir, input.id);
      m.frames = frames;
      m.duration = duration;
      m.preview = frames[0]?.file;
      m.notes = ["動画の音声（ナレーション）は読み取れません。説明が必要なことは、この資料の説明欄かメモに書いてください"];
    } else if (kind === "pdf") {
      const buf = fs.readFileSync(file);
      if (Buffer.from(buf.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new MaterialError("PDF ファイルとして読み込めません");
      m.units = countPdfPages(buf);
      if (size > 32 * 1024 * 1024) m.notes = ["大きなPDFのため、AIにはファイルとして別送します（最大500MB）"];
    } else if (kind === "document") {
      const buf = new Uint8Array(fs.readFileSync(file));
      const r = format === "docx" ? await readDocx(buf, input.dir, input.id) : format === "pptx" ? await readPptx(buf, input.dir, input.id) : await readXlsx(buf, input.dir, input.id);
      let text = r.text;
      const notes = [...r.notes];
      if (text.length > MAX_TEXT_CHARS) {
        notes.push(`文章が長いため、先頭${MAX_TEXT_CHARS.toLocaleString("ja-JP")}文字を使います`);
        text = text.slice(0, MAX_TEXT_CHARS);
      }
      if (!text.trim() && r.images.length === 0) throw new MaterialError("文書から文字も画像も読み取れませんでした");
      m.textFile = path.join(input.dir, `${input.id}-text.txt`);
      fs.writeFileSync(m.textFile, text);
      m.textChars = text.length;
      m.images = r.images;
      m.units = r.units;
      if (notes.length) m.notes = notes;
      m.preview = r.images[0]?.file;
    } else {
      let text = decodeText(new Uint8Array(fs.readFileSync(file)));
      if (!text.trim()) throw new MaterialError("テキストが空です");
      if (text.length > MAX_TEXT_CHARS) {
        m.notes = [`文章が長いため、先頭${MAX_TEXT_CHARS.toLocaleString("ja-JP")}文字を使います`];
        text = text.slice(0, MAX_TEXT_CHARS);
      }
      m.textFile = path.join(input.dir, `${input.id}-text.txt`);
      fs.writeFileSync(m.textFile, text);
      m.textChars = text.length;
    }
  } catch (e) {
    fs.rmSync(file, { force: true });
    if (e instanceof MaterialError) throw e;
    throw new MaterialError(`「${input.name}」を読み込めませんでした（${(e as Error).message.split("\n")[0]}）`);
  }
  return m;
}

export function readMaterialText(m: Material): string {
  return m.textFile && fs.existsSync(m.textFile) ? fs.readFileSync(m.textFile, "utf8") : "";
}

/** Removes a material's original and derived files. */
export function deleteMaterialFiles(m: Material) {
  const files = [m.file, m.preview, m.textFile, ...(m.images ?? []).map((i) => i.file), ...(m.frames ?? []).map((f) => f.file)];
  for (const f of files) if (f) fs.rmSync(f, { force: true });
}
