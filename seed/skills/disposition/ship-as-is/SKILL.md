---
name: ship-as-is
description: そのまま出荷。顧客が問題点を了承したうえで、通常どおり出荷工程へ進める。
metadata:
  layer: disposition
  title: そのまま出荷
  version: 1.0.0
  owner: 出荷管理
  applies_to:
    instructions: ["ship_as_is"]
  requires_approval: false
  wms_status: 検品OK（顧客承諾）
  worker_instruction: 商品を通常の出荷待ちエリアへ移動してください。
---
# そのまま出荷

## 手順
1. WMSのステータスを「検品OK（顧客承諾）」に更新する。
2. 作業者に出荷待ちエリアへの移動を指示する。
3. 顧客の承諾内容（返信）を記録として残す。
