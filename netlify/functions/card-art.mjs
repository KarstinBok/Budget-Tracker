// Card pictures for Everyday expenses (💳 Cards): a small image of each card's front,
// chosen by the person (from the bank's website or app, or a photo with the number covered).
//   GET  /api/card-art                    -> { art: { cardId: "data:image/jpeg;base64,…" } }
//   POST { op: "set", id, image }          saves a card's picture (a data URL, made small on the phone)
//   POST { op: "remove", id }              removes it
// Kept apart from the expenses document so that stays small; each card notes the picture's
// version (card.art) so every device knows when to reload.

import { getStore } from "@netlify/blobs";
import { json, passcodeError } from "../lib/shared-doc.mjs";

const store = () => getStore({ name: "card-art", consistency: "strong" });
const KEY = "art";
const MAX_IMAGE = 200_000; // characters of data URL (~150 KB)
const MAX_CARDS = 60;

async function update(change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store().getWithMetadata(KEY, { type: "json" });
    const value = cur?.data ?? { art: {} };
    change(value);
    const res = await store().setJSON(KEY, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (res.modified) return;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new Error("Busy, please try again");
}

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;

  if (req.method === "GET") {
    const saved = await store().get(KEY, { type: "json" });
    return json({ art: saved?.art ?? {} });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const id = String(body?.id ?? "").slice(0, 60);
    if (!/^[\w-]{8,60}$/.test(id)) return json({ error: "Pick a card" }, 400);
    try {
      if (body.op === "set") {
        const image = String(body.image ?? "");
        if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return json({ error: "That isn't a picture" }, 400);
        if (image.length > MAX_IMAGE) return json({ error: "That picture is too big" }, 400);
        await update((v) => {
          v.art[id] = image;
          const ids = Object.keys(v.art);
          if (ids.length > MAX_CARDS) delete v.art[ids[0]];
        });
      } else if (body.op === "remove") {
        await update((v) => { delete v.art[id]; });
      } else return json({ error: "Unknown operation" }, 400);
    } catch (err) {
      return json({ error: err.message }, 503);
    }
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/card-art" };
