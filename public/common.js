// Helpers shared by the budget tracker (app.js) and the trip journal (journal.js):
// formatting, the toast and sync indicator, who's using the page, and a live-synced
// document that polls its API for changes made by others.

const DAY_MS = 86400000;
const POLL_MS = 3000;
const POLL_HIDDEN_MS = 20000;

export const $ = (sel) => document.querySelector(sel);

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const toMs = (iso) => Date.parse(iso + "T00:00:00Z");
export const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayNumber = (iso, startIso) => Math.round((toMs(iso) - toMs(startIso)) / DAY_MS) + 1;

export function fmtDay(iso, opts = { weekday: "short", month: "short", day: "numeric" }) {
  return new Date(toMs(iso)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

export function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 3200);
}

export function setSync(state, label) {
  const el = $("#sync");
  el.className = `sync ${state}`;
  el.querySelector("span").textContent = label;
}

// True inside the Android app (android/), which provides window.AndroidBridge.
export const inAndroidApp = () => typeof window.AndroidBridge !== "undefined";

export function downloadFile(name, text, type) {
  // The app's WebView can't save blob downloads, so it saves the file itself.
  if (inAndroidApp()) return window.AndroidBridge.saveFile(name, text, type);
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: name,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// The installed web app's service worker (public/sw.js); not needed inside the Android app.
if ("serviceWorker" in navigator && !inAndroidApp()) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* installing is optional */ });
}

// ---------------------------------------------------------------- who's using the page

let me = store.get("trip.name") || "";
let passcode = store.get("trip.code") || "";
const syncs = [];

export const myName = () => me;

function askName() {
  $("#nameInput").value = me;
  $("#nameDlg").showModal();
}

function askPasscode() {
  if ($("#codeDlg").open) return;
  $("#codeInput").value = "";
  $("#codeDlg").showModal();
}

// Wires up the name and passcode dialogs, which both pages include.
export function setupIdentity() {
  $("#nameForm").addEventListener("submit", () => {
    me = $("#nameInput").value.trim().slice(0, 30);
    store.set("trip.name", me);
    $("#whoName").textContent = me || "Set name";
  });
  $("#whoBtn").addEventListener("click", askName);
  $("#codeForm").addEventListener("submit", () => {
    passcode = $("#codeInput").value;
    store.set("trip.code", passcode);
    for (const s of syncs) s.poll();
  });
  $("#whoName").textContent = me || "Set name";
  if (!me) askName();
}

// One-off GET of another page's API (e.g. the journal reading the trip's dates).
export async function fetchJson(path) {
  const res = await fetch(path, { headers: passcode ? { "x-trip-code": passcode } : {}, cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

// One-off POST (e.g. to the backups API), signed with your name like every other change.
export async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(passcode ? { "x-trip-code": passcode } : {}) },
    body: JSON.stringify({ ...body, by: me }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- live-synced document

// path: the API (e.g. "/api/trip"); schema: the doc shape this page understands, so an
// updated server makes the page reload; onDoc(doc, prevDoc): called with each new
// version (prevDoc is set when the change came from someone else).
export function createSync({ path, schema, onDoc }) {
  let doc = null;
  let pollTimer = null;
  let inflight = 0;

  async function api(method, body) {
    const url = method === "GET" && doc ? `${path}?v=${doc.version}` : path;
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...(passcode ? { "x-trip-code": passcode } : {}) },
      body: body ? JSON.stringify({ ...body, by: me }) : undefined,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      askPasscode();
      throw new Error("Passcode required");
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function applyDoc(next, fromRemote) {
    if ((next.schema ?? 1) > schema) return location.reload(); // the app was updated
    if (doc && next.version < doc.version) return; // stale response
    const prev = doc;
    doc = next;
    onDoc(doc, fromRemote && prev ? prev : null);
    if (!inflight) setSync("live", "Live");
  }

  async function poll() {
    clearTimeout(pollTimer);
    try {
      const data = await api("GET");
      if (data.changed) applyDoc(data.doc, true);
      if (!inflight) setSync("live", "Live");
    } catch (err) {
      setSync("offline", navigator.onLine ? "Reconnecting…" : "Offline");
      if (err.message !== "Passcode required") console.warn(err);
    }
    pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  }

  // Sends one operation; shows okMsg (or the error) as a toast. Resolves to true on success.
  async function runOp(op, okMsg) {
    inflight++;
    setSync("saving", "Saving…");
    let data;
    try {
      data = await api("POST", op);
    } catch (err) {
      toast(err.message);
      setSync("offline", "Not saved");
      return false;
    } finally {
      inflight--;
    }
    applyDoc(data.doc, false);
    if (okMsg) toast(okMsg);
    return true;
  }

  function start() {
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    window.addEventListener("online", poll);
    poll();
  }

  const sync = { runOp, poll, start, get doc() { return doc; } };
  syncs.push(sync);
  return sync;
}
