// Read-only NEAR check: how much power does the agent's access key really have?
// NEAR has two kinds of access keys. A full-access key can do anything with the account.
// A function-call key can only call methods on one contract: it cannot transfer NEAR or attach a deposit,
// and its allowance only caps the gas fees it may spend. That is the "sandboxed wallet" for an agent.
// This module only READS from public NEAR RPC nodes. It never signs anything and never needs a secret.

const ENDPOINTS = {
  mainnet: ["https://free.rpc.fastnear.com", "https://archival-rpc.mainnet.near.org"],
  testnet: ["https://test.rpc.fastnear.com", "https://archival-rpc.testnet.near.org"],
};
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const KEY = /^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{43,100}$/;
const YOCTO = 10n ** 24n;

export const validAccount = (a) => typeof a === "string" && a.length >= 2 && a.length <= 64 && ACCOUNT.test(a);
export const validKey = (k) => typeof k === "string" && KEY.test(k);

const nearText = (y) => {
  try {
    const n = BigInt(y);
    const whole = n / YOCTO;
    const frac = ((n % YOCTO) * 1000n) / YOCTO;
    return `${whole}.${String(frac).padStart(3, "0")} NEAR`;
  } catch {
    return String(y);
  }
};

// Turns the RPC permission into rows [label, level, detail] and one overall level.
export function judgeKey(permission) {
  if (permission === "FullAccess") {
    return { level: "bad", rows: [["Key type", "bad", "Full access: this key can do anything with the account, including moving all funds."]] };
  }
  const fc = permission && permission.FunctionCall;
  if (!fc) return { level: "warn", rows: [["Key type", "warn", "Unknown permission type."]] };
  const rows = [["Key type", "ok", "Function call: can only call methods on one contract. It cannot transfer NEAR or attach a deposit."]];
  rows.push(["Contract", fc.receiver_id ? "ok" : "warn", fc.receiver_id || "none"]);
  const methods = Array.isArray(fc.method_names) ? fc.method_names : [];
  rows.push(["Methods", methods.length ? "ok" : "warn", methods.length ? methods.join(", ") : "Any method on that contract"]);
  rows.push(["Fee allowance", fc.allowance ? "ok" : "warn", fc.allowance ? `${nearText(fc.allowance)} of gas fees at most` : "No cap on gas fees"]);
  const level = rows.some((r) => r[1] === "warn") ? "warn" : "ok";
  return { level, rows };
}

const short = (k) => `${k.slice(0, 12)}…${k.slice(-4)}`;

// Without a key: list every key on the account and describe each one.
export function judgeKeyList(keys) {
  const rows = keys.map((k) => {
    const j = judgeKey(k.access_key?.permission);
    if (j.level === "bad") return [short(k.public_key), "warn", "Full access. Normally this is YOUR key. Never give a full-access key to an agent."];
    return [short(k.public_key), j.level, j.rows.map((r) => r[2]).slice(1).join(" · ") || j.rows[0][2]];
  });
  const full = keys.filter((k) => k.access_key?.permission === "FullAccess").length;
  const limited = keys.length - full;
  const level = rows.some((r) => r[1] === "warn") ? "warn" : "ok";
  return { level, rows, summary: `${keys.length} key(s): ${full} full access, ${limited} limited` };
}

export async function checkAgentKey({ network, account, key }, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!Object.hasOwn(ENDPOINTS, network)) return { ok: false, error: "Choose testnet or mainnet." };
  if (!validAccount(account)) return { ok: false, error: "That does not look like a NEAR account id (for example alice.testnet)." };
  if (key && !validKey(key)) return { ok: false, error: 'The public key must look like "ed25519:..." (no secret key, only the public one).' };
  let lastError = "no RPC node answered";
  for (const url of ENDPOINTS[network]) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "approval-moment", method: "query", params: key ? { request_type: "view_access_key", finality: "final", account_id: account, public_key: key } : { request_type: "view_access_key_list", finality: "final", account_id: account } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = JSON.stringify(data.error || data.result?.error || "");
      if (/does not exist|UNKNOWN_ACCESS_KEY/i.test(text)) {
        return { ok: true, network, account, key, found: false, level: "warn", rows: [["Key", "warn", "This key is not registered on that account."]], rpc: url };
      }
      if (/UNKNOWN_ACCOUNT|INVALID_ACCOUNT/i.test(text)) {
        return { ok: true, network, account, key, found: false, level: "warn", rows: [["Account", "warn", `The account ${account} does not exist on ${network}.`]], rpc: url };
      }
      if (!key && Array.isArray(data.result?.keys)) {
        const j = judgeKeyList(data.result.keys);
        return { ok: true, network, account, key: null, found: true, list: true, level: j.level, rows: j.rows, summary: j.summary, rpc: url, blockHeight: data.result.block_height ?? null };
      }
      if (data.error || data.result?.error || !data.result || !("permission" in data.result)) throw new Error("unexpected RPC answer");
      const j = judgeKey(data.result.permission);
      return { ok: true, network, account, key, found: true, level: j.level, rows: j.rows, rpc: url, blockHeight: data.result.block_height ?? null };
    } catch (e) {
      lastError = String(e.message || e).slice(0, 100);
    }
  }
  return { ok: false, error: `Could not reach a NEAR RPC node (${lastError}).` };
}
