// Nutrition from Google's Gemini, grounded in Google Search, for the Claude connector
// (netlify/functions/mcp.mjs). Claude looks at the meal photo and describes each item and
// its estimated weight; Gemini then searches Google for the nutrition and works out the
// numbers for those weights, citing the pages it used.
//
// Needs GEMINI_API_KEY (a free key from Google AI Studio, aistudio.google.com/apikey).
// GEMINI_MODEL is optional.

import { str } from "./shared-doc.mjs";

const DEFAULT_MODEL = "gemini-2.5-flash";

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : undefined);

function prompt({ items, context }) {
  const list = items.map((it, i) => `${i + 1}. ${it.name}${it.grams ? `: ${it.grams} g` : ""}${it.notes ? ` (${it.notes})` : ""}`).join("\n");
  return `You are a nutrition analyst. Use Google Search to find reliable nutrition data for each food below: the brand's or restaurant's published nutrition facts when a brand or restaurant is named, otherwise official databases (USDA FoodData Central, Singapore HPB, national food composition tables) or reputable nutrition sites.
${context ? `\nContext: ${context}\n` : ""}
Foods (weights are what was eaten; if a weight is missing, estimate a typical portion and say so in "note"):
${list}

For each food, find the nutrition per 100 g (or per serving) and scale it to the weight given. Reply with ONLY a JSON object, no other text, in this shape:
{"items":[{"name":"","grams":0,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":0,"sugar_g":0,"sodium_mg":0,"per_100g_kcal":0,"source":"site or database name","source_url":"","note":""}]}`;
}

// The reply is meant to be bare JSON, but may come wrapped in a code fence or prose.
function parseJson(text) {
  const t = String(text ?? "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini didn't return the numbers");
  return JSON.parse(t.slice(start, end + 1));
}

export async function geminiNutrition({ items, context }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini isn't set up: add GEMINI_API_KEY in Netlify's environment variables, then redeploy");
  const foods = (Array.isArray(items) ? items : []).slice(0, 20).map((it) => ({
    name: str(it?.name, 120), grams: n(it?.grams), notes: str(it?.notes ?? "", 200),
  })).filter((it) => it.name);
  if (!foods.length) throw new Error("List at least one food");

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt({ items: foods, context: str(context ?? "", 300) }) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 429) throw new Error("Gemini's free limit is used up for now");
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`Gemini answered ${res.status}${detail?.error?.message ? `: ${detail.error.message}` : ""}`);
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  const out = parseJson(text);

  const list = (Array.isArray(out.items) ? out.items : []).map((it) => ({
    name: str(it.name, 120), grams: n(it.grams), kcal: Math.round(Number(it.kcal) || 0),
    protein_g: n(it.protein_g) ?? 0, carbs_g: n(it.carbs_g) ?? 0, fat_g: n(it.fat_g) ?? 0,
    fiber_g: n(it.fiber_g), sugar_g: n(it.sugar_g), sodium_mg: n(it.sodium_mg), per_100g_kcal: n(it.per_100g_kcal),
    source: str(it.source ?? "", 120), source_url: str(it.source_url ?? "", 500), note: str(it.note ?? "", 300),
  }));
  const sum = (k) => Math.round(list.reduce((s, it) => s + (Number(it[k]) || 0), 0) * 10) / 10;
  // The pages Google Search actually returned, as opposed to links the model wrote itself.
  const searched = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web && { title: c.web.title, url: c.web.uri }).filter(Boolean).slice(0, 10);

  return {
    model,
    items: list,
    totals: { kcal: Math.round(sum("kcal")), protein_g: sum("protein_g"), carbs_g: sum("carbs_g"), fat_g: sum("fat_g") },
    google_search_results: searched,
  };
}
