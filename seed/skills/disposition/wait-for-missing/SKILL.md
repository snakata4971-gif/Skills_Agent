---
name: wait-for-missing
description: 過不足待ち。顧客の指示で、不足品や正しい商品の到着を待つ。商品を保留棚へ移し、WMSのステータスを保留にする。
metadata:
  layer: disposition
  title: 過不足待ち
  version: 1.0.0
  owner: 出荷管理
  applies_to:
    instructions: ["wait_missing"]
  requires_approval: false
  wms_status: 保留（不足品待ち）
  worker_instruction: 商品を保留棚（H列）へ移動し、納品IDと「不足品待ち」を書いた保留札を付けてください。
---
# 過不足待ち

## 手順
1. WMSのステータスを「保留（不足品待ち）」に更新する。
2. 作業者に保留棚への移動を指示する。
3. 不足品が届いたら、同じ顧客IDのスキャン時に保留中の案件として再検品する。
4. 14日を過ぎても届かない場合は顧客に再確認する。
