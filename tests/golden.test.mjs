// Golden test: the scoring pipeline gives the same answer on Dossier's data as it
// gave on the direct Torn + tornsy data it replaces. Run: node --test tests/golden.test.mjs
//
// buildOwnedMap, enrichOwnedMap, mergeIntervals and calcScore (with what they call)
// are lifted out of torn_stock_analyzer.js by name and run in a vm with fixed
// inputs and a fixed clock. Three checks:
//   1. Dossier's shapes (/api/tsa/market as one batch, /api/tsa/me) give exactly
//      what the old shapes (four tornsy batches, Torn's user payload) give, with
//      the CURRENT code.
//   2. That output equals tests/fixtures/calcscore.golden.json, which was written
//      by the PRE-Dossier code (2.51.3, 5ac688a) from the old shapes:
//        git show 5ac688a:torn_stock_analyzer.js > /tmp/old.js
//        TSA_GOLDEN_SRC=/tmp/old.js TSA_GOLDEN_WRITE=1 node --test tests/golden.test.mjs
//   3. The fixture is not degenerate: real signals, owned positions, swings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const HERE = new URL(".", import.meta.url);
const GOLDEN = new URL("fixtures/calcscore.golden.json", HERE);
const SRC_PATH = process.env.TSA_GOLDEN_SRC || new URL("../torn_stock_analyzer.js", HERE);
// Normalise line endings: a Windows checkout, or `git archive` with core.autocrlf=true,
// hands over CRLF, and the "\n  }\n" end markers below would then never match.
const SRC = readFileSync(SRC_PATH, "utf8").replace(/\r\n/g, "\n");
const NOW_MS = Date.UTC(2026, 10, 1, 12, 0, 0);
const NOW_S = NOW_MS / 1000;

// "  function NAME(" up to its closing "\n  }\n" (top level of the IIFE: 2 spaces).
function fn(name) {
  const a = SRC.indexOf("\n  function " + name + "(");
  assert.ok(a >= 0, "function " + name + " missing");
  const b = SRC.indexOf("\n  }\n", a);
  assert.ok(b > a, "function " + name + " has no closing '  }' line");
  return SRC.slice(a + 1, b + 4);
}
// "  var NAME = ..." up to the end of its statement (one line, or a "  };"/"  ];" close).
function v(name) {
  const a = SRC.indexOf("\n  var " + name + " =");
  assert.ok(a >= 0, "var " + name + " missing");
  const eol = SRC.indexOf("\n", a + 1);
  const line = SRC.slice(a + 1, eol);
  if (/;\s*(\/\/.*)?$/.test(line)) return line;
  const m = /\n  [}\]];/g;
  m.lastIndex = a + 1;
  const r = m.exec(SRC);
  return SRC.slice(a + 1, r.index + r[0].length);
}

const FUNCS = ["buildOwnedMap", "enrichOwnedMap", "mergeIntervals", "calcSwingAvgPrice",
  "calcSwingNetPct", "calcScore", "calcMACD", "calcRSIContext", "getProfitTarget",
  "getStopLoss", "roiSymSkipped", "roiSymTierCap", "rsiFromPrices"];
const VARS = ["STOCK_ID_MAP", "PASSIVE_STOCKS", "BENEFIT_REQ", "SELL_FEE"];

function load() {
  class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW_MS); }
    static now() { return NOW_MS; }
  }
  const ctx = vm.createContext({ console, Date: FixedDate, Math, JSON, Object, Array, parseFloat, parseInt, isFinite, isNaN });
  const code = [
    "var roiSkipped = []; var roiTierCap = {};",
    "function lsGet(k, fb) { return fb; }",
    ...VARS.map(v),
    ...FUNCS.map(fn),
  ].join("\n");
  vm.runInContext(code, ctx);
  return ctx;
}

// ---- fixture (invented numbers; no real player) -------------------------------
const SYMS = ["FHG", "TSB", "WSU", "IOU", "SYM", "LAG", "CNC", "PRN"];
const GROUPS = [["m30", "h1", "h2", "h3", "h4"], ["h6", "h8", "h10", "h12", "h16"],
  ["h20", "d1", "d2", "d3", "d4"], ["d5", "d6", "d7", "w1", "h5"]];
const ALL = GROUPS.flat();

