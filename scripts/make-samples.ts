/**
 * Generates the synthetic product photos used by the demo (customer uploads and the
 * matching "received" photos a worker would take), plus seed/samples-manifest.json.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { ROOT } from "../src/config.ts";
import { SCENARIOS, type Background, type Drawing } from "../src/seed/scenarios.ts";
import { sha256 } from "../src/util.ts";

const W = 1200;
const H = 900;
const CX = W / 2;
const CY = H / 2;
const JP = "Hiragino Sans, Hiragino Kaku Gothic ProN, Noto Sans JP, sans-serif";
const LATIN = "Helvetica Neue, Helvetica, Arial, sans-serif";

function background(bg: Background): string {
  if (bg === "wood") {
    const stripes = Array.from({ length: 12 }, (_, i) => {
      const y = i * 78 + ((i * 37) % 23);
      const tone = ["#a47148", "#bc8a5f", "#9c6644", "#b5835a"][i % 4];
      return `<rect x="0" y="${y}" width="${W}" height="${30 + (i % 3) * 14}" fill="${tone}" opacity="0.55"/>`;
    }).join("");
    return `<rect width="${W}" height="${H}" fill="#b08968"/>${stripes}`;
  }
  if (bg === "white") {
    return `<rect width="${W}" height="${H}" fill="#f4f1ea"/><ellipse cx="${CX}" cy="${CY + 300}" rx="420" ry="40" fill="#000" opacity="0.06"/>`;
  }
  const ticks = Array.from({ length: 41 }, (_, i) => {
    const x = 100 + i * 25;
    const h = i % 4 === 0 ? 22 : 12;
    return `<line x1="${x}" y1="${H - 40}" x2="${x}" y2="${H - 40 - h}" stroke="#495057" stroke-width="2"/>`;
  }).join("");
  return `<rect width="${W}" height="${H}" fill="#e9ecef"/>
  <rect y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="#dee2e6"/>
  <rect x="90" y="${H - 70}" width="1030" height="40" fill="#f8f9fa" stroke="#adb5bd"/>${ticks}
  <g transform="translate(${W - 230}, 40)">
    <rect width="190" height="70" fill="#fff" stroke="#868e96"/>
    <rect x="10" y="10" width="40" height="40" fill="#ffffff" stroke="#ced4da"/>
    <rect x="55" y="10" width="40" height="40" fill="#adb5bd"/>
    <rect x="100" y="10" width="40" height="40" fill="#212529"/>
    <rect x="145" y="10" width="35" height="40" fill="#c92a2a"/>
    <text x="95" y="64" font-family="${LATIN}" font-size="11" text-anchor="middle" fill="#495057">COLOR REFERENCE</text>
  </g>
  <text x="40" y="60" font-family="Menlo, monospace" font-size="20" fill="#868e96">BOOTH-03  2026/09/23</text>`;
}

function cards(d: Extract<Drawing, { kind: "cards" }>): string {
  const w = 300;
  const h = 420;
  const gap = 40;
  const total = d.count * w + (d.count - 1) * gap;
  const x0 = CX - total / 2;
  const y = CY - h / 2 - 20;
  let out = "";
  for (let i = 0; i < d.count; i++) {
    const x = x0 + i * (w + gap);
    if (d.sleeve) out += `<rect x="${x - 12}" y="${y - 12}" width="${w + 24}" height="${h + 24}" rx="16" fill="#ffffff" opacity="0.45" stroke="#adb5bd" stroke-width="2"/>`;
    out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${d.accent}"/>
      <rect x="${x + 14}" y="${y + 14}" width="${w - 28}" height="${h - 28}" rx="8" fill="#fff8e6"/>
      <text x="${x + 28}" y="${y + 52}" font-family="${LATIN}" font-size="28" font-weight="bold" fill="#212529">${d.name}</text>
      <rect x="${x + 28}" y="${y + 70}" width="${w - 56}" height="200" fill="${d.accent}" opacity="0.28"/>
      <circle cx="${x + w / 2}" cy="${y + 170}" r="62" fill="${d.accent}" opacity="0.85"/>
      <polygon points="${x + w / 2 - 40},${y + 205} ${x + w / 2},${y + 120} ${x + w / 2 + 40},${y + 205}" fill="#fff8e6" opacity="0.8"/>
      <rect x="${x + 28}" y="${y + 290}" width="${w - 56}" height="56" fill="#f1e3c3"/>
      <text x="${x + 40}" y="${y + 326}" font-family="${JP}" font-size="18" fill="#495057">わざ: ほのおのいぶき 120</text>
      <text x="${x + 28}" y="${y + 386}" font-family="${LATIN}" font-size="24" fill="#212529">${d.number}</text>
      <rect x="${x + w - 110}" y="${y + 360}" width="82" height="36" rx="6" fill="#212529"/>
      <text x="${x + w - 69}" y="${y + 386}" font-family="${LATIN}" font-size="22" font-weight="bold" text-anchor="middle" fill="#ffd43b">${d.rarity}</text>`;
    if (d.damage) {
      out += `<line x1="${x + w - 130}" y1="${y + 4}" x2="${x + w - 4}" y2="${y + 140}" stroke="#ffffff" stroke-width="5"/>
        <line x1="${x + w - 124}" y1="${y + 4}" x2="${x + w - 4}" y2="${y + 132}" stroke="#495057" stroke-width="2" opacity="0.7"/>
        <rect x="${x + 60}" y="${y + h - 5}" width="22" height="7" fill="#ffffff"/>
        <rect x="${x + 140}" y="${y + h - 5}" width="30" height="7" fill="#ffffff"/>
        <rect x="${x + 220}" y="${y + h - 4}" width="16" height="6" fill="#ffffff"/>`;
    }
  }
  return out;
}

function shirt(d: Extract<Drawing, { kind: "shirt" }>): string {
  const c = { x: CX, y: CY + 20 };
  const body = `M ${c.x - 170},${c.y - 230} L ${c.x - 60},${c.y - 262} Q ${c.x},${c.y - 215} ${c.x + 60},${c.y - 262} L ${c.x + 170},${c.y - 230} L ${c.x + 295},${c.y - 125} L ${c.x + 225},${c.y - 50} L ${c.x + 170},${c.y - 95} L ${c.x + 170},${c.y + 265} L ${c.x - 170},${c.y + 265} L ${c.x - 170},${c.y - 95} L ${c.x - 225},${c.y - 50} L ${c.x - 295},${c.y - 125} Z`;
  const [line1, line2] = d.tag.split(" / ");
  const hood = d.hood
    ? `<ellipse cx="${c.x}" cy="${c.y - 250}" rx="115" ry="62" fill="${d.fill}" stroke="#343a40" stroke-opacity="0.35" stroke-width="3"/>
       <rect x="${c.x - 120}" y="${c.y + 90}" width="240" height="110" rx="20" fill="#000" opacity="0.12"/>`
    : "";
  const logo = d.hood ? "" : `<text x="${c.x}" y="${c.y - 60}" font-family="${LATIN}" font-size="54" font-weight="bold" text-anchor="middle" fill="#ffffff" opacity="0.9">LOGO</text>`;
  return `${hood}<path d="${body}" fill="${d.fill}" stroke="#343a40" stroke-opacity="0.35" stroke-width="3"/>${logo}
    <line x1="${c.x + 150}" y1="${c.y - 215}" x2="${c.x + 250}" y2="${c.y - 330}" stroke="#495057" stroke-width="2"/>
    <g transform="rotate(10 ${c.x + 330} ${c.y - 350})">
      <rect x="${c.x + 245}" y="${c.y - 395}" width="180" height="96" rx="6" fill="#ffffff" stroke="#adb5bd" stroke-width="2"/>
      <text x="${c.x + 335}" y="${c.y - 355}" font-family="${LATIN}" font-size="26" font-weight="bold" text-anchor="middle" fill="#212529">${line1 ?? ""}</text>
      <text x="${c.x + 335}" y="${c.y - 320}" font-family="${LATIN}" font-size="24" text-anchor="middle" fill="#495057">${line2 ?? ""}</text>
    </g>`;
}

function box(d: Extract<Drawing, { kind: "box" }>): string {
  const x = CX - 230;
  const y = CY - 150;
  const fw = 380;
  const fh = 330;
  const top = `${x},${y} ${x + 80},${y - 70} ${x + fw + 80},${y - 70} ${x + fw},${y}`;
  const side = `${x + fw},${y} ${x + fw + 80},${y - 70} ${x + fw + 80},${y + fh - 70} ${x + fw},${y + fh}`;
  let out = `<polygon points="${top}" fill="${d.fill}" opacity="0.75"/>
    <polygon points="${side}" fill="#000" opacity="0.25"/>
    <polygon points="${side}" fill="${d.fill}" opacity="0.6"/>
    <rect x="${x}" y="${y}" width="${fw}" height="${fh}" fill="${d.fill}"/>
    <text x="${x + fw / 2}" y="${y + 62}" font-family="${LATIN}" font-size="38" font-weight="bold" text-anchor="middle" fill="#ffffff">${d.title}</text>
    <rect x="${x + 40}" y="${y + 90}" width="${fw - 80}" height="170" fill="#ffffff" opacity="0.9"/>`;
  if (d.cars) {
    for (let i = 0; i < 4; i++) {
      const cx = x + 80 + i * 75;
      out += `<rect x="${cx}" y="${y + 170}" width="60" height="26" rx="8" fill="${["#c92a2a", "#1971c2", "#f08c00", "#2f9e44"][i]}"/>
        <circle cx="${cx + 14}" cy="${y + 200}" r="9" fill="#212529"/><circle cx="${cx + 46}" cy="${y + 200}" r="9" fill="#212529"/>
        <rect x="${cx + 14}" y="${y + 156}" width="30" height="16" rx="5" fill="#495057" opacity="0.6"/>`;
    }
  } else {
    out += `<rect x="${x + fw / 2 - 40}" y="${y + 105}" width="80" height="60" rx="10" fill="#495057"/>
      <circle cx="${x + fw / 2 - 16}" cy="${y + 133}" r="9" fill="#ffd43b"/><circle cx="${x + fw / 2 + 16}" cy="${y + 133}" r="9" fill="#ffd43b"/>
      <rect x="${x + fw / 2 - 55}" y="${y + 170}" width="110" height="75" rx="10" fill="#868e96"/>`;
  }
  out += `<text x="${x + fw / 2}" y="${y + 300}" font-family="${LATIN}" font-size="28" text-anchor="middle" fill="#ffffff">${d.model}</text>`;
  if (d.sealed) {
    out += `<line x1="${x + 20}" y1="${y + fh - 20}" x2="${x + 150}" y2="${y + 20}" stroke="#ffffff" stroke-width="10" opacity="0.28"/>
      <line x1="${x + 90}" y1="${y + fh - 10}" x2="${x + 230}" y2="${y + 10}" stroke="#ffffff" stroke-width="5" opacity="0.22"/>
      <circle cx="${x + fw - 45}" cy="${y + fh - 45}" r="30" fill="#ffd43b"/>
      <text x="${x + fw - 45}" y="${y + fh - 38}" font-family="${LATIN}" font-size="13" font-weight="bold" text-anchor="middle" fill="#212529">SEALED</text>`;
  }
  if (d.crushed) {
    const bx = x + fw + 80;
    const by = y - 70;
    out += `<polygon points="${bx - 95},${by} ${bx},${by} ${bx},${by + 95} ${bx - 30},${by + 70} ${bx - 55},${by + 30}" fill="#e9ecef"/>
      <polyline points="${bx - 95},${by + 2} ${bx - 70},${by + 22} ${bx - 55},${by + 30} ${bx - 40},${by + 52} ${bx - 30},${by + 70} ${bx - 12},${by + 82} ${bx},${by + 95}" fill="none" stroke="#212529" stroke-width="4"/>
      <polyline points="${bx - 75},${by + 40} ${bx - 58},${by + 58} ${bx - 45},${by + 88}" fill="none" stroke="#343a40" stroke-width="3" opacity="0.8"/>
      <polygon points="${bx - 55},${by + 30} ${bx - 30},${by + 70} ${bx - 120},${by + 120}" fill="#000" opacity="0.22"/>`;
  }
  return out;
}

function sneakers(d: Extract<Drawing, { kind: "sneakers" }>): string {
  const shoe = (x: number, y: number, stain: boolean) => `
    <rect x="${x}" y="${y + 92}" width="370" height="40" rx="20" fill="#dee2e6" stroke="#868e96" stroke-width="2"/>
    <path d="M ${x + 12},${y + 94} L ${x + 12},${y + 22} Q ${x + 22},${y - 10} ${x + 85},${y - 4} L ${x + 175},${y + 12} Q ${x + 265},${y + 30} ${x + 345},${y + 62} Q ${x + 372},${y + 78} ${x + 356},${y + 94} Z" fill="${d.fill}" stroke="#868e96" stroke-width="3"/>
    <path d="M ${x + 60},${y + 80} Q ${x + 170},${y + 40} ${x + 290},${y + 70}" fill="none" stroke="#adb5bd" stroke-width="10"/>
    ${[0, 1, 2, 3].map((i) => `<line x1="${x + 120 + i * 24}" y1="${y + 8 + i * 5}" x2="${x + 140 + i * 24}" y2="${y + 30 + i * 5}" stroke="#495057" stroke-width="3"/>`).join("")}
    ${stain ? `<ellipse cx="${x + 110}" cy="${y + 118}" rx="36" ry="9" fill="#8d6e63" opacity="0.55"/><ellipse cx="${x + 250}" cy="${y + 121}" rx="22" ry="6" fill="#8d6e63" opacity="0.45"/>` : ""}`;
  return shoe(CX - 390, CY - 150, false) + shoe(CX - 20, CY + 30, Boolean(d.soleStain));
}

function render(d: Drawing): string {
  const inner = d.kind === "cards" ? cards(d) : d.kind === "shirt" ? shirt(d) : d.kind === "box" ? box(d) : sneakers(d);
  const tilt = d.background === "booth" ? 0 : d.background === "wood" ? -4 : 3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${background(d.background)}
    <g transform="rotate(${tilt} ${CX} ${CY})">${inner}</g>
  </svg>`;
}

async function main() {
  const customerDir = path.join(ROOT, "seed", "images", "customer");
  const receivedRoot = path.join(ROOT, "samples", "現物写真");
  fs.rmSync(customerDir, { recursive: true, force: true });
  fs.rmSync(receivedRoot, { recursive: true, force: true });
  fs.mkdirSync(customerDir, { recursive: true });

  const manifest: {
    images: Record<string, { scenario: string; role: "customer" | "received"; file: string }>;
    scenarios: Record<string, { title: string; judgment: unknown }>;
  } = { images: {}, scenarios: {} };

  for (const s of SCENARIOS) {
    manifest.scenarios[s.shipmentId] = { title: s.title, judgment: s.demo };
    for (const [i, d] of s.customerImages.entries()) {
      const buf = await sharp(Buffer.from(render(d))).jpeg({ quality: 88 }).toBuffer();
      const file = path.join(customerDir, `${s.shipmentId}-${i + 1}.jpg`);
      fs.writeFileSync(file, buf);
      manifest.images[sha256(buf)] = { scenario: s.shipmentId, role: "customer", file: path.relative(ROOT, file) };
    }
    const dir = path.join(receivedRoot, s.shipmentId);
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, d] of s.receivedImages.entries()) {
      const buf = await sharp(Buffer.from(render(d))).jpeg({ quality: 88 }).toBuffer();
      const file = path.join(dir, `現物-${i + 1}.jpg`);
      fs.writeFileSync(file, buf);
      manifest.images[sha256(buf)] = { scenario: s.shipmentId, role: "received", file: path.relative(ROOT, file) };
    }
  }
  fs.writeFileSync(path.join(ROOT, "seed", "samples-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`サンプル画像を ${Object.keys(manifest.images).length} 枚作成しました`);
}

await main();
