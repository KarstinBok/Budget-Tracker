// Sums shared by the apps and the home page, so they always agree:
// who owes whom in everyday expenses, and daily calorie and macro goals.

// ---------------------------------------------------------------- everyday expenses (/daily/)

// A personal expense paid with someone else's card: { from, to, card }, else null.
export function borrowedOf(doc, item) {
  const card = item.kind === "personal" && item.card && doc.cards?.find((c) => c.id === item.card);
  return card && card.owner !== item.owner ? { from: item.owner, to: card.owner, card } : null;
}

// Who owes whom over all time, from shared expenses, borrowed cards and payments back:
// the fewest transfers [{ from, to, a: cents }] that even it out.
export function settleUp(doc) {
  const net = Object.fromEntries(doc.people.map((p) => [p, 0])); // positive = is owed money
  for (const i of doc.items) {
    const b = borrowedOf(doc, i);
    if (b && b.from in net && b.to in net) {
      net[b.to] += i.a;
      net[b.from] -= i.a;
    }
  }
  for (const i of doc.items.filter((x) => x.kind === "shared")) {
    if (i.paidBy in net) net[i.paidBy] += i.a;
    for (const [p, f] of Object.entries(i.shares ?? {})) if (p in net) net[p] -= i.a * f;
  }
  for (const s of doc.settlements) {
    if (s.from in net) net[s.from] += s.a;
    if (s.to in net) net[s.to] -= s.a;
  }
  // Largest debtor pays largest creditor, repeat.
  const owe = Object.entries(net).map(([p, v]) => ({ p, v: Math.round(v) }));
  const transfers = [];
  for (let guard = 0; guard < 20; guard++) {
    owe.sort((a, b) => a.v - b.v);
    const debtor = owe[0], creditor = owe[owe.length - 1];
    if (!debtor || debtor.v > -1 || creditor.v < 1) break;
    const a = Math.min(-debtor.v, creditor.v);
    transfers.push({ from: debtor.p, to: creditor.p, a });
    debtor.v += a;
    creditor.v -= a;
  }
  return transfers;
}

// ---------------------------------------------------------------- food & fitness (/fitness/)

const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very: 1.9 };
const KCAL_PER_KG = 7700;

// Whether a person's exercise calories are added back to their daily goal (on unless they
// turned it off in Goals). Exercise is still logged and shown either way.
export const exerciseAddsBack = (doc, p) => doc.profiles?.[p]?.addExercise !== false;

// A person's weigh-ins, oldest first.
export function weighInsOf(doc, p) {
  return doc.weights.filter((w) => w.person === p).sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t);
}

export const latestWeightOf = (doc, p, onOrBefore = "9999") => weighInsOf(doc, p).filter((w) => w.date <= onOrBefore).at(-1) ?? null;

// Daily goals from the profile: Mifflin-St Jeor BMR x activity, plus the weekly goal, never
// below 1,200 kcal (women) or 1,500 (men); or the person's own calorie goal. 2,000 if unset.
export function fitnessTargets(doc, p, onDay) {
  const pr = doc.profiles[p] ?? {};
  const w = latestWeightOf(doc, p, onDay)?.kg ?? null;
  const age = pr.birthYear ? new Date().getFullYear() - pr.birthYear : null;
  let calc = null;
  if (w && pr.heightCm && age) {
    const bmr = 10 * w + 6.25 * pr.heightCm - 5 * age + (pr.sex === "male" ? 5 : pr.sex === "female" ? -161 : -78);
    const tdee = bmr * (ACTIVITY[pr.activity] ?? 1.375);
    const floor = pr.sex === "male" ? 1500 : 1200;
    calc = { bmr: Math.round(bmr), tdee: Math.round(tdee), kcal: Math.max(floor, Math.round((tdee + ((pr.weeklyKg ?? 0) * KCAL_PER_KG) / 7) / 10) * 10), floor };
  }
  const kcal = pr.kcalTarget || calc?.kcal || 2000;
  const m = pr.macros ?? { p: 30, c: 40, f: 30 };
  return {
    kcal, calc, set: !!(pr.kcalTarget || calc),
    p: (kcal * m.p) / 100 / 4, c: (kcal * m.c) / 100 / 4, f: (kcal * m.f) / 100 / 9, pct: m,
  };
}
