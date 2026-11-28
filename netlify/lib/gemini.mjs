// Nutrition from Google's Gemini, grounded in Google Search:
//  - geminiNutrition: for the Claude connector (netlify/functions/mcp.mjs). Claude looks at
//    the meal photo and describes each item and its estimated weight; Gemini searches
//    Google for the nutrition and works out the numbers for those weights.
//  - geminiMeal: for the Telegram bot (netlify/functions/telegram-background.mjs). Gemini
//    looks at the photo itself (or reads a description), estimates each item's weight and
//    works out its nutrition the same way.
// Both cite the pages they used.
//
// Needs GEMINI_API_KEY (a free key from Google AI Studio, aistudio.google.com/apikey).
// GEMINI_MODEL is optional.

import { str } from "./shared-doc.mjs";

const DEFAULT_MODEL = "gemini-2.5-flash";

export const geminiEnabled = () => Boolean(process.env.GEMINI_API_KEY);

const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : undefined);

function prompt({ items, context }) {
  const list = items.map((it, i) => `${i + 1}. ${it.name}${it.grams ? `: ${it.grams} g` : ""}${it.notes ? ` (${it.notes})` : ""}`).join("\n");
  return `You are a nutrition analyst. ${SOURCES}
${context ? `\nContext: ${context}\n` : ""}
Foods (weights are what was eaten; if a weight is missing, estimate a typical portion and say so in "note"):
${list}

For each food, find the nutrition per 100 g (or per serving) and scale it to the weight given. Reply with ONLY a JSON object, no other text, in this shape:
{"items":[${ITEM_SHAPE}]}`;
}

// The reply is meant to be bare JSON, but may come wrapped in a code fence or prose.
function parseJson(text) {
  const t = String(text ?? "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini didn't return the numbers");
  return JSON.parse(t.slice(start, end + 1));
}

const ITEM_SHAPE = `{"name":"","grams":0,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":0,"sugar_g":0,"sodium_mg":0,"per_100g_kcal":0,"source":"site or database name","source_url":"","note":""}`;

const SOURCES = "Use Google Search to find reliable nutrition data for each food: the brand's or restaurant's published nutrition facts when a brand or restaurant is named or visible, otherwise official databases (USDA FoodData Central, Singapore HPB, national food composition tables) or reputable nutrition sites.";

function cleanItem(it) {
  return {
    name: str(it?.name, 120), grams: n(it?.grams), kcal: Math.round(Number(it?.kcal) || 0),
    protein_g: n(it?.protein_g) ?? 0, carbs_g: n(it?.carbs_g) ?? 0, fat_g: n(it?.fat_g) ?? 0,
    fiber_g: n(it?.fiber_g), sugar_g: n(it?.sugar_g), sodium_mg: n(it?.sodium_mg), per_100g_kcal: n(it?.per_100g_kcal),
    source: str(it?.source ?? "", 120), source_url: str(it?.source_url ?? "", 500), note: str(it?.note ?? "", 300),
  };
}

// Sends the parts (text and images) to Gemini with Google Search on, and returns the JSON
// object it replied with, the model and the pages Google Search returned.
async function ask(parts, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Gemini isn't set up: add GEMINI_API_KEY in Netlify's environment variables, then redeploy");
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new Error("Gemini's free limit is used up for now");
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(`Gemini answered ${res.status}${detail?.error?.message ? `: ${detail.error.message}` : ""}`);
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const out = parseJson((cand?.content?.parts ?? []).map((p) => p.text ?? "").join(""));
  // The pages Google Search actually returned, as opposed to links the model wrote itself.
  const searched = (cand?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web && { title: c.web.title, url: c.web.uri }).filter(Boolean).slice(0, 10);
  return { out, model, searched };
}

function withTotals(items) {
  const sum = (k) => Math.round(items.reduce((s, it) => s + (Number(it[k]) || 0), 0) * 10) / 10;
  return { kcal: Math.round(sum("kcal")), protein_g: sum("protein_g"), carbs_g: sum("carbs_g"), fat_g: sum("fat_g") };
}

export async function geminiNutrition({ items, context }) {
  const foods = (Array.isArray(items) ? items : []).slice(0, 20).map((it) => ({
    name: str(it?.name, 120), grams: n(it?.grams), notes: str(it?.notes ?? "", 200),
  })).filter((it) => it.name);
  if (!foods.length) throw new Error("List at least one food");
  const { out, model, searched } = await ask([{ text: prompt({ items: foods, context: str(context ?? "", 300) }) }], 25_000);
  const list = (Array.isArray(out.items) ? out.items : []).map(cleanItem);
  return { model, items: list, totals: withTotals(list), google_search_results: searched };
}

// A meal from a photo (base64 image) and/or a description. Returns
// { dish, items: [...], totals, confidence, model, google_search_results }.
export async function geminiMeal({ imageBase64, mimeType = "image/jpeg", text = "" }) {
  const caption = str(text, 500);
  if (!imageBase64 && !caption) throw new Error("Send a photo or describe the food");
  const instructions = `You are a nutrition analyst logging a meal to a food diary.
${imageBase64 ? "Look at the photo. Identify every food and drink in it, and estimate the weight eaten of each in grams (ml for drinks) from scale cues: a dinner plate is ~26 cm, a hawker plate ~23 cm, a rice bowl ~250 ml, a dessert spoon ~15 cm, chopsticks ~23 cm. Count pieces where you can. Include cooking oil, sauces and gravy. If there's a nutrition label or barcode, use it." : "Work out the foods described below and estimate a typical portion's weight in grams where none is given."}
${caption ? `The person wrote: "${caption}". Their words override what you see (e.g. a stated weight, portion, brand or restaurant, "half", "no rice"). Ignore words that only say whose diary, which meal or which day.` : ""}
Split a dish into its main components when that is more accurate (e.g. rice, chicken, sauce), but keep a known restaurant or packaged item whole when its published nutrition is available.
${SOURCES} Scale each to the weight you estimated.

Reply with ONLY a JSON object, no other text, in this shape:
{"dish":"short name for the whole meal","items":[${ITEM_SHAPE}],"confidence":"high|medium|low","note":"anything the person should check, e.g. a hidden ingredient or a portion you weren't sure of"}`;
  const parts = [{ text: instructions }];
  if (imageBase64) parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  const { out, model, searched } = await ask(parts, 60_000);
  const list = (Array.isArray(out.items) ? out.items : []).map(cleanItem).filter((it) => it.name && it.kcal >= 0);
  if (!list.length) throw new Error(out.note ? str(out.note, 200) : "Gemini couldn't find any food in that");
  return {
    dish: str(out.dish ?? "", 80) || list.map((it) => it.name).join(", ").slice(0, 80),
    items: list, totals: withTotals(list),
    confidence: ["high", "medium", "low"].includes(out.confidence) ? out.confidence : "medium",
    note: str(out.note ?? "", 300), model, google_search_results: searched,
  };
}
