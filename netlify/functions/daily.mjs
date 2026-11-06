// Everyday expenses API: GET/POST /api/daily (see netlify/lib/shared-doc.mjs).
//
// One shared document holds two kinds of expense:
//  - "personal": someone's own spending (owner), visible to everyone;
//  - "shared": spending the two of them split. paidBy says who paid, shares says who owes
//    what fraction (e.g. { Karstin: 0.5, Lilin: 0.5 }).
// Settlements record money paid back between people. Amounts are whole cents (SGD).

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
    // Money paid back: { id, date, from, to, a: cents, note, by, t }
    settlements: [],
    log: [],
  };
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
  if (kind === "personal") item.owner = person(doc, body.owner, "whose expense this is");
  else Object.assign(item, { paidBy: person(doc, body.paidBy, "who paid"), shares: shares(doc, body.shares) });
  return { item, cat };
}

function describe(item, cat) {
  const whose = item.kind === "personal" ? `${item.owner}'s` : `shared (paid by ${item.paidBy})`;
  return `${money(item.a)} ${whose} ${cat.emoji} ${cat.name} on ${prettyDate(item.date)}${item.note ? ` (${item.note})` : ""}`;
}

function applyOp(doc, body, by) {
  switch (body.op) {
    case "addItem": {
      if (doc.items.length >= MAX_ITEMS) fail("Too many expenses");
      const { item, cat } = readItem(doc, body);
      doc.items.push({ id: randomUUID(), ...item, by, t: Date.now() });
      return `added ${describe(item, cat)}`;
    }

    case "updateItem": {
      const old = doc.items.find((i) => i.id === body.id);
      if (!old) fail("This expense was deleted by someone else", 409);
      const { item, cat } = readItem(doc, { ...body, kind: old.kind });
      for (const k of ["owner", "paidBy", "shares"]) delete old[k];
      Object.assign(old, item, { editedBy: by, editedAt: Date.now() });
      return `edited ${describe(old, cat)}`;
    }

    case "deleteItem": {
      const item = doc.items.find((i) => i.id === body.id);
      if (!item) return null;
      doc.items = doc.items.filter((i) => i !== item);
      const cat = doc.categories.find((c) => c.id === item.cat) ?? { emoji: "", name: "an expense" };
      return `deleted ${describe(item, cat)}`;
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
      return `removed the category ${cat.name}`;
    }

    default:
      fail("Unknown operation");
  }
}

export default createDocHandler({
  key: DAILY_KEY,
  defaultDoc,
  applyOp,
  busyMessage: "The tracker is busy, please try again.",
});

export const config = { path: "/api/daily" };
