/**
 * Builds real-format sample materials for tests: Word / Excel / PowerPoint files (as zip
 * packages), a short video with scene changes (needs ffmpeg) and an iPhone-style HEIC photo
 * (needs macOS sips). Helpers return null when the tool is missing so tests can skip.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export async function pngBytes(color = "#d9480f", label = "POP"): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${color}"/><text x="20" y="110" font-size="48" fill="#fff">${label}</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;

export async function makeDocx(file: string) {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="1"/></w:pPr>${run("スニーカー検品の手順")}</w:p>
<w:p>${run("箱を開けたら、左右を並べて側面を撮影する。")}</w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run("ソールの黒ずみは5mm未満ならOK")}</w:p>
<w:p>${run("タブの前")}<w:r><w:tab/></w:r>${run("タブの後 &amp; 記号")}</w:p>
<w:tbl><w:tr><w:tc><w:p>${run("確認項目")}</w:p></w:tc><w:tc><w:p>${run("基準")}</w:p></w:tc></w:tr>
<w:tr><w:tc><w:p>${run("サイズ")}</w:p></w:tc><w:tc><w:p>${run("タグのcm表記")}</w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>
</w:body></w:document>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="${REL}/image" Target="media/image1.png"/></Relationships>`;
  fs.writeFileSync(
    file,
    zipSync({
      "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      "word/document.xml": strToU8(doc),
      "word/_rels/document.xml.rels": strToU8(rels),
      "word/media/image1.png": await pngBytes("#1c7ed6", "図"),
    }),
  );
  return file;
}

const slide = (lines: string[]) =>
  `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${lines
    .map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${l}</a:t></a:r></a:p></p:txBody></p:sp>`)
    .join("")}</p:spTree></p:cSld></p:sld>`;

/** Two slides whose file numbers are the reverse of their order in the deck. */
export async function makePptx(file: string) {
  const pres = `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`;
  const presRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`;
  const slide2Rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`;
  const notes = `<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>ベテランのコツ: 角は光に当てて確認</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  fs.writeFileSync(
    file,
    zipSync({
      "ppt/presentation.xml": strToU8(pres),
      "ppt/_rels/presentation.xml.rels": strToU8(presRels),
      "ppt/slides/slide1.xml": strToU8(slide(["2枚目: 付属品の確認"])),
      "ppt/slides/slide2.xml": strToU8(slide(["1枚目: 開梱と撮影", "箱の角4か所を撮る"])),
      "ppt/slides/_rels/slide2.xml.rels": strToU8(slide2Rels),
      "ppt/notesSlides/notesSlide1.xml": strToU8(notes),
      "ppt/media/image1.png": await pngBytes("#2b8a3e", "箱"),
    }),
  );
  return file;
}

export function makeXlsx(file: string) {
  const wb = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="検品手順" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>工程</t></si><si><t>確認内容</t></si><si><r><t>箱の</t></r><r><t>角のつぶれ</t></r></si></sst>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="D2" t="inlineStr"><is><t>要確認</t></is></c></row>
</sheetData></worksheet>`;
  fs.writeFileSync(
    file,
    zipSync({
      "xl/workbook.xml": strToU8(wb),
      "xl/_rels/workbook.xml.rels": strToU8(wbRels),
      "xl/sharedStrings.xml": strToU8(sst),
      "xl/worksheets/sheet1.xml": strToU8(sheet),
    }),
  );
  return file;
}

function has(cmd: string, args: string[]) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 6-second video: red → blue → green, with frequent keyframes so scene changes are found. */
export function makeVideo(file: string): string | null {
  if (!has("ffmpeg", ["-version"]) || !has("ffprobe", ["-version"])) return null;
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2", "-f", "lavfi", "-i", "color=c=green:s=320x240:d=2",
      "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-r", "10", "-g", "5", "-pix_fmt", "yuv420p", file],
    { stdio: "ignore" },
  );
  return file;
}

/** iPhone-style HEIC photo, made with macOS sips. */
export async function makeHeic(file: string): Promise<string | null> {
  if (process.platform !== "darwin" || !has("sips", ["--version"])) return null;
  const jpg = path.join(path.dirname(file), "heic-source.jpg");
  fs.writeFileSync(jpg, await sharp(await pngBytes("#7048e8", "HEIC")).jpeg().toBuffer());
  try {
    execFileSync("sips", ["-s", "format", "heic", jpg, "--out", file], { stdio: "ignore" });
  } catch {
    return null;
  }
  return fs.existsSync(file) ? file : null;
}

export function shiftJisCsv(file: string): string {
  // "工程,基準\n箱,つぶれはNG\n" encoded in Shift_JIS
  const bytes = [
    0x8d, 0x48, 0x92, 0xf6, 0x2c, 0x8a, 0xee, 0x8f, 0x80, 0x0a, 0x94, 0xa0, 0x2c, 0x82, 0xc2, 0x82, 0xd4, 0x82, 0xea, 0x82, 0xcd, 0x4e, 0x47, 0x0a,
  ];
  fs.writeFileSync(file, Buffer.from(bytes));
  return file;
}
