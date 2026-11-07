// 🔔 on every page: what the other person added lately (Everyday expenses and Food &
// fitness), an unread count, a pop-up when something new arrives while the page is open,
// and a switch for phone notifications (Web Push via /sw.js) that work with the app closed.
// The feed and push sending live in netlify/lib/notify.mjs (/api/notifications).

import { $, esc, store, toast, timeAgo, myName, setMyName, fetchJson, postJson } from "/common.js";

const POLL_MS = 20000;
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
let items = [];
let people = [];
let key = "";
let known = null; // ids already seen by this page, so only new ones pop up

const me = () => {
  const n = norm(myName());
  return people.find((p) => n && (norm(p) === n || n.startsWith(norm(p)) || norm(p).startsWith(n))) ?? null;
};
const fromOthers = (i) => !me() || norm(i.actor) !== norm(me());
const seenAt = () => Number(store.get("notify.seen")) || 0;

// ---------------------------------------------------------------- the bell and its list

const bell = document.createElement("button");
bell.type = "button";
bell.className = "btn ghost bell";
bell.title = "Notifications";
bell.setAttribute("aria-label", "Notifications");
bell.innerHTML = `🔔<span class="bell-count" hidden></span>`;
const actions = document.querySelector(".top-actions") ?? (() => {
  const div = document.createElement("div");
  div.className = "top-actions";
  document.querySelector(".topbar")?.append(div);
  return div;
})();
actions.prepend(bell);

const dlg = document.createElement("dialog");
dlg.className = "bell-dlg";
dlg.innerHTML = `
  <div class="bell-head"><h2>🔔 Notifications</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
  <div class="push-box" id="pushBox"></div>
  <ol class="bell-list" id="bellList"></ol>`;
document.body.append(dlg);

function renderBadge() {
  const n = items.filter((i) => fromOthers(i) && i.t > seenAt()).length;
  const badge = bell.querySelector(".bell-count");
  badge.hidden = !n;
  badge.textContent = n > 9 ? "9+" : String(n);
  bell.setAttribute("aria-label", n ? `Notifications, ${n} new` : "Notifications");
}

function renderList() {
  const seen = seenAt();
  const icon = { expenses: "💸", fitness: "🥗" };
  $("#bellList").innerHTML = items.length ? items.map((i) => `<li class="${fromOthers(i) && i.t > seen ? "new" : ""}">
    <a href="${esc(i.url || "/")}"><span class="bell-icon" aria-hidden="true">${icon[i.app] ?? "🔔"}</span>
      <span class="bell-text">${esc(i.text)}<time>${timeAgo(i.t)}</time></span></a></li>`).join("")
    : `<li class="muted small bell-empty">Nothing yet. When either of you adds an expense, food, exercise or weight, it shows up here.</li>`;
}

bell.addEventListener("click", () => {
  renderList();
  renderPush();
  dlg.showModal();
  store.set("notify.seen", String(Date.now()));
  renderBadge();
});
dlg.addEventListener("click", (e) => {
  if (e.target === dlg || e.target.closest("[data-close]")) dlg.close();
});

// ---------------------------------------------------------------- the feed

async function poll() {
  try {
    const data = await fetchJson("/api/notifications");
    items = data.items ?? [];
    people = data.people ?? [];
    key = data.publicKey ?? "";
  } catch {
    return; // offline or locked: try again later
  }
  if (known) {
    const fresh = items.filter((i) => !known.has(i.id) && fromOthers(i));
    if (fresh.length && document.getElementById("toast")) toast(`🔔 ${fresh[0].text}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""}`);
  }
  known = new Set(items.map((i) => i.id));
  renderBadge();
  if (dlg.open) renderList();
}

poll();
setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

// ---------------------------------------------------------------- phone notifications

const pushable = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function urlKey(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSub() {
  if (!pushable()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function renderPush() {
  const box = $("#pushBox");
  if (typeof window.AndroidBridge !== "undefined") {
    box.innerHTML = `<p class="muted small">Phone notifications don't work inside the Android app. Open the site in Chrome and use <b>Install app</b>, then turn them on there.</p>`;
    return;
  }
  if (!pushable()) {
    box.innerHTML = isIos && !installed()
      ? `<p class="muted small">📱 On iPhone, first add this app to your Home Screen (Share → <b>Add to Home Screen</b>), open it from there, then turn on notifications here.</p>`
      : `<p class="muted small">This browser can't show notifications. Try Chrome, or the app installed on your Home Screen.</p>`;
    return;
  }
  // A Home Screen app keeps its own storage, so it may not know whose phone this is yet.
  if (!myName()) {
    box.innerHTML = `<p class="small">Whose phone is this? Notifications come from the other person.</p>
      <div class="push-who">${(people.length ? people : ["Karstin", "Lilin"]).map((p) => `<button type="button" class="btn ghost" data-who="${esc(p)}">👤 ${esc(p)}</button>`).join("")}</div>`;
    for (const b of box.querySelectorAll("[data-who]")) {
      b.addEventListener("click", () => {
        setMyName(b.dataset.who);
        renderBadge();
        renderList();
        renderPush();
      });
    }
    return;
  }
  if (Notification.permission === "denied") {
    box.innerHTML = `<p class="muted small">Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.</p>`;
    return;
  }
  const sub = await currentSub().catch(() => null);
  box.innerHTML = sub
    ? `<p class="small">✅ This phone gets a notification when ${esc(people.filter((p) => p !== me()).join(" or ") || "the other person")} adds something.</p>
       <button type="button" class="btn ghost" id="pushOff">Turn off on this phone</button>`
    : `<p class="small">Get a notification on this phone whenever ${esc(people.filter((p) => p !== me()).join(" or ") || "the other person")} adds something, even with the app closed.</p>
       <button type="button" class="btn" id="pushOn">🔔 Turn on notifications</button>`;
  $("#pushOn")?.addEventListener("click", turnOn);
  $("#pushOff")?.addEventListener("click", turnOff);
}

async function turnOn() {
  if (!myName()) return renderPush(); // asks whose phone this is first
  try {
    if ((await Notification.requestPermission()) !== "granted") return renderPush();
    if (!key) await poll();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(key) });
    await postJson("/api/notifications", { op: "subscribe", subscription: sub.toJSON(), name: myName() });
    toast("🔔 Notifications are on for this phone");
  } catch (err) {
    toast(`Couldn't turn on notifications: ${err.message}`);
  }
  renderPush();
}

async function turnOff() {
  try {
    const sub = await currentSub();
    if (sub) {
      await postJson("/api/notifications", { op: "unsubscribe", endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    toast("Notifications are off for this phone");
  } catch (err) {
    toast(err.message);
  }
  renderPush();
}
