import { get, navigate, state } from "../api.js";
import { card, h, mount, verdictBadge } from "../ui.js";

const LOOP = [
  { n: "①", title: "スキルビルダー", text: "POPの写真・手順書・作業動画から、AIがスキルの下書きと質問を作る。ベテランが答えて承認する。", who: "AIが下書き／ベテランが承認" },
  { n: "②", title: "スキルライブラリー", text: "承認済みのスキルを版管理。納品IDのスキャンで、共通・カテゴリ・顧客別のスキルが自動で選ばれる。", who: "自動で引き当て" },
  { n: "③", title: "検品エージェント", text: "顧客写真と現物写真を比較して判定し、WMS登録・確認メール・返信後の処理を行う。", who: "作業者は開梱・撮影・スキャン" },
  { n: "④", title: "学習・改善", text: "人がAIと違う判断をした理由や操作エラーから改善案を作り、過去データでテストして更新する。", who: "改善案をベテランが承認" },
];

const STEPS = [
  "右上の「担当者名を設定」で名前を入れます（確定・承認の記録に使います）。",
  "「検品」を開き、下の表の納品ID（または顧客ID）をスキャン欄に入力して Enter を押します。実際の現場ではバーコードスキャナーで読み取ります。",
  "現物写真を追加します。デモでは「サンプル写真を使う」で用意した写真を入れます（現場では撮影ブースのカメラで撮影）。",
  "「AI照合を開始」を押すと、AIがスキルに従って顧客写真と現物写真を比較します。判定を確認して OK / NG / 保留 で確定するとWMSに登録されます。",
  "NGで確定すると「顧客確認」にケースができます。確認メールを承認して送信（模擬）し、回答ページで顧客として回答すると、処理（過不足待ち・返品・廃棄・そのまま出荷）に進みます。",
  "AIと違う判断をしたときは、理由をメモに書きます。「学習・改善」でその理由から改善案を作り、テストして公開するとスキルが更新されます。",
  "専用スキルがない商品（例: スニーカー）は「スキルビルダー」に作成依頼が届きます。POPの写真や手順書から新しいスキルを作れます。",
];

export async function render(root) {
  const samples = await get("/api/guide/samples");
  const live = state.status?.ai.mode === "live";

  mount(
    root,
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        null,
        h("h1", null, "QA Skill Builder"),
        h("p", null, "ベテランの検品ノウハウを「スキル」として蓄え、AIエージェントと新人が同じ基準で検品できるようにする仕組みです。"),
      ),
      h("button", { class: "btn primary lg", type: "button", onclick: () => navigate("#/station") }, "検品を始める"),
    ),
    h(
      "div",
      { class: "stack" },
      card(
        "全体の流れ",
        h("div", { class: "loop" }, LOOP.map((s) => h("div", { class: "loop-step" }, h("div", { class: "n" }, s.n), h("h3", null, s.title), h("p", null, s.text), h("div", { class: "who" }, s.who)))),
        { sub: "④で更新したスキルは②に戻り、次の検品から使われます" },
      ),
      card(
        live ? "AIに接続しています" : "いまはデモモードです（AI未接続）",
        h(
          "div",
          { class: live ? "note-box ok" : "note-box warn" },
          live
            ? h("p", null, "写真の比較・メール作成・スキル生成・改善案をAI（Claude）が実際に行います。判定1件ごとに利用料がかかります（学習・改善画面で概算を確認できます）。")
            : [
                h("p", null, "APIキーが未設定のため、AIの代わりに「模擬判定」で動いています。同梱のサンプル写真には用意した判定結果を返し、それ以外の写真は「要確認」として人に回します。"),
                h("p", null, "実際のAIで試すには、アプリのフォルダにある .env.example を .env にコピーして ANTHROPIC_API_KEY を設定し、アプリを再起動してください。"),
              ],
        ),
      ),
      card("デモの進め方", h("ol", { style: { margin: 0, paddingLeft: "20px", lineHeight: 1.9 } }, STEPS.map((s) => h("li", null, s)))),
      card(
        "サンプルの納品（模擬WMSに登録済み）",
        h(
          "table",
          { class: "tbl" },
          h("thead", null, h("tr", null, h("th", null, "納品ID"), h("th", null, "顧客"), h("th", null, "カテゴリ"), h("th", null, "内容"), h("th", null, "想定される判定"), h("th", null, ""))),
          h(
            "tbody",
            null,
            samples.map((s) =>
              h(
                "tr",
                null,
                h("td", { class: "mono nowrap" }, s.shipmentId),
                h("td", null, `${s.customerId} ${s.customerName}`),
                h("td", null, s.category),
                h("td", null, s.title),
                h("td", null, verdictBadge(s.expected)),
                h("td", null, h("button", { class: "btn sm", type: "button", onclick: () => navigate(`#/station?code=${encodeURIComponent(s.shipmentId)}`) }, "この納品を検品")),
              ),
            ),
          ),
        ),
        { sub: "顧客ID C-1001 には2件の納品があり、スキャンすると選択画面になります" },
      ),
      card(
        "WMSとの連携",
        h(
          "div",
          null,
          h("p", null, "同梱の「模擬WMS」を本物のWMSの代わりに使っています。連携方法は設定画面で切り替えられます。"),
          h(
            "ul",
            { style: { margin: "0 0 8px", paddingLeft: "20px", lineHeight: 1.9 } },
            h("li", null, h("b", null, "API連携"), "：WMSのAPIでデータを読み書きします（本番の想定。WMS側の改修が必要）。"),
            h("li", null, h("b", null, "ブラウザ自動操作"), "：APIがない場合の代替。操作スキルに書かれた画面の要素と手順に従って、WMSのWeb画面をスクリプトで操作します。"),
          ),
          h("div", { class: "row" }, h("a", { class: "btn", href: "/wms/", target: "_blank" }, "模擬WMSを開く"), h("a", { class: "btn", href: "/wms/admin", target: "_blank" }, "模擬WMSの管理（画面バージョン切替・入荷登録）")),
        ),
      ),
    ),
  );
}
