// Food recognition jobs: POST/GET /api/food-scan
//
//   POST { image?: <base64 JPEG/PNG/WebP>, mediaType?, text?, meal? } -> { id }
//   GET  ?id=<id> -> { status: "pending" } | { status: "done", items, note } | { status: "error", error }
//
// Asking Claude (with lookups) can take longer than a normal function may run, so the
// work happens in food-scan-background.mjs and the page polls for the result. Nothing is
// logged to the diary here: the page shows the result for checking first.

import { randomUUID } from "node:crypto";
import { json, passcodeError } from "../lib/shared-doc.mjs";
import { scanStore, scanToken } from "../lib/food-scans.mjs";

const MAX_IMAGE = 6_000_000; // base64 characters (~4.5 MB)
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const STALE_MS = 6 * 60_000; // a job that hasn't finished by now has failed

export default async (req) => {
  const denied = passcodeError(req);
  if (denied) return denied;
  const store = scanStore();

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!/^[\w-]{10,60}$/.test(id)) return json({ error: "Unknown scan" }, 404);
    const job = await store.get(id, { type: "json" });
    if (!job) return json({ error: "Unknown scan" }, 404);
    if (job.status === "pending" && Date.now() - job.t > STALE_MS) {
      await store.delete(id);
      return json({ status: "error", error: "Recognising this food took too long. Try again or describe it." });
    }
    if (job.status !== "pending") await store.delete(id); // the result is read once
    const { input, ...rest } = job;
    return json(rest);
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: "Food recognition isn't set up yet: add ANTHROPIC_API_KEY in Netlify's environment variables, then redeploy." }, 503);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const image = body.image ? String(body.image).replace(/^data:[^,]*,/, "") : "";
  if (image.length > MAX_IMAGE) return json({ error: "That photo is too large" }, 413);
  if (image && !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: "That photo couldn't be read" }, 400);
  const text = String(body.text ?? "").trim().slice(0, 500);
  if (!image && !text) return json({ error: "Add a photo or describe the food" }, 400);

  const id = randomUUID();
  const input = {
    image: image ? { data: image, mediaType: TYPES.includes(body.mediaType) ? body.mediaType : "image/jpeg" } : null,
    text,
    meal: String(body.meal ?? "").slice(0, 20),
  };
  await store.setJSON(id, { status: "pending", t: Date.now(), input });

  const res = await fetch(new URL("/.netlify/functions/food-scan-background", req.url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-scan-token": scanToken() },
    body: JSON.stringify({ id }),
  }).catch((err) => ({ ok: false, status: err.message }));
  if (!res.ok) {
    await store.delete(id);
    console.error("Couldn't start food scan:", res.status);
    return json({ error: "Couldn't start recognising the food. Try again." }, 502);
  }
  return json({ id });
};

export const config = { path: "/api/food-scan" };
