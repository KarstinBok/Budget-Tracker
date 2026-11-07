// Recognises food from a photo and/or a description and works out its calories and macros
// with Claude. Used by the food-scan background function.
//
//   recognizeFood({ image?: { data, mediaType }, text?, meal? })
//   -> { items: [{ name, amount, grams, kcal, p, c, f, fiber, sugar, sodium, confidence, source }], note }
//
// Claude looks the food up before estimating: packaged foods in the Open Food Facts
// database (by barcode or name), and branded or restaurant items on the web (the
// brand's or restaurant's own nutrition facts). Plain dishes use standard nutrition
// tables (e.g. USDA FoodData Central) for the portion it sees.
// Needs ANTHROPIC_API_KEY. FOOD_MODEL is optional.

import Anthropic from "@anthropic-ai/sdk";
import { str } from "./shared-doc.mjs";

const MODEL = process.env.FOOD_MODEL || "claude-opus-5-5";
const MAX_TURNS = 8;
const OFF_FIELDS = "code,product_name,brands,serving_size,quantity,nutriments";
const UA = "OurExpenses-FoodDiary/1.0 (https://japan-trip-budget.netlify.app/fitness/)";

// An error with a message that's safe to show on the page.
export class FoodError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const n = (description) => ({ type: "number", description });

const SAVE_TOOL = {
  name: "save_food_estimate",
  description: "Save the foods identified, with their nutrition for the amount eaten. Call this once, at the end.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["items", "note"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "amount", "grams", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "confidence", "source"],
          properties: {
            name: { type: "string", description: "Short food name, with brand or restaurant if known, e.g. \"Chicken rice (roasted)\" or \"Milo Kosong, Kopitiam\"." },
            amount: { type: "string", description: "The portion in everyday words, e.g. \"1 plate\", \"2 slices\", \"1 can (325 ml)\"." },
            grams: n("Estimated weight of the portion in grams (or ml for drinks)."),
            kcal: n("Calories for this portion."),
            protein_g: n("Protein in grams for this portion."),
            carbs_g: n("Carbohydrates in grams for this portion."),
            fat_g: n("Fat in grams for this portion."),
            fiber_g: n("Fibre in grams for this portion (0 if unknown)."),
            sugar_g: n("Sugars in grams for this portion (0 if unknown)."),
            sodium_mg: n("Sodium in milligrams for this portion (0 if unknown)."),
            confidence: { type: "string", enum: ["high", "medium", "low"], description: "high = exact product or published nutrition facts; medium = standard values for a clearly identified food; low = guessed dish or portion." },
            source: { type: "string", description: "Where the numbers come from, e.g. \"Open Food Facts\", \"mcdonalds.com.sg\", \"USDA FoodData Central\", \"Singapore HPB\", \"estimate\"." },
          },
        },
      },
      note: { type: "string", description: "One or two short sentences for the person: what you assumed (portion size, cooking oil, sauce) and anything worth double-checking. Empty if nothing." },
    },
  },
};

const LOOKUP_TOOL = {
  name: "lookup_food_database",
  description: "Search the Open Food Facts database of packaged foods and drinks. Give a barcode if one is readable (most exact), or a product name with brand. Returns up to 5 products with nutrition per 100 g/ml and per serving.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["barcode", "query"],
    properties: {
      barcode: { type: "string", description: "Digits of the barcode, or empty." },
      query: { type: "string", description: "Product name and brand, or empty when a barcode is given." },
    },
  },
};

const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 4 };

function prompt({ text, meal, hasImage }) {
  return [
    `This is food someone ate${meal ? ` for ${meal}` : ""}, to log in their calorie and macro diary. We live in Singapore.`,
    hasImage ? "The photo shows the food." : "",
    text ? `Their description: <description>${text}</description>` : "",
    "",
    "Work out each separate food or drink and the nutrition for the amount eaten:",
    "- Packaged products: use lookup_food_database, by barcode if you can read one, else by name and brand. Use the label's numbers scaled to the amount eaten.",
    "- Restaurant, chain or branded items (e.g. McDonald's, Starbucks, Subway, Ya Kun): search the web for the brand's published nutrition facts.",
    "- Home-cooked or hawker dishes: use standard nutrition values (USDA FoodData Central, Singapore HPB food composition data) for the portion you see, counting cooking oil and sauces.",
    "- If the description gives an amount, use it over what the photo suggests. Estimate portions from plate size and common serving sizes.",
    "- Keep it quick: look up only what changes the numbers. Don't search for plain foods like rice, eggs or fruit.",
    "Then call save_food_estimate once with every item. The calories should roughly match 4 kcal/g protein, 4 kcal/g carbs and 9 kcal/g fat.",
  ].filter(Boolean).join("\n");
}

const per = (nm, key) => {
  const v = nm?.[key];
  return typeof v === "number" ? Math.round(v * 10) / 10 : undefined;
};

