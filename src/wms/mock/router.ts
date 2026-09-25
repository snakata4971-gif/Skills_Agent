import express, { type Request, type Response } from "express";
import multer from "multer";
import { config } from "../../config.ts";
import { normalizeUpload } from "../../ai/images.ts";
import * as store from "./store.ts";
import * as views from "./views.ts";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 },
  defParamCharset: "utf8",
});

function absolutize(req: Request, rel: string) {
  return `${req.protocol}://${req.get("host")}/wms/files/${rel}`;
}

function apiShipment(req: Request, s: store.MockShipment) {
  return {
    id: s.id,
    customer: s.customer,
    category: s.category,
    declared_value: s.declared_value,
    status: s.status,
    items: s.items,
    customer_photos: s.customer_photos.map((f) => ({ url: absolutize(req, f) })),
    evidence_photos: s.evidence_photos.map((f) => ({ url: absolutize(req, f) })),
    inspection: s.inspection,
  };
}

async function savePhotos(id: string, kind: "customer" | "evidence", files: Express.Multer.File[]) {
  let saved = 0;
  for (const f of files) {
    try {
      const { buffer, ext } = await normalizeUpload(f.buffer);
      store.addPhoto(id, kind, buffer, ext);
      saved++;
    } catch {
      /* skip files that are not images */
    }
  }
  return saved;
}

