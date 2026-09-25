import { config } from "../config.ts";
import { type EvidenceFile, type InspectionResult, type WmsAdapter, WmsError, type WmsLookup, type WmsShipment } from "./types.ts";

interface ApiShipment {
  id: string;
  customer: { id: string; name: string; email: string };
  category: string;
  declared_value: number;
  status: string;
  items: Array<{ name: string; qty: number; color: string; size: string; note: string }>;
  customer_photos: Array<{ url: string }>;
  evidence_photos: Array<{ url: string }>;
  inspection: WmsShipment["inspection"];
}

/** Connects through the WMS REST API (the target once the WMS has been extended). */
export class ApiWmsAdapter implements WmsAdapter {
  readonly mode = "api" as const;
  constructor(
    private readonly baseUrl = config.wms.baseUrl.replace(/\/$/, ""),
    private readonly apiKey = config.wms.apiKey,
  ) {}

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api${pathname}`, {
        ...init,
        headers: { "X-WMS-API-Key": this.apiKey, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new WmsError(`WMSに接続できません（${this.baseUrl}）: ${(e as Error).message}`, "unavailable");
    }
    if (res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const msg = body.error ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new WmsError(`WMSのAPIキーが正しくありません: ${msg}`, "auth");
    if (res.status === 404) throw new WmsError(msg, "not_found");
    if (res.status === 400) throw new WmsError(msg, "invalid");
    throw new WmsError(`WMSのエラー: ${msg}`, "unavailable");
  }

  private json(body: unknown): RequestInit {
    return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  async lookup(code: string): Promise<WmsLookup> {
    const data = (await (await this.request(`/lookup?code=${encodeURIComponent(code)}`)).json()) as Omit<WmsLookup, "code">;
    return { code, ...data };
  }

  async getShipment(id: string): Promise<WmsShipment> {
    const s = (await (await this.request(`/shipments/${encodeURIComponent(id)}`)).json()) as ApiShipment;
    return {
      id: s.id,
      customer: s.customer,
      category: s.category,
      declaredValue: s.declared_value,
      status: s.status,
      items: s.items,
      customerPhotoUrls: s.customer_photos.map((p) => p.url),
      evidencePhotoUrls: s.evidence_photos.map((p) => p.url),
      inspection: s.inspection,
    };
  }

  async downloadPhoto(url: string): Promise<Buffer> {
    const res = await fetch(url, { headers: { "X-WMS-API-Key": this.apiKey }, signal: AbortSignal.timeout(20000) }).catch((e) => {
      throw new WmsError(`写真を取得できません: ${(e as Error).message}`, "unavailable");
    });
    if (!res.ok) throw new WmsError(`写真を取得できません（HTTP ${res.status}）`, "unavailable");
    return Buffer.from(await res.arrayBuffer());
  }

  async uploadEvidence(id: string, files: EvidenceFile[]): Promise<void> {
    const form = new FormData();
    for (const f of files) form.append("files", new Blob([new Uint8Array(f.buffer)], { type: f.mime }), f.name);
    await this.request(`/shipments/${encodeURIComponent(id)}/evidence`, { method: "POST", body: form });
  }

  async registerInspection(id: string, result: InspectionResult, note: string, inspector: string): Promise<void> {
    await this.request(`/shipments/${encodeURIComponent(id)}/inspection`, this.json({ result, note, inspector }));
  }

  async updateStatus(id: string, status: string, note: string): Promise<void> {
    await this.request(`/shipments/${encodeURIComponent(id)}/status`, this.json({ status, note }));
  }

  async health() {
    try {
      const data = (await (await this.request("/health")).json()) as { name?: string };
      return { ok: true, detail: `API接続OK（${data.name ?? "WMS"}）` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