function offProduct(p) {
  const nm = p.nutriments ?? {};
  return {
    barcode: p.code,
    name: p.product_name,
    brand: p.brands,
    quantity: p.quantity,
    serving_size: p.serving_size,
    per_100: { kcal: per(nm, "energy-kcal_100g"), protein_g: per(nm, "proteins_100g"), carbs_g: per(nm, "carbohydrates_100g"), fat_g: per(nm, "fat_100g"), fiber_g: per(nm, "fiber_100g"), sugar_g: per(nm, "sugars_100g"), sodium_mg: nm.sodium_100g !== undefined ? Math.round(nm.sodium_100g * 1000) : undefined },
    per_serving: nm["energy-kcal_serving"] !== undefined ? { kcal: per(nm, "energy-kcal_serving"), protein_g: per(nm, "proteins_serving"), carbs_g: per(nm, "carbohydrates_serving"), fat_g: per(nm, "fat_serving") } : undefined,
  };
}

// Open Food Facts: by barcode, or a name search. Returns JSON text for Claude.
async function lookupFood({ barcode, query }) {
  const code = String(barcode ?? "").replace(/\D/g, "");
  const headers = { "user-agent": UA };
  const opts = { headers, signal: AbortSignal.timeout(12_000) };
  if (code.length >= 8) {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, opts);
    const data = await res.json().catch(() => ({}));
    if (data.product) return JSON.stringify({ products: [offProduct({ ...data.product, code })] });
    if (!query) return JSON.stringify({ products: [], note: "No product with that barcode." });
  }
  const q = str(query, 120);
  if (!q) return JSON.stringify({ products: [], note: "Give a barcode or a product name." });
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=5&fields=${OFF_FIELDS}`;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Open Food Facts answered ${res.status}`);
  const data = await res.json();
  return JSON.stringify({ products: (data.products ?? []).slice(0, 5).map(offProduct) });
}

const round1 = (v) => Math.max(0, Math.round((Number(v) || 0) * 10) / 10);

function cleanItems(input) {
  return (input?.items ?? []).slice(0, 30).map((i) => ({
    name: str(i.name, 80) || "Food",
    amount: str(i.amount, 60),
    grams: Math.max(0, Math.round(Number(i.grams) || 0)),
    kcal: Math.max(0, Math.round(Number(i.kcal) || 0)),
    p: round1(i.protein_g),
    c: round1(i.carbs_g),
    f: round1(i.fat_g),
    fiber: round1(i.fiber_g),
    sugar: round1(i.sugar_g),
    sodium: Math.max(0, Math.round(Number(i.sodium_mg) || 0)),
    confidence: ["high", "medium", "low"].includes(i.confidence) ? i.confidence : "low",
    source: str(i.source, 80),
  }));
}

export async function recognizeFood({ image, text = "", meal = "" }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FoodError("Food recognition isn't set up yet: add ANTHROPIC_API_KEY in Netlify's environment variables, then redeploy.", 503);
  }
  const description = str(text, 500);
  if (!image && !description) throw new FoodError("Add a photo or describe the food", 400);

  const client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  const content = [];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  content.push({ type: "text", text: prompt({ text: description, meal: str(meal, 20), hasImage: !!image }) });
  const messages = [{ role: "user", content }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: [SAVE_TOOL, LOOKUP_TOOL, WEB_SEARCH],
        messages,
      });
    } catch (err) {
      console.error("Claude request failed:", err);
      if (err instanceof Anthropic.AuthenticationError) throw new FoodError("The Anthropic API key isn't valid. Check ANTHROPIC_API_KEY on Netlify.", 503);
      if (err instanceof Anthropic.RateLimitError) throw new FoodError("Claude is busy right now. Try again in a minute.", 429);
      throw new FoodError("Couldn't reach Claude. Try again.", 502);
    }

    if (response.stop_reason === "refusal") throw new FoodError("Claude couldn't read this one. Describe the food instead.", 422);

    const save = response.content.find((b) => b.type === "tool_use" && b.name === SAVE_TOOL.name);
    if (save) {
      const items = cleanItems(save.input);
      if (!items.length) throw new FoodError("No food found. Try a clearer photo or describe it.", 422);
      return { items, note: str(save.input.note, 400) };
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue; // web search ran long: let it carry on

    const lookups = response.content.filter((b) => b.type === "tool_use" && b.name === LOOKUP_TOOL.name);
    if (lookups.length) {
      const results = [];
      for (const call of lookups) {
        try {
          results.push({ type: "tool_result", tool_use_id: call.id, content: await lookupFood(call.input) });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Lookup failed: ${err.message}. Use standard values instead.` });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    // Answered in words without saving: ask once more for the tool call.
    messages.push({ role: "user", content: "Now call save_food_estimate with the foods and their nutrition." });
  }
  throw new FoodError("Recognising this food took too long. Try again or describe it.", 504);
}
