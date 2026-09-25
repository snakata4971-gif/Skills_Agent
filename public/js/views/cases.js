import { act, get, poll, post, put } from "../api.js";
import { badge, card, confirmDialog, fmtDateTime, h, lightbox, mount, spinner } from "../ui.js";

const STATUS_CLASS = {
  drafting: "ai",
  draft_ready: "warn",
  awaiting_reply: "info",
  instruction_received: "warn",
  awaiting_approval: "ng",
  ready: "warn",
  executed: "info",
  closed: "ok",
};

const FILTERS = [
  { key: "action", label: "要対応", match: (c) => ["draft_ready", "instruction_received", "awaiting_approval", "ready", "executed"].includes(c.status) },
  { key: "waiting", label: "返信待ち", match: (c) => c.status === "awaiting_reply" || c.status === "drafting" },
  { key: "closed", label: "完了", match: (c) => c.status === "closed" },
  { key: "all", label: "すべて", match: () => true },
];

const INSTRUCTIONS = [
  ["wait_missing", "過不足待ち"],
  ["return", "返品"],
  ["dispose", "廃棄"],
  ["ship_as_is", "そのまま出荷"],
];

const STEPS = [
  { label: "メール作成", done: (c) => !["drafting", "draft_ready"].includes(c.status), current: (c) => ["drafting", "draft_ready"].includes(c.status) },
  { label: "返信待ち", done: (c) => !!c.reply_received_at || ["awaiting_approval", "ready", "executed", "closed"].includes(c.status), current: (c) => c.status === "awaiting_reply" },
  { label: "指示の確認", done: (c) => ["awaiting_approval", "ready", "executed", "closed"].includes(c.status), current: (c) => c.status === "instruction_received" },
  { label: "責任者の承認", done: (c) => !!c.approved_by || (!c.requiresApproval && ["ready", "executed", "closed"].includes(c.status)), current: (c) => c.status === "awaiting_approval", skip: (c) => !c.requiresApproval && ["ready", "executed", "closed"].includes(c.status) },
  { label: "処理の実行", done: (c) => ["executed", "closed"].includes(c.status), current: (c) => c.status === "ready" },
  { label: "完了", done: (c) => c.status === "closed", current: (c) => c.status === "executed" },
];

