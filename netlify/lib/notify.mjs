// Notifications when someone adds something to Everyday expenses or Food & fitness:
// a short summary ("Lilin added 500 kcal of Chicken rice for lunch") goes into a shared
// feed, which every page shows under 🔔, and as a push notification to the phones of
// everyone else who turned notifications on.
//
// Netlify Blobs store "notify":
//   feed  { items: [{ id, t, app, actor, text, url }] }  newest first, capped
//   subs  { subs: [{ endpoint, keys, name, t }] }         push subscriptions, by device name
//   vapid { publicKey, privateKey }                       made on first use; the private key
//                                                         never leaves the server

import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { generateVAPIDKeys, sendNotification } from "web-push";

const MAX_FEED = 200;
const SITE = "https://japan-trip-budget.netlify.app";

export const notifyStore = () => getStore({ name: "notify", consistency: "strong" });

const money = (cents) => `S$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");

// The listed person a device or sender name belongs to ("Li Lin Loh" -> Lilin), else null.
export function personFor(people, name) {
  const n = norm(name);
  return people.find((p) => n && (norm(p) === n || n.startsWith(norm(p)) || norm(p).startsWith(n))) ?? null;
}

function list(names) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

// ---------------------------------------------------------------- summaries

// Who did it: the person matching the sender's name, or for Claude (the connector), the
// person it was logged for.
function actorOf(doc, by, subject) {
  const p = personFor(doc.people, by);
  if (p) return { person: p, label: p };
  if (norm(by) === "claude" && subject) return { person: subject, label: subject, via: "Claude" };
  return { person: null, label: by || "Someone" };
}

const describers = {
  "daily-v1"(doc, body, by) {
    if (body.op === "addItem") {
      const i = doc.items.at(-1);
      const cat = doc.categories.find((c) => c.id === i.cat);
      const what = `${money(i.a)} ${cat?.name.toLowerCase() ?? "expense"}${i.note ? ` (${i.note})` : ""}`;
      if (i.kind === "shared") {
        const a = actorOf(doc, by, i.paidBy);
        return { a, text: `${a.label} added a shared ${what}, paid by ${i.paidBy}`, url: "/daily/#shared" };
      }
      const a = actorOf(doc, by, i.owner);
      const card = i.card && doc.cards?.find((c) => c.id === i.card);
      const borrowed = card && card.owner !== i.owner ? ` on ${card.owner}'s ${card.name}` : "";
      return { a, text: `${a.label} added ${what}${a.person === i.owner ? "" : ` for ${i.owner}`}${borrowed}`, url: "/daily/#personal" };
    }
    if (body.op === "importItems") {
      if (body.final === false) return null; // a big import is sent in parts: one notification at the end
      const entry = doc.imports?.at(-1);
      if (!entry) return null;
      const a = actorOf(doc, by, entry.owner);
      return { a, text: `${a.label} imported ${entry.count} expenses (${money(entry.total)}) from ${entry.source}`, url: "/daily/#personal" };
    }
    if (body.op === "addSettlement") {
      const s = doc.settlements.at(-1);
      const a = actorOf(doc, by, s.from);
      return { a, text: `${a.label} recorded ${s.from} paying ${s.to} ${money(s.a)}`, url: "/daily/#shared" };
    }
    return null;
  },

  "fitness-v1"(doc, body, by) {
    if (body.op === "addFoods") {
      const n = Array.isArray(body.foods) ? Math.min(body.foods.length, 30) : 0;
      const foods = doc.foods.slice(-n);
      if (!foods.length) return null;
      const { person, meal } = foods[0];
      const kcal = foods.reduce((s, f) => s + f.kcal, 0);
      const a = actorOf(doc, by, person);
      const forWhom = a.person === person ? meal : `${person}'s ${meal}`;
      return { a, text: `${a.label} added ${kcal.toLocaleString("en-US")} kcal of ${list(foods.map((f) => f.name))} for ${forWhom}`, url: "/fitness/#diary" };
    }
    if (body.op === "addExercise") {
      const x = doc.exercises.at(-1);
      const a = actorOf(doc, by, x.person);
      return { a, text: `${a.label} logged ${x.minutes} min of ${x.name.toLowerCase()} (${x.kcal} kcal)${a.person === x.person ? "" : ` for ${x.person}`}`, url: "/fitness/#diary" };
    }
    if (body.op === "addWeight") {
      const w = doc.weights.at(-1);
      const a = actorOf(doc, by, w.person);
      return { a, text: `${a.label} logged ${a.person === w.person ? "a" : `${w.person}'s`} weight of ${w.kg} kg`, url: "/fitness/#progress" };
    }
    return null;
  },
};

