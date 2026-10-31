// Shared trip document API: GET/POST /api/trip (see netlify/lib/shared-doc.mjs).
// The whole trip lives in a single JSON blob: settings, categories, payment cards,
// expense items and an activity log.

import { randomUUID } from "node:crypto";
import { createDocHandler, fail, str } from "../lib/shared-doc.mjs";

const KEY = "trip-v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT = 100_000_000;
const DEFAULT_SGD_RATE = 115; // ¥ per S$1, used until a live rate is available
const SCHEMA = 4; // bump when the doc shape changes so open pages know to reload
const MAX_ITEMS = 5000;
const MAX_CARDS = 30;
const DEFAULT_CARD_LIMIT_SGD = 1000;

const yen = new Intl.NumberFormat("en-US", { style: "currency", currency: "JPY" });

function defaultDoc() {
  const start = new Date();
  const end = new Date(start.getTime() + 9 * 86400000);
  return {
    version: 0,
    schema: SCHEMA,
    updatedAt: Date.now(),
    trip: {
      name: "Japan Trip",
      start: isoDate(start),
      end: isoDate(end),
      budgetSgd: 0,
      currency: "SGD",
      rate: DEFAULT_SGD_RATE,
      autoRate: true,
    },
    categories: [
      { id: "food", name: "Food & Drinks", emoji: "🍜" },
      { id: "transport", name: "Transport", emoji: "🚄" },
      { id: "lodging", name: "Lodging", emoji: "🏯" },
      { id: "activities", name: "Activities", emoji: "⛩️" },
      { id: "shopping", name: "Shopping", emoji: "🛍️" },
      { id: "misc", name: "Misc", emoji: "🎌" },
    ],
    // Cards people pay with: { id, name, owner, limitSgd, shareWith }. shareWith links a
    // card to another one it shares a credit limit with (e.g. two cards on one account).
    cards: [],
    settle: defaultSettle(),
    // One entry per expense: { id, date, cat, a: amountInYen, note, by, t,
    //   pay: "cash" | "card" | "suica", payer (the cash holder, the card's owner, or whose
    //   Suica), card (card id), group (links the fares of one Suica trip for several people) }
    items: [],
    log: [],
  };
}

// Trips created before SGD support stored a different home currency; switch them to SGD.
function normalize(doc) {
  if (doc.trip.currency !== "SGD") {
    doc.trip.currency = "SGD";
    doc.trip.rate = DEFAULT_SGD_RATE;
    doc.trip.autoRate = true;
  }
  doc.trip.autoRate ??= true;
  // The budget used to be stored in yen; it's now set in SGD.
  if (doc.trip.budgetSgd === undefined) {
    doc.trip.budgetSgd = doc.trip.budget ? Math.round(doc.trip.budget / doc.trip.rate) : 0;
    delete doc.trip.budget;
  }
  // Trips from before itemised expenses stored one running total per day and category;
  // keep each of those as a single item.
  if (doc.cells) {
    doc.items = [];
    for (const [date, day] of Object.entries(doc.cells)) {
      for (const [cat, cell] of Object.entries(day)) {
        // Deterministic id: reads migrate without saving, so the id must not change between them.
        doc.items.push({ id: `old-${date}-${cat}`, date, cat, a: cell.a, note: "Earlier entries (combined)", by: cell.by, t: cell.t });
      }
    }
    delete doc.cells;
  }
  doc.items ??= [];
  doc.cards ??= [];
  doc.settle ??= defaultSettle();
  // All cash comes from the shared pool, so cash expenses always belong to its holder.
  for (const i of doc.items) if (i.pay === "cash") i.payer = doc.settle.holder;
  splitCombinedItems(doc);
  doc.schema = SCHEMA;
  return doc;
}

const COMBINED_NOTE = "Earlier entries (combined)";
const yenToNumber = (text) => Number(text.replace(/[^\d]/g, ""));

