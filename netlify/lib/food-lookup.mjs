// Food database lookups for the Claude connector (netlify/functions/mcp.mjs), so Claude
// can check nutrition per 100 g against real data when it logs a meal:
//  - lookupUsda: USDA FoodData Central (Foundation and SR Legacy foods), for whole foods
//    and cooked staples. Uses FDC_API_KEY (a free api.data.gov key) if set, else the
//    shared, heavily rate-limited DEMO_KEY.
//  - lookupFood: Open Food Facts, for packaged foods and drinks, by barcode or name.
// Both return JSON text.

import { str } from "./shared-doc.mjs";

const OFF_FIELDS = "code,product_name,brands,serving_size,quantity,nutriments";
const UA = "OurExpenses-FoodDiary/1.0 (https://japan-trip-budget.netlify.app/fitness/)";

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
export async function lookupFood({ barcode, query }) {
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

export async function lookupUsda({ query }) {
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
