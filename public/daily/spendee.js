// 📥 Import from Spendee: reads a Spendee CSV export (Settings → Export data → CSV) in the
// browser, shows a preview (wallets, other currencies, how Spendee's categories map to
// ours), then adds the expenses as one person's personal expenses with the "importItems"
// operation (netlify/functions/daily.mjs). Income and transfers are left out. Every row
// gets a stable key, so importing the same file again only adds rows that are new, and a
// whole import can be undone from Settings.

const CHUNK = 500;

// ---------------------------------------------------------------- CSV

export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
  const delim = (first.match(/;/g) ?? []).length > (first.match(/,/g) ?? []).length ? ";" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

// "1,234.56", "-12.50", "S$ 12", "1.234,56" -> a positive number, or NaN.
function parseAmount(text) {
  let t = String(text ?? "").replace(/[^\d.,-]/g, "");
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (/,\d{1,2}$/.test(t)) t = t.replace(",", ".");
  else t = t.replace(/,/g, "");
  return Math.abs(Number(t));
}

const pad = (n) => String(n).padStart(2, "0");

// ISO timestamps (with a time zone) become the local calendar day; plain dates stay as they are.
function parseDate(text) {
  const t = String(text ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d/.test(t)) {
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
      const d = new Date(t.replace(" ", "T"));
      if (!isNaN(d)) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    return t.slice(0, 10);
  }
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(t);
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;
  const d = new Date(t);
  return isNaN(d) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Spendee's export: Date, Wallet, Type, Category name, Amount, Currency, Note, Labels, Author.
export function readSpendee(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("That file has no rows");
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.some((n) => h.includes(n)));
  const c = {
    date: col("date"), wallet: col("wallet", "account"), type: col("type"), cat: col("category"),
    amount: col("amount"), currency: col("currency"), note: col("note", "description", "memo"), labels: col("label", "tag"),
  };
  if (c.date < 0 || c.amount < 0) throw new Error("This doesn't look like a Spendee export: it needs Date and Amount columns");
  const get = (r, i) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const out = [];
  let income = 0, bad = 0;
  for (const r of rows.slice(1)) {
    const type = get(r, c.type).toLowerCase();
    const raw = get(r, c.amount);
    const negative = /^-|\(/.test(raw.replace(/[^\d().,-]/g, ""));
    const isExpense = type ? /expense|spend|out/.test(type) : negative;
    if (!isExpense) { income++; continue; }
    const amount = parseAmount(raw);
    const date = parseDate(get(r, c.date));
    if (!(amount > 0) || !date) { bad++; continue; }
    out.push({
      date, amount, wallet: get(r, c.wallet) || "Wallet", category: get(r, c.cat) || "Other",
      currency: (get(r, c.currency) || "SGD").toUpperCase(), note: get(r, c.note), labels: get(r, c.labels),
    });
  }
  return { rows: out, income, bad };
}

// ---------------------------------------------------------------- categories

const GUESS = [
  ["groceries", /grocer|supermarket|market/],
  ["food", /food|drink|restaurant|dining|cafe|coffee|meal|eat|bar\b|lunch|dinner|breakfast/],
  ["transport", /transport|taxi|grab|gojek|car\b|fuel|petrol|parking|train|bus|mrt|commute/],
  ["bills", /bill|utilit|rent|home|house|phone|mobile|internet|insurance|subscription|loan/],
  ["shopping", /shop|cloth|fashion|electronic|gadget/],
  ["health", /health|medic|doctor|clinic|pharm|dental|beauty|fitness|gym|sport/],
  ["fun", /entertain|fun|movie|cinema|game|hobby|leisure|dating|holiday|travel|vacation/],
];

function guessCategory(doc, name) {
  const n = name.toLowerCase();
  const exact = doc.categories.find((c) => c.name.toLowerCase() === n || c.id === n);
  if (exact) return exact.id;
  const hit = GUESS.find(([id, re]) => re.test(n) && doc.categories.some((c) => c.id === id));
  return hit ? hit[0] : doc.categories.some((c) => c.id === "other") ? "other" : doc.categories[0].id;
}

// ---------------------------------------------------------------- dialog

export function setupSpendeeImport({ $, esc, toast, money, getDoc, me, runOp, people }) {
  let data = null; // { rows, income, bad }
  const dlg = $("#importDlg");

  function reset() {
    data = null;
    $("#importFile").value = "";
    $("#importPreview").hidden = true;
    $("#importHint").hidden = false;
  }

  $("#importBtn").addEventListener("click", () => { reset(); dlg.showModal(); });
  for (const id of ["#importClose", "#importCancel"]) $(id).addEventListener("click", () => dlg.close());

  $("#importFile").addEventListener("change", async () => {
    const file = $("#importFile").files[0];
    if (!file) return;
    try {
      data = readSpendee(await file.text());
    } catch (err) {
      toast(err.message);
      return reset();
    }
    if (!data.rows.length) { toast("No expenses found in that file"); return reset(); }
    const doc = getDoc();
    $("#importHint").hidden = true;
    $("#importPreview").hidden = false;
    $("#importOwner").innerHTML = people().map((p) => `<option ${p === me() ? "selected" : ""}>${esc(p)}</option>`).join("");

    const count = (key) => data.rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) ?? 0) + 1), new Map());
    const wallets = count("wallet");
    $("#importWallets").innerHTML = [...wallets].map(([w, n]) => `<label class="cat-choice"><input type="checkbox" value="${esc(w)}" checked /><span>${esc(w)} <span class="muted small">${n}</span></span></label>`).join("");
    $("#importWalletsBox").hidden = wallets.size < 2;

    const others = [...count("currency")].filter(([cur]) => cur !== "SGD");
    $("#importCurrencyBox").hidden = !others.length;
    $("#importCurrencies").innerHTML = others.map(([cur, n]) => `<label>${n} expense${n === 1 ? "" : "s"} in ${esc(cur)}: S$ per 1 ${esc(cur)}
      <input type="number" step="any" min="0" inputmode="decimal" data-cur="${esc(cur)}" placeholder="Leave blank to skip them" /></label>`).join("");

    const cats = [...count("category")].sort((a, b) => b[1] - a[1]);
    const options = (pick) => doc.categories.map((c) => `<option value="${esc(c.id)}" ${c.id === pick ? "selected" : ""}>${esc(c.emoji)} ${esc(c.name)}</option>`).join("")
      + (doc.categories.length < 16 ? `<option value="__new">＋ New category</option>` : "");
    $("#importCats").innerHTML = cats.map(([name, n]) => `<label><span>${esc(name)} <span class="muted small">${n}</span></span>
      <select data-from="${esc(name)}">${options(guessCategory(doc, name))}</select></label>`).join("");
    update();
  });

  $("#importPreview").addEventListener("change", update);
  $("#importPreview").addEventListener("input", update);

  // The rows that will go in, with the S$ amount and a stable key each.
  function selected() {
    const doc = getDoc();
    const wallets = new Set([...$("#importWallets").querySelectorAll("input:checked")].map((i) => i.value));
    const rates = Object.fromEntries([...$("#importCurrencies").querySelectorAll("input")].map((i) => [i.dataset.cur, Number(i.value)]));
    const map = Object.fromEntries([...$("#importCats").querySelectorAll("select")].map((s) => [s.dataset.from, s.value]));
    const seenKeys = new Set(doc.items.map((i) => i.importKey).filter(Boolean));
    const occurrences = new Map();
    const out = [];
    let skippedCurrency = 0, dupes = 0;
    for (const r of data.rows) {
      if (!wallets.has(r.wallet)) continue;
      const rate = r.currency === "SGD" ? 1 : rates[r.currency];
      if (!(rate > 0)) { skippedCurrency++; continue; }
      const cents = Math.round(r.amount * rate * 100);
      // Identical rows (two coffees the same day) are told apart by their order in the file.
      const base = `spendee|${r.wallet}|${r.date}|${r.amount}|${r.currency}|${r.category}|${r.note}`;
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);
      const key = `${base}|${n}`.slice(0, 200);
      if (seenKeys.has(key)) { dupes++; continue; }
      const note = [r.labels, r.note].filter(Boolean).join(": ")
        + (r.currency !== "SGD" ? ` (${r.currency} ${r.amount})` : "");
      out.push({ key, date: r.date, a: cents, from: r.category, cat: map[r.category], note: note.slice(0, 80) });
    }
    return { out, skippedCurrency, dupes };
  }

  function update() {
    if (!data) return;
    const { out, skippedCurrency, dupes } = selected();
    const dates = out.map((r) => r.date).sort();
    const total = out.reduce((s, r) => s + r.a, 0);
    $("#importStats").innerHTML = `
      <div class="home-stat"><span>Expenses to import</span><b>${out.length.toLocaleString("en-US")}</b><small>${dates.length ? `${dates[0]} to ${dates.at(-1)}` : ""}</small></div>
      <div class="home-stat"><span>Total</span><b>${money(total)}</b><small>${data.income} income/transfer row${data.income === 1 ? "" : "s"} left out</small></div>`;
    const notes = [];
    if (dupes) notes.push(`${dupes} already imported before, so skipped.`);
    if (skippedCurrency) notes.push(`${skippedCurrency} in other currencies skipped (enter a rate to include them).`);
    if (data.bad) notes.push(`${data.bad} row${data.bad === 1 ? "" : "s"} couldn't be read.`);
    $("#importDupes").textContent = notes.join(" ");
    $("#importGo").disabled = !out.length;
    $("#importGo").textContent = out.length ? `Import ${out.length.toLocaleString("en-US")} expenses` : "Nothing new to import";
  }

  $("#importGo").addEventListener("click", async () => {
    const btn = $("#importGo");
    btn.disabled = true;
    // New categories first, so the expenses can go into them.
    for (const sel of $("#importCats").querySelectorAll("select")) {
      if (sel.value !== "__new") continue;
      const name = sel.dataset.from.slice(0, 40);
      if (!(await runOp({ op: "addCategory", name, emoji: "🏷️" }))) { btn.disabled = false; return; }
      const made = [...getDoc().categories].reverse().find((c) => c.name === name);
      sel.insertAdjacentHTML("beforeend", `<option value="${made.id}">${esc(name)}</option>`);
      sel.value = made.id;
    }
    const { out } = selected();
    const owner = $("#importOwner").value;
    const batch = crypto.randomUUID();
    for (let i = 0; i < out.length; i += CHUNK) {
      const last = i + CHUNK >= out.length;
      btn.textContent = `Importing… ${Math.min(i + CHUNK, out.length)} of ${out.length}`;
      const ok = await runOp({ op: "importItems", source: "Spendee", owner, batch, final: last, items: out.slice(i, i + CHUNK) },
        last ? `Imported ${out.length.toLocaleString("en-US")} expenses from Spendee` : null);
      if (!ok) { btn.disabled = false; update(); return; }
    }
    dlg.close();
  });
}

// Past imports in Settings, each with Undo.
export function renderImports({ $, esc, money, getDoc, timeAgo }) {
  const list = getDoc().imports ?? [];
  $("#importList").innerHTML = [...list].reverse().map((x) => `<li>
    <div class="item-main"><span class="item-note"><b>${esc(x.source)}</b> · ${x.count.toLocaleString("en-US")} of ${esc(x.owner)}'s expenses</span>
      <span class="item-meta">${money(x.total)} · imported by ${esc(x.by)} ${timeAgo(x.t)}</span></div>
    <button type="button" class="btn ghost" data-undo-import="${esc(x.id)}">↩ Undo</button></li>`).join("");
}
