// Our insurance (/insurance/): each plan with what it covers, what it costs (monthly and
// yearly), how and when it's paid, and how long it covers. Live-synced with /api/insurance.

import { $, esc, store, localToday, fmtDay, timeAgo, toast, myName, setupIdentity, createSync, fetchJson, checkIdentity } from "/common.js";

const TYPES = [
  ["hospital", "🏥", "Hospitalisation (Integrated Shield)"],
  ["rider", "🩹", "Hospital rider"],
  ["life-term", "🛡️", "Life – term"],
  ["life-whole", "🛡️", "Life – whole life"],
  ["ci", "❤️", "Critical illness"],
  ["eci", "❤️", "Early critical illness"],
  ["pa", "🦺", "Personal accident"],
  ["disability", "🧑‍🦽", "Disability income"],
  ["ltc", "🧓", "Long-term care (CareShield)"],
  ["savings", "💰", "Endowment / savings"],
  ["ilp", "📈", "Investment-linked"],
  ["annuity", "🏖️", "Retirement / annuity"],
  ["travel", "✈️", "Travel"],
  ["home", "🏠", "Home / contents"],
  ["car", "🚗", "Car"],
  ["maid", "🧹", "Helper (maid)"],
  ["pet", "🐾", "Pet"],
  ["other", "📄", "Other"],
];
const typeOf = (id) => TYPES.find((t) => t[0] === id) ?? TYPES.at(-1);
const STATUS = { active: ["✅", "Active"], pending: ["⏳", "Pending"], lapsed: ["⚠️", "Lapsed"], cancelled: ["✖️", "Cancelled"], matured: ["🏁", "Matured"] };
const FREQ = { monthly: [1, "a month"], quarterly: [3, "every 3 months"], "half-yearly": [6, "every 6 months"], yearly: [12, "a year"], single: [0, "one-off"] };
const PAID = [["giro", "🏦 GIRO / bank deduction"], ["medisave", "🩺 MediSave"], ["cpf-oa", "🏛️ CPF Ordinary Account"], ["paynow", "📲 PayNow"], ["cash", "💵 Cash"], ["bank", "🏦 Bank transfer"], ["other", "📄 Other"]];
// The main kinds of cover to check each person has.
const CHECKS = [
  ["Hospitalisation", ["hospital"]],
  ["Critical illness", ["ci", "eci"]],
  ["Death / life", ["life-term", "life-whole"]],
  ["Personal accident", ["pa"]],
  ["Disability", ["disability", "ltc"]],
];

let doc = null;
let cards = []; // payment cards from Everyday expenses, for "Paid with"
let who = store.get("insurance.person") || "all";
let editing = null;

const sync = createSync({
  path: "/api/insurance",
  schema: 1,
  onDoc(next) {
    checkIdentity(next.people);
    doc = next;
    render();
  },
});

// ---------------------------------------------------------------- helpers

