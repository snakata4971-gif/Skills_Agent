// Small DOM helpers shared by all views. Text is always inserted as text nodes (never as HTML),
// except in renderMarkdown, which escapes everything before adding its own tags.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected" || k === "multiple") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(container, ...children) {
  container.replaceChildren();
  append(container, children);
  return container;
}

export const VERDICT_CLASS = { OK: "ok", NG: "ng", 要確認: "warn", 保留: "warn" };

export function verdictBadge(v, opts = {}) {
  if (!v) return h("span", { class: "badge" }, "—");
  return h("span", { class: `badge ${VERDICT_CLASS[v] ?? ""} ${opts.lg ? "lg" : ""}` }, v);
}

export function badge(text, cls = "") {
  return h("span", { class: `badge ${cls}` }, text);
}

export function confidence(v) {
  const pct = Math.round((Number(v) || 0) * 100);
  return h("span", { class: "conf" }, h("span", { class: "bar" }, h("i", { style: { width: `${pct}%` } })), `${pct}%`);
}

export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

export function yen(n) {
  return `${Number(n || 0).toLocaleString("ja-JP")}円`;
}

// ---------- toast ----------
export function toast(message, kind = "") {
  const box = document.getElementById("toasts");
  const el = h("div", { class: `toast ${kind}` }, message);
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
}

// ---------- modal ----------
export function openModal({ title, body, footer, wide = false, onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const backdrop = h(
    "div",
    { class: "modal-backdrop", onmousedown: (e) => e.target === backdrop && close() },
    h(
      "div",
      { class: `modal ${wide ? "wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "modal-head" }, h("h2", null, title), h("button", { class: "btn ghost sm", type: "button", onclick: close, "aria-label": "閉じる" }, "閉じる")),
      h("div", { class: "modal-body" }, body),
      footer ? h("div", { class: "modal-foot" }, footer) : null,
    ),
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  return { close, el: backdrop };
}

export function confirmDialog({ title, message, okText = "実行", okClass = "primary", requireText }) {
  return new Promise((resolve) => {
    let done = false;
    const input = requireText ? h("input", { type: "text", placeholder: requireText }) : null;
    const err = h("div", { class: "error-text", hidden: true });
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const ok = h("button", { class: `btn ${okClass}`, type: "button", onclick: () => {
      if (requireText && input.value.trim() !== requireText) {
        err.textContent = `「${requireText}」と入力してください`;
        err.hidden = false;
        return;
      }
      finish(true);
    } }, okText);
    const m = openModal({
      title,
      body: h("div", null, h("p", null, message), input ? h("label", { class: "field" }, h("span", null, `確認のため「${requireText}」と入力`), input) : null, err),
      footer: [h("button", { class: "btn", type: "button", onclick: () => finish(false) }, "キャンセル"), ok],
      onClose: () => finish(false),
    });
    (input ?? ok).focus();
  });
}

export function lightbox(src, caption) {
  openModal({ title: caption || "写真", wide: true, body: h("div", { class: "lightbox" }, h("img", { src, alt: caption || "" })) });
}

// ---------- markdown (subset used by skills) ----------
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

export function splitFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(content ?? "");
  return m ? { yaml: m[1], body: m[2] } : { yaml: "", body: content ?? "" };
}

export function renderMarkdown(md) {
  const lines = (md ?? "").split(/\r?\n/);
  let html = "";
  let list = null;
  let code = null;
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      closeList();
      code = [];
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) {
      closeList();
      const level = Math.min(hm[1].length, 3);
      html += `<h${level}>${inline(hm[2])}</h${level}>`;
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        html += `<${kind}>`;
        list = kind;
      }
      html += `<li>${inline((ul ?? ol)[1])}</li>`;
      continue;
    }
    closeList();
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  closeList();
  if (code !== null) html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
  const div = document.createElement("div");
  div.className = "md";
  div.innerHTML = html;
  return div;
}

export function renderDiff(lines, context = 3) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type !== "same") for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const box = h("div", { class: "diff" });
  let skipped = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    if (skipped) {
      box.append(h("div", { class: "gap" }, `… ${skipped} 行 変更なし …`));
      skipped = 0;
    }
    box.append(h("div", { class: l.type }, l.text || " "));
  });
  if (skipped) box.append(h("div", { class: "gap" }, `… ${skipped} 行 変更なし …`));
  if (!lines.some((l) => l.type !== "same")) return h("div", { class: "empty" }, "変更はありません");
  return box;
}

export function spinner(text) {
  return h("span", { class: "row" }, h("span", { class: "spinner" }), text ? h("span", { class: "muted" }, text) : null);
}

export function card(title, body, opts = {}) {
  return h(
    "section",
    { class: `card ${opts.class ?? ""}` },
    title ? h("div", { class: "card-head" }, h("h2", null, title, opts.sub ? h("span", { class: "sub" }, `　${opts.sub}`) : null), opts.actions ?? null) : null,
    h("div", { class: "card-body" }, body),
  );
}

/** Wires a drop zone + hidden file input; calls onFiles(FileList). */
export function dropzone({ label, accept, multiple = true, onFiles }) {
  const input = h("input", { type: "file", accept, multiple, hidden: true, onchange: () => {
    if (input.files?.length) onFiles(input.files);
    input.value = "";
  } });
  const zone = h(
    "div",
    {
      class: "dropzone",
      ondragover: (e) => {
        e.preventDefault();
        zone.classList.add("over");
      },
      ondragleave: () => zone.classList.remove("over"),
      ondrop: (e) => {
        e.preventDefault();
        zone.classList.remove("over");
        if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
      },
    },
    h("div", null, label),
    h("button", { class: "btn sm", type: "button", style: { marginTop: "8px" }, onclick: () => input.click() }, "ファイルを選ぶ"),
    input,
  );
  return zone;
}
