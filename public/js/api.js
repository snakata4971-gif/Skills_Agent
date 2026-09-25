import { toast } from "./ui.js";

const ACTOR_KEY = "qa.actor";

export function getActor() {
  try {
    return localStorage.getItem(ACTOR_KEY) || "";
  } catch {
    return "";
  }
}

export function setActor(name) {
  try {
    localStorage.setItem(ACTOR_KEY, name);
  } catch {
    /* storage unavailable: the name lasts until reload */
  }
  window.dispatchEvent(new Event("qa:actor"));
}

export async function api(method, url, body) {
  const headers = { "X-Actor": encodeURIComponent(getActor() || "未設定") };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new Error("サーバーに接続できません。アプリが起動しているか確認してください");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラーが発生しました（${res.status}）`);
  return data;
}

/**
 * Uploads a FormData with progress reports (fetch cannot report upload progress).
 * onProgress receives 0–1 while sending, then null while the server processes the files.
 */
export function uploadWithProgress(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-Actor", encodeURIComponent(getActor() || "未設定"));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.upload.onload = () => onProgress?.(null);
    xhr.onerror = () => reject(new Error("サーバーに接続できません。アプリが起動しているか確認してください"));
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `アップロードに失敗しました（${xhr.status}）`));
    };
    xhr.send(form);
  });
}

export const get = (url) => api("GET", url);
export const post = (url, body) => api("POST", url, body ?? {});
export const put = (url, body) => api("PUT", url, body ?? {});
export const del = (url) => api("DELETE", url);

export function refreshStatus() {
  window.dispatchEvent(new Event("qa:refresh"));
}

/** Runs an action, showing errors as a toast. Returns undefined on failure. */
export async function act(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage, "ok");
    refreshStatus();
    return r;
  } catch (e) {
    toast(e.message, "error");
    return undefined;
  }
}

/** Repeats fn every ms while the tab is visible; returns a stop function. */
export function poll(fn, ms) {
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    if (!document.hidden) {
      try {
        await fn();
      } catch {
        /* next tick retries */
      }
    }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

/** Latest /api/status payload, kept up to date by app.js. */
export const state = { status: null };

export async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "処理中…";
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
