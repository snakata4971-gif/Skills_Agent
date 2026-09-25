import { get, getActor, setActor, state } from "./api.js";
import { h, mount, openModal, toast } from "./ui.js";
import * as guide from "./views/guide.js";
import * as station from "./views/station.js";
import * as cases from "./views/cases.js";
import * as skills from "./views/skills.js";
import * as builder from "./views/builder.js";
import * as learning from "./views/learning.js";
import * as settings from "./views/settings.js";

const CASE_ACTION = ["draft_ready", "instruction_received", "awaiting_approval", "ready", "executed"];

const ROUTES = [
  { path: "guide", label: "はじめに", view: guide },
  { path: "station", label: "検品", view: station, count: (s) => s.counts.awaitingReview },
  { path: "cases", label: "顧客確認", view: cases, count: (s) => CASE_ACTION.reduce((n, k) => n + (s.counts.cases[k] ?? 0), 0) },
  { path: "skills", label: "スキルライブラリー", view: skills, count: (s) => s.counts.drafts },
  { path: "builder", label: "スキルビルダー", view: builder, count: (s) => s.counts.openRequests },
  { path: "learning", label: "学習・改善", view: learning, count: (s) => s.counts.openOperationErrors },
  { path: "settings", label: "設定", view: settings },
];

async function refreshStatus() {
  try {
    state.status = await get("/api/status");
  } catch {
    return;
  }
  const s = state.status;
  const ai = document.getElementById("ai-pill");
  ai.className = `pill ${s.ai.mode === "live" ? "live" : "demo"}`;
  mount(ai, h("span", { class: "dot" }), s.ai.mode === "live" ? `AI接続中（${s.ai.model}）` : "デモモード（AI未接続）");
  ai.title = s.ai.mode === "live" ? "Claude API に接続しています" : ".env に ANTHROPIC_API_KEY を設定するとAIが有効になります";
  mount(document.getElementById("wms-pill"), `WMS: ${s.wms.mode === "browser" ? "ブラウザ自動操作" : "API連携"}`);
  renderNav();
}

function currentPath() {
  return location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0] || "guide";
}

function renderNav() {
  const cur = currentPath();
  mount(
    document.getElementById("nav"),
    ROUTES.map((r) => {
      const n = state.status && r.count ? r.count(state.status) : 0;
      return h("a", { href: `#/${r.path}`, class: r.path === cur ? "active" : "" }, r.label, n ? h("span", { class: "count" }, n) : null);
    }),
  );
}

function renderActor() {
  const name = getActor();
  document.getElementById("actor-btn").textContent = name ? `担当: ${name}` : "担当者名を設定";
}

export function askActor() {
  const input = h("input", { type: "text", value: getActor(), placeholder: "例: 佐藤（検品）" });
  const save = () => {
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    setActor(v);
    m.close();
    toast(`担当者を「${v}」にしました`, "ok");
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && save());
  const m = openModal({
    title: "担当者名",
    body: h(
      "div",
      null,
      h("p", { class: "muted" }, "確定・承認・スキル編集の記録に使います（この試作版にはログイン機能はありません）。"),
      h("label", { class: "field" }, h("span", null, "名前"), input),
    ),
    footer: [h("button", { class: "btn primary", type: "button", onclick: save }, "保存")],
  });
  input.focus();
}

let cleanup = null;
let navToken = 0;

async function route() {
  const token = ++navToken;
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const r = ROUTES.find((x) => x.path === (segments[0] || "guide")) ?? ROUTES[0];
  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  renderNav();
  // Each navigation renders into its own element, so a slower earlier view that finishes
  // loading late cannot overwrite the page the user has moved on to.
  const container = h("div");
  document.getElementById("app").replaceChildren(container);
  window.scrollTo(0, 0);
  try {
    const done = await r.view.render(container, { params: segments.slice(1), query: new URLSearchParams(queryPart ?? "") });
    if (token !== navToken) {
      if (typeof done === "function") done();
      return;
    }
    cleanup = done;
  } catch (e) {
    if (token !== navToken) return;
    mount(container, h("div", { class: "card" }, h("div", { class: "card-body" }, h("p", null, "画面を表示できませんでした。"), h("p", { class: "muted" }, e.message))));
  }
}

document.getElementById("actor-btn").addEventListener("click", askActor);
window.addEventListener("hashchange", route);
window.addEventListener("qa:refresh", refreshStatus);
window.addEventListener("qa:actor", renderActor);
renderActor();
await refreshStatus();
setInterval(refreshStatus, 8000);
route();
