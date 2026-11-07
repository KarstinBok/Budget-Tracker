// Background half of /api/food-scan (food-scan.mjs): recognises one food photo or
// description with Claude and stores the result for the page to collect. Netlify runs
// "*-background" functions for up to 15 minutes and answers the caller with 202 at once.
// Only food-scan.mjs can start it (it signs the call with scanToken()).

import { FoodError, recognizeFood } from "../lib/food-ai.mjs";
import { sameSecret, scanStore, scanToken } from "../lib/food-scans.mjs";

export default async (req) => {
  if (!process.env.ANTHROPIC_API_KEY || !sameSecret(req.headers.get("x-scan-token"), scanToken())) return;
  const { id } = await req.json().catch(() => ({}));
  const store = scanStore();
  const job = id && (await store.get(String(id), { type: "json" }));
  if (!job || job.status !== "pending") return;
  try {
    const { items, note } = await recognizeFood(job.input);
    await store.setJSON(id, { status: "done", t: job.t, items, note }); // the photo isn't kept
  } catch (err) {
    console.error("Food scan failed:", err);
    const error = err instanceof FoodError ? err.message : "Something went wrong recognising the food. Try again.";
    await store.setJSON(id, { status: "error", t: job.t, error });
  }
};
