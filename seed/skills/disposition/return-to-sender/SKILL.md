---
name: return-to-sender
description: 返品。顧客の指示で送り主へ返送する。返送料が発生し取り消しにくいため、実行前に責任者の承認が必要。
metadata:
  layer: disposition
  title: 返品
  version: 1.0.0
  owner: 出荷管理
  applies_to:
    instructions: ["return"]
  requires_approval: true
  wms_status: 返品手配中
  worker_instruction: 商品を返品エリア（R列）へ移動してください。返品伝票が発行されたら貼付して出荷口へ回してください。
---
# 返品

## 手順
1. 責任者が返品を承認する（返送料が発生するため）。
2. WMSのステータスを「返品手配中」に更新する。
3. 作業者に返品エリアへの移動を指示する。
4. 返品伝票の発行後、出荷口へ回す。