function prng(seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

function marketRows() {
  const r = prng(7);
  return SYMS.map((sym, i) => {
    const live = 100 + i * 37.5;
    // shapes that reach different branches: a dip under the weekly peak, a rise, flat
    const tilt = [-0.08, 0.05, -0.02, 0.0, -0.12, 0.03, -0.05, 0.08][i];
    const interval = {};
    ALL.forEach((iv, k) => {
      const back = (k + 1) / ALL.length;
      interval[iv] = { price: (live * (1 - tilt * back) * (1 + (r() - 0.5) * 0.01)).toFixed(2) };
    });
    // the reversal pattern m30 > h1 > h2 for two symbols
    if (i === 0 || i === 4) {
      interval.m30.price = (live * 0.995).toFixed(2);
      interval.h1.price = (live * 0.99).toFixed(2);
      interval.h2.price = (live * 0.98).toFixed(2);
    }
    const hi = live * (1 + Math.abs(tilt) + 0.02), lo = live * (1 - Math.abs(tilt) - 0.02);
    return {
      stock: sym, name: sym + " Corp", price: live.toFixed(2),
      investors: 1000 + i * 111, total_shares: 1e9 + i,
      interval,
      ohlc: { w1: { open: (live * 0.97).toFixed(2), high: hi.toFixed(2), low: lo.toFixed(2) } },
    };
  });
}

// /api/tsa/market: one merged row per symbol.
function dossierMarket(rows) { return { data: rows, missing_batches: 0, meta: { server_ts: NOW_S, source_ts: NOW_S, offline: false } }; }

// The four tornsy batches the market rows were merged from (ohlc on batches 3 and 4).
function tornsyBatches(rows) {
  return GROUPS.map((g, gi) => ({
    data: rows.map((row) => {
      const o = { stock: row.stock, name: row.name, price: row.price, investors: row.investors, total_shares: row.total_shares, interval: {} };
      g.forEach((iv) => { o.interval[iv] = row.interval[iv]; });
      if (gi >= 2) o.ohlc = { w1: row.ohlc.w1 };
      return o;
    }),
  }));
}

function idOf(ctx, sym) { return Object.keys(ctx.STOCK_ID_MAP).find((k) => ctx.STOCK_ID_MAP[k] === sym); }

// Torn's v1 user payload (more fields than TSA reads) ...
function tornUser(ctx) {
  const stocks = {};
  const add = (sym, txs, cyc) => {
    const id = idOf(ctx, sym);
    const h = { stock_id: Number(id), total_shares: txs.reduce((a, t) => a + t.shares, 0), transactions: {} };
    txs.forEach((t, k) => { h.transactions[String(9000 + Number(id) * 10 + k)] = t; });
    if (cyc) h[cyc.kind] = cyc.v;
    stocks[id] = h;
  };
  const req = (s) => ctx.BENEFIT_REQ[s];
  add("FHG", [{ shares: req("FHG"), bought_price: 0, time_bought: NOW_S - 400 * 86400 },
              { shares: 5000, bought_price: 101.2, time_bought: NOW_S - 3 * 86400 }],
      { kind: "dividend", v: { ready: 0, increment: 1, progress: 3, frequency: 7 } });
  add("WSU", [{ shares: req("WSU"), bought_price: 60.5, time_bought: NOW_S - 90 * 86400 }],
      { kind: "benefit", v: { ready: 0, increment: 1, progress: 0, frequency: 7 } });
  add("SYM", [{ shares: 12000, bought_price: 290.0, time_bought: NOW_S - 2 * 86400 },
              { shares: 3000, bought_price: 260.0, time_bought: NOW_S - 1 * 86400 }]);
  add("LAG", [{ shares: 800, bought_price: 250.0, time_bought: NOW_S - 6 * 3600 }]);
  return { player_id: 1, name: "Fixture", money_onhand: 5e7, level: 10, stocks };
}

// ... and /api/tsa/me: the same holdings through Dossier's allowlist.
function dossierMe(user) {
  const stocks = {};
  Object.keys(user.stocks).forEach((id) => {
    const h = user.stocks[id];
    const e = { stock_id: h.stock_id, total_shares: h.total_shares, transactions: {} };
    ["dividend", "benefit"].forEach((c) => {
      if (h[c]) e[c] = { ready: h[c].ready, increment: h[c].increment, progress: h[c].progress, frequency: h[c].frequency };
    });
    Object.keys(h.transactions).forEach((t) => {
      const x = h.transactions[t];
      e.transactions[t] = { shares: x.shares, bought_price: x.bought_price, time_bought: x.time_bought };
    });
    stocks[id] = e;
  });
  return { player_id: 1, holdings_status: "ok", stocks, money_onhand: user.money_onhand,
           armory: { money_balance: 0, ok: false, as_of: null }, meta: { server_ts: NOW_S, source_ts: NOW_S - 60, offline: false } };
}

// 40 hourly points per symbol so MACD/RSI run.
function priceHistory(rows) {
  const h = {};
  rows.forEach((row, i) => {
    const live = parseFloat(row.price);
    h[row.stock] = Array.from({ length: 40 }, (_, k) => ({
      ts: NOW_MS - (40 - k) * 3600 * 1000,
      price: +(live * (1 + Math.sin((k + i) / 4) * 0.03)).toFixed(2),
    }));
  });
  return h;
}

function pipeline(ctx, raw, ownedSrc, hist) {
  const ownedMap = ctx.buildOwnedMap(ownedSrc);
  ctx.enrichOwnedMap(ownedMap, raw);
  const scores = SYMS.map((s) => ctx.calcScore(s, raw, ownedMap, hist));
  return JSON.parse(JSON.stringify({ ownedMap, scores }));
}

function oldPath(ctx) {
  const rows = marketRows();
  return pipeline(ctx, ctx.mergeIntervals(tornsyBatches(rows)), tornUser(ctx), priceHistory(rows));
}
function newPath(ctx) {
  const rows = marketRows();
  return pipeline(ctx, ctx.mergeIntervals([dossierMarket(rows)]), dossierMe(tornUser(ctx)), priceHistory(rows));
}

if (process.env.TSA_GOLDEN_WRITE === "1") {
  test("write the golden file from " + SRC_PATH, () => {
    writeFileSync(GOLDEN, JSON.stringify(oldPath(load()), null, 1) + "\n");
  });
} else {
  test("Dossier's shapes give exactly what the direct Torn + tornsy shapes gave (same code)", () => {
    const ctx = load();
    assert.deepEqual(newPath(ctx), oldPath(ctx));
  });

  test("calcScore output on Dossier data equals the 2.51.3 golden output", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    assert.deepEqual(newPath(load()), golden);
  });

  test("the fixture reaches real branches (scores, owned positions, a swing)", () => {
    const out = newPath(load());
    assert.equal(out.scores.filter(Boolean).length, SYMS.length);
    assert.ok(new Set(out.scores.map((s) => s.signal)).size >= 2, "more than one signal");
    assert.ok(out.ownedMap.FHG.benefit_shares > 0 && out.ownedMap.FHG.swing_shares > 0);
    assert.ok(out.ownedMap.SYM.shares === 15000);
  });
}
