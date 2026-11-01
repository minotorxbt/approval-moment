import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createApp } from "../server.js";
import { b58encode, b58decode, generateKeypair, parseSecretKey, payeeAccount, usdToYocto, yoctoToNearText, signTransfer, createChain, TESTNET_RPC } from "../chain.js";

const BLOCK = b58encode(createHash("sha256").update("block").digest());

test("chain: base58 round-trips, including leading zero bytes", () => {
  for (const hex of ["00", "0000ff", "ff", "0102030405060708090a", "00".repeat(5) + "abcdef"]) {
    assert.equal(b58decode(b58encode(Buffer.from(hex, "hex"))).toString("hex"), hex);
  }
});

test("chain: keys are valid, the secret key string round-trips and a mismatched key is refused", () => {
  const k = generateKeypair();
  assert.equal(k.accountId.length, 64);
  assert.equal(parseSecretKey(k.secretKey).accountId, k.accountId);
  const other = generateKeypair();
  const raw = b58decode(k.secretKey.slice(8));
  const bad = "ed25519:" + b58encode(Buffer.concat([raw.subarray(0, 32), b58decode(other.publicKey.slice(8))]));
  assert.throws(() => parseSecretKey(bad), /match/);
  assert.throws(() => parseSecretKey("hello"), /ed25519/);
  assert.equal(payeeAccount("MediPlus"), payeeAccount("MediPlus"));
  assert.notEqual(payeeAccount("MediPlus"), payeeAccount("HomeSure"));
});

test("chain: dollars become test NEAR at the fixed demo rate", () => {
  assert.equal(usdToYocto(840), 840n * 10n ** 21n);
  assert.equal(usdToYocto(48.5), 485n * 10n ** 20n);
  assert.equal(yoctoToNearText(usdToYocto(756)), "0.7560");
  assert.throws(() => usdToYocto(0));
  assert.throws(() => usdToYocto(NaN));
});

test("chain: a signed transfer verifies with the sender's public key and carries the right fields", () => {
  const kp = generateKeypair();
  const to = payeeAccount("School");
  const t = signTransfer({ keypair: kp, receiverId: to, nonce: 42n, blockHash: BLOCK, yocto: usdToYocto(350) });
  const sig = t.bytes.subarray(t.bytes.length - 64);
  const tx = t.bytes.subarray(0, t.bytes.length - 65);
  const digest = createHash("sha256").update(tx).digest();
  assert.ok(verify(null, digest, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), kp.pub]), format: "der", type: "spki" }), sig));
  assert.equal(t.hash, b58encode(digest));
  assert.ok(t.bytes.includes(Buffer.from(to)));
});

// A tiny fake NEAR node: tracks nonces, checks signatures and decodes what was sent.
function fakeNode({ failSend = null, noAccount = false } = {}) {
  const sent = [];
  let nonce = 100;
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (o) => ({ ok: true, status: 200, json: async () => o });
    if (method === "query" && params.request_type === "view_access_key") return reply(noAccount ? { result: { error: "does not exist" } } : { result: { nonce } });
    if (method === "query" && params.request_type === "view_account") return reply({ result: { amount: "5000000000000000000000000" } });
    if (method === "block") return reply({ result: { header: { hash: BLOCK } } });
    if (method === "send_tx") {
      if (failSend) return reply({ error: failSend });
      const raw = Buffer.from(params.signed_tx_base64, "base64");
      const len = raw.readUInt32LE(0);
      const signer = raw.subarray(4, 4 + len).toString();
      const pub = raw.subarray(5 + len, 37 + len);
      const n = raw.readBigUInt64LE(37 + len);
      const rl = raw.readUInt32LE(45 + len);
      const receiver = raw.subarray(49 + len, 49 + len + rl).toString();
      const deposit = raw.readBigUInt64LE(raw.length - 65 - 16) + (raw.readBigUInt64LE(raw.length - 65 - 8) << 64n);
      const digest = createHash("sha256").update(raw.subarray(0, raw.length - 65)).digest();
      const ok = verify(null, digest, createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" }), raw.subarray(raw.length - 64));
      if (!ok || n !== BigInt(nonce + 1)) return reply({ error: { cause: { name: "INVALID_TRANSACTION" }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: {} } } } } });
      nonce++;
      sent.push({ signer, receiver, deposit, nonce: n });
      return reply({ result: { transaction: { hash: b58encode(digest) }, status: { SuccessValue: "" }, transaction_outcome: { outcome: { tokens_burnt: "82000000000000000000" } }, receipts_outcome: [{ outcome: { tokens_burnt: "753000000000000000000" } }] } });
    }
    throw new Error("unexpected " + method);
  };
  return { fetchImpl, sent };
}
const envFor = (a, e) => ({ NEAR_TESTNET: "1", NEAR_TESTNET_AGENT_KEY: a.secretKey, NEAR_TESTNET_ESCROW_KEY: e.secretKey });

