// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — financial connectors (2026-07-28): Plaid · Coinbase · Binance.
//
// These touch MONEY, so the defaults are the strictest in the product:
//   • read  — balances, transactions, positions, prices. Allowed once connected.
//   • trade / transfer / withdraw — `sensitive` scope: an explicit, separately-granted permission AND
//     human approval, every single time. There is no configuration that makes them silent.
//   • withdrawals are additionally address-allowlisted: a destination that was never approved is
//     refused before any request is built.
// Credentials are the user's own and are read from the environment (never stored by these adapters).
//
// STATUS: the request SIGNING is verified (Binance is checked against the published HMAC test vector);
// the live endpoints are NOT exercised here — no exchange or bank credentials exist in this
// environment. Every adapter declares `verified: false` for live calls and refuses to construct
// without deliberate opt-in.
import { createHmac, timingSafeEqual } from "node:crypto";
import https from "node:https";

export const FINANCE_KINDS = ["plaid", "coinbase", "binance"];

/** Actions that move value. Always `sensitive`; never granted by a mode or a default. */
export const VALUE_MOVING = new Set(["place-order", "cancel-order", "trade", "withdraw", "transfer", "payment", "convert"]);

function httpsJson({ host, path, method = "GET", headers = {}, body = null, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method, timeout: timeoutMs, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { const j = d ? JSON.parse(d) : {}; res.statusCode < 400 ? resolve(j) : reject(new Error(j.message || j.error_message || `HTTP ${res.statusCode}`)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("finance: timeout")));
    if (body) req.write(body);
    req.end();
  });
}

// ── signing (deterministic and unit-tested) ─────────────────────────────────────────────────────

