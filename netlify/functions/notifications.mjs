// 🔔 Notifications API (see netlify/lib/notify.mjs):
//   GET  /api/notifications -> { items, people, publicKey }   the feed, newest first
//   POST { op: "subscribe", subscription, name }               this device gets push notifications
//   POST { op: "unsubscribe", endpoint }                       it stops

import { json, liveStore, passcodeError } from "../lib/shared-doc.mjs";
import { publicKey, readFeed, removeSubscription, saveSubscription } from "../lib/notify.mjs";

async function people() {
  const names = new Set();
  for (const key of ["daily-v1", "fitness-v1"]) {
    const doc = await liveStore().get(key, { type: "json" });
    for (const p of doc?.people ?? []) names.add(p);
  }
  return names.size ? [...names] : ["Karstin", "Lilin"];
}

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;

  if (req.method === "GET") {
    const [items, names, key] = await Promise.all([readFeed(), people(), publicKey()]);
    return json({ items: items.slice(0, 60), people: names, publicKey: key });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    try {
      if (body?.op === "subscribe") await saveSubscription(body.subscription, body.name ?? body.by);
      else if (body?.op === "unsubscribe") await removeSubscription(String(body.endpoint ?? ""));
      else return json({ error: "Unknown operation" }, 400);
    } catch (err) {
      return json({ error: err.message }, 400);
    }
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/notifications" };