test("tests never touch the real chain, even when testnet keys are present in the environment", async () => {
  const a = generateKeypair(), e = generateKeypair();
  const saved = { ...process.env };
  Object.assign(process.env, { NEAR_TESTNET: "1", NEAR_TESTNET_AGENT_KEY: a.secretKey, NEAR_TESTNET_ESCROW_KEY: e.secretKey });
  try {
    const app = createApp();
    await new Promise((r) => app.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${app.address().port}`;
      assert.equal((await (await fetch(`${base}/api/chain/status`)).json()).enabled, false);
      const r = await fetch(`${base}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ item: "school", proposal: "normal", digest: "c".repeat(64) }) });
      assert.equal(r.status, 200); // a simulated order, created instantly, no transfer attempted
      assert.equal((await r.json()).chain, null);
    } finally { app.closeAllConnections(); app.close(); }
  } finally {
    for (const k of ["NEAR_TESTNET", "NEAR_TESTNET_AGENT_KEY", "NEAR_TESTNET_ESCROW_KEY"]) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
  }
});

test("chain: off by default and when the keys are missing, equal or broken", () => {
  assert.equal(createChain({ env: {} }).enabled, false);
  const a = generateKeypair();
  assert.equal(createChain({ env: { NEAR_TESTNET: "1", NEAR_TESTNET_AGENT_KEY: a.secretKey } }).enabled, false);
  assert.match(createChain({ env: envFor(a, a) }).problem, /different/);
  assert.equal(createChain({ env: envFor(a, generateKeypair()) }).enabled, true);
  assert.deepEqual(TESTNET_RPC.filter((u) => /mainnet/.test(u)), []);
});

