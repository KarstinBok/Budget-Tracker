// Shared trip document API.
//
//   GET  /api/trip?v=<version>  -> { changed:false, version } when the client is up to date,
//                                  otherwise { changed:true, doc }
//   POST /api/trip  { op, by, ... } -> applies one change and returns { changed:true, doc }
//
// The whole trip lives in a single JSON blob. Writes are applied server-side as small
// operations (e.g. "add this expense") on top of the latest stored copy, using the
// blob's ETag for compare-and-swap, so two people adding expenses at the same moment
// never overwrite each other.

import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";

const KEY = "trip-v1";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LOG = 150;
const MAX_AMOUNT = 100_000_000;
const DEFAULT_SGD_RATE = 115; // ¥ per S$1, used until a live rate is available
const SCHEMA = 2; // bump when the doc shape changes so open pages know to reload
const MAX_ITEMS = 5000;

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
      budget: 0,
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
    // One entry per expense: { id, date, cat, a: amountInYen, note, by, t }
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
  doc.schema = SCHEMA;
  return doc;
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

function str(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function fail(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

function findCategory(doc, id) {
  const cat = doc.categories.find((c) => c.id === id);
  if (!cat) fail("Unknown category");
  return cat;
}

// Mutates doc and returns a human readable log line (or null for no-op).
function applyOp(doc, body, by) {
  switch (body.op) {
    // "addToCell" is what pages loaded before itemised expenses still send.
    case "addItem":
    case "addToCell": {
      const date = str(body.date, 10);
      if (!DATE_RE.test(date)) fail("Invalid date");
      const cat = findCategory(doc, body.cat);
      const amount = Math.round(Number(body.amount));
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) fail("Invalid amount");
      if (doc.items.length >= MAX_ITEMS) fail("Too many expenses");
      const note = str(body.note, 60);
      doc.items.push({ id: randomUUID(), date, cat: cat.id, a: amount, note, by, t: Date.now() });
      return `added ${yen.format(amount)} to ${cat.emoji} ${cat.name} on ${prettyDate(date)}` +
        (note ? ` (${note})` : "");
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
        budget: Math.max(0, Math.round(Number(t.budget) || 0)),
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const passcode = process.env.TRIP_PASSCODE;
  if (passcode && req.headers.get("x-trip-code") !== passcode) {
    return json({ error: "passcode" }, 401);
  }

  const store = getStore({ name: "japan-trip", consistency: "strong" });

  if (req.method === "GET") {
    const stored = await store.get(KEY, { type: "json" });
    const doc = stored ? normalize(stored) : defaultDoc();
    const since = new URL(req.url).searchParams.get("v");
    if (since !== null && Number(since) === doc.version) {
      return json({ changed: false, version: doc.version });
    }
    return json({ changed: true, doc });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const by = str(body.by, 30) || "Someone";

    for (let attempt = 0; attempt < 10; attempt++) {
      const current = await store.getWithMetadata(KEY, { type: "json" });
      const doc = current ? normalize(current.data) : defaultDoc();

      let message;
      try {
        message = applyOp(doc, body, by);
      } catch (err) {
        if (err.status) return json({ error: err.message }, err.status);
        throw err;
      }

      doc.version += 1;
      doc.updatedAt = Date.now();
      if (message) {
        doc.log.unshift({ t: doc.updatedAt, by, msg: message });
        doc.log.length = Math.min(doc.log.length, MAX_LOG);
      }

      const result = await store.setJSON(
        KEY,
        doc,
        current ? { onlyIfMatch: current.etag } : { onlyIfNew: true },
      );
      if (result.modified) return json({ changed: true, doc });

      // Someone else wrote in between; back off briefly and re-apply on the newer copy.
      await sleep(30 + Math.random() * 120 * (attempt + 1));
    }
    return json({ error: "The tracker is busy, please try again." }, 409);
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/trip" };
