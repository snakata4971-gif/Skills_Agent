import { act, get, getActor, post, put, refreshStatus, setActor, state } from "../api.js";
import { badge, card, confirmDialog, h, mount, spinner } from "../ui.js";

const EFFORTS = [
  ["low", "low（速い・安い）"],
  ["medium", "medium"],
  ["high", "high（標準）"],
  ["xhigh", "xhigh"],
  ["max", "max（最も慎重・高い）"],
];

export async function render(root) {
  const s = await get("/api/settings");
  const live = state.status?.ai.mode === "live";

  const actor = h("input", { type: "text", value: getActor(), placeholder: "例: 佐藤（検品）" });
  const model = h("input", { type: "text", value: s.model, list: "model-list" });
  const effort = h("select", null, EFFORTS.map(([k, label]) => h("option", { value: k, selected: k === s.effort }, label)));
  const shadow = h("input", { type: "checkbox", checked: s.shadow_mode });
  const threshold = h("input", { type: "number", min: "0.5", max: "1", step: "0.01", value: s.auto_ok_threshold });
  const highValue = h("input", { type: "number", min: "0", step: "1000", value: s.high_value_yen });
  const due = h("input", { type: "number", min: "1", max: "60", value: s.reply_due_days });
  const sample = h("input", { type: "number", min: "1", max: "50", value: s.regression_sample_size });
  const concurrency = h("input", { type: "number", min: "1", max: "16", value: s.concurrency });
  let wmsMode = s.wms_mode;
  const wmsResult = h("div");
  const modeButtons = h("div", { class: "seg" });
  const renderModes = () =>
    mount(
      modeButtons,
      [
        ["api", "API連携"],
        ["browser", "ブラウザ自動操作"],
      ].map(([k, label]) => h("button", { type: "button", class: wmsMode === k ? "on" : "", onclick: () => { wmsMode = k; renderModes(); } }, label)),
    );
  renderModes();

  const save = async () => {
    const patch = {
      model: model.value.trim(),
      effort: effort.value,
      shadow_mode: shadow.checked,
      auto_ok_threshold: Number(threshold.value),
      high_value_yen: Number(highValue.value),
      reply_due_days: Number(due.value),
      regression_sample_size: Number(sample.value),
      concurrency: Number(concurrency.value),
      wms_mode: wmsMode,
    };
    if (actor.value.trim() && actor.value.trim() !== getActor()) setActor(actor.value.trim());
    if (await act(() => put("/api/settings", patch), "設定を保存しました")) refreshStatus();
  };

  const testWms = async () => {
    mount(wmsResult, spinner("接続を確認しています…"));
    try {
      const r = await post("/api/settings/wms-test", { mode: wmsMode });
      mount(wmsResult, h("div", { class: `note-box ${r.ok ? "ok" : "ng"}`, style: { marginTop: "10px" } }, r.ok ? "接続できました：" : "接続できません：", r.detail));
    } catch (e) {
      mount(wmsResult, h("div", { class: "note-box ng", style: { marginTop: "10px" } }, e.message));
    }
  };

  const reset = async () => {
    const ok = await confirmDialog({
      title: "デモデータを初期化",
      message: "検品・ケース・スキルの版・作成セッションをすべて削除し、同梱の初期データに戻します（設定は残ります）。模擬WMSも初期状態に戻ります。",
      okText: "初期化する",
      okClass: "ng",
      requireText: "初期化",
    });
    if (ok && (await act(() => post("/api/admin/reset", { confirm: "初期化" }), "初期化しました"))) location.hash = "#/guide";
  };

  mount(
    root,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "設定")), h("button", { class: "btn primary lg", type: "button", onclick: save }, "設定を保存")),
    h(
      "div",
      { class: "stack", style: { maxWidth: "860px" } },
      card("担当者", h("label", { class: "field" }, h("span", null, "このパソコンで操作する人の名前"), actor, h("small", null, "確定・承認・スキル編集の記録に使います（試作版のためログイン機能はありません）"))),
      card(
        "AI（Claude）",
        h(
          "div",
          null,
          h("div", { class: "row", style: { marginBottom: "12px" } }, live ? badge("接続中", "ok") : badge("デモモード（未接続）", "warn"), h("span", { class: "small muted" }, "APIキーは画面からは設定できません。アプリのフォルダの .env に ANTHROPIC_API_KEY を書いて再起動してください。")),
          h("label", { class: "field" }, h("span", null, "モデル"), model, h("datalist", { id: "model-list" }, ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "claude-fable-5-1"].map((m) => h("option", { value: m }))), h("small", null, "既定は claude-opus-5。1日4,000件規模では、モデルと推論の深さで費用が大きく変わります。PoCで精度と費用を実測して選んでください")),
          h("label", { class: "field" }, h("span", null, "推論の深さ（effort）"), effort),
        ),
      ),
      card(
        "運用ルール",
        h(
          "div",
          null,
          h("label", { class: "toggle", style: { marginBottom: "6px" } }, shadow, "並走運用（AIの判定は参考表示のみ。必ず人が確定する）"),
          h("p", { class: "small muted", style: { margin: "0 0 14px 28px" } }, "導入初期はONのまま、人との一致率を確認します。OFFにすると、下の条件を満たしたOK判定は自動で確定されWMSに登録されます。"),
          h("div", { class: "grid-2", style: { gridTemplateColumns: "1fr 1fr", gap: "0 16px" } },
            h("label", { class: "field" }, h("span", null, "自動OKにする確信度の下限"), threshold, h("small", null, "0.5〜1。すべての判定項目がこの値以上のときだけ自動OK")),
            h("label", { class: "field" }, h("span", null, "高額品の基準（円）"), highValue, h("small", null, "この申告額以上は必ず人が確認")),
            h("label", { class: "field" }, h("span", null, "顧客の回答期限（日）"), due),
            h("label", { class: "field" }, h("span", null, "同時に判定する件数"), concurrency, h("small", null, "AI判定を並行して処理する数")),
            h("label", { class: "field" }, h("span", null, "改善案のテストに使う過去の検品数"), sample, h("small", null, "AI接続時は1件ごとに判定の費用がかかります")),
          ),
        ),
      ),
      card(
        "WMSとの連携",
        h(
          "div",
          null,
          h("div", { class: "row" }, modeButtons, h("button", { class: "btn", type: "button", onclick: testWms }, "接続テスト")),
          h(
            "ul",
            { class: "small muted", style: { margin: "10px 0 0", paddingLeft: "18px", lineHeight: 1.9 } },
            h("li", null, "API連携：WMSのAPIでデータを読み書きします（本番の想定。WMS側の改修が必要）。"),
            h("li", null, "ブラウザ自動操作：APIがない場合の代替。操作スキル（operation/wms-browser-operation）の要素と手順に従って、WMSの画面をスクリプトで操作します。Google Chrome が必要です。"),
          ),
          wmsResult,
          h("div", { class: "row", style: { marginTop: "12px" } }, h("a", { class: "btn sm", href: "/wms/", target: "_blank" }, "模擬WMSを開く"), h("a", { class: "btn sm", href: "/wms/admin", target: "_blank" }, "模擬WMSの管理（画面バージョン切替）")),
          h("p", { class: "small faint", style: { marginTop: "8px" } }, "模擬WMSの管理画面で画面バージョンを「2.0」にすると、画面リニューアルでブラウザ自動操作が失敗し、学習・改善で操作スキルの修正案を作る流れを試せます。"),
        ),
        { sub: "切り替えは「設定を保存」で反映されます" },
      ),
      card("データ", h("div", { class: "row" }, h("button", { class: "btn ng", type: "button", onclick: reset }, "デモデータを初期化"), h("span", { class: "small muted" }, "試した内容をすべて消して、最初の状態に戻します"))),
    ),
  );
}
