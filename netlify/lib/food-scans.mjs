// Storage for food recognition jobs (food-scan.mjs and food-scan-background.mjs).
// Each job lives in its own Netlify Blobs store until the page has read the result.

import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const scanStore = () => getStore({ name: "food-scans", consistency: "strong" });

// Signs the call that starts the background job, so only this site can start one.
export function scanToken() {
  return createHash("sha256").update(`food-scan:${process.env.ANTHROPIC_API_KEY}`).digest("hex");
}

export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
