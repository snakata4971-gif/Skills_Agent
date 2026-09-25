/**
 * Fallback connection for a WMS without an API: drives the WMS web screens with a script.
 * Element selectors and steps come from the operation skill, so when the WMS screen changes,
 * fixing the skill (by hand or through the learning loop) repairs the automation.
 */
import fs from "node:fs";
import type { Browser, Locator, Page } from "playwright-core";
import { config } from "../config.ts";
import { insert } from "../db.ts";
import { extractJsonBlock } from "../skills/format.ts";
import { getApprovedVersion } from "../skills/library.ts";
import { nowIso } from "../util.ts";
import { type EvidenceFile, type InspectionResult, type WmsAdapter, WmsError, type WmsLookup, type WmsShipment } from "./types.ts";

export const OPERATION_SKILL_ID = "operation/wms-browser-operation";

type PageKind = "top" | "list" | "shipment";

const PAGE_KEYS: Record<PageKind, string[]> = {
  top: ["scan_input", "scan_submit"],
  list: ["shipment_link"],
  shipment: [
    "shipment_id",
    "customer_id",
    "customer_name",
    "category",
    "declared_value",
    "status",
    "item_rows",
    "result_select",
    "note_input",
    "register_button",
    "status_select",
    "status_button",
    "evidence_input",
    "evidence_button",
  ],
};

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      let pw: typeof import("playwright-core");
      try {
        pw = await import("playwright-core");
      } catch {
        throw new WmsError("ブラウザ自動操作には playwright-core が必要です（npm install を実行してください）", "unavailable");
      }
      const executablePath = config.wms.chromePath || undefined;
      if (executablePath && !fs.existsSync(executablePath)) {
        throw new WmsError(`CHROME_PATH のChromeが見つかりません: ${executablePath}`, "unavailable");
      }
      try {
        return await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
      } catch (e) {
        throw new WmsError(`Chromeを起動できません。Google Chromeをインストールするか CHROME_PATH を設定してください（${(e as Error).message.split("\n")[0]}）`, "unavailable");
      }
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => undefined);
}

export interface BrowserAdapterOptions {
  /** Test a draft of the operation skill instead of the approved one. */
  selectors?: Record<string, string>;
  skillVersionId?: number | null;
  recordErrors?: boolean;
}

export class BrowserWmsAdapter implements WmsAdapter {
  readonly mode = "browser" as const;
  private readonly base = config.wms.baseUrl.replace(/\/$/, "");
  private readonly selectors: Record<string, string>;
  private readonly versionId: number | null;
  private readonly recordErrors: boolean;

  constructor(opts: BrowserAdapterOptions = {}) {
    if (opts.selectors) {
      this.selectors = opts.selectors;
      this.versionId = opts.skillVersionId ?? null;
    } else {
      const v = getApprovedVersion(OPERATION_SKILL_ID);
      if (!v) throw new WmsError(`操作スキル ${OPERATION_SKILL_ID} が承認されていません`, "unavailable");
      this.selectors = extractJsonBlock(v.content) ?? {};
      this.versionId = v.id;
    }
    this.recordErrors = opts.recordErrors ?? true;
  }

  private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await getBrowser();
    const context = await browser.newContext({ locale: "ja-JP" });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /** Lists every expected element that is absent on the current page, so one fix can cover them all. */
  private async audit(page: Page, kind: PageKind): Promise<string[]> {
    const missing: string[] = [];
    for (const key of PAGE_KEYS[kind]) {
      const sel = this.selectors[key];
      if (!sel || (await page.locator(sel).count().catch(() => 0)) === 0) missing.push(key);
    }
    if (kind === "shipment") {
      const photoSel = this.selectors.customer_photos;
      const images = await page.locator("img").count();
      if (images > 0 && (!photoSel || (await page.locator(photoSel).count().catch(() => 0)) === 0)) missing.push("customer_photos");
    }
    return missing;
  }

