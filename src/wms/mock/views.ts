/**
 * HTML screens of the mock WMS. "v1" is the screen the operation skill was written for;
 * "v2" simulates a WMS screen renewal in which many element ids/classes change, so the
 * browser-automation fallback breaks and the learning loop has something to repair.
 */
import { WMS_STATUSES } from "../types.ts";
import type { MockShipment } from "./store.ts";

export const esc = (v: unknown) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

type V = "v1" | "v2";

function layout(title: string, body: string, v: V, msg?: string) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - LogiWMS（模擬）</title>
<style>
  body { margin: 0; font: 13px/1.5 "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif; background: #eef1f4; color: #222; }
  header { background: ${v === "v2" ? "#0b3d6b" : "#34495e"}; color: #fff; padding: 8px 16px; display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
  header b { font-size: 15px; }
  header a { color: #dfe6ee; text-decoration: none; }
  header .ver { margin-left: auto; font-size: 11px; opacity: .8; }
  main { padding: 16px; max-width: 1100px; }
  .panel { background: #fff; border: 1px solid #c8d0d8; padding: 12px 14px; margin-bottom: 14px; }
  .panel h2 { font-size: 14px; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid #dde3e9; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #c8d0d8; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f5f7; font-weight: normal; color: #555; width: 140px; }
  .grid th { width: auto; }
  input[type=text], select, textarea { font: inherit; padding: 4px 6px; border: 1px solid #a9b4bf; }
  textarea { width: 100%; box-sizing: border-box; min-height: 60px; }
  button { font: inherit; padding: 5px 14px; border: 1px solid #52606d; background: #f8f9fa; cursor: pointer; }
  button.primary, .btn.primary { background: #1f6fb2; border-color: #1f6fb2; color: #fff; }
  .flash { background: #fff8d6; border: 1px solid #e6cf6e; padding: 8px 12px; margin-bottom: 12px; }
  .photos img { height: 150px; border: 1px solid #c8d0d8; margin: 0 8px 8px 0; background: #fafafa; }
  .muted { color: #777; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; }
  .row > .panel { flex: 1 1 420px; }
  .scan { font-size: 18px; padding: 8px; width: 320px; }
  .badge { display: inline-block; padding: 1px 8px; background: #e3e8ee; border: 1px solid #c8d0d8; }
</style></head>
<body>
<header><b>LogiWMS</b><span>（模擬WMS・テスト用）</span><a href="/wms/">入荷検品</a><a href="/wms/list">入荷一覧</a><a href="/wms/admin">管理</a><span class="ver">画面バージョン ${v === "v2" ? "2.0（リニューアル後）" : "1.0"}</span></header>
<main>${msg ? `<div class="${v === "v2" ? "flash notice" : "flash"}">${esc(msg)}</div>` : ""}${body}</main>
</body></html>`;
}

export function topPage(v: V, msg?: string) {
  const form =
    v === "v1"
      ? `<form id="scan-form" action="/wms/scan" method="get">
           <input type="text" id="scan-code" name="code" class="scan" placeholder="顧客ID / 納品ID をスキャン" autofocus>
           <button id="scan-submit" type="submit" class="primary">表示</button>
         </form>`
      : `<form class="scan-area" action="/wms/scan" method="get">
           <label>バーコード <input type="text" id="barcode-input" name="code" class="scan" placeholder="顧客ID / 納品ID" autofocus></label>
           <button type="submit" class="btn primary btn-scan" data-action="scan">検索</button>
         </form>`;
  return layout(
    "入荷検品",
    `<div class="panel"><h2>入荷検品</h2><p class="muted">顧客IDまたは納品IDをスキャンすると、顧客がアップロードした写真と申告内容が表示されます。</p>${form}</div>`,
    v,
    msg,
  );
}

export function scanListPage(v: V, result: { customer: { id: string; name: string }; shipments: Array<{ id: string; category: string; status: string; itemCount: number }> }) {
  const link = (id: string) =>
    v === "v1" ? `<a class="shipment-link" href="/wms/shipments/${esc(id)}">${esc(id)}</a>` : `<a class="row-link" href="/wms/shipments/${esc(id)}">${esc(id)}</a>`;
  const rows = result.shipments
    .map((s) => `<tr><td>${link(s.id)}</td><td>${esc(s.category)}</td><td>${esc(s.itemCount)}</td><td>${esc(s.status)}</td></tr>`)
    .join("");
  return layout(
    "納品一覧",
    `<div class="panel"><h2>顧客 ${esc(result.customer.id)} ${esc(result.customer.name)} の納品</h2>
     <table class="grid" id="shipment-list"><thead><tr><th>納品ID</th><th>カテゴリ</th><th>数量</th><th>ステータス</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    v,
  );
}

export function shipmentPage(v: V, s: MockShipment, msg?: string) {
  const items = s.items
    .map(
      (it) =>
        `<tr><td class="item-name">${esc(it.name)}</td><td class="item-qty">${esc(it.qty)}</td><td class="item-color">${esc(it.color)}</td><td class="item-size">${esc(it.size)}</td><td class="item-note">${esc(it.note)}</td></tr>`,
    )
    .join("");
  const custClass = v === "v1" ? "customer-photo" : "photo--customer";
  const evClass = v === "v1" ? "evidence-photo" : "photo--evidence";
  const customerPhotos = s.customer_photos.map((f) => `<img class="${custClass}" src="/wms/files/${esc(f)}" alt="顧客写真">`).join("") || '<span class="muted">なし</span>';
  const evidence = s.evidence_photos.map((f) => `<img class="${evClass}" src="/wms/files/${esc(f)}" alt="証跡写真">`).join("") || '<span class="muted">なし</span>';
  const statusOptions = WMS_STATUSES.map((st) => `<option ${st === s.status ? "selected" : ""}>${esc(st)}</option>`).join("");
  const statusCell = v === "v1" ? `<span id="shipment-status">${esc(s.status)}</span>` : `<span id="status-label" class="badge">${esc(s.status)}</span>`;
  const inspectionForm =
    v === "v1"
      ? `<form id="inspection-form" method="post" action="/wms/shipments/${esc(s.id)}/inspection">
           <table><tr><th>検品結果</th><td><select id="inspection-result" name="result"><option value="">選択してください</option><option>OK</option><option>NG</option><option>保留</option></select></td></tr>
           <tr><th>メモ</th><td><textarea id="inspection-note" name="note"></textarea></td></tr>
           <tr><th>検品者</th><td><input type="text" name="by" value="作業者"></td></tr></table>
           <p><button id="register-inspection" type="submit" class="primary">検品結果を登録</button></p>
         </form>`
      : `<form class="inspect" method="post" action="/wms/shipments/${esc(s.id)}/inspection">
           <table><tr><th>判定</th><td><select id="result-select" name="result"><option value="">--</option><option>OK</option><option>NG</option><option>保留</option></select></td></tr>
           <tr><th>判定メモ</th><td><textarea id="result-memo" name="note"></textarea></td></tr>
           <tr><th>担当</th><td><input type="text" name="by" value="作業者"></td></tr></table>
           <p><button type="submit" class="btn primary" data-action="register-result">登録する</button></p>
         </form>`;
  const statusForm =
    v === "v1"
      ? `<form id="status-form" method="post" action="/wms/shipments/${esc(s.id)}/status">
           <select id="status-select" name="status">${statusOptions}</select> <input type="text" name="note" placeholder="メモ">
           <button id="update-status" type="submit">ステータス更新</button></form>`
      : `<form class="status" method="post" action="/wms/shipments/${esc(s.id)}/status">
           <select id="next-status" name="status">${statusOptions}</select> <input type="text" name="reason" placeholder="理由">
           <button type="submit" class="btn" data-action="update-status">更新</button></form>`;
  const evidenceForm =
    v === "v1"
      ? `<form id="evidence-form" method="post" enctype="multipart/form-data" action="/wms/shipments/${esc(s.id)}/evidence">
           <input type="file" id="evidence-files" name="files" multiple accept="image/*"> <button id="upload-evidence" type="submit">証跡写真をアップロード</button></form>`
      : `<form class="photos-form" method="post" enctype="multipart/form-data" action="/wms/shipments/${esc(s.id)}/evidence">
           <input type="file" id="photo-files" name="files" multiple accept="image/*"> <button type="submit" class="btn" data-action="upload-photos">写真を追加</button></form>`;
  const history = s.history
    .map((h) => `<tr><td>${esc(new Date(h.at).toLocaleString("ja-JP"))}</td><td>${esc(h.status)}</td><td>${esc(h.via === "api" ? "API" : "画面")}</td><td>${esc(h.note)}</td></tr>`)
    .join("");

  return layout(
    `納品 ${s.id}`,
    `<div class="row">
      <div class="panel"><h2>納品情報</h2>
        <table>
          <tr><th>納品ID</th><td id="shipment-id">${esc(s.id)}</td></tr>
          <tr><th>顧客ID</th><td id="customer-id">${esc(s.customer.id)}</td></tr>
          <tr><th>顧客名</th><td id="customer-name">${esc(s.customer.name)}</td></tr>
          <tr><th>メール</th><td id="customer-email">${esc(s.customer.email)}</td></tr>
          <tr><th>カテゴリ</th><td id="shipment-category">${esc(s.category)}</td></tr>
          <tr><th>申告額</th><td id="declared-value">${esc(s.declared_value)}</td></tr>
          <tr><th>ステータス</th><td>${statusCell}</td></tr>
          <tr><th>検品結果</th><td>${s.inspection ? `${esc(s.inspection.result)}（${esc(s.inspection.by)}）${esc(s.inspection.note)}` : '<span class="muted">未登録</span>'}</td></tr>
        </table>
      </div>
      <div class="panel"><h2>申告内容</h2>
        <table class="grid" id="declared-items"><thead><tr><th>品名</th><th>数量</th><th>色</th><th>サイズ</th><th>備考</th></tr></thead><tbody>${items}</tbody></table>
      </div>
    </div>
    <div class="panel photos"><h2>顧客アップロード写真</h2>${customerPhotos}</div>
    <div class="panel photos"><h2>証跡写真（センター撮影）</h2>${evidence}${evidenceForm}</div>
    <div class="row">
      <div class="panel"><h2>検品結果の登録</h2>${inspectionForm}</div>
      <div class="panel"><h2>ステータス</h2>${statusForm}</div>
    </div>
    <div class="panel"><h2>履歴</h2><table class="grid"><thead><tr><th>日時</th><th>ステータス</th><th>経路</th><th>メモ</th></tr></thead><tbody>${history}</tbody></table></div>
    <div class="panel"><h2>テスト用: 顧客写真を追加</h2>
      <form method="post" enctype="multipart/form-data" action="/wms/shipments/${esc(s.id)}/customer-photos">
        <input type="file" id="test-customer-upload" name="files" multiple accept="image/*"> <button type="submit" data-action="test-add-customer">顧客写真として追加</button>
      </form></div>`,
    v,
    msg,
  );
}

export function listPage(v: V, rows: Array<Record<string, any>>) {
  const body = rows
    .map(
      (r) =>
        `<tr><td><a href="/wms/shipments/${esc(r.id)}">${esc(r.id)}</a></td><td>${esc(r.customer_id)} ${esc(r.customer_name)}</td><td>${esc(r.category)}</td><td>${esc(r.status)}</td><td>${esc(r.inspection_result ?? "")}</td></tr>`,
    )
    .join("");
  return layout(
    "入荷一覧",
    `<div class="panel"><h2>入荷一覧</h2><table class="grid"><thead><tr><th>納品ID</th><th>顧客</th><th>カテゴリ</th><th>ステータス</th><th>検品結果</th></tr></thead><tbody>${body}</tbody></table></div>`,
    v,
  );
}

export function adminPage(v: V, msg?: string) {
  return layout(
    "管理",
    `<div class="panel"><h2>画面バージョン（ブラウザ自動操作のテスト用）</h2>
      <p>「2.0」に切り替えると、WMSの画面リニューアルを想定して画面の要素名が変わります。ブラウザ自動操作モードで連携している場合は操作が失敗し、学習機能がセレクターの修正案を作る流れを試せます。</p>
      <form method="post" action="/wms/admin/ui-version">
        <label><input type="radio" name="version" value="v1" ${v === "v1" ? "checked" : ""}> 1.0（操作スキル作成時の画面）</label>
        <label><input type="radio" name="version" value="v2" ${v === "v2" ? "checked" : ""}> 2.0（リニューアル後の画面）</label>
        <button type="submit" class="primary">切り替え</button>
      </form></div>
    <div class="panel"><h2>入荷を登録（テスト用）</h2>
      <p class="muted">お手元の商品写真で試すときに使います。品名は1行に1つ「品名,数量,色,サイズ,備考」の形で入力してください。</p>
      <form method="post" enctype="multipart/form-data" action="/wms/admin/shipments">
        <table>
          <tr><th>顧客ID</th><td><input type="text" name="customer_id" required placeholder="C-2001"></td></tr>
          <tr><th>顧客名</th><td><input type="text" name="customer_name" required></td></tr>
          <tr><th>メール</th><td><input type="text" name="customer_email" placeholder="test@example.com"></td></tr>
          <tr><th>カテゴリ</th><td><input type="text" name="category" required placeholder="トレカ / アパレル / おもちゃ など"></td></tr>
          <tr><th>申告額（円）</th><td><input type="text" name="declared_value" value="0"></td></tr>
          <tr><th>申告内容</th><td><textarea name="items" required placeholder="ロゴTシャツ,1,ネイビー,M,新品"></textarea></td></tr>
          <tr><th>顧客写真</th><td><input type="file" name="files" multiple accept="image/*"></td></tr>
        </table>
        <p><button type="submit" class="primary">入荷を登録</button></p>
      </form></div>`,
    v,
    msg,
  );
}

export function messagePage(v: V, title: string, message: string) {
  return layout(title, `<div class="panel"><h2>${esc(title)}</h2><p>${esc(message)}</p><p><a href="/wms/">入荷検品に戻る</a></p></div>`, v);
}
