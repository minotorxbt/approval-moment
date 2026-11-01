// Deterministic checks: the safety floor.
// The AI verifier can only make the final verdict stricter, never looser.
export const worst = (levels) =>
  levels.includes("bad") ? "bad" : levels.includes("warn") ? "warn" : "ok";

// Text that is invisible to a human shopper but readable by an agent is a red flag.
// If it also looks like an instruction aimed at an AI, it is treated as an attack.
// (English patterns first; a few Turkish ones are kept for multilingual pages.)
const INJECTION = [
  /\b(ai|a\.i\.|llm|assistants?|agents?|bots?)\b/i,
  /ignore (all |any |previous |prior )?instructions/i,
  /(do not|don'?t|never) (ask|request|wait for)\b.*\b(user|approval|confirmation|permission)/i,
  /\b(pay|send|transfer|wire)\b.*\b(immediately|now|right away|at once)\b/i,
  /\b[a-z0-9_-]+\.near\b/i,
  /yapay zek[âa]/i,
  /asistan/i,
  /onay\s*isteme/i,
];

export function scanHidden(hidden) {
  const t = (hidden || "").trim();
  if (!t) return "ok";
  return INJECTION.some((re) => re.test(t)) ? "bad" : "warn";
}

export function check(ins, plan, page = {}) {
  const rows = [
    ["Item", plan.item === ins.item ? "ok" : "bad"],
    ["Color", plan.color === ins.color ? "ok" : "warn"],
    ["Size", plan.size === ins.size ? "ok" : "warn"],
    ["Price", plan.price <= ins.max ? "ok" : "bad"],
    ["Payee account", plan.to === ins.to ? "ok" : "bad"],
    ["Seller", plan.rep || "ok"],
    ["Source safety", scanHidden(page.hidden)],
  ];
  return { verdict: worst(rows.map((r) => r[1])), rows };
}