  private async fail(page: Page, op: string, step: string, key: string, kind: PageKind): Promise<never> {
    const selector = this.selectors[key] ?? "";
    const missing = await this.audit(page, kind).catch(() => [key]);
    if (!missing.includes(key)) missing.unshift(key);
    if (this.recordErrors) {
      const html = await page.content().catch(() => "");
      insert("operation_errors", {
        skill_id: OPERATION_SKILL_ID,
        skill_version_id: this.versionId,
        operation: op,
        step,
        selector_key: key,
        selector,
        missing,
        message: `画面の要素「${key}」（${selector || "未定義"}）が見つかりません`,
        page_url: page.url(),
        html_snapshot: html.slice(0, 200_000),
        created_at: nowIso(),
      });
    }
    throw new WmsError(
      `ブラウザ操作に失敗しました: ${step}（要素「${key}」が見つかりません。WMSの画面が変わった可能性があります。学習・改善画面で操作スキルの修正案を作れます）`,
      "operation",
    );
  }

  private async el(page: Page, op: string, step: string, key: string, kind: PageKind): Promise<Locator> {
    const sel = this.selectors[key];
    if (!sel) return this.fail(page, op, step, key, kind);
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "attached", timeout: 4000 });
      return loc;
    } catch {
      return this.fail(page, op, step, key, kind);
    }
  }

  private async text(page: Page, op: string, key: string): Promise<string> {
    return ((await (await this.el(page, op, `「${key}」を読み取る`, key, "shipment")).textContent()) ?? "").trim();
  }

  /** Scans a code on the top screen, as a worker would. Returns the resulting page kind. */
  private async openByScan(page: Page, code: string, op: string): Promise<"shipment" | "list"> {
    await page.goto(`${this.base}/`, { waitUntil: "domcontentloaded" }).catch((e) => {
      throw new WmsError(`WMSの画面を開けません（${this.base}）: ${(e as Error).message}`, "unavailable");
    });
    const input = await this.el(page, op, "スキャン欄に入力する", "scan_input", "top");
    await input.fill(code);
    const submit = await this.el(page, op, "表示ボタンを押す", "scan_submit", "top");
    const navigation = page.waitForResponse(
      (r) => r.request().isNavigationRequest() && ![301, 302, 303, 307, 308].includes(r.status()),
      { timeout: 15000 },
    );
    await submit.click();
    const resp = await navigation;
    await page.waitForLoadState("domcontentloaded");
    if (resp.status() === 404) throw new WmsError(`「${code}」に該当する顧客・納品がありません`, "not_found");
    const idSel = this.selectors.shipment_id;
    if (idSel && (await page.locator(idSel).count()) > 0) return "shipment";
    await this.el(page, op, "納品一覧から対象を開く", "shipment_link", "list");
    return "list";
  }

  private async readShipment(page: Page, op: string): Promise<WmsShipment> {
    const rowsSel = this.selectors.item_rows;
    await this.el(page, op, "申告内容を読み取る", "item_rows", "shipment");
    const cell = async (row: Locator, key: string) => {
      const sel = this.selectors[key];
      if (!sel) return "";
      const loc = row.locator(sel);
      return (await loc.count()) ? ((await loc.first().textContent()) ?? "").trim() : "";
    };
    const items: WmsShipment["items"] = [];
    for (const row of await page.locator(rowsSel).all()) {
      const name = await cell(row, "item_name");
      if (!name) continue;
      items.push({
        name,
        qty: Number.parseInt(await cell(row, "item_qty"), 10) || 1,
        color: await cell(row, "item_color"),
        size: await cell(row, "item_size"),
        note: await cell(row, "item_note"),
      });
    }
    const photoSel = this.selectors.customer_photos;
    let customerPhotoUrls: string[] = [];
    if (photoSel) {
      customerPhotoUrls = await page.locator(photoSel).evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
    }
    if (customerPhotoUrls.length === 0 && (await page.locator("img").count()) > 0) {
      await this.fail(page, op, "顧客写真を読み取る", "customer_photos", "shipment");
    }
    return {
      id: await this.text(page, op, "shipment_id"),
      customer: {
        id: await this.text(page, op, "customer_id"),
        name: await this.text(page, op, "customer_name"),
        email: this.selectors.customer_email && (await page.locator(this.selectors.customer_email).count()) ? await this.text(page, op, "customer_email") : "",
      },
      category: await this.text(page, op, "category"),
      declaredValue: Number.parseInt((await this.text(page, op, "declared_value")).replace(/[^\d]/g, ""), 10) || 0,
      status: await this.text(page, op, "status"),
      items,
      customerPhotoUrls,
      evidencePhotoUrls: [],
      inspection: null,
    };
  }

  async lookup(code: string): Promise<WmsLookup> {
    return this.withPage(async (page) => {
      const kind = await this.openByScan(page, code, "lookup");
      if (kind === "shipment") {
        const s = await this.readShipment(page, "lookup");
        return {
          code,
          customer: s.customer,
          shipments: [{ id: s.id, category: s.category, status: s.status, itemCount: s.items.reduce((n, it) => n + it.qty, 0) }],
        };
      }
      const rows = await page.locator(this.selectors.shipment_link).evaluateAll((links) =>
        links.map((a) => {
          const cells = Array.from(a.closest("tr")?.children ?? []).map((c) => (c.textContent ?? "").trim());
          return { id: (a.textContent ?? "").trim(), href: (a as HTMLAnchorElement).href, category: cells[1] ?? "", itemCount: Number(cells[2]) || 0, status: cells[3] ?? "" };
        }),
      );
      await page.goto(rows[0].href, { waitUntil: "domcontentloaded" });
      const first = await this.readShipment(page, "lookup");
      return { code, customer: first.customer, shipments: rows.map(({ href: _h, ...r }) => r) };
    });
  }

  async getShipment(id: string): Promise<WmsShipment> {
    return this.withPage(async (page) => {
      const kind = await this.openByScan(page, id, "getShipment");
      if (kind !== "shipment") throw new WmsError(`納品 ${id} の画面を開けません`, "not_found");
      return this.readShipment(page, "getShipment");
    });
  }

  async downloadPhoto(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) }).catch((e) => {
      throw new WmsError(`写真を取得できません: ${(e as Error).message}`, "unavailable");
    });
    if (!res.ok) throw new WmsError(`写真を取得できません（HTTP ${res.status}）`, "unavailable");
    return Buffer.from(await res.arrayBuffer());
  }

  private async submitAndConfirm(page: Page, op: string, step: string, key: string) {
    const button = await this.el(page, op, step, key, "shipment");
    await Promise.all([page.waitForLoadState("domcontentloaded"), page.waitForURL(/msg=/, { timeout: 15000 }), button.click()]);
    const flash = this.selectors.flash_message;
    const message = flash && (await page.locator(flash).count()) ? ((await page.locator(flash).first().textContent()) ?? "").trim() : "";
    if (!message) await this.fail(page, op, "完了メッセージを確認する", "flash_message", "shipment");
    if (/選んでください|できません|エラー/.test(message)) throw new WmsError(`WMSが登録を受け付けませんでした: ${message}`, "operation");
  }

  async uploadEvidence(id: string, files: EvidenceFile[]): Promise<void> {
    if (files.length === 0) return;
    await this.withPage(async (page) => {
      await this.openByScan(page, id, "uploadEvidence");
      const input = await this.el(page, "uploadEvidence", "証跡写真を指定する", "evidence_input", "shipment");
      await input.setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.mime, buffer: f.buffer })));
      await this.submitAndConfirm(page, "uploadEvidence", "アップロードボタンを押す", "evidence_button");
    });
  }

  async registerInspection(id: string, result: InspectionResult, note: string, inspector: string): Promise<void> {
    await this.withPage(async (page) => {
      await this.openByScan(page, id, "registerInspection");
      const select = await this.el(page, "registerInspection", "検品結果を選ぶ", "result_select", "shipment");
      await select.selectOption({ label: result });
      const noteInput = await this.el(page, "registerInspection", "メモを入力する", "note_input", "shipment");
      await noteInput.fill(`${note}（${inspector}）`.slice(0, 1900));
      await this.submitAndConfirm(page, "registerInspection", "登録ボタンを押す", "register_button");
    });
  }

  async updateStatus(id: string, status: string, _note: string): Promise<void> {
    await this.withPage(async (page) => {
      await this.openByScan(page, id, "updateStatus");
      const select = await this.el(page, "updateStatus", "ステータスを選ぶ", "status_select", "shipment");
      await select.selectOption({ label: status }).catch(() => {
        throw new WmsError(`WMSのステータスに「${status}」がありません`, "invalid");
      });
      await this.submitAndConfirm(page, "updateStatus", "更新ボタンを押す", "status_button");
    });
  }

  /**
   * Read-only check that the screens still match the skill: the top page, one shipment page and
   * (when the customer has several shipments) the shipment list. Nothing is registered.
   * Returns the HTML of every page with missing elements, for the learning loop to repair.
   */
  async smokeTest(sampleShipmentId: string): Promise<{ ok: boolean; missing: string[]; detail: string; html: string }> {
    return this.withPage(async (page) => {
      const missing: string[] = [];
      const pagesHtml: string[] = [];
      const note = async (kind: PageKind, keys: string[]) => {
        if (!keys.length) return;
        missing.push(...keys.filter((k) => !missing.includes(k)));
        pagesHtml.push(`<!-- 画面: ${kind} (${page.url()}) -->\n${await page.content()}`);
      };
      const result = (detail: string) => ({ ok: missing.length === 0, missing, detail, html: pagesHtml.join("\n\n").slice(0, 200_000) });

      await page.goto(`${this.base}/`, { waitUntil: "domcontentloaded" });
      await note("top", await this.audit(page, "top"));
      if (missing.length) return result("トップ画面の要素が見つかりません");

      let kind: "shipment" | "list";
      try {
        kind = await this.openByScan(page, sampleShipmentId, "smokeTest");
      } catch (e) {
        await note("shipment", await this.audit(page, "shipment"));
        return result((e as Error).message);
      }
      if (kind === "list") {
        const href = await page.locator(this.selectors.shipment_link).first().getAttribute("href");
        if (href) await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded" });
      }
      await note("shipment", await this.audit(page, "shipment"));

      const customerSel = this.selectors.customer_id;
      const customerId = customerSel && (await page.locator(customerSel).count()) ? ((await page.locator(customerSel).first().textContent()) ?? "").trim() : "";
      if (customerId) {
        await page.goto(`${this.base}/`, { waitUntil: "domcontentloaded" });
        try {
          await (await this.el(page, "smokeTest", "スキャン欄に入力する", "scan_input", "top")).fill(customerId);
          const navigation = page.waitForResponse((r) => r.request().isNavigationRequest() && ![301, 302, 303, 307, 308].includes(r.status()), { timeout: 15000 });
          await (await this.el(page, "smokeTest", "表示ボタンを押す", "scan_submit", "top")).click();
          await navigation;
          await page.waitForLoadState("domcontentloaded");
          const idSel = this.selectors.shipment_id;
          const onShipmentPage = idSel ? (await page.locator(idSel).count()) > 0 : false;
          if (!onShipmentPage) await note("list", await this.audit(page, "list"));
        } catch {
          /* the list check is best effort; the shipment page result above stands */
        }
      }
      return missing.length
        ? result(`${missing.length} 個の要素が見つかりません`)
        : result("トップ画面・納品一覧・納品詳細画面のすべての要素が見つかりました");
    });
  }

  async health() {
    try {
      const r = await this.withPage(async (page) => {
        await page.goto(`${this.base}/`, { waitUntil: "domcontentloaded" });
        return this.audit(page, "top");
      });
      return r.length
        ? { ok: false, detail: `WMSの画面は開けましたが、要素 ${r.join(", ")} が見つかりません（操作スキルの修正が必要）` }
        : { ok: true, detail: "ブラウザ自動操作でWMSの画面を開けました" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