const money = (c) => `S$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (c) => `S$${Math.round(c / 100).toLocaleString("en-US")}`;
const toCents = (v) => {
  const s = String(v ?? "").replace(/[,\s$S]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};
const asInput = (c) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(/\.00$/, ""));
const daysUntil = (iso) => Math.round((Date.parse(iso) - Date.parse(localToday())) / 86400000);
const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, "");

function me() {
  const n = norm(myName());
  return doc.people.find((p) => n && (norm(p) === n || n.startsWith(norm(p)) || norm(p).startsWith(n))) ?? null;
}

// Monthly and yearly cost (cents), filling in whichever wasn't given.
function costs(p) {
  if (p.frequency === "single") return { monthly: 0, annual: 0, single: p.annual ?? p.monthly ?? 0 };
  const monthly = p.monthly ?? (p.annual !== null ? Math.round(p.annual / 12) : 0);
  const annual = p.annual ?? (p.monthly !== null ? p.monthly * 12 : 0);
  return { monthly, annual, single: 0 };
}

// One payment of the plan (cents).
function paymentOf(p) {
  const [months] = FREQ[p.frequency] ?? FREQ.monthly;
  const c = costs(p);
  if (p.frequency === "single") return c.single;
  if (p.frequency === "monthly") return c.monthly;
  if (p.frequency === "yearly") return c.annual;
  return p.annual !== null ? Math.round((p.annual * months) / 12) : c.monthly * months;
}

function paidWithLabel(p) {
  if (p.paidWith?.startsWith("card:")) {
    const c = cards.find((x) => x.id === p.paidWith.slice(5));
    return c ? `💳 ${c.name} (${c.owner})` : "💳 Card";
  }
  return PAID.find(([k]) => k === p.paidWith)?.[1] ?? "—";
}

function payTermLabel(p) {
  const t = p.payTerm ?? {};
  if (t.kind === "years") return t.n ? `${t.n} years${p.start ? ` (until ${Number(p.start.slice(0, 4)) + t.n})` : ""}` : "A number of years";
  if (t.kind === "age") return t.n ? `Until age ${t.n}` : "Until an age";
  return { "whole-life": "Whole life", renewable: "Renews each year", single: "One payment only" }[t.kind] ?? "—";
}

function coverLabel(p) {
  const c = p.coverUntil ?? {};
  const until = c.kind === "date" && c.value ? fmtDay(c.value, { day: "numeric", month: "short", year: "numeric" })
    : c.kind === "age" && c.value ? `age ${c.value}` : { lifetime: "for life", renewable: "renews yearly" }[c.kind] ?? "";
  const from = p.start ? fmtDay(p.start, { day: "numeric", month: "short", year: "numeric" }) : "";
  return from && until ? `${from} → ${until}` : from ? `From ${from}` : until ? `Until ${until}` : "—";
}

function dueLabel(p) {
  if (!p.nextDue) return "";
  const d = daysUntil(p.nextDue);
  const when = d === 0 ? "today" : d === 1 ? "tomorrow" : d < 0 ? `${-d} day${d === -1 ? "" : "s"} overdue` : `in ${d} days`;
  return `${fmtDay(p.nextDue, { day: "numeric", month: "short", year: "numeric" })} · ${when}`;
}

const visible = () => doc.plans.filter((p) => who === "all" || p.person === who || p.person === "Joint");
const live = (p) => p.status === "active" || p.status === "pending";

// ---------------------------------------------------------------- rendering

function render() {
  if (!doc) return;
  if (who !== "all" && !doc.people.includes(who)) who = "all";
  $("#personPick").innerHTML = [...doc.people, "all"].map((p) => `<label><input type="radio" name="who" value="${esc(p)}"
    ${p === who ? "checked" : ""} /><span>${p === "all" ? "Both" : esc(p)}</span></label>`).join("");
  $("#subtitle").textContent = who === "all" ? "Karstin and Lilin's plans" : `${who}'s plans (and joint ones)`;
  const plans = visible();
  const active = plans.filter(live);

  // Summary
  const month = active.reduce((s, p) => s + costs(p).monthly, 0);
  const year = active.reduce((s, p) => s + costs(p).annual, 0);
  const medisave = active.filter((p) => p.paidWith === "medisave").reduce((s, p) => s + costs(p).annual, 0);
  const next = active.filter((p) => p.nextDue).sort((a, b) => a.nextDue.localeCompare(b.nextDue))[0];
  const card = (label, big, sub, cls = "") => `<article class="card ${cls}"><h2>${label}</h2><p class="big">${big}</p><p class="muted">${sub}</p></article>`;
  $("#insCards").innerHTML = [
    card("Per month", money(month), `${active.length} active plan${active.length === 1 ? "" : "s"}`),
    card("Per year", money(year), medisave ? `${money0(medisave)} of it from MediSave` : "All premiums together"),
    card("Next payment", next ? money(paymentOf(next)) : "—", next ? `${esc(next.name)}<br>${dueLabel(next)}` : "Add payment dates to see them", next && daysUntil(next.nextDue) <= 7 ? "due-soon" : ""),
    card("Total cover", money0(active.filter((p) => ["life-term", "life-whole", "ci", "eci", "pa"].includes(p.type)).reduce((s, p) => s + (p.sumAssured ?? 0), 0)), "Life, critical illness and accident sums assured"),
  ].join("");

  // Due in the next 30 days (or overdue)
  const due = active.filter((p) => p.nextDue && daysUntil(p.nextDue) <= 30).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  $("#duePanel").hidden = !due.length;
  $("#dueList").innerHTML = due.map((p) => `<li class="${daysUntil(p.nextDue) < 0 ? "overdue" : daysUntil(p.nextDue) <= 7 ? "soon" : ""}">
    <div class="item-main"><span class="item-note"><b>${esc(p.name)}</b> · ${esc(p.person)}</span>
      <span class="item-meta">${dueLabel(p)} · ${esc(paidWithLabel(p))}</span></div>
    <div class="item-amt">${money(paymentOf(p))}</div>
    <button type="button" class="btn ghost small-btn" data-paid="${esc(p.id)}">✓ Paid</button>
  </li>`).join("");

  // Cover check
  const people = who === "all" ? doc.people : [who];
  $("#coverCheck").innerHTML = CHECKS.map(([label, types]) => `<li><b>${label}</b><span class="cc-people">${people.map((person) => {
    const has = active.filter((p) => types.includes(p.type) && (p.person === person || p.person === "Joint"));
    return `<span class="cover-chip ${has.length ? "yes" : "no"}">${people.length > 1 ? `<small>${esc(person)}</small>` : ""}${has.length ? `✅ ${has.map((p) => esc(p.name)).join(", ")}` : "— None yet"}</span>`;
  }).join("")}</span></li>`).join("");

  // Plans: active first, then by next payment, then name
  const order = (p) => (live(p) ? 0 : 1);
  const list = [...plans].sort((a, b) => order(a) - order(b) || (a.nextDue || "9999").localeCompare(b.nextDue || "9999") || a.name.localeCompare(b.name));
  $("#planList").innerHTML = list.map((p) => {
    const [, emoji, typeName] = typeOf(p.type);
    const [sIcon, sName] = STATUS[p.status] ?? STATUS.active;
    const c = costs(p);
    const d = p.nextDue ? daysUntil(p.nextDue) : null;
    return `<button type="button" class="plan-card ${live(p) ? "" : "inactive"}" data-plan="${esc(p.id)}">
      <span class="plan-top"><span class="plan-emoji" aria-hidden="true">${emoji}</span>
        <span class="plan-name"><b>${esc(p.name)}</b><small>${esc([p.insurer, typeName].filter(Boolean).join(" · "))}</small></span>
        <span class="plan-badges"><span class="badge">${esc(p.person)}</span><span class="badge status-${p.status}">${sIcon} ${sName}</span></span></span>
      <span class="plan-cost">${p.frequency === "single" ? `<b>${money(c.single)}</b> one-off` : `<b>${money(c.monthly)}</b> a month · <b>${money(c.annual)}</b> a year`}</span>
      <span class="plan-grid">
        <span><small>Paid with</small>${esc(paidWithLabel(p))}</span>
        <span><small>Paying</small>${FREQ[p.frequency]?.[1] ?? "—"}${p.frequency !== "single" && p.frequency !== "monthly" ? ` (${money(paymentOf(p))})` : ""}</span>
        <span class="${d !== null && d <= 7 ? "hot" : ""}"><small>Next payment</small>${p.nextDue ? dueLabel(p) : "—"}</span>
        <span><small>Payment term</small>${payTermLabel(p)}</span>
        <span><small>Covers</small>${coverLabel(p)}</span>
        <span><small>Sum assured</small>${p.sumAssured ? money0(p.sumAssured) : "—"}</span>
      </span>
      ${p.covers ? `<span class="plan-covers"><small>What it covers</small>${esc(p.covers)}</span>` : ""}
    </button>`;
  }).join("") || `<p class="muted small">No plans yet. Tap ＋ Add plan to add your first one.</p>`;

  $("#log").innerHTML = doc.log.slice(0, 40).map((e) => `<li><b>${esc(e.by)}</b> ${esc(e.msg)}<time>${timeAgo(e.t)}</time></li>`).join("") || `<li class="empty">No changes yet.</li>`;
}

