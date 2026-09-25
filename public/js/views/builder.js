import { act, del, get, getActor, navigate, poll, post, put, state, uploadWithProgress } from "../api.js";
import { badge, card, fmtDateTime, h, lightbox, mount, openModal, renderMarkdown, spinner, splitFrontmatter, toast } from "../ui.js";
import { LAYERS } from "./skills.js";

const LAYER_LABEL = Object.fromEntries(LAYERS);
const ACCEPT = "image/*,video/*,.heic,.heif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.tsv";
const FORMATS = ["写真（JPG・PNG・HEIC）", "動画（MP4・MOV など）", "PDF", "Word（.docx）", "Excel（.xlsx）", "PowerPoint（.pptx）", "テキスト・CSV"];
const STATUS = { new: ["資料の準備中", ""], generating: ["AIが作成中", "ai"], ready: ["下書きあり", "warn"], error: ["エラー", "ng"], saved: ["ライブラリーに保存済み", "ok"] };
const DOC_LABEL = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint", pdf: "PDF", csv: "CSV", tsv: "TSV", json: "JSON" };

const kindLabel = (m) => ({ image: "写真", video: "動画", pdf: "PDF", document: DOC_LABEL[m.format] ?? "文書", text: DOC_LABEL[m.format] ?? "テキスト" })[m.kind] ?? m.kind;
const duration = (sec) => {
  const s = Math.round(sec ?? 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const mb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);

function materialMeta(m) {
  if (m.kind === "video") return `${duration(m.duration)}・${m.frames.length}コマ`;
  if (m.kind === "pdf") return m.units ? `${m.units}ページ` : mb(m.size);
  if (m.kind === "document") {
    const unit = m.format === "pptx" && m.units ? `${m.units}枚` : m.format === "xlsx" && m.units ? `${m.units}シート` : "";
    return [unit, `${(m.textChars ?? 0).toLocaleString("ja-JP")}文字`, m.images.length ? `図${m.images.length}` : ""].filter(Boolean).join("・");
  }
  if (m.kind === "text") return `${(m.textChars ?? 0).toLocaleString("ja-JP")}文字`;
  return mb(m.size);
}

/** Drop zone that uploads with a progress bar; resolves with the server's JSON. */
function uploadZone({ big = false, title, hint, url, extraFields, onDone }) {
  const bar = h("i");
  const progress = h("div", { class: "progress", hidden: true }, bar);
  const status = h("div", { class: "small muted", style: { marginTop: "6px" }, hidden: true });
  const input = h("input", { type: "file", accept: ACCEPT, multiple: true, hidden: true, onchange: () => { if (input.files?.length) send(input.files); input.value = ""; } });
  let busy = false;
  async function send(files) {
    if (busy) return;
    busy = true;
    zone.classList.add("over");
    const form = new FormData();
    for (const f of files) form.append("files", f);
    for (const [k, v] of Object.entries(extraFields?.() ?? {})) form.append(k, v);
    const total = [...files].reduce((n, f) => n + f.size, 0);
    progress.hidden = false;
    status.hidden = false;
    progress.classList.remove("indeterminate");
    status.textContent = `${files.length}件（${mb(total)}）をアップロード中…`;
    try {
      const r = await uploadWithProgress(url(), form, (p) => {
        if (p === null) {
          progress.classList.add("indeterminate");
          status.textContent = "読み取り中…（動画はコマの切り出し、文書は文章と図の取り出しを行っています）";
        } else bar.style.width = `${Math.round(p * 100)}%`;
      });
      for (const rj of r.rejected ?? []) toast(`「${rj.name}」は追加できませんでした: ${rj.reason}`, "error");
      await onDone(r);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      busy = false;
      zone.classList.remove("over");
      progress.hidden = true;
      status.hidden = true;
      bar.style.width = "0";
    }
  }
  const zone = h(
    "div",
    {
      class: `dropzone ${big ? "big" : ""}`,
      ondragover: (e) => {
        e.preventDefault();
        zone.classList.add("over");
      },
      ondragleave: () => !busy && zone.classList.remove("over"),
      ondrop: (e) => {
        e.preventDefault();
        if (e.dataTransfer?.files?.length) send(e.dataTransfer.files);
      },
    },
    h("div", { class: "dz-title" }, title),
    hint ? h("div", { class: "small" }, hint) : null,
    h("div", { class: "formats" }, FORMATS.map((f) => h("span", { class: "chip" }, f))),
    h("button", { class: `btn ${big ? "primary" : ""}`, type: "button", style: { marginTop: "8px" }, onclick: () => input.click() }, "ファイルを選ぶ"),
    h("div", { class: "small faint", style: { marginTop: "8px" } }, "1ファイル1GBまで・一度に20ファイルまで"),
    progress,
    status,
    input,
  );
  return zone;
}

function suggestSlug(title, categories) {
  const ascii = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (ascii.length >= 3) return ascii.slice(0, 40);
  const words = { スニーカー: "sneakers", 靴: "shoes", トレカ: "trading-cards", アパレル: "apparel", おもちゃ: "toys", 家電: "electronics", コスメ: "cosmetics", 時計: "watches", バッグ: "bags", 本: "books", ゲーム: "games" };
  for (const [k, v] of Object.entries(words)) if (`${title} ${categories}`.includes(k)) return v;
  return `skill-${Math.random().toString(36).slice(2, 7)}`;
}

/** Fields shared by "new skill" and "edit target". */
function targetFields(prefill = {}) {
  const layer = h("select", null, LAYERS.map(([k, label]) => h("option", { value: k, selected: k === (prefill.layer ?? "category") }, label)));
  const title = h("input", { type: "text", placeholder: "例: スニーカー検品", value: prefill.title ?? "" });
  const provisional = !prefill.name || String(prefill.name).startsWith("draft-");
  const slug = h("input", { type: "text", placeholder: "例: sneakers", value: provisional ? "" : prefill.name });
  const categories = h("input", { type: "text", placeholder: "例: スニーカー, 靴", value: (prefill.categories ?? []).join(", ") });
  const customers = h("input", { type: "text", placeholder: "例: C-1002（顧客別スキルの場合）", value: (prefill.customers ?? []).join(", ") });
  const owner = h("input", { type: "text", value: prefill.owner ?? getActor() });
  let slugTouched = !provisional;
  slug.addEventListener("input", () => (slugTouched = true));
  const autoSlug = () => {
    if (!slugTouched) slug.value = suggestSlug(title.value, categories.value);
  };
  title.addEventListener("input", autoSlug);
  categories.addEventListener("input", autoSlug);
  autoSlug();
  const el = h(
    "div",
    null,
    h("label", { class: "field" }, h("span", null, "スキルの種類"), layer, h("small", null, "検品の判断基準なら「カテゴリ別」、特定の顧客のルールなら「顧客別」、WMSなど端末の操作手順なら「端末・システム操作」")),
    h("label", { class: "field" }, h("span", null, "スキルの名前"), title),
    h("label", { class: "field" }, h("span", null, "識別名（半角英小文字）"), slug, h("small", null, "システム内で使う名前です。同じ種類・識別名のスキルがある場合は、その新しい版になります")),
    h("label", { class: "field" }, h("span", null, "対象カテゴリ（カンマ区切り）"), categories, h("small", null, "スキャンした納品のカテゴリがこれに一致すると自動で使われます")),
    h("label", { class: "field" }, h("span", null, "対象顧客ID（カンマ区切り）"), customers),
    h("label", { class: "field" }, h("span", null, "担当者"), owner),
  );
  return {
    el,
    focus: () => title.focus(),
    values: () => {
      autoSlug();
      return { layer: layer.value, title: title.value, name: slug.value, categories: categories.value, customers: customers.value, owner: owner.value };
    },
  };
}

export async function render(root, { params }) {
  let sessionId = params[0] ?? null;
  let session = null;
  const sideBox = h("div", { class: "stack" });
  const mainBox = h("div");

  mount(
    root,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "スキルビルダー"), h("p", null, "写真・動画・文書をアップロードすると、AIが中身を読み取ってスキルの下書きとベテランへの質問を作ります。回答すると下書きに反映されます。"))),
    h("div", { class: "grid-2 main-first" }, sideBox, mainBox),
  );

  async function loadSide() {
    const [requests, sessions] = await Promise.all([get("/api/builder/requests"), get("/api/builder/sessions")]);
    const open = requests.filter((r) => r.status !== "done");
    mount(
      sideBox,
      card(null, h("div", { class: "stack", style: { gap: "8px" } }, h("button", { class: "btn primary block", type: "button", onclick: () => navigate("#/builder") }, "資料からスキルを作る"), h("button", { class: "btn block", type: "button", onclick: () => openNew() }, "項目を指定して作る"))),
      card(
        "作成依頼",
        open.length
          ? h(
              "div",
              { class: "list", style: { margin: "-14px -16px" } },
              open.map((r) =>
                h(
                  "div",
                  { class: "list-item", style: { cursor: "default" } },
                  h("div", { class: "row between" }, h("span", { class: "title" }, r.category || "（カテゴリなし）"), badge(r.status === "open" ? "未着手" : "作成中", r.status === "open" ? "warn" : "info")),
                  h("div", { class: "small muted" }, r.reason),
                  h("div", { class: "small faint" }, `${r.id}・${fmtDateTime(r.created_at)}${r.inspection_id ? `・検品 ${r.inspection_id}` : ""}`),
                  h("button", { class: "btn sm", type: "button", style: { marginTop: "6px" }, onclick: async () => { const s = await act(() => post(`/api/builder/requests/${r.id}/session`)); if (s) navigate(`#/builder/${s.id}`); } }, r.session_id ? "作成を続ける" : "このスキルを作る"),
                ),
              ),
            )
          : h("div", { class: "empty" }, "スキルがない商品が検品されると、ここに依頼が届きます"),
        { sub: "専用スキルがなかった商品" },
      ),
      card(
        "作成セッション",
        sessions.length
          ? h(
              "div",
              { class: "list", style: { margin: "-14px -16px" } },
              sessions.map((s) =>
                h(
                  "a",
                  { class: `list-item ${s.id === sessionId ? "active" : ""}`, href: `#/builder/${s.id}` },
                  h("div", { class: "row between" }, h("span", { class: "title" }, s.title), badge(...STATUS[s.status])),
                  h("div", { class: "small muted" }, `${LAYER_LABEL[s.target.layer] ?? ""}・資料${s.materialCount}件・${fmtDateTime(s.updatedAt)}`),
                ),
              ),
            )
          : h("div", { class: "empty" }, "まだありません"),
      ),
    );
  }

  function openNew() {
    const fields = targetFields();
    const notes = h("textarea", { placeholder: "ベテランの口頭のコツ・注意点など（任意）" });
    const err = h("div", { class: "error-text", hidden: true });
    const create = async () => {
      try {
        const s = await post("/api/builder/sessions", { target: fields.values(), notes: notes.value });
        m.close();
        navigate(`#/builder/${s.id}`);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    };
    const m = openModal({
      title: "項目を指定して新しいスキルを作る",
      body: h("div", null, fields.el, h("label", { class: "field" }, h("span", null, "ベテランのメモ"), notes), err),
      footer: [h("button", { class: "btn primary", type: "button", onclick: create }, "作成して資料を追加する")],
    });
    fields.focus();
  }

  function editTarget() {
    const fields = targetFields(session.target);
    const err = h("div", { class: "error-text", hidden: true });
    const save = async () => {
      try {
        session = await put(`/api/builder/sessions/${session.id}/target`, fields.values());
        m.close();
        toast("スキルの名前・対象を更新しました", "ok");
        renderSession();
        loadSide();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
      }
    };
    const m = openModal({
      title: "スキルの名前・対象を編集",
      body: h("div", null, fields.el, session.draft ? h("p", { class: "small muted" }, "下書きの本文はそのままで、設定（名前・対象）だけを書き換えます。") : null, err),
      footer: [h("button", { class: "btn primary", type: "button", onclick: save }, "保存")],
    });
    fields.focus();
  }

  function renderHome() {
    const notes = h("textarea", { placeholder: "ベテランのメモ（任意）: 口頭のコツ、よくあるミス、例外など", style: { minHeight: "70px" } });
    mount(
      mainBox,
      h(
        "div",
        { class: "stack" },
        card(
          "資料からスキルを作る",
          h(
            "div",
            null,
            h("p", null, "作業手順のPOPや掲示物の写真、手順書（Word・PDF）、チェック表（Excel）、研修資料（PowerPoint）、作業動画を、まとめてドロップしてください。"),
            h("p", { class: "muted small" }, "アップロード後に中身（動画のコマ・文書から取り出した文章）を確認し、資料ごとに説明を付けてから「AIで下書きを作る」を押します。スキルの名前と対象カテゴリは、AIが資料から提案します（あとで変更できます）。"),
            uploadZone({
              big: true,
              title: "ここに資料をドロップ",
              url: () => "/api/builder/quick",
              extraFields: () => ({ notes: notes.value }),
              onDone: (r) => {
                toast(`資料を${r.session.materials.length}件読み込みました`, "ok");
                navigate(`#/builder/${r.session.id}`);
              },
            }),
            h("label", { class: "field", style: { marginTop: "12px" } }, h("span", null, "メモ"), notes),
          ),
        ),
        card(
          "スキルができるまで",
          h(
            "ol",
            { style: { margin: 0, paddingLeft: "20px", lineHeight: 2 } },
            h("li", null, "資料をアップロード（写真・動画・文書をまとめて）"),
            h("li", null, "中身を確認し、資料ごとに説明を付ける（例:「検品台のPOP」「端末の登録画面の操作動画」）"),
            h("li", null, "AIが下書きと、資料に書かれていない点についての質問を作る"),
            h("li", null, "ベテランが質問に答えると、基準が下書きに反映される"),
            h("li", null, "スキルライブラリーに保存し、内容を確認して承認すると検品で使われる"),
          ),
        ),
      ),
    );
  }

  async function loadSession() {
    if (!sessionId) return renderHome();
    session = await get(`/api/builder/sessions/${sessionId}`);
    renderSession();
  }

  function showMaterial(m) {
    if (m.kind === "image") return lightbox(m.preview ?? m.url, m.name);
    if (m.kind === "pdf") return window.open(m.url, "_blank", "noopener");
    if (m.kind === "video") {
      return openModal({
        title: `${m.name}（${duration(m.duration)}）`,
        wide: true,
        body: h(
          "div",
          null,
          h("p", { class: "small muted" }, `場面が切り替わったところを中心に ${m.frames.length} コマを切り出し、時刻つきでAIに渡します。音声（ナレーション）は読み取れないため、補足は資料の説明かメモに書いてください。`),
          h("div", { class: "frames" }, m.frames.map((f, i) => h("figure", null, h("img", { src: f.url, alt: `コマ${i + 1}`, onclick: () => lightbox(f.url, `コマ${i + 1}（${f.label}）`) }), h("figcaption", null, `コマ${i + 1}・${f.label}`)))),
          h("p", { style: { marginTop: "10px" } }, h("a", { href: m.url, target: "_blank", rel: "noopener" }, "元の動画を開く")),
        ),
      });
    }
    openModal({
      title: m.name,
      wide: true,
      body: h(
        "div",
        null,
        h("div", { class: "section-title" }, `AIに渡す文章（${(m.textChars ?? 0).toLocaleString("ja-JP")}文字${m.textChars > 4000 ? "。ここには先頭4,000文字を表示" : ""}）`),
        h("pre", { class: "extracted" }, m.textPreview || "（文字なし）"),
        m.images.length
          ? h("div", null, h("div", { class: "section-title" }, `文書の中の図（${m.images.length}枚）`), h("div", { class: "frames" }, m.images.map((img) => h("figure", null, h("img", { src: img.url, alt: img.label, onclick: () => lightbox(img.url, img.label) }), h("figcaption", null, img.label)))))
          : null,
        h("p", { style: { marginTop: "10px" } }, h("a", { href: m.url, target: "_blank", rel: "noopener" }, "元のファイルを開く")),
      ),
    });
  }

  function materialCard(m, editable) {
    const desc = h("input", {
      type: "text",
      value: m.description,
      placeholder: "説明（例: 検品台のPOP）",
      disabled: !editable,
      onchange: async () => {
        const r = await act(() => put(`/api/builder/sessions/${session.id}/materials/${m.id}`, { description: desc.value }));
        if (r) session = r;
      },
    });
    return h(
      "div",
      { class: "material" },
      h(
        "div",
        { class: "thumb", title: "中身を確認", onclick: () => showMaterial(m) },
        m.preview ? h("img", { src: m.preview, alt: m.name, loading: "lazy" }) : h("span", { class: "doc" }, kindLabel(m)),
        h("span", { class: "kind" }, m.kind === "video" ? "▶ 動画" : kindLabel(m)),
        h("span", { class: "meta" }, materialMeta(m)),
        editable ? h("button", { class: "del", type: "button", title: "削除", "aria-label": `${m.name}を削除`, onclick: (e) => { e.stopPropagation(); removeMaterial(m.id); } }, "×") : null,
      ),
      h("div", { class: "info" }, h("div", { class: "name", title: m.name }, m.name), desc, (m.notes ?? []).map((n) => h("div", { class: "warn" }, n))),
    );
  }

  function renderSession() {
    const s = session;
    const generating = s.status === "generating";
    const editable = s.status !== "saved" && !generating;
    const provisional = s.target.auto || String(s.target.name).startsWith("draft-");
    const notes = h("textarea", { value: s.notes, placeholder: "ベテランの口頭のコツ・注意点・例外など", disabled: !editable });
    const answerInputs = new Map();
    const { body } = splitFrontmatter(s.draft);
    const live = state.status?.ai.mode === "live";

    mount(
      mainBox,
      h(
        "div",
        { class: "stack" },
        card(
          s.title,
          h(
            "div",
            null,
            h(
              "div",
              { class: "row" },
              badge(LAYER_LABEL[s.target.layer] ?? s.target.layer, "info"),
              provisional ? badge("名前・対象は仮", "warn") : h("span", { class: "mono small muted" }, `${s.target.layer}/${s.target.name}`),
              s.target.skillId && !provisional ? badge("既存スキルの改訂", "warn") : null,
              s.target.categories.length ? h("span", { class: "small muted" }, `カテゴリ: ${s.target.categories.join("、")}`) : null,
              s.target.customers.length ? h("span", { class: "small muted" }, `顧客: ${s.target.customers.join("、")}`) : null,
            ),
            provisional && s.status !== "saved" ? h("p", { class: "small muted", style: { margin: "8px 0 0" } }, "スキルの名前と対象カテゴリは、下書きを作るときにAIが資料から提案します。自分で決める場合は「名前・対象を編集」から設定してください。") : null,
            s.error ? h("div", { class: "note-box ng", style: { marginTop: "10px" } }, s.error) : null,
          ),
          { actions: h("span", { class: "row" }, badge(...STATUS[s.status]), editable ? h("button", { class: "btn sm", type: "button", onclick: editTarget }, "名前・対象を編集") : null) },
        ),
        card(
          "1. 資料",
          h(
            "div",
            null,
            s.materials.length ? h("div", { class: "materials" }, s.materials.map((m) => materialCard(m, editable))) : h("div", { class: "empty" }, "まだ資料がありません"),
            editable
              ? h(
                  "div",
                  { style: { marginTop: "12px" } },
                  uploadZone({
                    title: "資料を追加（ドロップまたは選択）",
                    url: () => `/api/builder/sessions/${s.id}/materials`,
                    onDone: (r) => {
                      session = r.session;
                      renderSession();
                      loadSide();
                    },
                  }),
                )
              : null,
            h("label", { class: "field", style: { marginTop: "12px" } }, h("span", null, "ベテランのメモ"), notes),
            editable
              ? h(
                  "div",
                  { class: "row" },
                  h("button", { class: "btn", type: "button", onclick: async () => { const r = await act(() => put(`/api/builder/sessions/${s.id}/notes`, { notes: notes.value }), "メモを保存しました"); if (r) session = r; } }, "メモを保存"),
                  h("span", { class: "spacer" }),
                  h("button", { class: "btn primary", type: "button", disabled: s.materials.length === 0 && !s.notes.trim(), onclick: async () => {
                    await put(`/api/builder/sessions/${s.id}/notes`, { notes: notes.value }).catch(() => undefined);
                    const r = await act(() => post(`/api/builder/sessions/${s.id}/generate`));
                    if (r) { session = r; renderSession(); }
                  } }, s.draft ? "資料から下書きを作り直す" : "AIで下書きを作る"),
                )
              : null,
            editable && !live ? h("p", { class: "small faint", style: { marginTop: "6px" } }, "デモモード（AI未接続）では、文書から取り出した文章をテンプレートに差し込みます。写真・動画の中身は AI を接続すると読み取ります。") : null,
          ),
          { sub: "中身を確認するには資料をクリック。説明を付けるとAIが資料の位置づけを理解しやすくなります" },
        ),
        generating
          ? card("2. 下書き", h("div", { class: "empty" }, spinner("AIが資料を読み、下書きと質問を作っています（資料が多いと数分かかることがあります）")))
          : s.draft
            ? draftCard(s, body)
            : null,
        !generating && s.questions.length && s.status !== "saved"
          ? card(
              "3. ベテランへの質問",
              h(
                "div",
                null,
                h("p", { class: "small muted" }, "資料に書かれていない判断基準についての質問です。答えられるものだけ回答してください。"),
                s.questions.map((q, i) => {
                  const input = h("textarea", { style: { minHeight: "60px" }, placeholder: "回答" });
                  answerInputs.set(q.id, input);
                  return h("div", { style: { marginBottom: "14px" } }, h("div", null, h("b", null, `Q${i + 1}. `), q.question), h("div", { class: "small faint", style: { margin: "2px 0 6px" } }, q.why), input);
                }),
                h("button", { class: "btn primary", type: "button", onclick: async () => {
                  const answers = Object.fromEntries([...answerInputs].map(([k, el]) => [k, el.value]));
                  const r = await act(() => post(`/api/builder/sessions/${s.id}/answers`, { answers }));
                  if (r) { session = r; renderSession(); }
                } }, "回答を反映して更新"),
              ),
              { sub: `${s.questions.length}問` },
            )
          : null,
        s.draft && !generating ? saveCard(s, provisional) : null,
        s.history.length ? card("作成の履歴", h("ul", { class: "timeline" }, s.history.slice().reverse().map((x) => h("li", null, h("div", null, h("b", null, x.action), x.note ? `：${x.note}` : ""), h("div", { class: "meta" }, fmtDateTime(x.at)))))) : null,
      ),
    );
  }

  function draftCard(s, body) {
    const view = h("div");
    let editing = false;
    const show = () => {
      if (!editing) {
        mount(view, s.validation ? h("div", { class: "note-box ng", style: { marginBottom: "10px" } }, `形式の誤り: ${s.validation}`) : null, renderMarkdown(body));
        return;
      }
      const text = h("textarea", { class: "code", value: s.draft, spellcheck: false });
      mount(
        view,
        text,
        h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn", type: "button", onclick: () => { editing = false; show(); } }, "やめる"), h("button", { class: "btn primary", type: "button", onclick: async () => { const r = await act(() => put(`/api/builder/sessions/${s.id}/draft`, { draft: text.value }), "下書きを保存しました"); if (r) { session = r; renderSession(); } } }, "保存")),
      );
    };
    show();
    return card("2. 下書き", view, {
      sub: s.mode === "demo" ? "デモモード（テンプレートに資料の文章を差し込み）" : "AIが作成",
      actions: s.status !== "saved" ? h("button", { class: "btn sm", type: "button", onclick: () => { editing = !editing; show(); } }, "手で編集") : null,
    });
  }

  function saveCard(s, provisional) {
    if (s.status === "saved") {
      return card(
        "4. ライブラリーに保存済み",
        h("div", null, h("p", null, "スキルライブラリーに下書きとして保存しました。内容と差分を確認し、承認して公開すると検品で使われます。"), h("a", { class: "btn primary", href: `#/skills/${s.target.skillId}` }, "スキルライブラリーで確認・承認する")),
      );
    }
    return card(
      "4. ライブラリーに保存",
      h(
        "div",
        null,
        provisional
          ? h("div", { class: "note-box warn", style: { marginBottom: "10px" } }, "スキルの名前と識別名がまだ仮です。保存する前に決めてください。", h("div", { style: { marginTop: "6px" } }, h("button", { class: "btn sm", type: "button", onclick: editTarget }, "名前・対象を編集")))
          : h("p", { class: "small muted" }, "保存しても、承認するまでエージェントには使われません。"),
        h("button", { class: "btn primary", type: "button", disabled: Boolean(s.validation) || provisional, onclick: async () => {
          const r = await act(() => post(`/api/builder/sessions/${s.id}/save`), "ライブラリーに下書きとして保存しました");
          if (r) { session = r.session; renderSession(); loadSide(); }
        } }, "スキルライブラリーに下書き保存"),
      ),
    );
  }

  async function removeMaterial(mid) {
    const r = await act(() => del(`/api/builder/sessions/${session.id}/materials/${mid}`));
    if (r) {
      session = r;
      renderSession();
    }
  }

  const stop = poll(async () => {
    if (session?.status === "generating") {
      const r = await get(`/api/builder/sessions/${session.id}`);
      if (r.status !== "generating") {
        session = r;
        renderSession();
        loadSide();
        if (r.status === "ready") toast("下書きができました", "ok");
      }
    }
  }, 2000);

  await loadSide();
  await loadSession();
  return stop;
}
