---
name: wms-browser-operation
description: WMS（Web画面）をブラウザ自動操作で扱うための操作スキル。WMSのAPIが使えない場合に、画面の要素（セレクター）と手順に従って読み取り・登録を行う。
metadata:
  layer: operation
  title: WMS ブラウザ操作
  version: 1.0.0
  owner: システム担当
  applies_to:
    systems: ["wms-web"]
---
# WMS ブラウザ操作

WMSのAPIが使えない場合、このスキルの手順とセレクターに従って、WMSのWeb画面をスクリプトで操作する。
操作はAIではなく決まったスクリプトが行うため速く確実。画面が変わって操作に失敗した場合は、
失敗した手順と画面の状態が記録され、学習機能がセレクターの修正案を作る。

## 手順
### 納品情報の読み取り
1. トップ画面のスキャン欄（scan_input）に顧客IDまたは納品IDを入力し、送信（scan_submit）する。
2. 納品の一覧が表示された場合は、各行のリンク（shipment_link）から対象の納品を開く。
3. 納品詳細画面から、顧客情報・申告内容（item_rows）・顧客写真（customer_photos）を読み取る。

### 検品結果の登録
1. 納品詳細画面の検品結果（result_select）で OK / NG / 保留 を選ぶ。
2. メモ欄（note_input）に判定理由を入力する。
3. 登録ボタン（register_button）を押し、完了メッセージ（flash_message）を確認する。

### ステータス更新
1. ステータス（status_select）で新しいステータスを選び、更新ボタン（status_button）を押す。

### 証跡写真のアップロード
1. ファイル欄（evidence_input）に現物写真を指定し、アップロードボタン（evidence_button）を押す。

## セレクター
```json
{
  "scan_input": "#scan-code",
  "scan_submit": "#scan-submit",
  "shipment_link": "a.shipment-link",
  "shipment_id": "#shipment-id",
  "customer_id": "#customer-id",
  "customer_name": "#customer-name",
  "customer_email": "#customer-email",
  "category": "#shipment-category",
  "declared_value": "#declared-value",
  "status": "#shipment-status",
  "item_rows": "table#declared-items tbody tr",
  "item_name": "td.item-name",
  "item_qty": "td.item-qty",
  "item_color": "td.item-color",
  "item_size": "td.item-size",
  "item_note": "td.item-note",
  "customer_photos": "img.customer-photo",
  "result_select": "#inspection-result",
  "note_input": "#inspection-note",
  "register_button": "#register-inspection",
  "flash_message": ".flash",
  "status_select": "#status-select",
  "status_button": "#update-status",
  "evidence_input": "#evidence-files",
  "evidence_button": "#upload-evidence"
}
```