// ---------------------------------------------------------------- add / edit a plan

const form = $("#planForm");

function fillSelects() {
  $("#personSel").innerHTML = [...doc.people, "Joint"].map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  $("#typeSel").innerHTML = TYPES.map(([id, e, n]) => `<option value="${id}">${e} ${esc(n)}</option>`).join("");
  const byOwner = doc.people.map((o) => {
    const mine = cards.filter((c) => c.owner === o);
    return mine.length ? `<optgroup label="${esc(o)}'s cards">${mine.map((c) => `<option value="card:${esc(c.id)}">💳 ${esc(c.name)}</option>`).join("")}</optgroup>` : "";
  }).join("");
  $("#paidSel").innerHTML = `<option value="">Not set</option>${PAID.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}${byOwner}`;
}

function showConditional() {
  const pk = form.elements.payKind.value;
  $("#payNLabel").hidden = pk !== "years" && pk !== "age";
  $("#payNText").textContent = pk === "age" ? "Until age" : "Number of years";
  const ck = form.elements.coverKind.value;
  $("#coverDateLabel").hidden = ck !== "date";
  $("#coverAgeLabel").hidden = ck !== "age";
  const single = form.elements.frequency.value === "single";
  form.elements.monthly.closest("label").hidden = single;
  form.elements.annual.closest("label").firstChild.textContent = single ? "One-off premium (S$) " : "Yearly (S$) ";
  $("#costTip").hidden = single;
}