test("chain: transfer signs a valid transaction, sends the right amount and returns a testnet explorer link", async () => {
  const a = generateKeypair(), e = generateKeypair(), node = fakeNode();
  const c = createChain({ env: envFor(a, e), fetchImpl: node.fetchImpl });
  const r = await c.transfer("agent", e.accountId, 756);
  assert.equal(node.sent.length, 1);
  assert.equal(node.sent[0].signer, a.accountId);
  assert.equal(node.sent[0].receiver, e.accountId);
  assert.equal(node.sent[0].deposit, 756n * 10n ** 21n);
  assert.match(r.explorer, /^https:\/\/testnet\.nearblocks\.io\/txns\//);
  assert.equal(r.fromBefore, "5.0000"); // sender balance before and after, shown in the app
  assert.equal(r.feeNear, "0.000835"); // the fee the network reports (as in the explorer)
  assert.equal(r.fromAfter, "4.2431"); // 5 - 0.756 - 0.000835 = 4.243165, shown with 4 digits
  const [x, y] = await Promise.all([c.transfer("agent", e.accountId, 10), c.transfer("agent", e.accountId, 20)]);
  assert.notEqual(x.hash, y.hash);
  assert.equal(node.sent.length, 3);
  const st = await c.status();
  assert.equal(st.enabled, true);
  assert.equal(st.agent.near, "5.0000");
});

test("chain: clear errors for an unfunded sender and a rejected transaction", async () => {
  const a = generateKeypair(), e = generateKeypair();
  await assert.rejects(createChain({ env: envFor(a, e), fetchImpl: fakeNode({ noAccount: true }).fetchImpl }).transfer("agent", e.accountId, 5), /no funds/);
  await assert.rejects(createChain({ env: envFor(a, e), fetchImpl: fakeNode({ failSend: { data: "NotEnoughBalance" } }).fetchImpl }).transfer("agent", e.accountId, 5), /not enough test NEAR/);
  await assert.rejects(createChain({ env: envFor(a, e), fetchImpl: async () => { throw new Error("offline"); } }).transfer("agent", e.accountId, 5), /not reachable/);
});

// ---------- the server with a fake chain ----------
function fakeChain({ fail = false } = {}) {
  const calls = [];
  return {
    calls, enabled: true, problem: "", accounts: { agent: "a".repeat(64), escrow: "e".repeat(64) },
    transfer: async (from, to, usd) => {
      if (fail) throw new Error("not enough test NEAR in the sender account");
      calls.push({ from, to, usd });
      return { hash: "H" + calls.length, from: from === "agent" ? "a".repeat(64) : "e".repeat(64), to, near: String(usd / 1000), explorer: "https://testnet.nearblocks.io/txns/H" + calls.length };
    },
    status: async () => ({ enabled: true, network: "testnet" }),
  };
}
async function withChainApp(chain, fn) {
  const app = createApp({ chainImpl: chain });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${app.address().port}`); } finally { app.closeAllConnections(); app.close(); }
}
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const D = "b".repeat(64);

test("on-chain orders: a direct payment goes straight to the provider's address and carries the tx", async () => {
  const chain = fakeChain();
  await withChainApp(chain, async (base) => {
    const o = await (await post(base, "/api/orders", { item: "school", proposal: "normal", digest: D })).json();
    assert.deepEqual(chain.calls.map((c) => [c.from, c.usd]), [["agent", 350]]);
    assert.equal(chain.calls[0].to, payeeAccount("Greenfield School"));
    assert.equal(o.chain.txs[0].kind, "payment");
    assert.equal(o.steps[0].tx.hash, "H1");
    assert.equal(o.chain.txs[0].fromLabel, "Your agent wallet");
    assert.equal(o.chain.txs[0].toLabel, "Greenfield School (demo address)");
    assert.equal(o.events[0].actor, "chain");
  });
});

test("on-chain orders: escrow holds the money, releases it on the buyer's OK and refunds on a timeout", async () => {
  const chain = fakeChain();
  await withChainApp(chain, async (base) => {
    const o = await (await post(base, "/api/orders", { item: "shoes", proposal: "normal", digest: D })).json();
    assert.deepEqual(chain.calls.map((c) => [c.from, c.to]), [["agent", chain.accounts.escrow]]);
    const act = (body) => post(base, `/api/provider/orders/${o.id}/action`, body);
    await act({ action: "ship", tracking: "TR12345678" });
    await act({ action: "deliver", role: "courier", deliveryCode: o.buyerCode, size: "42" });
    assert.equal(chain.calls.length, 1, "nothing is released before the buyer confirms");
    const done = await (await post(base, `/api/orders/${o.id}/buyer`, { action: "accept" })).json();
    assert.deepEqual(chain.calls[1], { from: "escrow", to: payeeAccount("RunMarket"), usd: 74 });
    assert.equal(done.steps.at(-1).tx.kind, "release");
    assert.equal(done.steps.at(-1).tx.fromLabel, "Escrow account");
    assert.equal(done.steps.at(-1).tx.toLabel, "RunMarket (demo address)");
    assert.equal(done.chain.txs[0].toLabel, "Escrow account");
    const r = await (await post(base, "/api/orders", { item: "car", proposal: "sat", digest: D })).json();
    const exp = await (await post(base, `/api/orders/${r.id}/expire`)).json();
    assert.equal(exp.status, "refund");
    assert.deepEqual([chain.calls.at(-1).from, chain.calls.at(-1).to], ["escrow", chain.accounts.agent]);
    const r2 = await (await post(base, "/api/orders", { item: "car", proposal: "sat", digest: D })).json();
    const n = chain.calls.length;
    await post(base, `/api/provider/orders/${r2.id}/action`, { action: "confirm", code: "INS-1234" });
    await post(base, `/api/provider/orders/${r2.id}/action`, { action: "complete", result: "Passed", validUntil: "2027-12-31" });
    await post(base, `/api/orders/${r2.id}/buyer`, { action: "report" });
    assert.equal(chain.calls.length, n, "a reported problem keeps the money in escrow");
    // the simulated arbitrator decides: for the buyer = refund to the agent wallet, for the shop = release to the payee
    const res = (id, side) => post(base, `/api/orders/${id}/resolve`, { side });
    assert.equal((await res(r2.id, "nonsense")).status, 400);
    const back = await (await res(r2.id, "buyer")).json();
    assert.equal(back.status, "refund");
    assert.deepEqual([chain.calls.at(-1).from, chain.calls.at(-1).to], ["escrow", chain.accounts.agent]);
    assert.equal((await res(r2.id, "buyer")).status, 400, "a decided dispute cannot be decided twice");
    const r3 = await (await post(base, "/api/orders", { item: "car", proposal: "sat", digest: D })).json();
    await post(base, `/api/provider/orders/${r3.id}/action`, { action: "confirm", code: "INS-1234" });
    await post(base, `/api/provider/orders/${r3.id}/action`, { action: "complete", result: "Passed", validUntil: "2027-12-31" });
    await post(base, `/api/orders/${r3.id}/buyer`, { action: "report" });
    const pay = await (await res(r3.id, "shop")).json();
    assert.equal(pay.status, "completed");
    assert.equal(chain.calls.at(-1).from, "escrow");
    assert.equal(chain.calls.at(-1).to, payeeAccount("City Inspection Center"));
  });
});

test("on-chain orders: if the payment fails no order is created and nothing is paid", async () => {
  await withChainApp(fakeChain({ fail: true }), async (base) => {
    const r = await post(base, "/api/orders", { item: "school", proposal: "normal", digest: D });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /nothing was paid/);
    assert.deepEqual((await (await fetch(`${base}/api/provider/orders`)).json()).orders, []);
  });
});

test("on-chain orders: a blocked plan never reaches the chain, and the status endpoint answers", async () => {
  const chain = fakeChain();
  await withChainApp(chain, async (base) => {
    assert.equal((await post(base, "/api/orders", { item: "health", proposal: "newaccount", digest: D })).status, 409);
    assert.equal(chain.calls.length, 0);
    assert.equal((await (await fetch(`${base}/api/chain/status`)).json()).enabled, true);
  });
});
