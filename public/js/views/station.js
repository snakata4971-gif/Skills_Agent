import { act, api, del, get, poll, post, refreshStatus, state } from "../api.js";
import { badge, card, confidence, dropzone, fmtTime, h, lightbox, mount, openModal, spinner, toast, verdictBadge, yen } from "../ui.js";

const LAYER_LABEL = { common: "共通", category: "カテゴリ別", customer: "顧客別" };
const checklist = new Map(); // inspection id -> Set of checked instruction indexes

export async function render(root, { query }) {
  let current = null;
  let lastRendered = "";
  let lookupResult = null;
  let disposed = false;

  const scanInput = h("input", { type: "text", class: "scan-input", placeholder: "IDをスキャン", autocomplete: "off", "aria-label": "顧客ID・納品IDのスキャン欄" });
  const scanArea = h("div");
  const left = h("div", { class: "stack" });
  const center = h("div", { class: "stack" });
  const queueBox = h("div");

  mount(
    root,
    h(
      "div",
      { class: "page-head" },
      h("div", null, h("h1", null, "検品ステーション"), h("p", null, "スキャン → 開梱・撮影 → AI照合 → 確定。AIの判定を待たずに次の商品をスキャンできます。")),
    ),
    h(
      "div",
      { class: "grid-station" },
      h("div", { class: "stack" }, card("スキャン", h("div", null, h("div", { class: "row", style: { flexWrap: "nowrap" } }, scanInput, h("button", { class: "btn primary", type: "button", onclick: () => doScan(scanInput.value) }, "表示")), h("p", { class: "small faint", style: { margin: "6px 0 0" } }, "例: C-1005、N-260923-003（はじめに画面にサンプル一覧があります）"), scanArea)), left),
      center,
      h("div", { class: "stack" }, queueBox),
    ),
  );

  scanInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doScan(scanInput.value);
  });

  // Barcode scanners type into whatever has focus; route stray keystrokes to the scan field.
  const onGlobalKey = (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || document.querySelector(".modal-backdrop")) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      scanInput.value += e.key;
      scanInput.focus();
    }
  };
  document.addEventListener("keydown", onGlobalKey);

  async function doScan(raw) {
    const code = raw.trim();
    if (!code) return;
    lookupResult = null;
    mount(scanArea, h("div", { style: { marginTop: "10px" } }, spinner("WMSから読み込み中…")));
    try {
      const r = await get(`/api/station/lookup?code=${encodeURIComponent(code)}`);
      if (r.shipments.length === 1) {
        mount(scanArea);
        await start(r.shipments[0].id);
      } else if (r.shipments.length === 0) {
        mount(scanArea, h("p", { class: "error-text" }, "検品できる納品がありません"));
      } else {
        lookupResult = r;
        renderChoice();
      }
      scanInput.value = "";
    } catch (e) {
      mount(scanArea, h("p", { class: "error-text" }, e.message));
      scanInput.select();
    }
  }

  function renderChoice() {
    mount(
      scanArea,
      h(
        "div",
        { style: { marginTop: "10px" } },
        h("div", { class: "section-title" }, `${lookupResult.customer.id} ${lookupResult.customer.name} の納品（${lookupResult.shipments.length}件）`),
        h(
          "div",
          { class: "list card", style: { boxShadow: "none" } },
          lookupResult.shipments.map((s) =>
            h(
              "a",
              { class: "list-item", onclick: () => { mount(scanArea); start(s.id); } },
              h("div", { class: "row between" }, h("span", { class: "title mono" }, s.id), h("span", { class: "small muted" }, s.status)),
              h("div", { class: "small muted" }, `${s.category}・数量 ${s.itemCount}`),
            ),
          ),
        ),
      ),
    );
  }

  async function start(shipmentId) {
    const r = await act(() => post("/api/inspections", { shipmentId }));
    if (!r) return;
    setCurrent(r);
    refreshQueue();
  }

  async function load(id) {
    const r = await act(() => get(`/api/inspections/${encodeURIComponent(id)}`));
    if (r) setCurrent(r);
  }

  function setCurrent(insp, force = true) {
    current = insp;
    const key = `${insp.id}|${insp.status}|${insp.updatedAt}|${insp.photos.length}`;
    if (!force && key === lastRendered) return;
    lastRendered = key;
    renderLeft();
    renderCenter();
    renderQueueHighlight();
  }

  // ---------------- left column ----------------
  function renderLeft() {
    if (!current) return mount(left);
    const s = current.shipment;
    const checked = checklist.get(current.id) ?? new Set();
    checklist.set(current.id, checked);
    mount(
      left,
      card(
        "納品情報",
        h(
          "div",
          null,
          h(
            "dl",
            { class: "kv" },
            h("dt", null, "納品ID"), h("dd", { class: "mono" }, current.shipmentId),
            h("dt", null, "顧客"), h("dd", null, `${current.customerId} ${current.customerName}`),
            h("dt", null, "カテゴリ"), h("dd", null, current.category),
            h("dt", null, "申告額"), h("dd", null, yen(s.declaredValue)),
            h("dt", null, "検品ID"), h("dd", { class: "mono" }, current.id),
          ),
          h("div", { class: "section-title" }, "申告内容"),
          h(
            "table",
            { class: "tbl compact" },
            h("thead", null, h("tr", null, h("th", null, "品名"), h("th", null, "数量"), h("th", null, "色・サイズ"))),
            h("tbody", null, (s.items ?? []).map((it) => h("tr", null, h("td", null, it.name, it.note ? h("div", { class: "small faint" }, it.note) : null), h("td", null, it.qty), h("td", null, [it.color, it.size].filter(Boolean).join(" / ") || "—")))),
          ),
        ),
      ),
      card(
        "適用スキル",
        h(
          "div",
          null,
          h(
            "div",
            { class: "row" },
            current.skills.map((sk) =>
              h("a", { class: "chip", href: `#/skills/${sk.id}`, title: sk.id }, h("span", { class: "small muted" }, LAYER_LABEL[sk.layer] ?? sk.layer), h("b", null, sk.title), h("span", { class: "small faint" }, `v${sk.version}`)),
            ),
          ),
          current.resolution.notes.length
            ? h(
                "div",
                { class: `note-box ${current.resolution.missingCategory ? "warn" : "ai"}`, style: { marginTop: "10px" } },
                current.resolution.notes.map((n) => h("div", null, n)),
                current.resolution.missingCategory ? h("a", { href: "#/builder" }, "スキルビルダーで作成する →") : null,
              )
            : null,
        ),
        {
          sub: "自動で選択",
          actions: ["capturing", "judged", "error"].includes(current.status)
            ? h("button", { class: "btn ghost sm", type: "button", title: "スキルが追加・更新されたときに、この検品で使うスキルを選び直します", onclick: reresolve }, "選び直す")
            : null,
        },
      ),
      current.photoInstructions.length
        ? card(
            "撮影チェックリスト",
            h(
              "div",
              { class: "list" },
              current.photoInstructions.map((p, i) =>
                h(
                  "label",
                  { class: "row", style: { flexWrap: "nowrap", alignItems: "flex-start", padding: "4px 0", cursor: "pointer" } },
                  h("input", { type: "checkbox", checked: checked.has(i), style: { marginTop: "4px" }, onchange: (e) => (e.target.checked ? checked.add(i) : checked.delete(i)) }),
                  h("span", null, p.text, h("span", { class: "small faint" }, `（${p.skill}）`)),
                ),
              ),
            ),
            { sub: "スキルの撮影指示" },
          )
        : null,
    );
  }

  // ---------------- center column ----------------
  function renderCenter() {
    if (!current) {
      return mount(
        center,
        card(
          null,
          h(
            "div",
            { class: "empty", style: { padding: "56px 16px" } },
            h("h2", null, "顧客ID または 納品ID をスキャンしてください"),
            h("p", { class: "muted", style: { marginTop: "8px" } }, "顧客がアップロードした写真と申告内容がWMSから読み込まれ、この商品に合うスキルが自動で選ばれます。"),
          ),
        ),
      );
    }
    const editable = current.status !== "confirmed";
    const customerPhotos = current.photos.filter((p) => p.kind === "customer");
    const workerPhotos = current.photos.filter((p) => p.kind === "worker");
    const photoTile = (p, deletable) =>
      h(
        "div",
        { class: "photo" },
        h("img", { src: p.url, alt: p.label, loading: "lazy", onclick: () => lightbox(p.url, p.label) }),
        h("span", { class: "cap" }, p.label),
        deletable ? h("button", { class: "del", type: "button", title: "削除", "aria-label": `${p.label}を削除`, onclick: () => removePhoto(p.id) }, "×") : null,
      );

    const workerTools = editable
      ? h(
          "div",
          { class: "stack", style: { gap: "8px", marginTop: "10px" } },
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn", type: "button", onclick: openCamera }, "カメラで撮影"),
            h("button", { class: "btn", type: "button", title: "同梱のサンプル写真（現物写真）を追加します", onclick: addSamples }, "サンプル写真を使う（デモ）"),
          ),
          dropzone({ label: "写真をここにドロップ", accept: "image/*", onFiles: uploadFiles }),
        )
      : null;

    const judging = current.status === "queued" || current.status === "judging";
    const canJudge = editable && workerPhotos.length > 0 && !judging;

    mount(
      center,
      card(
        "写真の比較",
        h(
          "div",
          null,
          h(
            "div",
            { class: "compare" },
            h(
              "div",
              { class: "photo-panel" },
              h("h3", null, "顧客写真"),
              h("div", { class: "small muted", style: { margin: "-6px 0 8px" } }, "顧客がWMSにアップロードした写真"),
              customerPhotos.length ? h("div", { class: "photo-grid" }, customerPhotos.map((p) => photoTile(p, false))) : h("div", { class: "empty" }, "顧客写真がありません"),
            ),
            h(
              "div",
              { class: "photo-panel" },
              h("h3", null, "現物写真"),
              h("div", { class: "small muted", style: { margin: "-6px 0 8px" } }, "センターで撮影（証跡としてWMSにも保存）"),
              workerPhotos.length ? h("div", { class: "photo-grid" }, workerPhotos.map((p) => photoTile(p, editable))) : h("div", { class: "empty" }, "まだありません"),
              workerTools,
            ),
          ),
          editable
            ? h(
                "div",
                { class: "row", style: { marginTop: "14px" } },
                h("button", { class: "btn primary lg", type: "button", disabled: !canJudge, onclick: startJudge }, current.ai.result ? "AIで再判定する" : "AI照合を開始"),
                judging ? spinner("AIが判定中です。この間に次の商品をスキャンできます") : h("span", { class: "muted small" }, workerPhotos.length ? "スキルの基準で顧客写真と現物写真を比較します" : "現物写真を1枚以上追加してください"),
              )
            : null,
        ),
        { sub: `${current.shipmentId}・${current.customerName}` },
      ),
      renderJudgment(),
    );
  }

  function renderJudgment() {
    const ai = current.ai;
    if (current.status === "queued" || current.status === "judging") {
      return card("AI判定", h("div", { class: "empty" }, spinner(current.status === "queued" ? "判定の順番待ちです…" : "AIがスキルに従って判定しています…")));
    }
    const parts = [];
    if (current.status === "error") {
      parts.push(h("div", { class: "note-box ng", style: { marginBottom: "12px" } }, h("b", null, "AI判定でエラーが発生しました: "), ai.error ?? "不明なエラー", h("div", { class: "small" }, "写真を確認して再判定するか、人の判断で確定してください。")));
    }
    const r = ai.result;
    if (r) {
      const cls = { OK: "ok", NG: "ng", 要確認: "warn" }[r.overall];
      parts.push(
        h(
          "div",
          { class: `verdict ${cls}` },
          verdictBadge(r.overall, { lg: true }),
          h("div", null, h("div", { class: "summary" }, r.summary), h("div", { class: "small muted" }, `${ai.mode === "demo" ? "デモの模擬判定" : `AI（${ai.model}）`}・最低確信度 ${Math.round((ai.minConfidence ?? 0) * 100)}%・${fmtTime(ai.finishedAt)}`)),
        ),
        h(
          "table",
          { class: "tbl" },
          h("thead", null, h("tr", null, h("th", null, "判定項目"), h("th", null, "結果"), h("th", null, "確信度"), h("th", null, "理由"), h("th", null, "根拠"))),
          h(
            "tbody",
            null,
            r.checks.map((c) => h("tr", null, h("td", { class: "nowrap" }, h("b", null, c.item)), h("td", null, verdictBadge(c.result)), h("td", null, confidence(c.confidence)), h("td", null, c.reason), h("td", { class: "small muted" }, c.evidence.join("、") || "—"))),
          ),
        ),
      );
      if (r.issues.length) parts.push(h("div", { class: "note-box ng", style: { marginTop: "12px" } }, h("b", null, "見つかった問題"), h("ul", null, r.issues.map((i) => h("li", null, `［${i.type}］${i.detail}（${i.photo}）`)))));
      if (r.additional_photos.length) parts.push(h("div", { class: "note-box warn", style: { marginTop: "10px" } }, h("b", null, "追加で撮影すると判定できる写真"), h("ul", null, r.additional_photos.map((p) => h("li", null, p)))));
      if (r.skill_gaps.length) parts.push(h("div", { class: "note-box ai", style: { marginTop: "10px" } }, h("b", null, "スキルに基準がなく迷った点（学習・改善に送られます）"), h("ul", null, r.skill_gaps.map((g) => h("li", null, g)))));
      if (r.corrections?.length) parts.push(h("div", { class: "small muted", style: { marginTop: "8px" } }, "安全ルールによる補正: ", r.corrections.join(" / ")));
      if (r.routing_reasons?.length && current.status !== "confirmed") {
        parts.push(h("div", { class: "small muted", style: { marginTop: "6px" } }, "人の確認に回した理由: ", r.routing_reasons.join(" / ")));
      }
    } else if (current.status === "capturing") {
      parts.push(h("div", { class: "empty" }, "現物写真を追加して「AI照合を開始」を押すと、ここに判定が表示されます"));
    }

    if (current.status === "confirmed") parts.push(renderConfirmed());
    else if (current.photos.some((p) => p.kind === "worker")) parts.push(renderConfirmForm());

    return card("AI判定と確定", h("div", null, parts));
  }

  function renderConfirmed() {
    const hm = current.human;
    return h(
      "div",
      { class: "note-box", style: { marginTop: "14px" } },
      h("div", { class: "row" }, h("b", null, "確定済み"), verdictBadge(hm.overall), h("span", { class: "muted small" }, `${hm.by}・${fmtTime(hm.at)}`)),
      hm.note ? h("div", { style: { marginTop: "4px" } }, `メモ: ${hm.note}`) : null,
      h(
        "div",
        { class: "row", style: { marginTop: "8px" } },
        current.wms.registeredAt
          ? badge(`WMS登録済み（${fmtTime(current.wms.registeredAt)}）`, "ok")
          : h("span", { class: "row" }, badge("WMS未登録", "ng"), h("span", { class: "small" }, current.wms.error ?? ""), h("button", { class: "btn sm", type: "button", onclick: retryWms }, "WMSに再登録")),
        current.caseId ? h("a", { class: "btn sm", href: `#/cases/${current.caseId}` }, `顧客確認ケース ${current.caseId} を開く`) : null,
      ),
    );
  }

  function renderConfirmForm() {
    const note = h("textarea", { placeholder: "判断の理由・気づいた点（AIと違う判定にする場合は必須。スキルの改善に使われます）", style: { minHeight: "64px" } });
    const err = h("div", { class: "error-text", hidden: true });
    const aiOverall = current.ai.result?.overall;
    const submit = async (overall, btn) => {
      const differs = (aiOverall === "OK" || aiOverall === "NG") && aiOverall !== overall;
      if (differs && !note.value.trim()) {
        err.textContent = `AIの判定（${aiOverall}）と違う結果にする理由を書いてください。スキルの改善に使われます`;
        err.hidden = false;
        note.focus();
        return;
      }
      btn.disabled = true;
      const r = await act(() => post(`/api/inspections/${current.id}/confirm`, { overall, note: note.value }), overall === "NG" ? "NGで確定しました。顧客確認ケースを作成します" : `${overall}で確定し、WMSに登録しました`);
      btn.disabled = false;
      if (r) {
        setCurrent(r);
        refreshQueue();
        scanInput.focus();
      }
    };
    const b = (label, overall, cls) => {
      const btn = h("button", { class: `btn ${cls}`, type: "button", onclick: () => submit(overall, btn) }, label);
      return btn;
    };
    return h(
      "div",
      { style: { marginTop: "16px", paddingTop: "14px", borderTop: "1px solid var(--border)" } },
      h("div", { class: "section-title" }, "人が確定する（WMSに登録されます）"),
      note,
      err,
      h("div", { class: "row", style: { marginTop: "10px" } }, b("OKで確定", "OK", "ok"), b("NGで確定（顧客確認へ）", "NG", "ng"), b("保留にする", "保留", "warn")),
    );
  }

  // ---------------- actions ----------------
  async function uploadFiles(files) {
    if (!current) return;
    const form = new FormData();
    for (const f of files) form.append("files", f);
    const r = await act(() => api("POST", `/api/inspections/${current.id}/photos`, form));
    if (r) {
      if (r.failed.length) toast(`読み込めない写真がありました: ${r.failed.join("、")}（JPEG / PNG / WebP を使ってください）`, "error");
      setCurrent(r.inspection);
    }
  }

  async function addSamples() {
    const r = await act(() => post(`/api/inspections/${current.id}/sample-photos`), "サンプル写真を追加しました");
    if (r) setCurrent(r.inspection);
  }

  async function removePhoto(photoId) {
    const r = await act(() => del(`/api/inspections/${current.id}/photos/${photoId}`));
    if (r) setCurrent(r);
  }

  async function startJudge() {
    const r = await act(() => post(`/api/inspections/${current.id}/judge`));
    if (r) {
      setCurrent(r);
      refreshQueue();
      scanInput.focus();
      watchJudging(r.id);
    }
  }

  /** Checks the current inspection every second while the AI works, so results show promptly. */
  function watchJudging(id) {
    let tries = 0;
    const tick = async () => {
      if (disposed || current?.id !== id || tries++ > 300) return;
      await checkCurrent().catch(() => undefined);
      if (current?.id === id && (current.status === "queued" || current.status === "judging")) setTimeout(tick, 1000);
    };
    setTimeout(tick, 700);
  }

  async function checkCurrent() {
    if (!current || (current.status !== "queued" && current.status !== "judging")) return;
    const r = await get(`/api/inspections/${current.id}`);
    if (r.id !== current.id || (r.status === current.status && r.updatedAt === current.updatedAt)) return;
    setCurrent(r, false);
    if (r.status === "judged" || r.status === "confirmed") {
      refreshStatus();
      refreshQueue();
    }
    if (r.status === "judged" && r.routing === "human_review") toast(`${r.shipmentId} のAI判定: ${r.ai.overall}（人の確認待ち）`);
  }

  async function reresolve() {
    const before = current.skills.map((s) => `${s.id}@${s.version}`).join(",");
    const r = await act(() => post(`/api/inspections/${current.id}/reresolve`));
    if (!r) return;
    setCurrent(r);
    const after = r.skills.map((s) => `${s.id}@${s.version}`).join(",");
    toast(before === after ? "適用するスキルに変更はありません" : "スキルを選び直しました。AIで再判定してください", before === after ? "" : "ok");
  }

  async function retryWms() {
    const r = await act(() => post(`/api/inspections/${current.id}/register`));
    if (r) setCurrent(r);
  }

  function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("このブラウザではカメラを使えません。写真ファイルを追加してください", "error");
      return;
    }
    const video = h("video", { class: "camera", autoplay: true, playsinline: true, muted: true });
    const shots = h("div", { class: "row small muted" }, "撮影すると現物写真に追加されます");
    let stream = null;
    const stop = () => stream?.getTracks().forEach((t) => t.stop());
    const shoot = async () => {
      if (!video.videoWidth) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
      if (!blob) return;
      await uploadFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" })]);
      mount(shots, `${current.photos.filter((p) => p.kind === "worker").length} 枚になりました`);
    };
    openModal({
      title: "カメラで撮影",
      body: h("div", { class: "stack", style: { gap: "10px" } }, video, shots),
      footer: [h("button", { class: "btn primary", type: "button", onclick: shoot }, "撮影")],
      onClose: stop,
    });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        stream = s;
        video.srcObject = s;
      })
      .catch(() => toast("カメラを起動できませんでした。ブラウザのカメラ許可を確認するか、写真ファイルを追加してください", "error"));
  }

  // ---------------- queue ----------------
  let queue = [];
  function statusBadge(q) {
    if (q.status === "capturing") return badge("撮影中");
    if (q.status === "queued") return badge("判定待ち", "ai");
    if (q.status === "judging") return badge("AI判定中", "ai");
    if (q.status === "error") return badge("エラー", "ng");
    if (q.status === "judged") return h("span", { class: "row", style: { gap: "4px" } }, h("span", { class: "small muted" }, "AI"), verdictBadge(q.aiOverall), badge("確認待ち", "warn"));
    return h("span", { class: "row", style: { gap: "4px" } }, verdictBadge(q.humanOverall), h("span", { class: "small muted" }, q.routing === "auto_ok" ? "自動確定" : "確定"));
  }

  function renderQueue() {
    const waiting = queue.filter((q) => q.status === "judged" || q.status === "error").length;
    mount(
      queueBox,
      card(
        "検品キュー",
        queue.length
          ? h(
              "div",
              { class: "list", style: { margin: "-14px -16px" } },
              queue.map((q) =>
                h(
                  "a",
                  { class: `list-item ${current?.id === q.id ? "active" : ""}`, onclick: () => load(q.id) },
                  h(
                    "div",
                    { class: "row", style: { flexWrap: "nowrap", alignItems: "flex-start" } },
                    q.thumb ? h("img", { src: q.thumb, alt: "", style: { width: "52px", height: "39px", objectFit: "cover", borderRadius: "6px", border: "1px solid var(--border)" } }) : h("div", { style: { width: "52px", height: "39px", borderRadius: "6px", background: "var(--surface-2)", border: "1px solid var(--border)" } }),
                    h("div", { style: { minWidth: 0, flex: 1 } }, h("div", { class: "row between" }, h("span", { class: "title mono small" }, q.shipmentId), h("span", { class: "small faint" }, fmtTime(q.updatedAt))), h("div", { class: "small muted", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${q.customerName}・${q.category}`), h("div", { style: { marginTop: "4px" } }, statusBadge(q))),
                  ),
                ),
              ),
            )
          : h("div", { class: "empty" }, "まだ検品はありません"),
        { sub: waiting ? `人の確認待ち ${waiting}件` : "", class: "" },
      ),
    );
  }

  function renderQueueHighlight() {
    renderQueue();
  }

  async function refreshQueue() {
    queue = await get("/api/inspections?limit=30");
    renderQueue();
  }

  const stopPoll = poll(async () => {
    await refreshQueue();
    await checkCurrent();
  }, 2500);

  renderCenter();
  await refreshQueue();
  if (query.get("id")) await load(query.get("id"));
  else if (query.get("code")) await doScan(query.get("code"));
  if (!state.status) refreshStatus();
  scanInput.focus();

  return () => {
    disposed = true;
    stopPoll();
    document.removeEventListener("keydown", onGlobalKey);
  };
}
