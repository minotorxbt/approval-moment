// Deterministic checks: the safety floor.
// The AI verifier can only make the final verdict stricter, never looser.
export const worst = (levels) =>
  levels.includes("bad") ? "bad" : levels.includes("warn") ? "warn" : "ok";

// Text that is invisible to a human reader but readable by an agent is a red flag.
// If it also looks like an instruction aimed at an AI, it is treated as an attack.
// (English patterns first; a few Turkish ones are kept for multilingual pages.)
const INJECTION = [
  /\b(ai|a\.i\.|llm|assistants?|agents?|bots?)\b/i,
  /ignore (all |any |previous |prior )?instructions/i,
  /(do not|don'?t|never) (ask|request|wait for)\b.*\b(user|approval|confirmation|permission)/i,
  /\b(pay|send|transfer|wire)\b.*\b(immediately|now|right away|at once)\b/i,
  /\b[a-z0-9_-]+\.near\b/i,
  /\b(system|admin|developer|operator)\s*(message|prompt|notice|override)?\s*:/i,
  /<!--/,
  /\b(raised|changed|updated|increased|lifted)\b.*\b(limit|rules?|budget)\b/i,
  /\b(update|change|raise|override|forget)\b.*\b(your )?(rules?|limits?|instructions)\b/i,
  /yapay zek[âa]/i,
  /asistan/i,
  /onay\s*isteme/i,
];

export function scanHidden(hidden) {
  const t = (hidden || "").trim();
  if (!t) return "ok";
  return INJECTION.some((re) => re.test(t)) ? "bad" : "warn";
}

// ins  = the user's standing rule: { item, max, expected?, to, slots?, attrs? }
// plan = what the agent wants to pay: { item, price, to, slot?, attrs?, seller, rep }
// Each row is [label, level, detail].
export function check(ins, plan, page = {}) {
  const rows = [];
  const sameItem = plan.item === ins.item;
  rows.push(["Item", sameItem ? "ok" : "bad", sameItem ? plan.item : `${plan.item} (your rule: ${ins.item})`]);

  for (const [key, want] of Object.entries(ins.attrs || {})) {
    const got = plan.attrs?.[key];
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    rows.push([label, got === want ? "ok" : "warn", got === want ? String(got) : `${got ?? "none"} (you asked for ${want})`]);
  }

  const price = plan.price > ins.max ? "bad" : ins.expected != null && plan.price > ins.expected ? "warn" : "ok";
  const limit = `limit $${ins.max}${ins.expected != null ? `, expected $${ins.expected}` : ""}`;
  rows.push(["Price", price, `$${plan.price} (${limit})`]);

  if (Array.isArray(ins.slots)) {
    const free = ins.slots.includes(plan.slot);
    rows.push(["Appointment", free ? "ok" : "warn", free ? `${plan.slot} (you are free)` : `${plan.slot ?? "none"} (not in your free times)`]);
  }

  const sameAccount = plan.to === ins.to;
  rows.push(["Payee account", sameAccount ? "ok" : "bad", sameAccount ? plan.to : `${plan.to} (not your saved payee ${ins.to})`]);
  rows.push(["Payee reputation", plan.rep || "ok", plan.seller || ""]);

  const src = scanHidden(page.hidden);
  rows.push(["Source safety", src, src === "ok" ? "Clean" : src === "warn" ? "Hidden text found on the page" : "Hidden instruction found on the page"]);

  return { verdict: worst(rows.map((r) => r[1])), rows };
}
