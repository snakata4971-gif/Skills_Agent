export interface WmsItem {
  name: string;
  qty: number;
  color: string;
  size: string;
  note: string;
}

export interface WmsCustomer {
  id: string;
  name: string;
  email: string;
}

export interface WmsShipment {
  id: string;
  customer: WmsCustomer;
  category: string;
  declaredValue: number;
  status: string;
  items: WmsItem[];
  customerPhotoUrls: string[];
  evidencePhotoUrls: string[];
  inspection: { result: string; note: string; at: string; by: string } | null;
}

export interface WmsLookup {
  code: string;
  customer: WmsCustomer | null;
  shipments: Array<{ id: string; category: string; status: string; itemCount: number }>;
}

export type InspectionResult = "OK" | "NG" | "保留";

export interface EvidenceFile {
  name: string;
  buffer: Buffer;
  mime: string;
}

/** What the inspection app needs from a WMS, whichever way it is connected. */
export interface WmsAdapter {
  readonly mode: "api" | "browser";
  lookup(code: string): Promise<WmsLookup>;
  getShipment(id: string): Promise<WmsShipment>;
  downloadPhoto(url: string): Promise<Buffer>;
  uploadEvidence(id: string, files: EvidenceFile[]): Promise<void>;
  registerInspection(id: string, result: InspectionResult, note: string, inspector: string): Promise<void>;
  updateStatus(id: string, status: string, note: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class WmsError extends Error {
  constructor(
    message: string,
    public readonly kind: "not_found" | "unavailable" | "operation" | "auth" | "invalid",
  ) {
    super(message);
  }
}

/** Shipment statuses the mock WMS offers in its dropdown. */
export const WMS_STATUSES = [
  "入荷済み（検品待ち）",
  "検品OK",
  "検品NG（顧客確認中）",
  "保留",
  "保留（不足品待ち）",
  "返品手配中",
  "廃棄予定",
  "検品OK（顧客承諾）",
  "出荷済み",
];