function openPlan(plan) {
  if (!doc) return;
  editing = plan;
  fillSelects();
  form.reset();
  const f = form.elements;
  const p = plan ?? { person: who === "all" ? me() ?? doc.people[0] : who, type: "hospital", status: "active", frequency: "monthly", paidWith: "", payTerm: {}, coverUntil: {} };
  for (const k of ["name", "insurer", "policyNo", "person", "type", "status", "frequency", "paidWith", "paidNote", "nextDue", "start", "covers", "description", "notes", "agent", "agentContact", "link"]) {
    if (f[k]) f[k].value = p[k] ?? "";
  }
  if (p.paidWith && f.paidWith.value !== p.paidWith) { // e.g. a card that's since been removed
    f.paidWith.insertAdjacentHTML("beforeend", `<option value="${esc(p.paidWith)}">Removed card</option>`);
    f.paidWith.value = p.paidWith;
  }
  f.monthly.value = asInput(p.monthly);
  f.annual.value = asInput(p.annual);
  f.sumAssured.value = asInput(p.sumAssured);
  f.payKind.value = p.payTerm?.kind ?? "";
  f.payN.value = p.payTerm?.n ?? "";
  f.coverKind.value = p.coverUntil?.kind ?? "";
  f.coverDate.value = p.coverUntil?.kind === "date" ? p.coverUntil.value ?? "" : "";
  f.coverAge.value = p.coverUntil?.kind === "age" ? p.coverUntil.value ?? "" : "";
  form.dataset.monthlyTouched = form.dataset.annualTouched = plan ? "1" : "";
  $("#planTitle").textContent = plan ? "Edit plan" : "Add plan";
  $("#planSave").textContent = plan ? "Save" : "Add plan";
  $("#planDelete").hidden = !plan;
  const pays = plan?.payments ?? [];
  $("#paymentHist").hidden = !pays.length;
  $("#paymentHist").innerHTML = pays.length ? `<h3 class="form-h">Payments made</h3><ul>${pays.slice(0, 12).map((x) =>
    `<li>${fmtDay(x.date, { day: "numeric", month: "short", year: "numeric" })}<span>${x.amount !== null ? money(x.amount) : ""}</span><small>${esc(x.by)}</small></li>`).join("")}</ul>` : "";
  showConditional();
  $("#planDlg").showModal();
}