export async function render(root, { params }) {
  let filter = "action";
  let list = [];
  let selectedId = params[0] ?? null;
  let detail = null;
  const listBox = h("div");
  const detailBox = h("div");

  mount(
    root,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "顧客確認"), h("p", null, "NGで確定した検品について、確認メール → 顧客の回答 → 処理の実行までを管理します。"))),
    h("div", { class: "grid-2" }, listBox, detailBox),
  );

  async function loadList() {
    list = await get("/api/cases");
    if (!selectedId && list.length) {
      const first = list.find(FILTERS.find((f) => f.key === filter).match) ?? list[0];
      selectedId = first?.id ?? null;
    }
    renderList();
  }

  function renderList() {
    const f = FILTERS.find((x) => x.key === filter);
    const items = list.filter(f.match);
    mount(
      listBox,
      h(
        "section",
        { class: "card" },
        h("div", { class: "card-head" }, h("div", { class: "seg" }, FILTERS.map((x) => h("button", { type: "button", class: x.key === filter ? "on" : "", onclick: () => { filter = x.key; renderList(); } }, `${x.label} ${list.filter(x.match).length}`)))),
        items.length
          ? h(
              "div",
              { class: "list" },
              items.map((c) =>
                h(
                  "a",
                  { class: `list-item ${c.id === selectedId ? "active" : ""}`, onclick: () => select(c.id) },
                  h("div", { class: "row between" }, h("span", { class: "title mono" }, c.id), badge(c.statusLabel, STATUS_CLASS[c.status])),
                  h("div", { class: "small" }, `${c.customerName}・${c.shipmentId}`),
                  h("div", { class: "small muted", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.issueSummary || "—"),
                  c.error ? h("div", { class: "small", style: { color: "var(--ng)" } }, c.error) : null,
                ),
              ),
            )
          : h("div", { class: "empty" }, "該当するケースはありません"),
      ),
    );
  }

  async function select(id) {
    selectedId = id;
    history.replaceState(null, "", `#/cases/${id}`);
    renderList();
    await loadDetail();
  }

  async function loadDetail() {
    if (!selectedId) {
      mount(detailBox, card(null, h("div", { class: "empty", style: { padding: "48px" } }, "NGで確定した検品があると、ここに顧客確認のケースが表示されます")));
      return;
    }
    detail = await get(`/api/cases/${encodeURIComponent(selectedId)}`);
    renderDetail();
  }

  function renderDetail() {
    const c = detail;
    const insp = c.inspection;
    const photos = insp?.photos ?? [];
    mount(
      detailBox,
      h(
        "div",
        { class: "stack" },
        card(
          `ケース ${c.id}`,
          h(
            "div",
            null,
            h(
              "div",
              { class: "steps" },
              STEPS.filter((s) => !(s.skip && s.skip(c))).map((s) => h("span", { class: `step ${s.current(c) ? "current" : s.done(c) ? "done" : ""}` }, s.done(c) && !s.current(c) ? `✓ ${s.label}` : s.label)),
            ),
            h(
              "dl",
              { class: "kv" },
              h("dt", null, "顧客"), h("dd", null, `${c.customer_id} ${c.customer_name}（${c.customer_email || "メール未登録"}）`),
              h("dt", null, "納品ID"), h("dd", { class: "mono" }, c.shipment_id),
              h("dt", null, "検品"), h("dd", null, h("a", { href: `#/station?id=${c.inspection_id}` }, c.inspection_id), insp?.human ? h("span", { class: "muted small" }, `（${insp.human.by} が ${insp.human.overall} で確定）`) : null),
              h("dt", null, "回答期限"), h("dd", null, fmtDateTime(c.reply_due_at)),
            ),
            h("div", { class: "section-title" }, "問題点"),
            h("ul", { style: { margin: 0, paddingLeft: "20px" } }, c.issues.map((i) => h("li", null, h("b", null, `［${i.type}］`), i.detail))),
            photos.length
              ? h(
                  "div",
                  { class: "photo-grid", style: { marginTop: "10px", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" } },
                  photos.map((p) => h("div", { class: "photo" }, h("img", { src: p.url, alt: p.label, onclick: () => lightbox(p.url, p.label) }), h("span", { class: "cap" }, p.label))),
                )
              : null,
            c.error ? h("div", { class: "note-box ng", style: { marginTop: "12px" } }, c.error) : null,
          ),
          { actions: badge(c.statusLabel, STATUS_CLASS[c.status]) },
        ),
        renderAction(c),
        card("履歴", h("ul", { class: "timeline" }, c.events.map((e) => h("li", null, h("div", null, e.message), h("div", { class: "meta" }, `${fmtDateTime(e.created_at)}・${e.actor}`))))),
      ),
    );
  }

  const reload = async () => {
    await loadList();
    await loadDetail();
  };

  function instructionPicker(initial) {
    const select = h("select", null, h("option", { value: "" }, "対応方法を選ぶ"), INSTRUCTIONS.map(([k, label]) => h("option", { value: k, selected: k === initial }, label)));
    return select;
  }

  function renderAction(c) {
    if (c.status === "drafting") return card("確認メール", h("div", { class: "empty" }, spinner("メールの下書きを作成しています…")));

    if (c.status === "draft_ready") {
      const subject = h("input", { type: "text", value: c.email_subject });
      const body = h("textarea", { value: c.email_body, style: { minHeight: "360px" } });
      return card(
        "確認メールの下書き",
        h(
          "div",
          null,
          h("div", { class: `note-box ${c.email_mode === "live" ? "ai" : "warn"}`, style: { marginBottom: "12px" } }, c.email_mode === "live" ? "AIが連絡スキルに従って作成した下書きです。内容を確認・修正してから送信してください。" : "デモモードのため、テンプレートから作成した下書きです。", h("div", { class: "small" }, "送信は模擬です（実際のメールは送られません）。送信後、回答ページで顧客として回答を試せます。")),
          h("label", { class: "field" }, h("span", null, "件名"), subject),
          h("label", { class: "field" }, h("span", null, "本文"), body),
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn", type: "button", onclick: async () => { if (await act(() => post(`/api/cases/${c.id}/email/regenerate`), "作り直しを開始しました")) reload(); } }, "AIで作り直す"),
            h("button", { class: "btn", type: "button", onclick: async () => { if (await act(() => put(`/api/cases/${c.id}/email`, { subject: subject.value, body: body.value }), "下書きを保存しました")) reload(); } }, "下書きを保存"),
            h("span", { class: "spacer" }),
            h(
              "button",
              {
                class: "btn primary",
                type: "button",
                onclick: async () => {
                  if (subject.value !== c.email_subject || body.value !== c.email_body) {
                    const saved = await act(() => put(`/api/cases/${c.id}/email`, { subject: subject.value, body: body.value }));
                    if (!saved) return;
                  }
                  const ok = await confirmDialog({ title: "確認メールを送信", message: `${c.customer_name} 様（${c.customer_email || "宛先未設定"}）へ送信します（模擬送信）。`, okText: "承認して送信" });
                  if (ok && (await act(() => post(`/api/cases/${c.id}/send`), "送信しました（模擬）"))) reload();
                },
              },
              "承認して送信",
            ),
          ),
        ),
      );
    }

    if (c.status === "awaiting_reply" || c.status === "instruction_received") {
      const replyText = h("textarea", { placeholder: "顧客からのメール返信を貼り付けると、AIが指示を読み取ります", style: { minHeight: "90px" } });
      const pick = instructionPicker(c.instruction && c.instruction !== "unclear" ? c.instruction : "");
      const received =
        c.status === "instruction_received"
          ? h(
              "div",
              { class: `note-box ${c.instruction === "unclear" ? "warn" : "ai"}`, style: { marginBottom: "12px" } },
              h("div", { class: "row" }, h("b", null, "顧客の回答"), c.instructionLabel ? badge(c.instructionLabel, "info") : null, c.instruction_source ? h("span", { class: "small muted" }, { form: "回答ページ", ai: "AIがメールを読み取り", keyword: "キーワード判定", manual: "手入力" }[c.instruction_source] ?? c.instruction_source) : null, c.instruction_confidence !== null && c.instruction_source !== "form" ? h("span", { class: "small muted" }, `確信度 ${Math.round((c.instruction_confidence ?? 0) * 100)}%`) : null),
              h("div", null, c.instruction_summary ?? ""),
              c.reply_text ? h("div", { class: "small", style: { marginTop: "6px", whiteSpace: "pre-wrap" } }, `コメント・本文: ${c.reply_text}`) : null,
            )
          : h("div", { class: "note-box", style: { marginBottom: "12px" } }, h("b", null, "顧客の回答を待っています"), h("div", { class: "small" }, `送信: ${fmtDateTime(c.email_sent_at)}（${c.email_sent_by}）`), h("div", { class: "row", style: { marginTop: "8px" } }, h("a", { class: "btn sm", href: c.replyUrl, target: "_blank", rel: "noopener" }, "顧客の回答ページを開く（テスト用）"), h("button", { class: "btn sm ghost", type: "button", onclick: reload }, "最新の状態に更新")));
      return card(
        c.status === "instruction_received" ? "指示の確認" : "顧客の返信",
        h(
          "div",
          null,
          received,
          h("div", { class: "section-title" }, "対応方法を確定する"),
          h("div", { class: "row", style: { flexWrap: "nowrap" } }, pick, h("button", { class: "btn primary", type: "button", onclick: async () => { if (!pick.value) return; if (await act(() => post(`/api/cases/${c.id}/instruction`, { instruction: pick.value }), "対応方法を確定しました")) reload(); } }, "この対応で確定")),
          h("div", { class: "small faint", style: { marginTop: "4px" } }, "電話など、メール以外で指示を受けた場合もここで選べます。返品・廃棄は確定後に責任者の承認が必要です。"),
          h("div", { class: "section-title", style: { marginTop: "18px" } }, "メールで返信が来た場合"),
          replyText,
          h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn", type: "button", onclick: async (e) => { const btn = e.currentTarget; btn.disabled = true; const r = await act(() => post(`/api/cases/${c.id}/reply-text`, { text: replyText.value }), "返信を読み取りました"); btn.disabled = false; if (r) reload(); } }, "AIで指示を読み取る")),
        ),
      );
    }

    if (c.status === "awaiting_approval") {
      return card(
        "責任者の承認",
        h(
          "div",
          null,
          h("div", { class: "note-box ng", style: { marginBottom: "12px" } }, h("b", null, `「${c.instructionLabel}」は取り消せない、または費用が発生する処理です。`), h("div", null, "内容を確認し、責任者が承認してください。承認者は右上の担当者名で記録されます。")),
          h("button", { class: "btn ng", type: "button", onclick: async () => { const ok = await confirmDialog({ title: "処理を承認", message: `ケース ${c.id} の「${c.instructionLabel}」を承認します。`, okText: "承認する", okClass: "ng" }); if (ok && (await act(() => post(`/api/cases/${c.id}/approve`), "承認しました"))) reload(); } }, `「${c.instructionLabel}」を承認する`),
        ),
      );
    }

    if (c.status === "ready") {
      return card(
        "処理の実行",
        h(
          "div",
          null,
          h("p", null, `対応方法: `, badge(c.instructionLabel, "info"), c.approved_by ? h("span", { class: "small muted" }, `（${c.approved_by} が承認）`) : null),
          h("p", { class: "muted small" }, "処理スキルに従って、WMSのステータスを更新し、作業者への指示を出します。"),
          h("button", { class: "btn primary", type: "button", onclick: async (e) => { e.currentTarget.disabled = true; if (await act(() => post(`/api/cases/${c.id}/execute`), "処理を実行しました")) reload(); else e.currentTarget.disabled = false; } }, "処理を実行する"),
        ),
      );
    }

    if (c.status === "executed") {
      return card(
        "作業者への指示",
        h(
          "div",
          null,
          h("div", { class: "note-box ok", style: { fontSize: "15px", marginBottom: "12px" } }, h("div", { class: "small muted" }, `WMSステータス: ${c.wms_status}`), h("b", null, c.worker_instruction)),
          h("button", { class: "btn", type: "button", onclick: async () => { if (await act(() => post(`/api/cases/${c.id}/close`), "ケースを完了にしました")) reload(); } }, "作業完了にする"),
        ),
      );
    }

    return card("完了", h("div", null, h("p", null, `対応: ${c.instructionLabel ?? "—"}・WMSステータス: ${c.wms_status ?? "—"}`), h("p", { class: "muted small" }, `完了: ${fmtDateTime(c.closed_at)}`)));
  }

  const stop = poll(async () => {
    const before = JSON.stringify(list.map((c) => [c.id, c.status, c.updatedAt]));
    list = await get("/api/cases");
    if (JSON.stringify(list.map((c) => [c.id, c.status, c.updatedAt])) !== before) {
      renderList();
      const cur = list.find((c) => c.id === selectedId);
      if (cur && detail && (cur.status !== detail.status || detail.status === "drafting")) await loadDetail();
    }
  }, 3000);

  await loadList();
  await loadDetail();
  return stop;
}
