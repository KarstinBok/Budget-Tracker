// Recognises food from photos and/or a description and works out its calories and macros
// with Claude. Used by the food-scan background function.
//
//   recognizeFood({ images?: [{ data, mediaType }], text?, meal? })
//   -> { items: [{ name, amount, grams, kcal, p, c, f, fiber, sugar, sodium, confidence, source, url,
//                  ingredients: [{ name, grams, kcal, p, c, f, source, url }] }], note }
//
// Claude estimates each dish ingredient by ingredient: what's in it and how many grams of
// each, judged from the photo (plate and cutlery size, how full the bowl is), then the
// nutrition per 100 g of each ingredient from a database, scaled to its weight:
//  - USDA FoodData Central for whole foods and cooked staples (lookup_usda);
//  - Open Food Facts for packaged products, by barcode or name (lookup_food_database);
//  - the web for restaurant, chain and branded items (the brand's own nutrition facts).
// Needs ANTHROPIC_API_KEY. FOOD_MODEL and FDC_API_KEY (a free api.data.gov key; without
// one the shared, heavily rate-limited DEMO_KEY is used) are optional.

import Anthropic from "@anthropic-ai/sdk";
import { str } from "./shared-doc.mjs";

const MODEL = process.env.FOOD_MODEL || "claude-opus-5-5";
const MAX_TURNS = 14;
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
const URL_FIELD = { type: "string", description: "Link to the database entry or web page the numbers came from, or empty." };

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
          required: ["name", "amount", "grams", "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g", "sugar_g", "sodium_mg", "confidence", "source", "url", "ingredients"],
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
            source: { type: "string", description: "Where the numbers come from, e.g. \"Open Food Facts\", \"mcdonalds.com.sg\", \"USDA FoodData Central\", \"Singapore HPB\", \"estimate\". For a dish built from ingredients: \"Ingredients\"." },
            url: URL_FIELD,
            ingredients: {
              type: "array",
              description: "For a dish: its ingredients with estimated weights, each with its own nutrition; the item's totals are their sum. Empty for a single packaged product or published menu item.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "grams", "kcal", "protein_g", "carbs_g", "fat_g", "source", "url"],
                properties: {
                  name: { type: "string", description: "Ingredient as cooked, e.g. \"White rice, cooked\", \"Chicken thigh, roasted, with skin\", \"Peanut oil\"." },
                  grams: n("Estimated weight in this portion, in grams."),
                  kcal: n("Calories for that weight."),
                  protein_g: n("Protein in grams for that weight."),
                  carbs_g: n("Carbohydrates in grams for that weight."),
                  fat_g: n("Fat in grams for that weight."),
                  source: { type: "string", description: "Database or site, e.g. \"USDA FoodData Central\"." },
                  url: URL_FIELD,
                },
              },
            },
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

const USDA_TOOL = {
  name: "lookup_usda",
  description: "Search USDA FoodData Central (Foundation and SR Legacy foods) for an ingredient. Returns up to 5 matches with nutrition per 100 g and a link. Use cooked forms for cooked food, e.g. \"rice white cooked\".",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: { query: { type: "string", description: "Ingredient in plain words, e.g. \"chicken thigh roasted skin\"." } },
  },
};

const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 5 };

function prompt({ text, meal, photos }) {
  return [
    `This is food someone ate${meal ? ` for ${meal}` : ""}, to log in their calorie and macro diary. We live in Singapore.`,
    photos ? `${photos === 1 ? "The photo shows" : `The ${photos} photos show`} the food (possibly also its label, barcode or a menu).` : "",
    text ? `Their description: <description>${text}</description>` : "",
    "",
    "Work out every separate food and drink and its nutrition for the amount eaten, as accurately as you can:",
    "1. Identify each dish and what's in it. Look closely: the cut and cooking of meat, sauces and gravy, oil sheen, toppings, sides.",
    "2. Estimate the weight of each ingredient. Use the scale cues in the photo: a dinner plate is about 26 cm across, a hawker plate 23 cm, a rice bowl holds about 250 ml, a dessert spoon is 15 cm long; judge how high and how spread the food is. Count pieces where you can (dumplings, slices, wings). Include cooking oil and sauces, which are easy to miss. If the description gives a weight or amount, use it.",
    "3. Look up each ingredient's nutrition per 100 g and scale it to the weight:",
    "   - whole foods and cooked staples (rice, noodles, meat, fish, egg, vegetables, oil): lookup_usda;",
    "   - packaged products and drinks: lookup_food_database, by barcode if you can read one, else by name and brand;",
    "   - restaurant, chain and branded items (McDonald's, Starbucks, Subway, Ya Kun, Toast Box…): search the web for the brand's published nutrition facts and use those for the whole item, without an ingredient list;",
    "   - local dishes: you may also search for Singapore HPB or other published values to check your total.",
    "   Look up several ingredients at once where you can. Keep the url of each source you use.",
    "4. For a dish, its totals are the sum of its ingredients. Check that calories roughly match 4 kcal/g protein, 4 kcal/g carbs and 9 kcal/g fat.",
    "Then call save_food_estimate once with every item. In the note, say what you assumed (portion, oil, sauce) and what to double-check.",
  ].filter(Boolean).join("\n");
}

