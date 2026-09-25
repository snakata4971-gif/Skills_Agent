/**
 * Data store of the bundled mock WMS. It is deliberately separate from the app database:
 * the app only reaches it through the WMS API or the WMS web screens, like a real WMS.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "../../config.ts";
import { SCENARIOS } from "../../seed/scenarios.ts";
import { nowIso } from "../../util.ts";

const wdb = new DatabaseSync(path.join(config.paths.data, "wms.sqlite"));
wdb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
wdb.exec(`
CREATE TABLE IF NOT EXISTS wms_customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wms_shipments (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  category TEXT NOT NULL,
  declared_value INTEGER NOT NULL,
  status TEXT NOT NULL,
  inspection_result TEXT,
  inspection_note TEXT,
  inspected_at TEXT,
  inspected_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wms_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL,
  name TEXT NOT NULL, qty INTEGER NOT NULL, color TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS wms_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wms_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', via TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wms_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const q = (sql: string, ...p: SQLInputValue[]) => wdb.prepare(sql).all(...p) as Record<string, any>[];
const one = (sql: string, ...p: SQLInputValue[]) => wdb.prepare(sql).get(...p) as Record<string, any> | undefined;
const exec = (sql: string, ...p: SQLInputValue[]) => wdb.prepare(sql).run(...p);

export const filesDir = config.paths.wmsFiles;

export interface MockShipment {
  id: string;
  customer: { id: string; name: string; email: string };
  category: string;
  declared_value: number;
  status: string;
  created_at: string;
  items: Array<{ name: string; qty: number; color: string; size: string; note: string }>;
  customer_photos: string[];
  evidence_photos: string[];
  inspection: { result: string; note: string; at: string; by: string } | null;
  history: Array<{ status: string; note: string; via: string; at: string }>;
}

export function getUiVersion(): "v1" | "v2" {
  return one("SELECT value FROM wms_config WHERE key = 'ui_version'")?.value === "v2" ? "v2" : "v1";
}

export function setUiVersion(v: "v1" | "v2") {
  exec("INSERT INTO wms_config (key, value) VALUES ('ui_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", v);
}

export function getShipment(id: string): MockShipment | undefined {
  const s = one("SELECT * FROM wms_shipments WHERE id = ?", id);
  if (!s) return undefined;
  const c = one("SELECT * FROM wms_customers WHERE id = ?", s.customer_id);
  const photos = q("SELECT * FROM wms_photos WHERE shipment_id = ? ORDER BY id", id);
  return {
    id: s.id,
    customer: { id: s.customer_id, name: c?.name ?? "", email: c?.email ?? "" },
    category: s.category,
    declared_value: s.declared_value,
    status: s.status,
    created_at: s.created_at,
    items: q("SELECT name, qty, color, size, note FROM wms_items WHERE shipment_id = ? ORDER BY id", id) as MockShipment["items"],
    customer_photos: photos.filter((p) => p.kind === "customer").map((p) => p.file),
    evidence_photos: photos.filter((p) => p.kind === "evidence").map((p) => p.file),
    inspection: s.inspection_result
      ? { result: s.inspection_result, note: s.inspection_note ?? "", at: s.inspected_at ?? "", by: s.inspected_by ?? "" }
      : null,
    history: q("SELECT status, note, via, at FROM wms_status_log WHERE shipment_id = ? ORDER BY id DESC", id) as MockShipment["history"],
  };
}

export function lookup(code: string) {
  const trimmed = code.trim();
  const shipment = one("SELECT id, customer_id FROM wms_shipments WHERE upper(id) = upper(?)", trimmed);
  const customerId = shipment?.customer_id ?? one("SELECT id FROM wms_customers WHERE upper(id) = upper(?)", trimmed)?.id;
  if (!customerId) return null;
  const customer = one("SELECT * FROM wms_customers WHERE id = ?", customerId)!;
  const rows = shipment
    ? q("SELECT * FROM wms_shipments WHERE id = ?", shipment.id)
    : q("SELECT * FROM wms_shipments WHERE customer_id = ? ORDER BY created_at DESC, id DESC", customerId);
  return {
    customer: { id: customer.id as string, name: customer.name as string, email: customer.email as string },
    shipments: rows.map((r) => ({
      id: r.id as string,
      category: r.category as string,
      status: r.status as string,
      itemCount: (one("SELECT COALESCE(SUM(qty), 0) AS n FROM wms_items WHERE shipment_id = ?", r.id)?.n as number) ?? 0,
    })),
    exactShipment: shipment?.id as string | undefined,
  };
}

export function listShipments(): Array<Record<string, any>> {
  return q(
    `SELECT s.*, c.name AS customer_name FROM wms_shipments s JOIN wms_customers c ON c.id = s.customer_id ORDER BY s.created_at DESC, s.id DESC`,
  );
}

export function registerInspection(id: string, result: string, note: string, by: string, via: "api" | "web") {
  const status = result === "OK" ? "検品OK" : result === "NG" ? "検品NG（顧客確認中）" : "保留";
  const at = nowIso();
  exec(
    "UPDATE wms_shipments SET inspection_result = ?, inspection_note = ?, inspected_at = ?, inspected_by = ?, status = ? WHERE id = ?",
    result,
    note,
    at,
    by,
    status,
    id,
  );
  exec("INSERT INTO wms_status_log (shipment_id, status, note, via, at) VALUES (?, ?, ?, ?, ?)", id, status, `検品結果 ${result}: ${note}`.slice(0, 500), via, at);
}

export function updateStatus(id: string, status: string, note: string, via: "api" | "web") {
  const at = nowIso();
  exec("UPDATE wms_shipments SET status = ? WHERE id = ?", status, id);
  exec("INSERT INTO wms_status_log (shipment_id, status, note, via, at) VALUES (?, ?, ?, ?, ?)", id, status, note.slice(0, 500), via, at);
}

export function addPhoto(id: string, kind: "customer" | "evidence", buffer: Buffer, ext: string): string {
  const n = (one("SELECT COUNT(*) AS n FROM wms_photos WHERE shipment_id = ? AND kind = ?", id, kind)?.n as number) + 1;
  const rel = `${kind}/${id}-${n}-${Date.now().toString(36)}.${ext}`;
  fs.mkdirSync(path.join(filesDir, kind), { recursive: true });
  fs.writeFileSync(path.join(filesDir, rel), buffer);
  exec("INSERT INTO wms_photos (shipment_id, kind, file, uploaded_at) VALUES (?, ?, ?, ?)", id, kind, rel, nowIso());
  return rel;
}

export function createShipment(input: {
  id: string;
  customer: { id: string; name: string; email: string };
  category: string;
  declaredValue: number;
  items: MockShipment["items"];
}) {
  exec(
    "INSERT INTO wms_customers (id, name, email) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email",
    input.customer.id,
    input.customer.name,
    input.customer.email,
  );
  const at = nowIso();
  exec(
    "INSERT INTO wms_shipments (id, customer_id, category, declared_value, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    input.id,
    input.customer.id,
    input.category,
    input.declaredValue,
    "入荷済み（検品待ち）",
    at,
  );
  for (const it of input.items) {
    exec("INSERT INTO wms_items (shipment_id, name, qty, color, size, note) VALUES (?, ?, ?, ?, ?, ?)", input.id, it.name, it.qty, it.color, it.size, it.note);
  }
  exec("INSERT INTO wms_status_log (shipment_id, status, note, via, at) VALUES (?, ?, ?, ?, ?)", input.id, "入荷済み（検品待ち）", "入荷登録", "web", at);
}

export function nextShipmentId(): string {
  const d = new Date();
  const prefix = `N-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const n = (one("SELECT COUNT(*) AS n FROM wms_shipments WHERE id LIKE ?", `${prefix}-%`)?.n as number) + 1;
  return `${prefix}-${String(n + 100).padStart(3, "0")}`;
}

export function seedMockWms(force = false) {
  const count = one("SELECT COUNT(*) AS n FROM wms_shipments")!.n as number;
  if (count > 0 && !force) return;
  for (const t of ["wms_customers", "wms_shipments", "wms_items", "wms_photos", "wms_status_log"]) exec(`DELETE FROM ${t}`);
  fs.rmSync(filesDir, { recursive: true, force: true });
  fs.mkdirSync(filesDir, { recursive: true });
  setUiVersion("v1");
  const imageDir = path.join(config.paths.seed, "images", "customer");
  for (const s of SCENARIOS) {
    createShipment({ id: s.shipmentId, customer: s.customer, category: s.category, declaredValue: s.declaredValue, items: s.items });
    s.customerImages.forEach((_, i) => {
      const src = path.join(imageDir, `${s.shipmentId}-${i + 1}.jpg`);
      if (fs.existsSync(src)) addPhoto(s.shipmentId, "customer", fs.readFileSync(src), "jpg");
    });
  }
}
