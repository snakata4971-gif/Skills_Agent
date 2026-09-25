import fs from "node:fs";
import heicConvert from "heic-convert";
import sharp from "sharp";
import type { ContentBlock } from "./client.ts";

/**
 * Loads a photo for the model: fixes EXIF rotation and shrinks the long edge to `maxPx`
 * (image tokens scale with pixel count, so this is the main cost lever for 4,000 items/day).
 */
export async function imageBlock(filePath: string, maxPx: number): Promise<ContentBlock> {
  const data = await sharp(fs.readFileSync(filePath))
    .rotate()
    .resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } };
}

export function pdfBlock(filePath: string, title: string): ContentBlock {
  return {
    type: "document",
    title,
    source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(filePath).toString("base64") },
  };
}

const isHeic = (buf: Buffer) => /^....ftyp(heic|heix|hevc|hevx|mif1|msf1)/.test(buf.subarray(0, 12).toString("latin1"));

/**
 * Accepts photos as they come off phones and cameras: JPEG/PNG/WebP are kept as-is (so demo
 * sample hashes still match), HEIC from iPhones and other formats are converted to JPEG.
 */
export async function normalizeUpload(buffer: Buffer): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  if (isHeic(buffer)) {
    const jpeg = Buffer.from(await heicConvert({ buffer, format: "JPEG", quality: 0.9 }));
    return { buffer: jpeg, mime: "image/jpeg", ext: "jpg" };
  }
  const meta = await sharp(buffer).metadata();
  if (meta.format === "jpeg" || meta.format === "png" || meta.format === "webp") {
    return { buffer, mime: `image/${meta.format}`, ext: meta.format === "jpeg" ? "jpg" : meta.format };
  }
  const converted = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
  return { buffer: converted, mime: "image/jpeg", ext: "jpg" };
}