// Monthly <-> yearly: fill the other one in until the person types it themselves.
form.elements.monthly.addEventListener("input", () => {
  form.dataset.monthlyTouched = "1";
  const c = toCents(form.elements.monthly.value);
  if (!form.dataset.annualTouched || !form.elements.annual.value) form.elements.annual.value = c > 0 ? asInput(c * 12) : "";
});
form.elements.annual.addEventListener("input", () => {
  form.dataset.annualTouched = "1";
  const c = toCents(form.elements.annual.value);
  if (!form.dataset.monthlyTouched || !form.elements.monthly.value) form.elements.monthly.value = c > 0 ? asInput(Math.round(c / 12)) : "";
});
form.addEventListener("change", showConditional);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = form.elements;
  const nums = { monthly: toCents(f.monthly.value), annual: toCents(f.annual.value), sumAssured: toCents(f.sumAssured.value) };
  for (const [k, v] of Object.entries(nums)) if (Number.isNaN(v)) return toast(`Check the ${k === "sumAssured" ? "sum assured" : k === "annual" ? "yearly cost" : "monthly cost"}`);
  const body = {
    op: "savePlan", id: editing?.id,
    name: f.name.value, insurer: f.insurer.value, policyNo: f.policyNo.value, person: f.person.value, type: f.type.value, status: f.status.value,
    monthly: f.frequency.value === "single" ? null : nums.monthly, annual: nums.annual, frequency: f.frequency.value,
    paidWith: f.paidWith.value, paidNote: f.paidNote.value, nextDue: f.nextDue.value,
    payTerm: { kind: f.payKind.value, n: f.payN.value },
    start: f.start.value,
    coverUntil: { kind: f.coverKind.value, value: f.coverKind.value === "date" ? f.coverDate.value : f.coverKind.value === "age" ? f.coverAge.value : null },
    sumAssured: nums.sumAssured, covers: f.covers.value, description: f.description.value, notes: f.notes.value,
    agent: f.agent.value, agentContact: f.agentContact.value, link: f.link.value,
  };
  if (await sync.runOp(body, editing ? `Saved ${body.name}` : `Added ${body.name}`)) $("#planDlg").close();
});
$("#planCancel").addEventListener("click", () => $("#planDlg").close());
$("#planDelete").addEventListener("click", async () => {
  if (!editing || !confirm(`Remove ${editing.name}?`)) return;
  if (await sync.runOp({ op: "deletePlan", id: editing.id }, `Removed ${editing.name}`)) $("#planDlg").close();
});

// ---------------------------------------------------------------- events

$("#fab").addEventListener("click", () => openPlan(null));
$("#planList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-plan]");
  if (b) openPlan(doc.plans.find((p) => p.id === b.dataset.plan));
});
$("#dueList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-paid]");
  if (!b) return;
  const p = doc.plans.find((x) => x.id === b.dataset.paid);
  if (p) await sync.runOp({ op: "markPaid", id: p.id }, `Marked ${p.name} as paid`);
});
$("#personPick").addEventListener("change", (e) => {
  who = e.target.value;
  store.set("insurance.person", who);
  render();
});
for (const btn of document.querySelectorAll(".fold-tab")) {
  btn.addEventListener("click", () => {
    const open = !btn.classList.contains("active");
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-expanded", String(open));
    $(`#${btn.dataset.fold}`).hidden = !open;
  });
}

// Cards for "Paid with" come from Everyday expenses.
fetchJson("/api/daily").then((r) => { cards = r.doc?.cards ?? []; if (doc) render(); }).catch(() => {});

setupIdentity();
sync.start();