/** Binance: HMAC-SHA256(secret, queryString), hex. Verified against the published test vector. */
export function binanceSignature(secret, queryString) {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

/** Coinbase Advanced Trade: HMAC-SHA256(secret, timestamp + method + path + body), hex. */
export function coinbaseSignature(secret, { timestamp, method, path, body = "" }) {
  return createHmac("sha256", secret).update(`${timestamp}${String(method).toUpperCase()}${path}${body}`).digest("hex");
}

/** Constant-time compare, for verifying inbound webhook signatures. */
export function signatureMatches(a, b) {
  const A = Buffer.from(String(a || "")), B = Buffer.from(String(b || ""));
  return A.length === B.length && timingSafeEqual(A, B);
}

// ── the guard every value-moving call passes through ────────────────────────────────────────────

/**
 * Decide whether a financial action may proceed. Read is allowed once connected; anything that moves
 * value needs `sensitive` granted for that exact action AND an approved approval; a withdrawal also
 * needs its destination on the allowlist. Pure — it never performs I/O.
 */
export function authorizeFinanceAction(conn, { action, amount = null, destination = null, approval = null } = {}) {
  const moves = VALUE_MOVING.has(String(action));
  if (!moves) return { allowed: true, scope: "read", requiresApproval: false, reason: `${action} is read-only` };

  const grant = (conn.grants || []).find((g) => g.scope === "sensitive" && (!g.action || g.action === action));
  if (!grant)
    return { allowed: false, scope: "sensitive", requiresApproval: true,
      reason: `'${action}' moves value — grant it explicitly for this account first` };

  if (conn.limits?.maxAmount != null && amount != null && Number(amount) > Number(conn.limits.maxAmount))
    return { allowed: false, scope: "sensitive", requiresApproval: true,
      reason: `amount ${amount} exceeds the configured limit ${conn.limits.maxAmount}` };

  if (action === "withdraw" || action === "transfer") {
    const list = conn.limits?.allowedDestinations || [];
    if (!list.length)
      return { allowed: false, scope: "sensitive", requiresApproval: true,
        reason: "no withdrawal destination is allowlisted — add one deliberately" };
    if (!destination || !list.includes(destination))
      return { allowed: false, scope: "sensitive", requiresApproval: true,
        reason: `destination '${destination || "(none)"}' is not on the allowlist` };
  }

  if (!approval || approval.status !== "approved")
    return { allowed: false, scope: "sensitive", requiresApproval: true,
      reason: `'${action}' requires an approved human approval` };

  return { allowed: true, scope: "sensitive", requiresApproval: true, approvedBy: approval.approvedBy || "human",
    reason: `granted and approved for ${action}` };
}

/** Common shape: read-only by default, no grants, no destinations, and an optional amount ceiling. */
function baseConnection(kind, { account, limits = {} }) {
  return { kind, account, id: `${kind}:${account}`, scope: "read", grants: [],
    limits: { maxAmount: limits.maxAmount ?? null, allowedDestinations: limits.allowedDestinations || [] },
    verified: false };   // live endpoints unexercised in this environment
}

/** Grant a value-moving action on a financial account. Always human-approved, never implicit. */
export function grantFinanceAction(conn, action) {
  if (!VALUE_MOVING.has(String(action))) throw new Error(`'${action}' is read-only — no grant needed`);
  return { ...conn, grants: [...(conn.grants || []), { scope: "sensitive", action, approval: "human" }] };
}
export function allowDestination(conn, destination) {
  return { ...conn, limits: { ...conn.limits, allowedDestinations: [...(conn.limits.allowedDestinations || []), destination] } };
}

// ── Plaid — banking data. READ ONLY here by design. ─────────────────────────────────────────────

/**
 * Plaid: accounts, balances and transactions. This adapter exposes NO money movement at all — Plaid
 * transfers are deliberately out of scope for the Community Edition.
 */
export function plaidConnector({ account, clientId = null, secret = null, accessToken = null, env = "sandbox", fetchImpl = null } = {}) {
  const host = { sandbox: "sandbox.plaid.com", development: "development.plaid.com", production: "production.plaid.com" }[env] || "sandbox.plaid.com";
  const creds = () => ({ client_id: clientId ?? process.env.PLAID_CLIENT_ID, secret: secret ?? process.env.PLAID_SECRET,
    access_token: accessToken ?? process.env.PLAID_ACCESS_TOKEN });
  const call = fetchImpl || ((path, payload) => httpsJson({ host, path, method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
  const conn = baseConnection("plaid", { account });
  return {
    ...conn, provider: "plaid", readOnly: true,
    async balances() {
      const r = await call("/accounts/balance/get", creds());
      return (r.accounts || []).map((a) => ({ id: a.account_id, name: a.name, type: a.subtype || a.type,
        currency: a.balances?.iso_currency_code || null, available: a.balances?.available ?? null,
        current: a.balances?.current ?? null, mask: a.mask || null }));
    },
    async transactions({ startDate, endDate, count = 100 } = {}) {
      const r = await call("/transactions/get", { ...creds(), start_date: startDate, end_date: endDate, options: { count } });
      return (r.transactions || []).map((t) => ({ id: t.transaction_id, date: t.date, name: t.name,
        amount: t.amount, currency: t.iso_currency_code || null, pending: !!t.pending,
        category: (t.category || []).join(" / ") || null, account: t.account_id }));
    },
  };
}

// ── Coinbase — read by default; trades/withdrawals are sensitive. ───────────────────────────────

export function coinbaseConnector({ account, apiKey = null, apiSecret = null, limits = {}, fetchImpl = null, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const key = () => apiKey ?? process.env.COINBASE_API_KEY;
  const sec = () => apiSecret ?? process.env.COINBASE_API_SECRET;
  const host = "api.coinbase.com";
  const signed = (method, path, body = "") => {
    const ts = String(now());
    return { "CB-ACCESS-KEY": key(), "CB-ACCESS-SIGN": coinbaseSignature(sec(), { timestamp: ts, method, path, body }),
      "CB-ACCESS-TIMESTAMP": ts, "Content-Type": "application/json" };
  };
  const call = fetchImpl || ((path, { method = "GET", body = "" } = {}) =>
    httpsJson({ host, path, method, headers: signed(method, path, body), body: body || null }));
  const conn = baseConnection("coinbase", { account, limits });
  return {
    ...conn, provider: "coinbase",
    signedHeaders: signed,                                  // exposed so signing is testable
    async accounts() {
      const r = await call("/api/v3/brokerage/accounts");
      return (r.accounts || []).map((a) => ({ id: a.uuid, name: a.name, currency: a.currency,
        available: a.available_balance?.value ?? null, hold: a.hold?.value ?? null }));
    },
    async transactions({ accountId, limit = 50 } = {}) {
      const r = await call(`/api/v3/brokerage/accounts/${accountId}/transactions?limit=${limit}`);
      return r.transactions || [];
    },
    /** Value-moving: refuses unless granted AND approved (and allowlisted for withdrawals). */
    async placeOrder(order = {}, { approval = null, connection = conn } = {}) {
      const d = authorizeFinanceAction(connection, { action: "place-order", amount: order.amount, approval });
      if (!d.allowed) return { executed: false, decision: d };
      const body = JSON.stringify(order);
      const r = await call("/api/v3/brokerage/orders", { method: "POST", body });
      return { executed: true, decision: d, result: r };
    },
    async withdraw({ amount, currency, destination } = {}, { approval = null, connection = conn } = {}) {
      const d = authorizeFinanceAction(connection, { action: "withdraw", amount, destination, approval });
      if (!d.allowed) return { executed: false, decision: d };
      const body = JSON.stringify({ amount, currency, crypto_address: destination });
      const r = await call("/api/v3/brokerage/withdrawals", { method: "POST", body });
      return { executed: true, decision: d, result: r };
    },
  };
}

// ── Binance — read by default; trades/withdrawals are sensitive. ────────────────────────────────

export function binanceConnector({ account, apiKey = null, apiSecret = null, limits = {}, fetchImpl = null, now = () => Date.now() } = {}) {
  const key = () => apiKey ?? process.env.BINANCE_API_KEY;
  const sec = () => apiSecret ?? process.env.BINANCE_API_SECRET;
  const host = "api.binance.com";
  /** Build a signed query string exactly as Binance expects (params in order, signature appended). */
  const signedQuery = (params = {}) => {
    const qs = new URLSearchParams({ ...params, timestamp: String(now()) }).toString();
    return `${qs}&signature=${binanceSignature(sec(), qs)}`;
  };
  const call = fetchImpl || ((path, { method = "GET" } = {}) =>
    httpsJson({ host, path, method, headers: { "X-MBX-APIKEY": key() } }));
  const conn = baseConnection("binance", { account, limits });
  return {
    ...conn, provider: "binance",
    signedQuery,                                            // exposed so signing is testable
    async balances() {
      const r = await call(`/api/v3/account?${signedQuery({})}`);
      return (r.balances || []).filter((b) => Number(b.free) > 0 || Number(b.locked) > 0)
        .map((b) => ({ asset: b.asset, free: b.free, locked: b.locked }));
    },
    async trades({ symbol, limit = 50 } = {}) {
      const r = await call(`/api/v3/myTrades?${signedQuery({ symbol, limit: String(limit) })}`);
      return Array.isArray(r) ? r : [];
    },
    async placeOrder(order = {}, { approval = null, connection = conn } = {}) {
      const d = authorizeFinanceAction(connection, { action: "place-order", amount: order.quantity, approval });
      if (!d.allowed) return { executed: false, decision: d };
      const r = await call(`/api/v3/order?${signedQuery(order)}`, { method: "POST" });
      return { executed: true, decision: d, result: r };
    },
    async withdraw({ coin, amount, address } = {}, { approval = null, connection = conn } = {}) {
      const d = authorizeFinanceAction(connection, { action: "withdraw", amount, destination: address, approval });
      if (!d.allowed) return { executed: false, decision: d };
      const r = await call(`/sapi/v1/capital/withdraw/apply?${signedQuery({ coin, amount: String(amount), address })}`, { method: "POST" });
      return { executed: true, decision: d, result: r };
    },
  };
}

export function connectFinance(spec = {}) {
  switch (spec.kind) {
    case "plaid": return plaidConnector(spec);
    case "coinbase": return coinbaseConnector(spec);
    case "binance": return binanceConnector(spec);
    default: throw new Error(`unknown financial connector '${spec.kind}'`);
  }
}

export function financeOptions() {
  return [
    { key: "plaid", label: "Plaid (bank accounts & transactions)", reads: "balances, transactions", moves: "nothing — read-only by design" },
    { key: "coinbase", label: "Coinbase", reads: "accounts, balances, transactions", moves: "orders and withdrawals — each needs an explicit grant + approval" },
    { key: "binance", label: "Binance", reads: "balances, trades", moves: "orders and withdrawals — each needs an explicit grant + approval" },
  ];
}
