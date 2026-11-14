// Photos attached to feedback (⚙️ Settings → 💬 Feedback): screenshots with the problem
// circled, so whoever fixes it can see exactly where it is.
//   POST { image: "data:image/jpeg;base64,…" }  -> { id }   (made small on the phone first)
//   GET  ?id=<id>                               -> { id, image }
// Kept apart from the feedback document so that stays small; feedback items list the ids.

import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { json, passcodeError } from "../lib/shared-doc.mjs";

const store = () => getStore({ name: "feedback-photos", consistency: "strong" });
const MAX_IMAGE = 700_000; // characters of data URL (~500 KB)
const ID_RE = /^[0-9a-f-]{36}$/;

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!ID_RE.test(id)) return json({ error: "Pick a photo" }, 400);
    const image = await store().get(id, { type: "text" });
    return image ? json({ id, image }) : json({ error: "That photo is gone" }, 404);
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => null);
    const image = String(body?.image ?? "");
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) return json({ error: "That isn't a picture" }, 400);
    if (image.length > MAX_IMAGE) return json({ error: "That picture is too big" }, 400);
    const id = randomUUID();
    await store().set(id, image);
    return json({ id });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config = { path: "/api/feedback-photo" };
