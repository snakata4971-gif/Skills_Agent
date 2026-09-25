import { act, get, post } from "../api.js";
import { badge, card, confirmDialog, fmtDateTime, h, mount, openModal, renderDiff, renderMarkdown, splitFrontmatter } from "../ui.js";

export const LAYERS = [
  ["common", "共通"],
  ["category", "カテゴリ別"],
  ["customer", "顧客別"],
  ["operation", "端末・システム操作"],
  ["communication", "連絡"],
  ["disposition", "処理"],
];
const LAYER_LABEL = Object.fromEntries(LAYERS);
const VERSION_STATUS = { draft: ["下書き", "warn"], approved: ["公開中", "ok"], superseded: ["過去の版", ""], rejected: ["却下", "ng"] };
const SOURCE_LABEL = { seed: "初期データ", builder: "スキルビルダー", improvement: "改善エージェント", manual: "手で編集", rollback: "版の戻し" };

export async function render(root, { params }) {
  let layerFilter = "";
  let q = "";
  let skills = [];
  let selected = params.length >= 2 ? `${params[0]}/${params[1]}` : null;
  let tab = "content";
  const listBox = h("div", { class: "stack" });
  const detailBox = h("div");

  mount(
    root,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "スキルライブラリー"), h("p", null, "承認済みのスキルだけがエージェントに使われます。下書きは内容と差分を確認してから公開します。"))),
    h("div", { class: "grid-2" }, listBox, detailBox),
  );

  const search = h("input", { type: "search", placeholder: "スキルを検索（名前・説明・本文）", value: q });
  let timer = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      q = search.value.trim();
      loadList();
    }, 250);
  });
  const listInner = h("div");
  const layerRow = h("div", { class: "row", style: { marginTop: "8px", gap: "4px" } });
  const resolveCard = renderResolveTester();
  mount(listBox, h("section", { class: "card" }, h("div", { class: "card-body", style: { paddingBottom: "8px" } }, search, layerRow), listInner), resolveCard);

  function renderLayerButtons() {
    mount(
      layerRow,
      [["", "すべて"], ...LAYERS].map(([k, label]) =>
        h("button", { class: `btn sm ${layerFilter === k ? "primary" : ""}`, type: "button", onclick: () => { layerFilter = k; renderLayerButtons(); loadList(); } }, label),
      ),
    );
  }
  renderLayerButtons();

  async function loadList() {
    const params = new URLSearchParams();
    if (layerFilter) params.set("layer", layerFilter);
    if (q) params.set("q", q);
    params.set("all", "1");
    skills = await get(`/api/skills?${params}`);
    renderList();
  }

  function renderList() {
    if (!skills.length) {
      mount(listInner, h("div", { class: "empty" }, "該当するスキルはありません"));
      return;
    }
    const groups = LAYERS.map(([k, label]) => [label, skills.filter((s) => s.layer === k)]).filter(([, items]) => items.length);
    mount(
      listInner,
      groups.map(([label, items]) => [
        h("div", { class: "section-title", style: { padding: "0 14px", margin: "10px 0 4px" } }, label),
        h(
          "div",
          { class: "list", style: { borderTop: "1px solid var(--border)" } },
          items.map((s) =>
            h(
              "a",
              { class: `list-item ${s.id === selected ? "active" : ""}`, onclick: () => select(s.id) },
              h("div", { class: "row between" }, h("span", { class: "title" }, s.title), h("span", { class: "row", style: { gap: "4px" } }, s.draftCount ? badge(`下書き ${s.draftCount}`, "warn") : null, s.status === "deprecated" ? badge("廃止") : s.currentVersion ? badge(`v${s.currentVersion}`) : badge("未公開", "warn"))),
              h("div", { class: "small muted mono" }, s.id),
              s.usageCount ? h("div", { class: "small faint" }, `検品で ${s.usageCount} 回使用`) : null,
            ),
          ),
        ),
      ]),
    );
  }

  async function select(id) {
    selected = id;
    tab = "content";
    history.replaceState(null, "", `#/skills/${id}`);
    renderList();
    await loadDetail();
  }

  async function loadDetail() {
    if (!selected) {
      mount(detailBox, card(null, h("div", { class: "empty", style: { padding: "48px" } }, "左の一覧からスキルを選んでください")));
      return;
    }
    let skill;
    try {
      skill = await get(`/api/skills/${selected}`);
    } catch (e) {
      mount(detailBox, card(null, h("div", { class: "empty" }, e.message)));
      return;
    }
    renderDetail(skill);
  }

  function renderDetail(skill) {
    const current = skill.versions.find((v) => v.id === skill.currentVersionId);
    const drafts = skill.versions.filter((v) => v.status === "draft");
    const applies = Object.entries(skill.appliesTo ?? {}).flatMap(([k, vals]) =>
      (Array.isArray(vals) ? vals : []).map((v) => h("span", { class: "chip" }, h("span", { class: "small muted" }, { categories: "カテゴリ", customers: "顧客", purposes: "用途", instructions: "指示", systems: "システム" }[k] ?? k), h("b", null, v === "*" ? "すべて" : v))),
    );
    const tabs = [
      ["content", "内容"],
      ["history", `版の履歴（${skill.versions.length}）`],
      ["edit", "編集"],
    ];
    const tabBody = h("div");
    const renderTab = () => {
      if (tab === "content") mount(tabBody, current ? contentView(current.content) : h("div", { class: "empty" }, "公開中の版はありません。下書きを承認してください"));
      else if (tab === "history") mount(tabBody, historyView(skill));
      else mount(tabBody, editView(skill, current ?? skill.versions[0]));
    };
    renderTab();

    mount(
      detailBox,
      h(
        "div",
        { class: "stack" },
        card(
          skill.title,
          h(
            "div",
            null,
            h("div", { class: "row", style: { marginBottom: "8px" } }, badge(LAYER_LABEL[skill.layer] ?? skill.layer, "info"), skill.currentVersion ? badge(`公開中 v${skill.currentVersion}`, "ok") : badge("未公開", "warn"), skill.status === "deprecated" ? badge("廃止", "ng") : null, h("span", { class: "small muted mono" }, skill.id)),
            h("p", null, skill.description),
            applies.length ? h("div", { class: "row" }, applies) : null,
            h("div", { class: "small muted", style: { marginTop: "8px" } }, `担当: ${skill.owner || "—"}・公開日: ${fmtDateTime(skill.approvedAt)}・検品での使用: ${skill.usageCount}回`),
          ),
          {
            actions: h(
              "button",
              {
                class: "btn sm",
                type: "button",
                onclick: async () => {
                  const next = skill.status === "deprecated" ? "active" : "deprecated";
                  const ok = await confirmDialog({ title: next === "deprecated" ? "スキルを廃止" : "スキルを再開", message: next === "deprecated" ? "廃止するとエージェントに使われなくなります（履歴は残ります）。" : "エージェントが再び使えるようにします。", okText: next === "deprecated" ? "廃止する" : "再開する", okClass: next === "deprecated" ? "ng" : "primary" });
                  if (ok && (await act(() => post(`/api/skills/${skill.id}/status`, { status: next }), "更新しました"))) {
                    await loadList();
                    await loadDetail();
                  }
                },
              },
              skill.status === "deprecated" ? "再開する" : "廃止する",
            ),
          },
        ),
        drafts.length
          ? card(
              "承認待ちの下書き",
              h(
                "div",
                { class: "stack", style: { gap: "10px" } },
                drafts.map((d) =>
                  h(
                    "div",
                    { class: "note-box warn" },
                    h("div", { class: "row between" }, h("b", null, `v${d.version}`), h("span", { class: "small muted" }, `${SOURCE_LABEL[d.source] ?? d.source}・${d.created_by}・${fmtDateTime(d.created_at)}`)),
                    d.change_note ? h("div", { class: "small", style: { whiteSpace: "pre-wrap", margin: "4px 0 8px" } }, d.change_note) : null,
                    h(
                      "div",
                      { class: "row" },
                      h("button", { class: "btn sm", type: "button", onclick: () => showDiff(d, skill) }, "差分を見る"),
                      h("button", { class: "btn sm", type: "button", onclick: () => showVersion(d) }, "全文を見る"),
                      h("span", { class: "spacer" }),
                      h("button", { class: "btn sm", type: "button", onclick: () => reject(d) }, "却下"),
                      h("button", { class: "btn sm primary", type: "button", onclick: () => approve(d) }, "承認して公開"),
                    ),
                  ),
                ),
              ),
              { sub: "承認すると、次の検品からエージェントがこの版を使います" },
            )
          : null,
        h(
          "section",
          { class: "card" },
          h("div", { class: "card-head" }, h("div", { class: "seg" }, tabs.map(([k, label]) => h("button", { type: "button", class: tab === k ? "on" : "", onclick: (e) => { tab = k; [...e.currentTarget.parentElement.children].forEach((b) => b.classList.toggle("on", b === e.currentTarget)); renderTab(); } }, label)))),
          h("div", { class: "card-body" }, tabBody),
        ),
      ),
    );
  }

  function contentView(content) {
    const { yaml, body } = splitFrontmatter(content);
    return h("div", null, h("details", null, h("summary", { class: "small muted", style: { cursor: "pointer", marginBottom: "8px" } }, "設定（frontmatter）を表示"), h("div", { class: "frontmatter" }, yaml)), renderMarkdown(body));
  }

  function historyView(skill) {
    return h(
      "table",
      { class: "tbl" },
      h("thead", null, h("tr", null, h("th", null, "版"), h("th", null, "状態"), h("th", null, "作成"), h("th", null, "変更内容"), h("th", null, ""))),
      h(
        "tbody",
        null,
        skill.versions.map((v) =>
          h(
            "tr",
            null,
            h("td", { class: "mono nowrap" }, `v${v.version}`),
            h("td", null, badge(...(VERSION_STATUS[v.status] ?? [v.status, ""]))),
            h("td", { class: "small" }, SOURCE_LABEL[v.source] ?? v.source, h("div", { class: "faint" }, `${v.created_by}・${fmtDateTime(v.created_at)}`), v.approved_by ? h("div", { class: "faint" }, `承認: ${v.approved_by}`) : null),
            h("td", { class: "small", style: { whiteSpace: "pre-wrap", maxWidth: "320px" } }, v.change_note || "—"),
            h(
              "td",
              { class: "nowrap" },
              h("button", { class: "btn sm", type: "button", onclick: () => showVersion(v) }, "表示"),
              " ",
              v.id !== skill.currentVersionId ? h("button", { class: "btn sm", type: "button", onclick: () => showDiff(v, skill) }, "差分") : null,
              " ",
              v.status === "superseded" ? h("button", { class: "btn sm warn", type: "button", onclick: () => rollback(skill, v) }, "この版に戻す") : null,
            ),
          ),
        ),
      ),
    );
  }

  function editView(skill, base) {
    const text = h("textarea", { class: "code", value: base?.content ?? "", spellcheck: false });
    const note = h("input", { type: "text", placeholder: "変更内容のメモ（例: 箱のへこみの基準を追加）" });
    return h(
      "div",
      null,
      h("p", { class: "small muted" }, "編集内容は下書きとして保存され、承認するまでエージェントには使われません。name と metadata.layer は変更できません。"),
      text,
      h("div", { class: "row", style: { marginTop: "10px", flexWrap: "nowrap" } }, note, h("button", { class: "btn primary", type: "button", onclick: async () => {
        const r = await act(() => post(`/api/skills/${skill.id}/drafts`, { content: text.value, changeNote: note.value }), "下書きとして保存しました");
        if (r) {
          tab = "content";
          await loadList();
          await loadDetail();
        }
      } }, "下書きとして保存")),
    );
  }

  async function showDiff(v, skill) {
    try {
      const d = await get(`/api/skill-versions/${v.id}/diff${skill.currentVersionId ? `?against=${skill.currentVersionId}` : ""}`);
      openModal({ title: `差分（公開中の版 → v${v.version}）`, wide: true, body: renderDiff(d.lines) });
    } catch (e) {
      openModal({ title: "差分", body: h("p", null, e.message) });
    }
  }

  function showVersion(v) {
    openModal({ title: `v${v.version} の内容`, wide: true, body: contentView(v.content) });
  }

  async function approve(v) {
    const ok = await confirmDialog({ title: "承認して公開", message: `v${v.version} を公開します。次の検品からエージェントがこの版を使います。`, okText: "公開する" });
    if (ok && (await act(() => post(`/api/skill-versions/${v.id}/approve`), `v${v.version} を公開しました`))) {
      await loadList();
      await loadDetail();
    }
  }

  async function reject(v) {
    const ok = await confirmDialog({ title: "下書きを却下", message: `v${v.version} を却下します。`, okText: "却下する", okClass: "ng" });
    if (ok && (await act(() => post(`/api/skill-versions/${v.id}/reject`, { reason: "" }), "却下しました"))) {
      await loadList();
      await loadDetail();
    }
  }

  async function rollback(skill, v) {
    const ok = await confirmDialog({ title: "この版に戻す", message: `v${v.version} の内容を新しい版として公開します（履歴は残ります）。`, okText: "戻す", okClass: "warn" });
    if (ok && (await act(() => post(`/api/skills/${skill.id}/rollback`, { versionId: v.id }), `v${v.version} の内容に戻しました`))) {
      await loadList();
      await loadDetail();
    }
  }

  function renderResolveTester() {
    const customer = h("input", { type: "text", placeholder: "例: C-1002" });
    const category = h("input", { type: "text", placeholder: "例: おもちゃ / スニーカー" });
    const items = h("input", { type: "text", placeholder: "品名（任意）" });
    const out = h("div");
    const runTest = async () => {
      const p = new URLSearchParams({ customerId: customer.value, category: category.value, items: items.value });
      const r = await act(() => get(`/api/skills/resolve?${p}`));
      if (!r) return;
      mount(
        out,
        h(
          "div",
          { style: { marginTop: "10px" } },
          h("div", { class: "row" }, r.skills.map((s) => h("a", { class: "chip", href: `#/skills/${s.id}` }, h("span", { class: "small muted" }, LAYER_LABEL[s.layer]), h("b", null, s.title), h("span", { class: "small faint" }, `v${s.version}`)))),
          r.notes.length ? h("div", { class: `note-box ${r.missingCategory ? "warn" : "ai"}`, style: { marginTop: "8px" } }, r.notes.map((n) => h("div", null, n))) : h("div", { class: "small muted", style: { marginTop: "6px" } }, "顧客ID・カテゴリから確定的に引き当てました"),
        ),
      );
    };
    return card(
      "引き当てテスト",
      h("div", null, h("p", { class: "small muted" }, "スキャンした顧客・カテゴリで、どのスキルが使われるかを確認できます（作成依頼は登録されません）。"), h("label", { class: "field" }, h("span", null, "顧客ID"), customer), h("label", { class: "field" }, h("span", null, "カテゴリ"), category), h("label", { class: "field" }, h("span", null, "品名"), items), h("button", { class: "btn", type: "button", onclick: runTest }, "引き当てる"), out),
    );
  }

  await loadList();
  if (!selected && skills.length) selected = skills[0].id;
  await loadDetail();
  renderList();
}
