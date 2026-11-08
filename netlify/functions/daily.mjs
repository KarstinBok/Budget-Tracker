// Everyday expenses API: GET/POST /api/daily (see netlify/lib/shared-doc.mjs).
//
// One shared document holds two kinds of expense:
//  - "personal": someone's own spending (owner), visible to everyone;
//  - "shared": spending the two of them split. paidBy says who paid, shares says who owes
//    what fraction (e.g. { Karstin: 0.5, Lilin: 0.5 }).
// Settlements record money paid back between people. Amounts are whole cents (SGD).
//
// Cards: each belongs to one person and lists the categories it's meant for. An expense can
// say which card paid. Using someone else's card on a personal expense means owing them the
// whole amount; on a shared expense the card's owner is the one who paid.

import { randomUUID } from "node:crypto";
import { createDocHandler, fail, str } from "../lib/shared-doc.mjs";

export const DAILY_KEY = "daily-v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CENTS = 100_000_000; // S$1,000,000
const MAX_ITEMS = 20000;

function defaultDoc() {
  return {
    version: 0,
    schema: 1,
    updatedAt: Date.now(),
    people: ["Karstin", "Lilin"],
    categories: [
      { id: "food", name: "Food & Drinks", emoji: "🍜" },
      { id: "groceries", name: "Groceries", emoji: "🛒" },
      { id: "transport", name: "Transport", emoji: "🚇" },
      { id: "bills", name: "Bills & Home", emoji: "🧾" },
      { id: "shopping", name: "Shopping", emoji: "🛍️" },
      { id: "health", name: "Health", emoji: "💊" },
      { id: "fun", name: "Fun", emoji: "🎬" },
      { id: "other", name: "Other", emoji: "📦" },
    ],
    // { id, kind: "personal" | "shared", date, cat, a: cents, note, by, t,
    //   owner (personal), paidBy + shares (shared) }
    items: [],
    // { id, name, emoji, owner, cats: [category ids it's meant for] }
    cards: [],
    // Which card each person usually uses for what: [{ what, picks: { person: card } }]
    cardGuide: structuredClone(DEFAULT_GUIDE),
    // Money paid back: { id, date, from, to, a: cents, note, by, t }
    settlements: [],
    log: [],
  };
}

const MAX_CARDS = 60;

// Older documents had no cards.
// Which card each of us usually uses for what (shown under 💳 Cards, edited in Settings).
const pick = (karstin, lilin = karstin) => ({ Karstin: karstin, Lilin: lilin });
const DEFAULT_GUIDE = [
  { what: "🍜 Dining", picks: pick("UOB Lady's Card (Food)") },
  { what: "✈️ Flights + accommodation", picks: pick("UOB Lady's Card (Travels)") },
  { what: "🚇 Daily contactless + public transport", picks: pick("UOB PPV") },
  { what: "🌏 Overseas", picks: pick("Amaze + Citi Rewards → PPV", "Amaze + Citi Rewards") },
  { what: "🛒 Online shopping", picks: pick("UOB PPV") },
  { what: "💎 Big-ticket items", picks: pick("UOB PRVI (TBC)") },
];

function normalize(doc) {
  doc.cards ??= [];
  doc.cardGuide ??= structuredClone(DEFAULT_GUIDE);
  // Imports from other apps (e.g. Spendee): { id, source, by, t, count, total }, so one can be undone.
  doc.imports ??= [];
  return doc;
}

const money = (cents) => `S$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function prettyDate(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function person(doc, name, what) {
  const n = str(name, 30);
  const match = doc.people.find((p) => p.toLowerCase() === n.toLowerCase());
  if (!match) fail(`Pick ${what}`);
  return match;
}

function cents(value) {
  const c = Math.round(Number(value));
  if (!Number.isFinite(c) || c <= 0 || c > MAX_CENTS) fail("Enter an amount");
  return c;
}

function date(value) {
  const d = str(value, 10);
  if (!DATE_RE.test(d)) fail("Pick a date");
  return d;
}

// Who owes what fraction of a shared expense. Missing or invalid: split equally.
function shares(doc, input) {
  const out = {};
  let total = 0;
  for (const p of doc.people) {
    const f = Number(input?.[p]);
    out[p] = Number.isFinite(f) && f >= 0 ? f : 0;
    total += out[p];
  }
  if (!(total > 0)) {
    for (const p of doc.people) out[p] = 1 / doc.people.length;
    return out;
  }
  for (const p of doc.people) out[p] /= total;
  return out;
}

// Reads an expense from the page. kind decides whose it is: an owner, or a payer and shares.
function readItem(doc, body) {
  const kind = body.kind === "shared" ? "shared" : "personal";
  const cat = doc.categories.find((c) => c.id === body.cat);
  if (!cat) fail("Pick a category");
  const item = { kind, date: date(body.date), cat: cat.id, a: cents(body.a), note: str(body.note, 80) };
  let card = null;
  if (body.card) {
    card = doc.cards.find((c) => c.id === body.card);
    if (!card) fail("That card was removed, pick another");
    item.card = card.id;
  }
  if (kind === "personal") item.owner = person(doc, body.owner, "whose expense this is");
  else Object.assign(item, { paidBy: card ? card.owner : person(doc, body.paidBy, "who paid"), shares: shares(doc, body.shares) });
  return { item, cat, card };
}

const cardName = (card) => `${card.owner}'s ${card.name}`;

