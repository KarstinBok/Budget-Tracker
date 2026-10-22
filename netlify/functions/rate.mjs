// Live JPY per SGD exchange rate.
//
//   GET /api/rate -> { rate, source, fetched, asOf? }   (rate = ¥ per S$1)
//
// Coinbase's public exchange-rate feed tracks the market and updates every few minutes;
// the two daily reference-rate feeds are only used if it is unreachable. The result is
// cached in Netlify Blobs for a few minutes so everyone on the trip sees the same rate.

import { getStore } from "@netlify/blobs";

const KEY = "rate-sgd-jpy";
const TTL_MS = 5 * 60 * 1000;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const SOURCES = [
  {
    name: "Coinbase",
    async load() {
      const r = await getJson("https://api.coinbase.com/v2/exchange-rates?currency=SGD");
      return { rate: Number(r.data.rates.JPY) };
    },
  },
  {
    name: "ECB reference rate",
    async load() {
      const r = await getJson("https://api.frankfurter.dev/v1/latest?base=SGD&symbols=JPY");
      return { rate: Number(r.rates.JPY), asOf: r.date };
    },
  },
  {
    name: "open.er-api.com",
    async load() {
      const r = await getJson("https://open.er-api.com/v6/latest/SGD");
      return { rate: Number(r.rates.JPY), asOf: new Date(r.time_last_update_unix * 1000).toISOString().slice(0, 10) };
    },
  },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async () => {
  const store = getStore({ name: "japan-trip", consistency: "strong" });
  const cached = await store.get(KEY, { type: "json" });
  if (cached && Date.now() - cached.fetched < TTL_MS) return json(cached);

  for (const source of SOURCES) {
    try {
      const { rate, asOf } = await source.load();
      if (!(rate > 0)) continue;
      const result = { rate, source: source.name, fetched: Date.now(), ...(asOf ? { asOf } : {}) };
      await store.setJSON(KEY, result);
      return json(result);
    } catch (err) {
      console.warn(`Rate source ${source.name} failed:`, err.message);
    }
  }
  // Every source failed: fall back to the last rate we had, however old.
  if (cached) return json(cached);
  return json({ error: "No exchange rate available right now" }, 503);
};

export const config = { path: "/api/rate" };