const per = (nm, key) => {
  const v = nm?.[key];
  return typeof v === "number" ? Math.round(v * 10) / 10 : undefined;
};

function offProduct(p) {
  const nm = p.nutriments ?? {};
  return {
    url: p.code ? `https://world.openfoodfacts.org/product/${p.code}` : undefined,
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

// USDA FoodData Central nutrient ids (energy has three ids depending on the data type).
const FDC = { kcal: [1008, 2047, 2048], protein_g: [1003], carbs_g: [1005], fat_g: [1004], fiber_g: [1079], sugar_g: [2000, 1063], sodium_mg: [1093] };

async function lookupUsda({ query }) {
  const q = str(query, 120);
  if (!q) return JSON.stringify({ foods: [], note: "Give an ingredient to search for." });
  const key = process.env.FDC_API_KEY || "DEMO_KEY";
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(q)}&pageSize=5&dataType=Foundation,SR%20Legacy&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12_000) });
  if (res.status === 429) throw new Error("USDA rate limit reached");
  if (!res.ok) throw new Error(`USDA answered ${res.status}`);
  const data = await res.json();
  const foods = (data.foods ?? []).slice(0, 5).map((f) => {
    const per100 = {};
    for (const [k, ids] of Object.entries(FDC)) {
      const hit = ids.map((id) => f.foodNutrients?.find((x) => x.nutrientId === id)).find((x) => x && typeof x.value === "number");
      if (hit) per100[k] = Math.round(hit.value * (k === "sodium_mg" ? 1 : 10)) / (k === "sodium_mg" ? 1 : 10);
    }
    return { name: f.description, type: f.dataType, per_100g: per100, url: `https://fdc.nal.usda.gov/food-details/${f.fdcId}/nutrients` };
  });
  return JSON.stringify({ foods });
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
    url: safeUrl(i.url),
    ingredients: (i.ingredients ?? []).slice(0, 15).map((g) => ({
      name: str(g.name, 60) || "Ingredient",
      grams: Math.max(0, Math.round(Number(g.grams) || 0)),
      kcal: Math.max(0, Math.round(Number(g.kcal) || 0)),
      p: round1(g.protein_g),
      c: round1(g.carbs_g),
      f: round1(g.fat_g),
      source: str(g.source, 60),
      url: safeUrl(g.url),
    })),
  }));
}

// Only plain https links reach the page.
function safeUrl(u) {
  try {
    const url = new URL(String(u ?? ""));
    return url.protocol === "https:" ? url.href.slice(0, 300) : "";
  } catch {
    return "";
  }
}

const LOOKUPS = { [USDA_TOOL.name]: lookupUsda, [LOOKUP_TOOL.name]: lookupFood };

export async function recognizeFood({ images = [], image, text = "", meal = "" }) {
  if (image) images = [image, ...images]; // jobs saved before several photos were allowed
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FoodError("Food recognition isn't set up yet: add ANTHROPIC_API_KEY in Netlify's environment variables, then redeploy.", 503);
  }
  const description = str(text, 500);
  if (!images.length && !description) throw new FoodError("Add a photo or describe the food", 400);

  const client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  const content = [];
  for (const img of images.slice(0, 3)) content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  content.push({ type: "text", text: prompt({ text: description, meal: str(meal, 20), photos: Math.min(images.length, 3) }) });
  const messages = [{ role: "user", content }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: [SAVE_TOOL, USDA_TOOL, LOOKUP_TOOL, WEB_SEARCH],
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

    const lookups = response.content.filter((b) => b.type === "tool_use" && LOOKUPS[b.name]);
    if (lookups.length) {
      // All of this turn's lookups at once, answered together in one message.
      const results = await Promise.all(lookups.map(async (call) => {
        try {
          return { type: "tool_result", tool_use_id: call.id, content: await LOOKUPS[call.name](call.input) };
        } catch (err) {
          return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Lookup failed: ${err.message}. Use another source or standard values.` };
        }
      }));
      messages.push({ role: "user", content: results });
      continue;
    }

    // Answered in words without saving: ask once more for the tool call.
    messages.push({ role: "user", content: "Now call save_food_estimate with the foods and their nutrition." });
  }
  throw new FoodError("Recognising this food took too long. Try again or describe it.", 504);
}
