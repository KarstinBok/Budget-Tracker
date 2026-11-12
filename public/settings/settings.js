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
    ${f.reply ? `<p class="fb-reply">↳ ${esc(f.reply)}</p>` : ""}
    <small class="muted">${esc(f.by)} · ${timeAgo(f.t)}</small>
  </li>`).join("") : `<li class="muted small">Nothing sent yet.</li>`;
}

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
    const r = await postJson("/api/feedback", { op: "addFeedback", kind: f.kind.value, area: f.area.value, text: f.text.value });
    feedback = r.doc?.items ?? feedback;
    f.text.value = "";
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
