import { act, get, poll, post } from "../api.js";
import { badge, card, confirmDialog, fmtDateTime, h, mount, renderDiff, renderMarkdown, spinner, verdictBadge } from "../ui.js";

const PROPOSAL_STATUS = {
  generating: ["作成中", "ai"],
  proposed: ["提案", "warn"],
  testing: ["テスト中", "ai"],
  tested: ["テスト済み", "info"],
  approved: ["公開済み", "ok"],
  rejected: ["却下", ""],
  error: ["作成失敗", "ng"],
};
const PURPOSE = {
  inspection_judgment: "検品の判定",
  skill_draft: "スキルの下書き",
  skill_refine: "下書きの更新",
  skill_improvement: "スキルの改善案",
  selector_fix: "操作スキルの修正案",
  email_draft: "確認メール",
  reply_classification: "返信の読み取り",
  skill_selection: "スキルの選定",
};
const KIND_CLASS = { 見逃し: "ng", 過検出: "warn", "AIが要確認→人が判断": "ai" };

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export async function render(root, { params }) {
  let selectedProposal = params[0] ?? null;
  const kpiBox = h("div");
  const skillBox = h("div");
  const proposalList = h("div");
  const proposalDetail = h("div");
  const casesBox = h("div");
  const gapsBox = h("div");
  const errorsBox = h("div");
  const costBox = h("div");

  mount(
    root,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "学習・改善"), h("p", null, "人がAIと違う判断をした検品・AIが迷った点・WMSの操作エラーから、スキルの改善案を作ります。改善案は過去の検品でテストし、承認すると公開されます。"))),
    h(
      "div",
      { class: "stack" },
      kpiBox,
      skillBox,
      h("div", { class: "grid-2" }, proposalList, proposalDetail),
      casesBox,
      h("div", { class: "grid-2", style: { gridTemplateColumns: "1fr 1fr" } }, gapsBox, errorsBox),
      costBox,
    ),
  );

  async function loadMetrics() {
    const [m, cases, gaps, errors] = await Promise.all([get("/api/learning/metrics"), get("/api/learning/cases"), get("/api/learning/gaps"), get("/api/learning/operation-errors")]);
    const o = m.overall;
    const kpi = (label, value, hint, alert = false, unit = "") => h("div", { class: `card kpi ${alert ? "alert" : ""}` }, h("div", { class: "label" }, label), h("div", { class: "value" }, value, unit ? h("small", null, unit) : null), h("div", { class: "hint" }, hint));
    mount(
      kpiBox,
      h(
        "div",
        { class: "grid-cards" },
        kpi("AIが判定", o.judged, "判定した検品の数", false, "件"),
        kpi("人が確定", o.confirmed, "確定した検品の数", false, "件"),
        kpi("人との一致率", pct(o.agree, o.compared), `OK/NGで比べられた ${o.compared} 件のうち`),
        kpi("見逃し", o.miss, "AIがOK → 人がNG（最も重い失敗）", o.miss > 0, "件"),
        kpi("過検出", o.falseAlarm, "AIがNG → 人がOK", false, "件"),
        kpi("AIが要確認", o.aiUnsure, "AIが判断を人に回した", false, "件"),
        kpi("自動OK", o.autoOk, "並走運用OFF時に自動確定", false, "件"),
      ),
    );

    mount(
      skillBox,
      card(
        "スキル別の成績",
        m.perSkill.length
          ? h(
              "table",
              { class: "tbl" },
              h("thead", null, h("tr", null, h("th", null, "スキル"), h("th", null, "判定"), h("th", null, "一致率"), h("th", null, "見逃し"), h("th", null, "過検出"), h("th", null, "AIが要確認"), h("th", null, ""))),
              h(
                "tbody",
                null,
                m.perSkill.map((s) =>
                  h(
                    "tr",
                    null,
                    h("td", null, h("a", { href: `#/skills/${s.id}` }, s.title), h("div", { class: "small faint mono" }, `${s.id} v${s.version}`)),
                    h("td", null, s.stats.judged),
                    h("td", null, pct(s.stats.agree, s.stats.compared)),
                    h("td", null, s.stats.miss ? badge(s.stats.miss, "ng") : "0"),
                    h("td", null, s.stats.falseAlarm),
                    h("td", null, s.stats.aiUnsure),
                    h("td", { class: "nowrap" }, s.id.startsWith("common/") || s.id.startsWith("category/") || s.id.startsWith("customer/") ? h("button", { class: "btn sm", type: "button", onclick: () => propose(s.id) }, "改善案を作る") : null),
                  ),
                ),
              ),
            )
          : h("div", { class: "empty" }, "まだ検品の実績がありません。検品画面でAI判定と確定を行うと集計されます"),
        { sub: "改善案は、人の判定メモとAIが迷った点から作られます" },
      ),
    );

    mount(
      casesBox,
      card(
        "学習材料（人がAIと違う判断をした検品）",
        cases.length
          ? h(
              "table",
              { class: "tbl" },
              h("thead", null, h("tr", null, h("th", null, "種類"), h("th", null, "検品"), h("th", null, "AI"), h("th", null, "人"), h("th", null, "人のメモ（改善に使われる）"), h("th", null, "使用スキル"))),
              h(
                "tbody",
                null,
                cases.map((c) =>
                  h(
                    "tr",
                    null,
                    h("td", null, badge(c.kind, KIND_CLASS[c.kind])),
                    h("td", { class: "nowrap" }, h("a", { href: `#/station?id=${c.inspectionId}` }, c.inspectionId), h("div", { class: "small faint" }, `${c.shipmentId}・${c.category}`)),
                    h("td", null, verdictBadge(c.aiOverall), h("div", { class: "small muted" }, c.aiSummary)),
                    h("td", null, verdictBadge(c.humanOverall)),
                    h("td", null, c.humanNote || h("span", { class: "faint" }, "（メモなし）")),
                    h("td", { class: "small" }, c.skills.map((s) => h("div", null, `${s.title} v${s.version}`))),
                  ),
                ),
              ),
            )
          : h("div", { class: "empty" }, "まだありません。AIの判定と違う結果で確定するとき、理由をメモに書くとここに集まります"),
      ),
    );

    mount(
      gapsBox,
      card(
        "AIが迷った点（スキルに基準がない）",
        gaps.length ? h("table", { class: "tbl compact" }, h("tbody", null, gaps.map((g) => h("tr", null, h("td", null, g.gap), h("td", { class: "nowrap small muted" }, `${g.count}件`))))) : h("div", { class: "empty" }, "まだありません"),
      ),
    );

    mount(
      errorsBox,
      card(
        "WMS操作エラー（画面の変化）",
        errors.length
          ? h(
              "div",
              null,
              h(
                "table",
                { class: "tbl compact" },
                h("tbody", null, errors.slice(0, 8).map((e) => h("tr", null, h("td", { class: "small nowrap" }, fmtDateTime(e.created_at)), h("td", { class: "small" }, e.step, h("div", { class: "faint mono" }, `見つからない要素: ${e.missing.join(", ")}`))))),
              ),
              h("button", { class: "btn sm primary", type: "button", style: { marginTop: "10px" }, onclick: () => propose("operation/wms-browser-operation") }, "操作スキルの修正案を作る"),
            )
          : h("div", { class: "empty" }, "未解決のエラーはありません（ブラウザ自動操作モードで記録されます）"),
      ),
    );

    mount(
      costBox,
      card(
        "AIの利用量（概算）",
        m.cost.length
          ? h(
              "table",
              { class: "tbl" },
              h("thead", null, h("tr", null, h("th", null, "用途"), h("th", null, "回数"), h("th", null, "失敗"), h("th", null, "トークン"), h("th", null, "概算費用"))),
              h("tbody", null, m.cost.map((c) => h("tr", null, h("td", null, PURPOSE[c.purpose] ?? c.purpose), h("td", null, c.calls), h("td", null, c.errors), h("td", null, c.tokens.toLocaleString("ja-JP")), h("td", null, `$${c.usd.toFixed(3)}`, c.calls ? h("span", { class: "small muted" }, `（1回 $${(c.usd / c.calls).toFixed(4)}）`) : null)))),
            )
          : h("div", { class: "empty" }, "AIの呼び出しはまだありません（デモモードではAIを呼び出しません）"),
        { sub: "料金表をもとにした目安です。実際の請求はAnthropicのコンソールで確認してください" },
      ),
    );
  }

  let proposals = [];
  async function loadProposals() {
    proposals = await get("/api/learning/proposals");
    if (!selectedProposal && proposals.length) selectedProposal = proposals[0].id;
    mount(
      proposalList,
      card(
        "改善案",
        proposals.length
          ? h(
              "div",
              { class: "list", style: { margin: "-14px -16px" } },
              proposals.map((p) =>
                h(
                  "a",
                  { class: `list-item ${p.id === selectedProposal ? "active" : ""}`, onclick: () => { selectedProposal = p.id; history.replaceState(null, "", `#/learning/${p.id}`); loadProposals(); loadDetail(); } },
                  h("div", { class: "row between" }, h("span", { class: "title mono" }, p.id), badge(...PROPOSAL_STATUS[p.status])),
                  h("div", { class: "small" }, p.skillId),
                  h("div", { class: "small faint" }, `${fmtDateTime(p.createdAt)}${p.mode === "demo" ? "・デモ" : ""}`),
                ),
              ),
            )
          : h("div", { class: "empty" }, "「改善案を作る」を押すと、ここに表示されます"),
      ),
    );
  }

  async function loadDetail() {
    if (!selectedProposal) {
      mount(proposalDetail, card(null, h("div", { class: "empty", style: { padding: "40px" } }, "改善案を選んでください")));
      return;
    }
    const p = await get(`/api/learning/proposals/${selectedProposal}`);
    const busy = p.status === "generating" || p.status === "testing";
    const canAct = p.status === "proposed" || p.status === "tested";
    mount(
      proposalDetail,
      card(
        `改善案 ${p.id}`,
        h(
          "div",
          null,
          h("div", { class: "row", style: { marginBottom: "10px" } }, badge(...PROPOSAL_STATUS[p.status]), h("a", { href: `#/skills/${p.skill_id}` }, p.skill_id), p.base && p.draft ? h("span", { class: "small muted" }, `v${p.base.version} → v${p.draft.version}`) : null, p.mode === "demo" ? badge("デモ", "warn") : badge("AI", "ai")),
          p.status === "generating" ? h("div", { class: "empty" }, spinner("改善エージェントが材料を分析しています…")) : null,
          p.error ? h("div", { class: "note-box ng", style: { marginBottom: "10px" } }, p.error) : null,
          p.rationale ? h("div", { class: "note-box ai", style: { marginBottom: "10px" } }, h("b", null, "改善の理由"), h("div", null, p.rationale)) : null,
          p.change_summary ? h("div", null, h("div", { class: "section-title" }, "変更点"), renderMarkdown(p.change_summary)) : null,
          p.evidence.length ? h("div", { class: "small muted", style: { margin: "6px 0" } }, `根拠: ${p.evidence.join("、")}`) : null,
          p.diff.length ? h("div", null, h("div", { class: "section-title" }, "差分"), renderDiff(p.diff)) : null,
          p.status === "testing" ? h("div", { class: "empty" }, spinner(p.kind === "operation" ? "WMSの画面で操作スキルを試しています…" : "過去の検品で再判定しています…")) : null,
          p.test_result ? testResult(p.test_result) : null,
          canAct
            ? h(
                "div",
                { class: "row", style: { marginTop: "14px" } },
                h("button", { class: "btn", type: "button", disabled: busy, onclick: () => runTest(p) }, p.test_result ? "もう一度テスト" : p.kind === "operation" ? "WMS画面でテスト" : "過去の検品でテスト"),
                h("span", { class: "spacer" }),
                h("button", { class: "btn", type: "button", onclick: () => reject(p) }, "却下"),
                h("button", { class: "btn primary", type: "button", onclick: () => approve(p) }, "承認して公開"),
              )
            : null,
        ),
      ),
    );
  }

  function testResult(t) {
    if (t.type === "smoke") {
      return h(
        "div",
        { class: `note-box ${t.ok ? "ok" : "ng"}`, style: { marginTop: "12px" } },
        h("b", null, t.ok ? "テスト合格：WMSの画面で必要な要素がすべて見つかりました" : "テスト不合格"),
        h("div", { class: "small" }, t.detail),
        t.missing?.length ? h("div", { class: "small mono" }, `見つからない要素: ${t.missing.join(", ")}`) : null,
        h("div", { class: "small muted" }, `試した納品: ${t.sample}（読み取りのみ・登録はしていません）`),
      );
    }
    if (t.skipped) return h("div", { class: "note-box warn", style: { marginTop: "12px" } }, h("b", null, "再判定は行いませんでした"), h("div", { class: "small" }, t.reason));
    const better = t.after.match - t.before.match;
    return h(
      "div",
      { style: { marginTop: "12px" } },
      h("div", { class: `note-box ${t.after.misses > t.before.misses ? "ng" : better >= 0 ? "ok" : "warn"}` }, h("b", null, `人の判定との一致: ${t.before.match}/${t.total} → ${t.after.match}/${t.total}`), h("div", { class: "small" }, `見逃し ${t.before.misses} → ${t.after.misses}・要確認 ${t.before.unsure} → ${t.after.unsure}`)),
      h(
        "table",
        { class: "tbl compact", style: { marginTop: "8px" } },
        h("thead", null, h("tr", null, h("th", null, "検品"), h("th", null, "人"), h("th", null, "改善前"), h("th", null, "改善後"))),
        h("tbody", null, t.results.map((r) => h("tr", null, h("td", { class: "mono small" }, r.inspectionId), h("td", null, verdictBadge(r.human)), h("td", null, verdictBadge(r.before)), h("td", null, verdictBadge(r.after))))),
      ),
    );
  }

  async function propose(skillId) {
    const p = await act(() => post("/api/learning/proposals", { skillId }), "改善案の作成を開始しました");
    if (p) {
      selectedProposal = p.id;
      history.replaceState(null, "", `#/learning/${p.id}`);
      await loadProposals();
      await loadDetail();
    }
  }

  async function runTest(p) {
    if (await act(() => post(`/api/learning/proposals/${p.id}/test`))) await loadDetail();
  }

  async function approve(p) {
    const ok = await confirmDialog({ title: "改善案を承認して公開", message: `${p.skill_id} の v${p.draft?.version} を公開します。次の検品からこの版が使われます。`, okText: "公開する" });
    if (ok && (await act(() => post(`/api/learning/proposals/${p.id}/approve`), "公開しました"))) {
      await loadProposals();
      await loadDetail();
      await loadMetrics();
    }
  }

  async function reject(p) {
    const ok = await confirmDialog({ title: "改善案を却下", message: "この改善案を却下します。", okText: "却下する", okClass: "ng" });
    if (ok && (await act(() => post(`/api/learning/proposals/${p.id}/reject`, { reason: "" }), "却下しました"))) {
      await loadProposals();
      await loadDetail();
    }
  }

  const stop = poll(async () => {
    const before = JSON.stringify(proposals.map((p) => [p.id, p.status]));
    const busy = proposals.some((p) => p.status === "generating" || p.status === "testing");
    if (!busy) return;
    await loadProposals();
    if (JSON.stringify(proposals.map((p) => [p.id, p.status])) !== before) await loadDetail();
  }, 2000);

  await Promise.all([loadMetrics(), loadProposals()]);
  await loadDetail();
  return stop;
}
