// Optional NEAR TESTNET mode: real transfers of test NEAR instead of simulated payments.
// Safety rules baked in:
//  - testnet only. There is no mainnet endpoint anywhere in this file and no setting that adds one.
//  - dependency-free: ed25519 signing uses node:crypto, transactions are serialized by hand (borsh).
//    test/chain.test.js checks the bytes against the official near-api-js library.
//  - the keys live in .env on the user's own computer and are never sent anywhere except as signatures.
//  - the escrow here is an ordinary testnet account that this server controls. It is NOT an escrow contract.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";

export const TESTNET_RPC = ["https://test.rpc.fastnear.com", "https://archival-rpc.testnet.near.org"];
export const EXPLORER = "https://testnet.nearblocks.io/txns/";
export const ACCOUNT_URL = "https://testnet.nearblocks.io/address/";
export const YOCTO_PER_USD = 10n ** 21n; // demo rate: $1 = 0.001 NEAR, so $840 = 0.84 test NEAR
const YOCTO = 10n ** 24n;

// ---------- base58 (Bitcoin alphabet, as NEAR uses) ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  for (const c of str) { if (c === "1") zeros++; else break; }
  return Buffer.from([...Array(zeros).fill(0), ...bytes]);
}

// ---------- keys ----------
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function fromSeed(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x, "base64url");
  return { seed, priv, pub, accountId: pub.toString("hex"), publicKey: "ed25519:" + b58encode(pub), secretKey: "ed25519:" + b58encode(Buffer.concat([seed, pub])) };
}
export function generateKeypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  return fromSeed(seed);
}
export function parseSecretKey(str) {
  if (typeof str !== "string" || !str.startsWith("ed25519:")) throw new Error("secret key must start with ed25519:");
  const raw = b58decode(str.slice(8));
  if (raw.length !== 64) throw new Error("secret key has the wrong length");
  const kp = fromSeed(raw.subarray(0, 32));
  if (!kp.pub.equals(raw.subarray(32))) throw new Error("secret key does not match its public half");
  return kp;
}
// A fixed, harmless address for each demo provider (nobody needs its private key).
export const payeeAccount = (provider) => fromSeed(createHash("sha256").update("approval-moment-demo-payee:" + provider).digest()).accountId;

// ---------- amounts ----------
export function usdToYocto(usd) {
  if (!Number.isFinite(usd) || usd <= 0 || usd > 1e6) throw new Error("bad amount");
  return BigInt(Math.round(usd * 100)) * (YOCTO_PER_USD / 100n);
}
export const yoctoToNearText = (y, digits = 4) => `${BigInt(y) / YOCTO}.${String((BigInt(y) % YOCTO) * 10n ** BigInt(digits) / YOCTO).padStart(digits, "0")}`;

// ---------- transaction (borsh) ----------
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const str = (s) => { const t = Buffer.from(s, "utf8"); return Buffer.concat([u32(t.length), t]); };

export function transferTransaction({ signerId, publicBytes, nonce, receiverId, blockHash, yocto }) {
  return Buffer.concat([
    str(signerId), Buffer.from([0]), publicBytes, u64(nonce), str(receiverId), b58decode(blockHash),
    u32(1), Buffer.from([3]), u128(yocto), // one action: Transfer
  ]);
}
export function signTransfer({ keypair, receiverId, nonce, blockHash, yocto }) {
  const tx = transferTransaction({ signerId: keypair.accountId, publicBytes: keypair.pub, nonce, receiverId, blockHash, yocto });
  const digest = createHash("sha256").update(tx).digest();
  const signature = edSign(null, digest, keypair.priv);
  const signed = Buffer.concat([tx, Buffer.from([0]), signature]);
  return { bytes: signed, base64: signed.toString("base64"), hash: b58encode(digest) };
}