export function mockWmsRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(express.json());
  r.use("/files", express.static(config.paths.wmsFiles, { fallthrough: false }));

  // ---- Web screens (what a person or the browser-automation adapter sees) ----
  r.get("/", (req, res) => {
    res.send(views.topPage(store.getUiVersion(), String(req.query.msg ?? "") || undefined));
  });

  r.get("/scan", (req, res) => {
    const code = String(req.query.code ?? "").trim();
    const found = code ? store.lookup(code) : null;
    if (!found) {
      res.status(404).send(views.messagePage(store.getUiVersion(), "見つかりません", `「${code}」に該当する顧客・納品はありません。`));
      return;
    }
    if (found.exactShipment) return res.redirect(`/wms/shipments/${encodeURIComponent(found.exactShipment)}`);
    if (found.shipments.length === 1) return res.redirect(`/wms/shipments/${encodeURIComponent(found.shipments[0].id)}`);
    res.send(views.scanListPage(store.getUiVersion(), found));
  });

  r.get("/list", (_req, res) => {
    res.send(views.listPage(store.getUiVersion(), store.listShipments()));
  });

  r.get("/shipments/:id", (req, res) => {
    const s = store.getShipment(req.params.id);
    if (!s) {
      res.status(404).send(views.messagePage(store.getUiVersion(), "見つかりません", `納品 ${req.params.id} はありません。`));
      return;
    }
    res.send(views.shipmentPage(store.getUiVersion(), s, String(req.query.msg ?? "") || undefined));
  });

  const back = (res: Response, id: string, msg: string) => res.redirect(`/wms/shipments/${encodeURIComponent(id)}?msg=${encodeURIComponent(msg)}`);

  r.post("/shipments/:id/inspection", (req, res) => {
    const id = req.params.id;
    const result = String(req.body.result ?? "");
    if (!store.getShipment(id)) return res.status(404).send("not found");
    if (!["OK", "NG", "保留"].includes(result)) return back(res, id, "検品結果を選んでください");
    store.registerInspection(id, result, String(req.body.note ?? ""), String(req.body.by ?? "作業者"), "web");
    back(res, id, `検品結果「${result}」を登録しました`);
  });

  r.post("/shipments/:id/status", (req, res) => {
    const id = req.params.id;
    const status = String(req.body.status ?? "").trim();
    if (!store.getShipment(id)) return res.status(404).send("not found");
    if (!status) return back(res, id, "ステータスを選んでください");
    store.updateStatus(id, status, String(req.body.note ?? req.body.reason ?? ""), "web");
    back(res, id, `ステータスを「${status}」に更新しました`);
  });

  r.post("/shipments/:id/evidence", upload.array("files", 12), async (req, res) => {
    const id = String(req.params.id);
    if (!store.getShipment(id)) return res.status(404).send("not found");
    const n = await savePhotos(id, "evidence", (req.files as Express.Multer.File[]) ?? []);
    back(res, id, `証跡写真を${n}枚アップロードしました`);
  });

  r.post("/shipments/:id/customer-photos", upload.array("files", 12), async (req, res) => {
    const id = String(req.params.id);
    if (!store.getShipment(id)) return res.status(404).send("not found");
    const n = await savePhotos(id, "customer", (req.files as Express.Multer.File[]) ?? []);
    back(res, id, `顧客写真を${n}枚追加しました`);
  });

  r.get("/admin", (req, res) => {
    res.send(views.adminPage(store.getUiVersion(), String(req.query.msg ?? "") || undefined));
  });

  r.post("/admin/ui-version", (req, res) => {
    const v = req.body.version === "v2" ? "v2" : "v1";
    store.setUiVersion(v);
    res.redirect(`/wms/admin?msg=${encodeURIComponent(`画面バージョンを ${v === "v2" ? "2.0" : "1.0"} に切り替えました`)}`);
  });

  r.post("/admin/shipments", upload.array("files", 12), async (req, res) => {
    const b = req.body as Record<string, string>;
    const items = String(b.items ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, qty, color, size, note] = l.split(/[,，]/).map((x) => (x ?? "").trim());
        return { name, qty: Math.max(1, Number.parseInt(qty ?? "1", 10) || 1), color: color ?? "", size: size ?? "", note: note ?? "" };
      })
      .filter((it) => it.name);
    if (!b.customer_id?.trim() || !b.customer_name?.trim() || !b.category?.trim() || items.length === 0) {
      return res.redirect(`/wms/admin?msg=${encodeURIComponent("顧客ID・顧客名・カテゴリ・申告内容を入力してください")}`);
    }
    const id = store.nextShipmentId();
    store.createShipment({
      id,
      customer: { id: b.customer_id.trim(), name: b.customer_name.trim(), email: (b.customer_email ?? "").trim() || `${b.customer_id.trim().toLowerCase()}@example.com` },
      category: b.category.trim(),
      declaredValue: Number.parseInt(String(b.declared_value ?? "0").replace(/[^\d]/g, ""), 10) || 0,
      items,
    });
    await savePhotos(id, "customer", (req.files as Express.Multer.File[]) ?? []);
    res.redirect(`/wms/shipments/${encodeURIComponent(id)}?msg=${encodeURIComponent("入荷を登録しました")}`);
  });

  // ---- REST API (what the inspection app uses when the WMS offers an API) ----
  const api = express.Router();
  api.use((req, res, next) => {
    if (req.get("X-WMS-API-Key") !== config.wms.apiKey) {
      res.status(401).json({ error: "APIキーが正しくありません" });
      return;
    }
    next();
  });
  api.get("/health", (_req, res) => {
    res.json({ ok: true, name: "LogiWMS mock", ui_version: store.getUiVersion() });
  });
  api.get("/lookup", (req, res) => {
    const found = store.lookup(String(req.query.code ?? ""));
    if (!found) return res.status(404).json({ error: "該当する顧客・納品がありません" });
    res.json({ customer: found.customer, shipments: found.shipments });
  });
  api.get("/shipments/:id", (req, res) => {
    const s = store.getShipment(req.params.id);
    if (!s) return res.status(404).json({ error: "納品が見つかりません" });
    res.json(apiShipment(req, s));
  });
  api.post("/shipments/:id/inspection", (req, res) => {
    const s = store.getShipment(req.params.id);
    if (!s) return res.status(404).json({ error: "納品が見つかりません" });
    const result = String(req.body?.result ?? "");
    if (!["OK", "NG", "保留"].includes(result)) return res.status(400).json({ error: "result は OK / NG / 保留 のいずれかです" });
    store.registerInspection(s.id, result, String(req.body?.note ?? "").slice(0, 2000), String(req.body?.inspector ?? "API"), "api");
    res.json({ ok: true });
  });
  api.post("/shipments/:id/status", (req, res) => {
    const s = store.getShipment(req.params.id);
    if (!s) return res.status(404).json({ error: "納品が見つかりません" });
    const status = String(req.body?.status ?? "").trim();
    if (!status || status.length > 40) return res.status(400).json({ error: "status が不正です" });
    store.updateStatus(s.id, status, String(req.body?.note ?? "").slice(0, 2000), "api");
    res.json({ ok: true });
  });
  api.post("/shipments/:id/evidence", upload.array("files", 12), async (req, res) => {
    const id = String(req.params.id);
    if (!store.getShipment(id)) return res.status(404).json({ error: "納品が見つかりません" });
    const saved = await savePhotos(id, "evidence", (req.files as Express.Multer.File[]) ?? []);
    res.json({ ok: true, saved });
  });
  r.use("/api", api);

  return r;
}