// The migration above merged everyone's inputs for a day and category into one combined
// item. The activity log still records each input (who, amount, note), so rebuild the
// individual entries from it. Whatever the log can't account for (it only keeps the latest
// entries) stays as one remaining item, so totals never change. Ids are derived from the
// log so that repeated reads, which don't save, produce the same items.
function splitCombinedItems(doc) {
  const combined = doc.items.filter((i) => i.id === `old-${i.date}-${i.cat}` && i.note === COMBINED_NOTE);
  if (!combined.length) return;
  const realItems = doc.items.filter((i) => !combined.includes(i));
  const oldestFirst = [...doc.log].reverse();

  for (const item of combined) {
    const cat = doc.categories.find((c) => c.id === item.cat);
    if (!cat) continue;
    const what = `${cat.emoji} ${cat.name} on ${prettyDate(item.date)}`;
    let parts = [];
    for (const entry of oldestFirst) {
      const m = entry.msg;
      let found;
      if ((found = m.match(/^added (¥[\d,]+) to (.*)$/)) && found[2].startsWith(what)) {
        const rest = found[2].slice(what.length).match(/^(?: \((.*)\))?(?: · now ¥[\d,]+)?$/);
        if (!rest) continue;
        const a = yenToNumber(found[1]);
        // Expenses added since the migration are already their own items; skip those.
        const isRealItem = realItems.some((i) => i.date === item.date && i.cat === item.cat &&
          i.a === a && i.by === entry.by && Math.abs(i.t - entry.t) < 2000);
        if (!isRealItem) parts.push({ a, note: rest[1] ?? "", by: entry.by, t: entry.t });
      } else if ((found = m.match(/^changed (.*) from (¥[\d,]+) to (¥[\d,]+)$/)) && found[1] === what) {
        // Someone typed a new total into the old editable table.
        const delta = yenToNumber(found[3]) - yenToNumber(found[2]);
        parts.push({ a: delta, note: delta > 0 ? "Total edited up" : "Total edited down", by: entry.by, t: entry.t });
      } else if ((found = m.match(/^cleared (.*) \(was ¥[\d,]+\)$/)) && found[1] === what) {
        parts = [];
      }
    }
    const explained = parts.reduce((sum, p) => sum + p.a, 0);
    const rest = item.a - explained;
    if (!parts.length || rest < 0) continue; // nothing usable in the log, or it doesn't add up
    if (rest > 0) parts.unshift({ a: rest, note: "Earlier entries (no details kept)", by: item.by, t: Math.min(item.t, ...parts.map((p) => p.t)) - 1 });
    const replacements = parts.map((p, n) => ({ id: `${item.id}-${n}`, date: item.date, cat: item.cat, ...p }));
    doc.items.splice(doc.items.indexOf(item), 1, ...replacements);
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function prettyDate(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function findCategory(doc, id) {
  const cat = doc.categories.find((c) => c.id === id);
  if (!cat) fail("Unknown category");
  return cat;
}

// Settling up: the shared cash pool (who put in how much, who holds it) and who splits
// the trip's expenses evenly. Pre-filled with what Karstin and Lilin brought; editable
// in Settings.
function defaultSettle() {
  return {
    holder: "Karstin",
    people: ["Karstin", "Lilin"],
    contributions: [
      { id: "start-1", who: "Karstin", a: 66000, note: "" },
      { id: "start-2", who: "Karstin", a: 4080, note: "" },
      { id: "start-3", who: "Lilin", a: 576, note: "" },
      { id: "start-4", who: "Lilin", a: 16000, note: "" },
    ],
  };
}

function cleanSettle(input = {}) {
  const holder = str(input.holder, 30);
  if (!holder) fail("Say who holds the shared cash");
  const people = [...new Set((Array.isArray(input.people) ? input.people : []).map((p) => str(p, 30)).filter(Boolean))];
  if (!people.length) fail("Add at least one person to split the expenses between");
  if (people.length > 20) fail("Too many people");
  const contributions = (Array.isArray(input.contributions) ? input.contributions : []).map((c) => {
    const who = str(c?.who, 30);
    const a = Math.round(Number(c?.a));
    if (!who) fail("Say who put the cash in");
    if (!Number.isFinite(a) || a <= 0 || a > MAX_AMOUNT) fail("Invalid cash amount");
    return { id: /^[\w-]{1,40}$/.test(c?.id ?? "") ? c.id : randomUUID(), who, a, note: str(c?.note, 60) };
  });
  if (contributions.length > 100) fail("Too many cash entries");
  return { holder, people, contributions };
}

// Mutates doc and returns a human readable log line (or null for no-op).
function cleanCard(input = {}) {
  const name = str(input.name, 40);
  if (!name) fail("Give the card a name, e.g. DBS Visa");
  const owner = str(input.owner, 30);
  if (!owner) fail("Say whose card it is");
  const limitSgd = input.limitSgd === undefined || input.limitSgd === "" ? DEFAULT_CARD_LIMIT_SGD : Number(input.limitSgd);
  if (!Number.isFinite(limitSgd) || limitSgd <= 0 || limitSgd > 1_000_000) fail("Invalid card limit");
  return { name, owner, limitSgd: Math.round(limitSgd * 100) / 100, shareWith: str(input.shareWith, 40) || null };
}

// A card can only share a limit with another card that exists.
function checkShareWith(doc, card) {
  if (card.shareWith && (card.shareWith === card.id || !doc.cards.some((c) => c.id === card.shareWith))) card.shareWith = null;
}

function addCard(doc, input) {
  if (doc.cards.length >= MAX_CARDS) fail("Too many cards");
  const card = { id: randomUUID(), ...cleanCard(input) };
  checkShareWith(doc, card);
  doc.cards.push(card);
  return card;
}

const cardLabel = (card) => `${card.owner}'s ${card.name}`;

// Reads how an expense was paid: { pay, payer, card }, or {} if not given. A card the
// person is adding on the spot comes in as body.newCard.
function readPayment(doc, body, by) {
  if (!body.pay) return {};
  if (body.pay === "cash") return { pay: "cash", payer: doc.settle.holder }; // the shared cash
  if (body.pay === "suica") {
    const payer = str(body.payer, 30);
    if (!payer) fail("Pick whose Suica was used");
    return { pay: "suica", payer };
  }
  if (body.pay !== "card") fail("Pick cash, card or Suica");
  const card = body.newCard ? addCard(doc, body.newCard) : doc.cards.find((c) => c.id === body.card);
  if (!card) fail("Pick which card was used");
  return { pay: "card", payer: card.owner, card: card.id };
}

// Whose Suica cards a fare was paid with: one fare each, so a trip taken together is
// entered once.
function suicaPeople(body) {
  const names = [...new Set((Array.isArray(body.suicaFor) ? body.suicaFor : [body.payer]).map((p) => str(p, 30)).filter(Boolean))];
  if (!names.length) fail("Pick whose Suica was used");
  if (names.length > 20) fail("Too many people");
  return names;
}

function paymentText(doc, item) {
  if (item.pay === "cash") return ` · 💵 ${item.payer}'s cash`;
  if (item.pay === "suica") return ` · 🚃 ${item.payer}'s Suica`;
  const card = item.pay === "card" && doc.cards.find((c) => c.id === item.card);
  return card ? ` · 💳 ${cardLabel(card)}` : "";
}

function readExpense(doc, body) {
  const date = str(body.date, 10);
  if (!DATE_RE.test(date)) fail("Invalid date");
  const cat = findCategory(doc, body.cat);
  const amount = Math.round(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) fail("Invalid amount");
  return { date, cat, amount, note: str(body.note, 60) };
}

function applyOp(doc, body, by) {
  switch (body.op) {
    // "addToCell" is what pages loaded before itemised expenses still send.
    case "addItem":
    case "addToCell": {
      const { date, cat, amount, note } = readExpense(doc, body);
      if (body.pay === "suica") {
        // The same fare on each person's Suica, saved as linked expenses.
        const who = suicaPeople(body);
        if (doc.items.length + who.length > MAX_ITEMS) fail("Too many expenses");
        const t = Date.now();
        const group = who.length > 1 ? randomUUID() : undefined;
        for (const payer of who) {
          doc.items.push({ id: randomUUID(), date, cat: cat.id, a: amount, note, by, t, pay: "suica", payer, ...(group ? { group } : {}) });
        }
        return `added ${yen.format(amount)}${who.length > 1 ? ` each (${yen.format(amount * who.length)} in all)` : ""} to ` +
          `${cat.emoji} ${cat.name} on ${prettyDate(date)}${note ? ` (${note})` : ""} · 🚃 Suica: ${who.join(", ")}`;
      }
      if (doc.items.length >= MAX_ITEMS) fail("Too many expenses");
      const item = { id: randomUUID(), date, cat: cat.id, a: amount, note, by, t: Date.now(), ...readPayment(doc, body, by) };
      doc.items.push(item);
      return `added ${yen.format(amount)} to ${cat.emoji} ${cat.name} on ${prettyDate(date)}` +
        (note ? ` (${note})` : "") + paymentText(doc, item);
    }

    case "updateItem": {
      const item = doc.items.find((i) => i.id === body.id);
      if (!item) fail("This expense was deleted by someone else", 409);
      const { date, cat, amount, note } = readExpense(doc, body);
      const before = `${yen.format(item.a)}${item.note ? ` (${item.note})` : ""}`;
      for (const k of ["pay", "payer", "card", "group"]) delete item[k];
      Object.assign(item, { date, cat: cat.id, a: amount, note, editedBy: by, editedAt: Date.now() }, readPayment(doc, body, by));
      return `edited ${before} → ${yen.format(amount)}${note ? ` (${note})` : ""} in ${cat.emoji} ${cat.name} on ${prettyDate(date)}` +
        paymentText(doc, item);
    }

    case "addCard": {
      const card = addCard(doc, body.card);
      return `added the card ${cardLabel(card)} (limit S$${card.limitSgd})`;
    }

    case "editCard": {
      const card = doc.cards.find((c) => c.id === body.id);
      if (!card) fail("That card was removed by someone else", 409);
      Object.assign(card, cleanCard(body.card));
      checkShareWith(doc, card);
      for (const i of doc.items) if (i.card === card.id) i.payer = card.owner;
      return `updated the card ${cardLabel(card)} (limit S$${card.limitSgd})`;
    }

    case "removeCard": {
      const card = doc.cards.find((c) => c.id === body.id);
      if (!card) return null;
      const used = doc.items.filter((i) => i.card === card.id).length;
      if (used) fail(`${cardLabel(card)} is used by ${used} expense${used === 1 ? "" : "s"}, so it can't be removed`);
      doc.cards = doc.cards.filter((c) => c !== card);
      for (const c of doc.cards) if (c.shareWith === card.id) c.shareWith = null;
      return `removed the card ${cardLabel(card)}`;
    }

    case "updateSettle": {
      doc.settle = cleanSettle(body.settle);
      for (const i of doc.items) if (i.pay === "cash") i.payer = doc.settle.holder;
      const total = doc.settle.contributions.reduce((sum, c) => sum + c.a, 0);
      return `updated the cash pool (${yen.format(total)}, held by ${doc.settle.holder}) and the split`;
    }

    case "deleteItem": {
      const item = doc.items.find((i) => i.id === body.id);
      if (!item) return null; // already removed by someone else
      doc.items = doc.items.filter((i) => i !== item);
      const cat = doc.categories.find((c) => c.id === item.cat);
      return `removed ${yen.format(item.a)}${item.note ? ` (${item.note})` : ""} from ` +
        `${cat ? `${cat.emoji} ${cat.name}` : "a category"} on ${prettyDate(item.date)}`;
    }

    case "setCell":
      fail("This page is out of date, please refresh it");

    case "updateTrip": {
      const t = body.trip ?? {};
      const next = {
        name: str(t.name, 60) || "Japan Trip",
        start: str(t.start, 10),
        end: str(t.end, 10),
        budgetSgd: Math.max(0, Math.round((Number(t.budgetSgd) || 0) * 100) / 100),
        currency: "SGD",
        rate: Number(t.rate),
        autoRate: t.autoRate === true || t.autoRate === "on",
      };
      if (!DATE_RE.test(next.start) || !DATE_RE.test(next.end)) fail("Invalid dates");
      if (next.end < next.start) fail("End date is before start date");
      const days = (Date.parse(next.end) - Date.parse(next.start)) / 86400000;
      if (days > 120) fail("Trips longer than 120 days are not supported");
      if (!Number.isFinite(next.rate) || next.rate <= 0) fail("Invalid exchange rate");
      doc.trip = next;
      return "updated the trip settings";
    }

    case "addCategory": {
      const name = str(body.name, 40);
      if (!name) fail("Category name is required");
      if (doc.categories.length >= 20) fail("Too many categories");
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cat";
      let id = base;
      for (let i = 2; doc.categories.some((c) => c.id === id); i++) id = `${base}-${i}`;
      const cat = { id, name, emoji: str(body.emoji, 8) || "💴" };
      doc.categories.push(cat);
      return `added category ${cat.emoji} ${cat.name}`;
    }

    case "editCategory": {
      const cat = findCategory(doc, body.id);
      const name = str(body.name, 40);
      if (!name) fail("Category name is required");
      const before = `${cat.emoji} ${cat.name}`;
      cat.name = name;
      cat.emoji = str(body.emoji, 8) || cat.emoji;
      const after = `${cat.emoji} ${cat.name}`;
      return before === after ? null : `renamed ${before} to ${after}`;
    }

    case "removeCategory": {
      const cat = findCategory(doc, body.id);
      doc.categories = doc.categories.filter((c) => c.id !== cat.id);
      doc.items = doc.items.filter((i) => i.cat !== cat.id);
      return `removed category ${cat.emoji} ${cat.name}`;
    }

    case "moveCategory": {
      const i = doc.categories.findIndex((c) => c.id === body.id);
      const j = i + (body.dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= doc.categories.length) return null;
      [doc.categories[i], doc.categories[j]] = [doc.categories[j], doc.categories[i]];
      return null;
    }

    default:
      fail("Unknown operation");
  }
}

export default createDocHandler({
  key: KEY,
  defaultDoc,
  normalize,
  applyOp,
  busyMessage: "The tracker is busy, please try again.",
});

export const config = { path: "/api/trip" };