// ---------------------------------------------------------------- feed and push

async function vapidKeys(store) {
  const saved = await store.get("vapid", { type: "json" });
  if (saved?.publicKey) return saved;
  const keys = generateVAPIDKeys();
  await store.setJSON("vapid", keys, { onlyIfNew: true });
  return (await store.get("vapid", { type: "json" })) ?? keys; // whichever was saved first
}

export async function publicKey() {
  return (await vapidKeys(notifyStore())).publicKey;
}

// Changes a JSON blob with compare-and-swap, retrying if someone else wrote in between.
async function updateJSON(store, key, empty, change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await store.getWithMetadata(key, { type: "json" });
    const value = current?.data ?? empty();
    change(value);
    const res = await store.setJSON(key, value, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (res.modified) return value;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error(`${key} stayed busy`);
}

export async function saveSubscription(sub, name) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("Bad subscription");
  const entry = { endpoint: String(sub.endpoint).slice(0, 1000), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) }, name: String(name ?? "").slice(0, 30), t: Date.now() };
  await updateJSON(notifyStore(), "subs", () => ({ subs: [] }), (v) => {
    v.subs = v.subs.filter((s) => s.endpoint !== entry.endpoint).concat(entry).slice(-50);
  });
}

export async function removeSubscription(endpoint) {
  await updateJSON(notifyStore(), "subs", () => ({ subs: [] }), (v) => {
    v.subs = v.subs.filter((s) => s.endpoint !== endpoint);
  });
}

export async function readFeed() {
  return (await notifyStore().get("feed", { type: "json" }))?.items ?? [];
}

// After a saved change: adds its summary to the feed and pushes it to everyone else.
// Never throws: a failed notification mustn't fail the change.
export async function notifyChange(key, body, by, doc) {
  try {
    const d = describers[key]?.(doc, body, by);
    if (!d) return;
    const store = notifyStore();
    const app = key === "daily-v1" ? "expenses" : "fitness";
    const item = { id: randomUUID(), t: Date.now(), app, actor: d.a.person ?? d.a.label, text: d.a.via ? `${d.text} (via ${d.a.via})` : d.text, url: d.url };
    await updateJSON(store, "feed", () => ({ items: [] }), (v) => {
      v.items = [item, ...v.items].slice(0, MAX_FEED);
    });

    const { subs } = (await store.get("subs", { type: "json" })) ?? { subs: [] };
    const to = subs.filter((s) => !d.a.person || personFor(doc.people, s.name) !== d.a.person);
    if (!to.length) return;
    const keys = await vapidKeys(store);
    const payload = JSON.stringify({ title: app === "expenses" ? "💸 Our expenses" : "🥗 Food & fitness", body: item.text, url: item.url, tag: item.id });
    const gone = [];
    await Promise.all(to.map((s) => sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, {
      vapidDetails: { subject: SITE, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 24 * 3600,
      timeout: 8000,
    }).catch((err) => {
      if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(s.endpoint); // unsubscribed or expired
      else console.error("Push failed:", err?.statusCode ?? err?.message);
    })));
    for (const endpoint of gone) await removeSubscription(endpoint);
  } catch (err) {
    console.error("Notification failed:", err);
  }
}
