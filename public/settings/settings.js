// ⚙️ Settings (/settings/): who's using this phone, light or dark mode, and the app map.

import { $, esc, myName, setMyName, personOf, toast, fetchJson, postJson, timeAgo } from "/common.js";

const PEOPLE = ["Karstin", "Lilin"];

function renderWho() {
  const me = personOf(myName(), PEOPLE);
  $("#whoPick").innerHTML = PEOPLE.map((p) => `<label><input type="radio" name="who" value="${esc(p)}" ${p === me ? "checked" : ""} /><span>👤 ${esc(p)}</span></label>`).join("");
}
$("#whoPick").addEventListener("change", (e) => {
  setMyName(e.target.value);
  toast(`✅ This phone is ${e.target.value}'s`);
});

const theme = window.appTheme?.get() ?? "auto";
const pick = document.querySelector(`#themePick input[value="${theme}"]`);
if (pick) pick.checked = true;
$("#themePick").addEventListener("change", (e) => window.appTheme?.set(e.target.value));

renderWho();

// ---------------------------------------------------------------- 💬 feedback

const KIND = { problem: "🐞 Problem", idea: "💡 Idea", other: "💬 Other" };
const AREA = { home: "🏠 Home", expenses: "💸 Expenses", fitness: "🥗 Food & fitness", toilet: "🚽 Toilet log", insurance: "🛡️ Insurance", japan: "🗾 Japan trip", settings: "⚙️ Settings", other: "Other" };
const STATUS = { open: "Open", planned: "Planned", done: "✅ Done", wontdo: "Won't do" };
let feedback = [];