function describe(doc, item, cat) {
  const whose = item.kind === "personal" ? `${item.owner}'s` : `shared (paid by ${item.paidBy})`;
  const card = item.card && doc.cards.find((c) => c.id === item.card);
  return `${money(item.a)} ${whose} ${cat.emoji} ${cat.name} on ${prettyDate(item.date)}` +
    `${card ? ` with ${cardName(card)}` : ""}${item.note ? ` (${item.note})` : ""}`;
}

// A card from the page: name, emoji, owner and the categories it's for.
function readCard(doc, body) {
  const name = str(body.name, 40);
  if (!name) fail("Give the card a name");
  const cats = [...new Set((Array.isArray(body.cats) ? body.cats : []).filter((id) => doc.categories.some((c) => c.id === id)))];
  return { name, emoji: str(body.emoji, 8) || "💳", owner: person(doc, body.owner, "whose card this is"), cats };
}

function applyOp(doc, body, by) {
  switch (body.op) {
    case "updateCardGuide": {
      const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 30).map((r) => ({
        what: str(r?.what, 60),
        picks: Object.fromEntries(doc.people.map((p) => [p, str(r?.picks?.[p], 80)])),
      })).filter((r) => r.what || Object.values(r.picks).some(Boolean));
      doc.cardGuide = rows;
      return `updated which card to use for what (${rows.length} row${rows.length === 1 ? "" : "s"})`;
    }

    case "importItems": {
      // A batch of personal expenses from another app's export, e.g. Spendee. Rows whose
      // key was imported before are skipped, so importing the same file twice is safe.
      const source = str(body.source, 30) || "import";
      const owner = person(doc, body.owner, "whose expenses these are");
      const rows = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
      if (!rows.length) fail("Nothing to import");
      const seen = new Set(doc.items.map((i) => i.importKey).filter(Boolean));
      const batch = str(body.batch, 60) || randomUUID();
      const t = Date.now();
      let count = 0, total = 0;
      for (const r of rows) {
        const key = str(r.key, 200);
        if (key && seen.has(key)) continue;
        if (doc.items.length >= MAX_ITEMS) fail("Too many expenses");
        const cat = doc.categories.find((c) => c.id === r.cat);
        if (!cat) fail(`Pick a category for ${str(r.from, 40) || "every row"}`);
        const item = { id: randomUUID(), kind: "personal", owner, date: date(r.date), cat: cat.id, a: cents(r.a), note: str(r.note, 80), by, t, src: source, importBatch: batch };
        if (key) { item.importKey = key; seen.add(key); }
        doc.items.push(item);
        count++;
        total += item.a;
      }
      if (!count) return null;
      const entry = doc.imports.find((x) => x.id === batch);
      if (entry) Object.assign(entry, { count: entry.count + count, total: entry.total + total });
      else doc.imports.push({ id: batch, source, by, owner, t, count, total });
      doc.imports = doc.imports.slice(-20);
      return `imported ${count} of ${owner}'s expenses (${money(total)}) from ${source}`;
    }

    case "undoImport": {
      const entry = doc.imports.find((x) => x.id === body.id);
      if (!entry) return null;
      const before = doc.items.length;
      doc.items = doc.items.filter((i) => i.importBatch !== entry.id);
      doc.imports = doc.imports.filter((x) => x !== entry);
      return `undid the ${entry.source} import (${before - doc.items.length} expenses removed)`;
    }

    case "addItem": {
      if (doc.items.length >= MAX_ITEMS) fail("Too many expenses");
      const { item, cat } = readItem(doc, body);
      doc.items.push({ id: randomUUID(), ...item, by, t: Date.now() });
      return `added ${describe(doc, item, cat)}`;
    }

    case "updateItem": {
      const old = doc.items.find((i) => i.id === body.id);
      if (!old) fail("This expense was deleted by someone else", 409);
      const { item, cat } = readItem(doc, { ...body, kind: old.kind });
      for (const k of ["owner", "paidBy", "shares", "card"]) delete old[k];
      Object.assign(old, item, { editedBy: by, editedAt: Date.now() });
      return `edited ${describe(doc, old, cat)}`;
    }

    case "deleteItem": {
      const item = doc.items.find((i) => i.id === body.id);
      if (!item) return null;
      doc.items = doc.items.filter((i) => i !== item);
      const cat = doc.categories.find((c) => c.id === item.cat) ?? { emoji: "", name: "an expense" };
      return `deleted ${describe(doc, item, cat)}`;
    }

    case "addSettlement": {
      const from = person(doc, body.from, "who paid back");
      const to = person(doc, body.to, "who was paid back");
      if (from === to) fail("Pick two different people");
      const s = { id: randomUUID(), date: date(body.date), from, to, a: cents(body.a), note: str(body.note, 80), by, t: Date.now() };
      doc.settlements.push(s);
      return `recorded ${from} paying ${to} ${money(s.a)}`;
    }

    case "deleteSettlement": {
      const s = doc.settlements.find((x) => x.id === body.id);
      if (!s) return null;
      doc.settlements = doc.settlements.filter((x) => x !== s);
      return `removed the ${money(s.a)} payment from ${s.from} to ${s.to}`;
    }

    case "updateSettings": {
      const people = [...new Set((body.people ?? []).map((p) => str(p, 30)).filter(Boolean))];
      if (people.length < 1 || people.length > 6) fail("Add between one and six people");
      // Renaming keeps each person's expenses: names are mapped by position.
      const renames = new Map(doc.people.map((p, n) => [p, people[n]]).filter(([a, b]) => b && a !== b));
      const rename = (p) => renames.get(p) ?? p;
      for (const i of doc.items) {
        if (i.owner) i.owner = rename(i.owner);
        if (i.paidBy) i.paidBy = rename(i.paidBy);
        if (i.shares) i.shares = Object.fromEntries(Object.entries(i.shares).map(([p, f]) => [rename(p), f]));
      }
      for (const s of doc.settlements) Object.assign(s, { from: rename(s.from), to: rename(s.to) });
      for (const g of doc.cardGuide ?? []) g.picks = Object.fromEntries(Object.entries(g.picks ?? {}).map(([p, v]) => [rename(p), v]));
      for (const c of doc.cards) c.owner = rename(c.owner);
      doc.people = people;
      return `updated the people to ${people.join(" and ")}`;
    }

    case "addCategory": {
      const name = str(body.name, 40);
      if (!name) fail("Give the category a name");
      if (doc.categories.length >= 16) fail("Too many categories");
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cat";
      let id = base;
      for (let n = 2; doc.categories.some((c) => c.id === id); n++) id = `${base}-${n}`;
      doc.categories.push({ id, name, emoji: str(body.emoji, 8) || "💸" });
      return `added the category ${name}`;
    }

    case "editCategory": {
      const cat = doc.categories.find((c) => c.id === body.id);
      if (!cat) fail("That category was removed");
      cat.name = str(body.name, 40) || cat.name;
      cat.emoji = str(body.emoji, 8) || cat.emoji;
      return `renamed a category to ${cat.emoji} ${cat.name}`;
    }

    case "removeCategory": {
      const cat = doc.categories.find((c) => c.id === body.id);
      if (!cat) return null;
      const used = doc.items.filter((i) => i.cat === cat.id).length;
      if (used) fail(`${cat.name} has ${used} expense${used === 1 ? "" : "s"}, so it can't be removed`);
      doc.categories = doc.categories.filter((c) => c !== cat);
      for (const card of doc.cards) card.cats = card.cats.filter((id) => id !== cat.id);
      return `removed the category ${cat.name}`;
    }

    case "addCard": {
      if (doc.cards.length >= MAX_CARDS) fail("Too many cards");
      const card = { id: randomUUID(), ...readCard(doc, body) };
      if (body.id && /^[\w-]{8,60}$/.test(body.id) && !doc.cards.some((c) => c.id === body.id)) card.id = body.id; // picture already saved under this id
      const art = str(body.art, 40);
      if (art) card.art = art;
      doc.cards.push(card);
      return `added the card ${cardName(card)}`;
    }

    case "editCard": {
      const card = doc.cards.find((c) => c.id === body.id);
      if (!card) fail("That card was removed");
      const next = readCard(doc, body);
      if (next.owner !== card.owner && doc.items.some((i) => i.card === card.id)) {
        fail(`${cardName(card)} has expenses on it, so its owner can't change. Add a new card instead.`);
      }
      Object.assign(card, next);
      if (body.art !== undefined) { // version of the card's picture (see card-art.mjs); "" when removed
        const art = str(body.art, 40);
        if (art) card.art = art;
        else delete card.art;
      }
      return `updated the card ${cardName(card)}`;
    }

    case "removeCard": {
      const card = doc.cards.find((c) => c.id === body.id);
      if (!card) return null;
      const used = doc.items.filter((i) => i.card === card.id).length;
      if (used) fail(`${cardName(card)} has ${used} expense${used === 1 ? "" : "s"}, so it can't be removed`);
      doc.cards = doc.cards.filter((c) => c !== card);
      return `removed the card ${cardName(card)}`;
    }

    default:
      fail("Unknown operation");
  }
}

export default createDocHandler({
  key: DAILY_KEY,
  defaultDoc,
  normalize,
  applyOp,
  busyMessage: "The tracker is busy, please try again.",
});

export const config = { path: "/api/daily" };
