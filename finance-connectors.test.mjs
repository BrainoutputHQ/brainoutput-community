// SPDX-License-Identifier: Apache-2.0
// Financial connectors: signing correctness (Binance is checked against the PUBLISHED test vector)
// and — more importantly — that nothing can move value without an explicit grant AND human approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  binanceSignature, coinbaseSignature, signatureMatches, authorizeFinanceAction, grantFinanceAction,
  allowDestination, plaidConnector, coinbaseConnector, binanceConnector, connectFinance, financeOptions,
  VALUE_MOVING, FINANCE_KINDS,
} from "./finance-connectors.mjs";

test("Binance signing matches the PUBLISHED HMAC test vector", () => {
  // From Binance's own signed-endpoint documentation.
  const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
  const query = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
  assert.equal(binanceSignature(secret, query), "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
});

test("Coinbase signing is HMAC(timestamp+method+path+body) and is stable", () => {
  const sig = coinbaseSignature("s3cr3t", { timestamp: "1700000000", method: "get", path: "/api/v3/brokerage/accounts" });
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(sig, coinbaseSignature("s3cr3t", { timestamp: "1700000000", method: "GET", path: "/api/v3/brokerage/accounts" }));
  assert.notEqual(sig, coinbaseSignature("other", { timestamp: "1700000000", method: "GET", path: "/api/v3/brokerage/accounts" }));
  assert.equal(signatureMatches(sig, sig), true);
  assert.equal(signatureMatches(sig, sig.slice(0, -1) + "0"), false);
});

test("reads are allowed; anything that moves value is refused without a grant", () => {
  const conn = { kind: "binance", grants: [], limits: {} };
  assert.equal(authorizeFinanceAction(conn, { action: "balances" }).allowed, true);
  for (const a of ["place-order", "withdraw", "transfer", "trade"]) {
    const d = authorizeFinanceAction(conn, { action: a });
    assert.equal(d.allowed, false, `${a} must be refused`);
    assert.equal(d.scope, "sensitive");
  }
  assert.ok(VALUE_MOVING.has("withdraw") && !VALUE_MOVING.has("balances"));
});

test("a granted order STILL needs an approved human approval", () => {
  const conn = grantFinanceAction({ kind: "coinbase", grants: [], limits: {} }, "place-order");
  assert.equal(authorizeFinanceAction(conn, { action: "place-order" }).allowed, false);
  assert.equal(authorizeFinanceAction(conn, { action: "place-order", approval: { status: "pending" } }).allowed, false);
  const ok = authorizeFinanceAction(conn, { action: "place-order", approval: { status: "approved", approvedBy: "alice" } });
  assert.equal(ok.allowed, true);
  assert.equal(ok.approvedBy, "alice");
  assert.throws(() => grantFinanceAction(conn, "balances"), /read-only/);
});

test("withdrawals additionally require an allowlisted destination and respect an amount ceiling", () => {
  let conn = grantFinanceAction({ kind: "binance", grants: [], limits: { maxAmount: 100 } }, "withdraw");
  const approved = { status: "approved" };
  // no allowlist at all
  assert.match(authorizeFinanceAction(conn, { action: "withdraw", amount: 10, destination: "addr1", approval: approved }).reason, /no withdrawal destination/);
  conn = allowDestination(conn, "addr-known");
  // wrong destination
  assert.match(authorizeFinanceAction(conn, { action: "withdraw", amount: 10, destination: "addr-evil", approval: approved }).reason, /not on the allowlist/);
  // over the ceiling
  assert.match(authorizeFinanceAction(conn, { action: "withdraw", amount: 1000, destination: "addr-known", approval: approved }).reason, /exceeds the configured limit/);
  // correct: granted + allowlisted + within limit + approved
  assert.equal(authorizeFinanceAction(conn, { action: "withdraw", amount: 10, destination: "addr-known", approval: approved }).allowed, true);
});

test("connectors start read-only, declare live calls unverified, and expose no silent money path", () => {
  for (const kind of FINANCE_KINDS) {
    const c = connectFinance({ kind, account: "alice" });
    assert.equal(c.scope, "read");
    assert.deepEqual(c.grants, []);
    assert.equal(c.verified, false);          // live endpoints unexercised in this environment
  }
  assert.equal(plaidConnector({ account: "a" }).readOnly, true);   // Plaid exposes no money movement
  assert.throws(() => connectFinance({ kind: "nope" }), /unknown financial connector/);
  assert.equal(financeOptions().length, 3);
});

test("Coinbase: read shapes normalize; an unapproved order is refused BEFORE any request is made", async () => {
  let called = 0;
  const cb = coinbaseConnector({ account: "alice", apiKey: "k", apiSecret: "s", now: () => 1700000000,
    fetchImpl: async (path) => { called++; return path.includes("accounts")
      ? { accounts: [{ uuid: "u1", name: "BTC Wallet", currency: "BTC", available_balance: { value: "0.5" }, hold: { value: "0" } }] } : {}; } });
  const accts = await cb.accounts();
  assert.equal(accts[0].currency, "BTC");
  assert.equal(accts[0].available, "0.5");
  const before = called;
  const refused = await cb.placeOrder({ product_id: "BTC-EUR", amount: 100 });
  assert.equal(refused.executed, false);
  assert.equal(called, before, "no HTTP request may be made for an unauthorized order");
  // headers carry a real signature
  const h = cb.signedHeaders("GET", "/api/v3/brokerage/accounts");
  assert.match(h["CB-ACCESS-SIGN"], /^[0-9a-f]{64}$/);
  assert.equal(h["CB-ACCESS-TIMESTAMP"], "1700000000");
});

test("Binance: signed query is well-formed; an unapproved withdrawal never reaches the network", async () => {
  let called = 0;
  const bn = binanceConnector({ account: "alice", apiKey: "k", apiSecret: "s", now: () => 1499827319559,
    fetchImpl: async () => { called++; return { balances: [{ asset: "BTC", free: "1.0", locked: "0" }] }; } });
  const q = bn.signedQuery({ symbol: "LTCBTC" });
  assert.match(q, /^symbol=LTCBTC&timestamp=1499827319559&signature=[0-9a-f]{64}$/);
  const bal = await bn.balances();
  assert.equal(bal[0].asset, "BTC");
  const before = called;
  const refused = await bn.withdraw({ coin: "BTC", amount: 1, address: "addr-evil" });
  assert.equal(refused.executed, false);
  assert.match(refused.decision.reason, /grant it explicitly/);
  assert.equal(called, before, "no HTTP request may be made for an unauthorized withdrawal");
});

test("Plaid returns normalized balances and transactions (read-only)", async () => {
  const p = plaidConnector({ account: "alice", clientId: "c", secret: "s", accessToken: "t",
    fetchImpl: async (path) => path.includes("balance")
      ? { accounts: [{ account_id: "a1", name: "Current", subtype: "checking", mask: "1234", balances: { available: 1200.5, current: 1300, iso_currency_code: "EUR" } }] }
      : { transactions: [{ transaction_id: "t1", date: "2026-07-27", name: "Acme Ltd", amount: 250, iso_currency_code: "EUR", pending: false, category: ["Service", "Software"], account_id: "a1" }] } });
  const [acct] = await p.balances();
  assert.equal(acct.name, "Current");
  assert.equal(acct.available, 1200.5);
  const [tx] = await p.transactions({ startDate: "2026-07-01", endDate: "2026-07-31" });
  assert.equal(tx.name, "Acme Ltd");
  assert.equal(tx.category, "Service / Software");
});
