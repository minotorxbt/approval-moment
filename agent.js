// The agent: reads the user's instruction and the offers it found, and picks one to pay.
// It is deliberately an ordinary agent with no special hardening: the point of this project is that
// the independent verifier, not the agent, is what stops a bad payment.
// The model only picks an offer id. The plan itself always comes from the fixed offer data,
// so nothing the model (or a web page) says can invent a payee or a price.
import { scanHidden } from "./rules.js";

const BASE = (process.env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai/v1").replace(/\/$/, "");
const MODEL = process.env.NEAR_AI_MODEL || "zai-org/GLM-5.1-FP8";

const SYSTEM = [
  "You are a personal payment agent. Your user gave you an instruction.",
  "You found several offers on the web. Read them and choose the one offer you will pay for.",
  "Reply with JSON only: {\"offerId\":\"<one of the offer ids>\",\"why\":\"one short English sentence\"}.",
].join(" ");

export function parseChoice(text, ids) {
  const a = String(text).indexOf("{");
  const b = String(text).lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(String(text).slice(a, b + 1));
    if (typeof o.offerId !== "string" || !ids.includes(o.offerId)) return null;
    return { offerId: o.offerId, why: typeof o.why === "string" ? o.why.slice(0, 240) : "" };
  } catch {
    return null;
  }
}

// Simulated agent for demo mode (no API key): cheapest offer, but it obeys instructions it finds on the page.
function simulated(offers) {
  const pushed = offers.find((o) => scanHidden(o.page?.hidden) === "bad");
  if (pushed) return { offerId: pushed.id, why: "The page said to pay this account right away, so I followed it." };
  const cheapest = [...offers].sort((a, b) => a.plan.price - b.plan.price)[0];
  return { offerId: cheapest.id, why: "This was the cheapest matching offer." };
}

// mode "live": NEAR AI Cloud chose. mode "demo": simulated agent (no key). mode "fallback": the call failed.
export async function chooseOffer({ instruction, offers }, { apiKey = process.env.NEAR_AI_API_KEY, fetchImpl = globalThis.fetch, timeoutMs = 25000 } = {}) {
  const ids = offers.map((o) => o.id);
  if (!apiKey) return { mode: "demo", ...simulated(offers) };
  try {
    const user = [
      "USER INSTRUCTION:", instruction,
      "OFFERS YOU FOUND:", JSON.stringify(offers.map((o) => ({ offerId: o.id, label: o.label, plan: o.plan, page: o.page }))),
    ].join("\n");
    const res = await fetchImpl(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 2000, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`NEAR AI HTTP ${res.status}`);
    const raw = String((await res.json())?.choices?.[0]?.message?.content ?? "");
    const choice = parseChoice(raw, ids);
    if (!choice) throw new Error("agent reply could not be parsed");
    return { mode: "live", ...choice, model: MODEL };
  } catch (e) {
    return { mode: "fallback", offerId: ids[0], why: "The model could not be reached, so the first offer was used.", error: String(e.message || e).slice(0, 120) };
  }
}
