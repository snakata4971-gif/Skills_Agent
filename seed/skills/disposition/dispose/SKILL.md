---
name: dispose
description: 廃棄。顧客の指示で商品を廃棄する。取り消しできないため、実行前に責任者の承認が必要。
metadata:
  layer: disposition
  title: 廃棄
  version: 1.0.0
  owner: 出荷管理
  applies_to:
    instructions: ["dispose"]
  requires_approval: true
  wms_status: 廃棄予定
  worker_instruction: 商品を廃棄待ちエリア（D列）へ移動し、廃棄札を付けてください。廃棄は週次の廃棄作業でまとめて行います。
---
# 廃棄

## 手順
1. 責任者が廃棄を承認する（取り消しできないため）。
2. WMSのステータスを「廃棄予定」に更新する。
3. 作業者に廃棄待ちエリアへの移動を指示する。
4. 週次の廃棄作業で処分し、写真を記録として残す。
