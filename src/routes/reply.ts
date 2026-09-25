/**
 * The page a customer opens from the confirmation email to choose how to handle the problem.
 * A fixed set of choices avoids misreading free-text replies.
 */
import express from "express";
import { CaseError, getCaseByToken, receiveFormReply } from "../cases.ts";
import { all, parseJson } from "../db.ts";
import { INSTRUCTION_LABELS, INSTRUCTIONS } from "../ai/mailer.ts";
import { esc } from "../wms/mock/views.ts";

const DESCRIPTIONS: Record<(typeof INSTRUCTIONS)[number], string> = {
  wait_missing: "不足している商品や正しい商品を追加で送ります。届くまで保管してください。",
  return: "送り主へ返送してください。※返送料が発生します。",
  dispose: "当センターで廃棄してください。※取り消しはできません。",
  ship_as_is: "内容を了承しました。このまま出荷してください。",
};

function page(title: string, body: string) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f5f6f8; color: #1d2330; font: 16px/1.7 "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  .brand { font-size: 13px; color: #5b6475; letter-spacing: .04em; }
  h1 { font-size: 22px; margin: 4px 0 20px; }
  .card { background: #fff; border: 1px solid #e3e6eb; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 16px; margin: 0 0 10px; }
  ul { margin: 0; padding-left: 1.2em; }
  .photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .photos figure { margin: 0; }
  .photos img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 8px; border: 1px solid #e3e6eb; }
  .photos figcaption { font-size: 12px; color: #5b6475; }
  label.opt { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; align-items: start; border: 1px solid #d5d9e0; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; cursor: pointer; }
  label.opt:has(input:checked) { border-color: #2754c5; background: #f0f4ff; }
  label.opt input { grid-row: span 2; margin: 6px 0 0; width: 18px; height: 18px; accent-color: #2754c5; }
  label.opt span { font-size: 14px; color: #5b6475; }
  textarea { width: 100%; box-sizing: border-box; min-height: 90px; font: inherit; padding: 10px; border: 1px solid #d5d9e0; border-radius: 8px; }
  button { font: inherit; font-weight: 600; background: #2754c5; color: #fff; border: 0; border-radius: 10px; padding: 12px 22px; cursor: pointer; }
  .muted { color: #5b6475; font-size: 14px; }
  .error { color: #b42318; font-weight: 600; }
</style></head><body><div class="wrap"><div class="brand">越境物流センター</div>${body}</div></body></html>`;
}

export function replyRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  r.get("/:token", (req, res) => {
    const c = getCaseByToken(req.params.token);
    if (!c) {
      res.status(404).send(page("ページが見つかりません", "<h1>ページが見つかりません</h1><p>URLをご確認ください。</p>"));
      return;
    }
    if (c.status !== "awaiting_reply") {
      const answered = c.reply_choice ? `「${INSTRUCTION_LABELS[c.reply_choice as keyof typeof INSTRUCTION_LABELS] ?? c.reply_choice}」でご回答いただいています。` : "";
      res.send(page("ご回答ありがとうございます", `<h1>ご回答ありがとうございます</h1><div class="card"><p>納品ID ${esc(c.shipment_id)} について、${esc(answered)}</p><p class="muted">変更をご希望の場合は、検品チームへご連絡ください。</p></div>`));
      return;
    }
    const issues = parseJson<Array<{ detail: string }>>(c.issues, []);
    const photos = all<{ kind: string; seq: number; file: string }>("SELECT kind, seq, file FROM photos WHERE inspection_id = ? ORDER BY kind, seq", c.inspection_id);
    const error = String(req.query.error ?? "");
    res.send(
      page(
        "検品結果のご確認",
        `<h1>検品結果のご確認</h1>
        <div class="card"><h2>納品ID ${esc(c.shipment_id)}</h2>
          <p>${esc(c.customer_name)} 様からお送りいただいたお荷物で、次の点を確認いたしました。</p>
          <ul>${issues.map((i) => `<li>${esc(i.detail)}</li>`).join("")}</ul></div>
        <div class="card"><h2>写真</h2><div class="photos">${photos
          .map((p) => `<figure><img src="/files/${esc(c.inspection_id)}/${esc(p.file)}" alt=""><figcaption>${p.kind === "customer" ? "お客様の写真" : "当センター撮影"} ${p.seq}</figcaption></figure>`)
          .join("")}</div></div>
        <form class="card" method="post">
          <h2>対応方法をお選びください</h2>
          ${error ? `<p class="error">${esc(error)}</p>` : ""}
          ${INSTRUCTIONS.map((k) => `<label class="opt"><input type="radio" name="choice" value="${k}" required><b>${esc(INSTRUCTION_LABELS[k])}</b><span>${esc(DESCRIPTIONS[k])}</span></label>`).join("")}
          <p><label>ご要望・補足（任意）<br><textarea name="comment" maxlength="2000"></textarea></label></p>
          <button type="submit">回答を送信する</button>
          <p class="muted">回答期限: ${c.reply_due_at ? esc(new Date(c.reply_due_at).toLocaleDateString("ja-JP")) : "—"}</p>
        </form>`,
      ),
    );
  });

  r.post("/:token", (req, res) => {
    try {
      receiveFormReply(req.params.token, String(req.body?.choice ?? ""), String(req.body?.comment ?? ""));
      res.redirect(303, `/reply/${encodeURIComponent(req.params.token)}`);
    } catch (e) {
      if (e instanceof CaseError) {
        res.redirect(303, `/reply/${encodeURIComponent(req.params.token)}?error=${encodeURIComponent(e.message)}`);
        return;
      }
      throw e;
    }
  });

  return r;
}