function renderFeedback() {
  $("#feedbackList").innerHTML = feedback.length ? feedback.map((f) => `<li class="fb fb-${f.status}">
    <div class="fb-top"><span>${KIND[f.kind] ?? ""} · ${AREA[f.area] ?? ""}</span>
      <select data-fb-status="${esc(f.id)}" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === f.status ? "selected" : ""}>${v}</option>`).join("")}</select></div>
    <p>${esc(f.text)}</p>
    ${f.photos?.length ? `<div class="fb-list-photos">${f.photos.map((id) => `<img data-fb-photo="${esc(id)}" alt="Screenshot" />`).join("")}</div>` : ""}
    ${f.reply ? `<p class="fb-reply">↳ ${esc(f.reply)}</p>` : ""}
    <small class="muted">${esc(f.by)} · ${timeAgo(f.t)}</small>
  </li>`).join("") : `<li class="muted small">Nothing sent yet.</li>`;
  loadListPhotos();
}

// Screenshots in the list load one by one (they're kept apart from the feedback).
const photoCache = new Map();
async function loadListPhotos() {
  for (const img of document.querySelectorAll("#feedbackList img[data-fb-photo]")) {
    const id = img.dataset.fbPhoto;
    try {
      if (!photoCache.has(id)) photoCache.set(id, (await fetchJson(`/api/feedback-photo?id=${encodeURIComponent(id)}`)).image);
      img.src = photoCache.get(id);
    } catch { img.replaceWith(Object.assign(document.createElement("span"), { className: "muted small", textContent: "Photo unavailable" })); }
  }
}
$("#feedbackList").addEventListener("click", (e) => {
  const img = e.target.closest("img[data-fb-photo]");
  if (img?.src) window.open(img.src, "_blank");
});

// ---------------------------------------------------------------- screenshots to send

let pending = []; // [{ base: HTMLImageElement, marks: [[{x,y}…] | {box}], url }] — url is the marked-up JPEG
const MAX_PHOTOS = 4;

function loadImage(src) {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("Couldn't read that picture")); i.src = src; });
}

// Draws a screenshot with its marks, scaled so the longest side is at most `max` pixels.
function draw(p, canvas, max = 1400) {
  const s = Math.min(1, max / Math.max(p.base.naturalWidth, p.base.naturalHeight));
  canvas.width = Math.round(p.base.naturalWidth * s);
  canvas.height = Math.round(p.base.naturalHeight * s);
  const g = canvas.getContext("2d");
  g.drawImage(p.base, 0, 0, canvas.width, canvas.height);
  g.strokeStyle = "#ff1f4b"; g.lineCap = "round"; g.lineJoin = "round";
  g.lineWidth = Math.max(4, canvas.width / 90);
  for (const m of p.marks) {
    g.beginPath();
    if (m.box) g.rect(m.box.x * canvas.width, m.box.y * canvas.height, m.box.w * canvas.width, m.box.h * canvas.height);
    else m.forEach((pt, i) => (i ? g.lineTo : g.moveTo).call(g, pt.x * canvas.width, pt.y * canvas.height));
    g.stroke();
  }
}

function render(p) {
  const c = document.createElement("canvas");
  draw(p, c, 1280);
  let q = 0.8, url = c.toDataURL("image/jpeg", q);
  while (url.length > 650000 && q > 0.35) url = c.toDataURL("image/jpeg", (q -= 0.1));
  p.url = url;
}

function renderThumbs() {
  $("#fbThumbs").innerHTML = pending.map((p, n) => `<button type="button" class="fb-thumb" data-n="${n}" aria-label="Highlight screenshot ${n + 1}"><img src="${p.url}" alt="" />${p.marks.length ? `<span class="fb-marked">✏️</span>` : ""}</button>`).join("");
  document.querySelector(".fb-add-photo").hidden = pending.length >= MAX_PHOTOS;
}

$("#fbPhotoInput").addEventListener("change", async (e) => {
  const files = [...e.target.files].slice(0, MAX_PHOTOS - pending.length);
  e.target.value = "";
  for (const file of files) {
    try {
      const url = URL.createObjectURL(file);
      const p = { base: await loadImage(url), marks: [] };
      render(p);
      pending.push(p);
    } catch (err) { toast(err.message); }
  }
  renderThumbs();
  if (files.length === 1) openMark(pending.length - 1);
});

// Highlighting: draw freehand or drag a box on the screenshot.
let marking = -1;
const canvas = $("#markCanvas");
function openMark(n) {
  marking = n;
  draw(pending[n], canvas);
  $("#markDlg").showModal();
}
$("#fbThumbs").addEventListener("click", (e) => { const b = e.target.closest("[data-n]"); if (b) openMark(Number(b.dataset.n)); });
const tool = () => document.querySelector('input[name="markTool"]:checked').value;
const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
let stroke = null, start = null;
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const p = pending[marking];
  start = pos(e);
  stroke = tool() === "box" ? { box: { x: start.x, y: start.y, w: 0, h: 0 } } : [start];
  p.marks.push(stroke);
});
canvas.addEventListener("pointermove", (e) => {
  if (!stroke) return;
  const pt = pos(e);
  if (stroke.box) Object.assign(stroke.box, { x: Math.min(start.x, pt.x), y: Math.min(start.y, pt.y), w: Math.abs(pt.x - start.x), h: Math.abs(pt.y - start.y) });
  else stroke.push(pt);
  draw(pending[marking], canvas);
});
for (const ev of ["pointerup", "pointercancel"]) canvas.addEventListener(ev, () => { stroke = null; });
$("#markUndo").addEventListener("click", () => { pending[marking].marks.pop(); draw(pending[marking], canvas); });
$("#markDone").addEventListener("click", () => { render(pending[marking]); renderThumbs(); $("#markDlg").close(); });
$("#markRemove").addEventListener("click", () => { pending.splice(marking, 1); renderThumbs(); $("#markDlg").close(); });
$("#markDlg").addEventListener("close", () => { if (pending[marking]) { render(pending[marking]); renderThumbs(); } });

async function loadFeedback() {
  try {
    feedback = (await fetchJson("/api/feedback")).doc?.items ?? [];
  } catch {
    feedback = [];
  }
  renderFeedback();
}

$("#feedbackForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const photos = [];
    for (const p of pending) photos.push((await postJson("/api/feedback-photo", { image: p.url })).id);
    const r = await postJson("/api/feedback", { op: "addFeedback", kind: f.kind.value, area: f.area.value, text: f.text.value, photos });
    feedback = r.doc?.items ?? feedback;
    f.text.value = "";
    pending = [];
    renderThumbs();
    renderFeedback();
    toast("✅ Thanks! Feedback sent");
  } catch (err) {
    toast(err.message);
  }
  btn.disabled = false;
});

$("#feedbackList").addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-fb-status]");
  if (!sel) return;
  try {
    const r = await postJson("/api/feedback", { op: "updateFeedback", id: sel.dataset.fbStatus, status: sel.value });
    feedback = r.doc?.items ?? feedback;
    renderFeedback();
  } catch (err) {
    toast(err.message);
  }
});

loadFeedback();
