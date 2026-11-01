# Approval Moment

**Track:** AI Security & Defense (also relevant to Agent Economy and Privacy & Private AI)

## The problem

Shopping agents will soon buy things for us. A human clicking "Buy" used to be the last check that
the purchase matched what was asked. With an agent, that moment disappears, and the agent can be
wrong (wrong size) or be hijacked (a product page with hidden text telling it to pay a different
account). Nothing today shows the user, in one glance, whether the payment plan matches their
instruction.

## What this is

A small web app plus an API that sits between a shopping agent and the payment:

1. The user gives an instruction ("red running shoes, size 42, max $80, pay only `shop.near`").
2. The agent produces a payment plan and shows the page text it read (including text a human would not see).
3. An **independent verifier** compares plan and instruction and returns `ok`, `warn` or `bad`.
   - Deterministic rules (`rules.js`) are the safety floor: item, colour, size, price limit, payee account, seller reputation, hidden instruction-like text on the page.
   - A model on **NEAR AI Cloud** (`verifier.js`) adds a second opinion. It can only make the verdict **stricter**, never looser, so a page that fools the model still cannot turn a rules `bad` into `ok`.
4. `bad` blocks the approve button. Otherwise the user approves and gets a receipt (SHA-256 of instruction, plan and verdict).
5. A delivery stepper (escrow, shipping, delivery, product check) shows what should happen after approval: auto-refund if the seller never ships, dispute with the receipt as evidence if the wrong item arrives.

## Try it (no account, no key, no network needed)

Requires Node.js 20.12 or newer. There are no dependencies to install.

```sh
npm test        # 13 tests, see test/all.test.js
npm start       # then open http://localhost:3000
```

In the page:

- Click **Normal purchase**, then **Approve**: you see `ok`, a receipt, then the delivery stepper.
- Click **Wrong size**: the size is 43 instead of 42, verdict `warn`.
- Click **Agent hijacked**: the page contains hidden text telling the agent to pay `fast-pay.near`. Verdict `bad`, the approve button is disabled.

## Using NEAR AI Cloud

```sh
cp .env.example .env     # then put your key after NEAR_AI_API_KEY=
npm start
```

Create the key at https://cloud.near.ai. The app calls the OpenAI-compatible endpoint
`https://cloud-api.near.ai/v1/chat/completions` (default model `zai-org/GLM-5.1-FP8`, override with
`NEAR_AI_MODEL`). The key is only read from the environment or `.env` and is never sent to the browser.

How NEAR is used: the verifier runs on NEAR AI Cloud so the instruction, the payment plan and the
page text are processed in a TEE-backed environment rather than by a general-purpose API.

## Status, honestly

| Part | State |
| --- | --- |
| Rules engine, API, UI, receipt, delivery stepper | Working, covered by tests |
| NEAR AI Cloud verifier | Implemented against the documented OpenAI-compatible API and unit-tested with a mocked response. Run by hand against the live service on 1 Nov 2026 (model `zai-org/GLM-5.1-FP8`): all three demo scenarios returned sensible reasons. If the call fails the app falls back to rules only and says so in the UI. |
| TEE attestation | **Partly.** With a key set, the server asks `GET /v1/attestation/report` for a report with a fresh random nonce and the page shows whether the nonce was echoed and an Intel TDX quote is present. It does **not** verify the Intel signature or the measurements itself; the page tells the user to check the quote at proof.t16z.com. Unit-tested with mocked responses; not yet seen against the live endpoint. |
| NEAR Intents payment / on-chain escrow | **Not implemented.** Payment, escrow, shipping and dispute pool are simulated in the page. |
| Shops, carriers, real money | None. All scenarios are fixed demo data in `scenarios.js`. |

## Files

- `rules.js` deterministic checks and the "only stricter" combination rule
- `verifier.js` NEAR AI Cloud call, reply parsing, fallback modes (`demo`, `live`, `rules-only`), attestation report fetch
- `server.js` dependency-free HTTP server (binds to 127.0.0.1); `/api/check` accepts only a scenario id, `/api/attestation` returns the attestation summary
- `scenarios.js` demo instruction and three scenarios (`normal`, `size`, `hijacked`)
- `public/index.html` the UI
- `test/all.test.js` tests

## License

MIT, see `LICENSE`.