// ---------- the chain object used by the server ----------
export function createChain({ env = process.env, fetchImpl = globalThis.fetch, endpoints = TESTNET_RPC, timeoutMs = 20000 } = {}) {
  let agent = null, escrow = null, problem = "";
  if (env.NEAR_TESTNET === "1") {
    try {
      agent = parseSecretKey(env.NEAR_TESTNET_AGENT_KEY);
      escrow = parseSecretKey(env.NEAR_TESTNET_ESCROW_KEY);
      if (agent.accountId === escrow.accountId) throw new Error("agent and escrow keys must be different");
    } catch (e) { problem = String(e.message || e); agent = escrow = null; }
  }
  const enabled = Boolean(agent && escrow);
  const wallets = { agent, escrow };

  async function rpc(method, params) {
    let last = "no RPC node answered";
    for (const url of endpoints) {
      try {
        const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "am", method, params }), signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) { last = String(e.message || e).slice(0, 100); }
    }
    throw new Error(`NEAR testnet is not reachable (${last})`);
  }

  async function balance(accountId, finality = "final") {
    const d = await rpc("query", { request_type: "view_account", finality, account_id: accountId });
    if (d.error || d.result?.error || !d.result?.amount) return null; // account does not exist yet
    return BigInt(d.result.amount);
  }

  // One sender signs one transaction at a time, so nonces never collide.
  const queues = new Map();
  const inQueue = (key, fn) => {
    const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(key, run);
    return run;
  };

  async function sendOnce(kp, receiverId, yocto) {
    const k = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: kp.accountId, public_key: kp.publicKey });
    if (!k.result || k.result.error || k.result.nonce === undefined) throw new Error("the sender account has no funds yet (or its key is not registered)");
    const blk = await rpc("block", { finality: "final" });
    const blockHash = blk.result?.header?.hash;
    if (!blockHash) throw new Error("could not read the latest block");
    const t = signTransfer({ keypair: kp, receiverId, nonce: BigInt(k.result.nonce) + 1n, blockHash, yocto });
    const out = await rpc("send_tx", { signed_tx_base64: t.base64, wait_until: "EXECUTED_OPTIMISTIC" });
    if (out.error) {
      const text = JSON.stringify(out.error);
      const e = new Error(/InvalidNonce/.test(text) ? "nonce" : /NotEnoughBalance|LackBalanceForState/.test(text) ? "not enough test NEAR in the sender account" : "the network rejected the transaction");
      e.retry = /InvalidNonce/.test(text);
      throw e;
    }
    const failure = out.result?.status?.Failure;
    if (failure) throw new Error("the transfer failed on chain: " + JSON.stringify(failure).slice(0, 120));
    // Network fee actually burnt (transaction + receipts), as the explorer shows it. null if the node did not report it.
    let fee = null;
    try {
      const outs = [out.result?.transaction_outcome, ...(out.result?.receipts_outcome || [])];
      if (outs.length > 1 && outs.every((o) => o?.outcome?.tokens_burnt !== undefined)) fee = outs.reduce((n, o) => n + BigInt(o.outcome.tokens_burnt), 0n);
    } catch { fee = null; }
    return { fee, hash: out.result?.transaction?.hash || t.hash, from: kp.accountId, to: receiverId, yocto: yocto.toString(), near: yoctoToNearText(yocto), explorer: EXPLORER + (out.result?.transaction?.hash || t.hash) };
  }

  return {
    enabled, problem,
    accounts: enabled ? { agent: agent.accountId, escrow: escrow.accountId } : null,
    // from: "agent" | "escrow"; to: an account id; usd: the dollar amount shown in the app
    transfer(from, to, usd) {
      if (!enabled) return Promise.reject(new Error("testnet mode is off"));
      const kp = wallets[from];
      if (!kp) return Promise.reject(new Error("unknown sender"));
      const yocto = usdToYocto(usd);
      return inQueue(from, async () => {
        // Sender balance before and after, for display only. A failed read never blocks the payment.
        // "After" = before - amount - the fee the network reports: exact, and not fooled by gas that is still being refunded.
        let before = null;
        try { before = await balance(kp.accountId, "optimistic"); } catch { before = null; }
        let tx;
        try { tx = await sendOnce(kp, to, yocto); }
        catch (e) { if (e.retry) tx = await sendOnce(kp, to, yocto); else throw e; }
        const { fee, ...rest } = tx;
        if (before === null || fee === null) return rest;
        return { ...rest, feeNear: yoctoToNearText(fee, 6), fromBefore: yoctoToNearText(before), fromAfter: yoctoToNearText(before - yocto - fee) };
      });
    },
    async status() {
      if (!enabled) return { enabled: false, problem: problem || "", network: "testnet" };
      const bal = async (k) => { try { const b = await balance(wallets[k].accountId); return b === null ? null : yoctoToNearText(b); } catch { return undefined; } };
      return { enabled: true, network: "testnet", rate: "$1 = 0.001 test NEAR", agent: { account: agent.accountId, near: await bal("agent"), url: ACCOUNT_URL + agent.accountId }, escrow: { account: escrow.accountId, near: await bal("escrow"), url: ACCOUNT_URL + escrow.accountId } };
    },
  };
}
