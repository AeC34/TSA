// Tests for TSA's Dossier data client. Run: node --test tests/data.test.mjs
//
// dossierGet lives between the TSA-NET markers, the cache/plan/trade-log module
// between the TSA-DATA markers; both are loaded here unchanged from
// torn_stock_analyzer.js beside TSA-LICENSE, into a fresh vm context per test, with
// a GM_xmlhttpRequest stub as the only transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");

function block(name) {
  const a = SRC.indexOf("// ==" + name + "-BEGIN==");
  const b = SRC.indexOf("// ==" + name + "-END==");
  assert.ok(a >= 0 && b > a, name + " markers missing");
  return SRC.slice(a, b);
}

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const TOKEN = "tsa1_" + "A".repeat(20) + "b-_9" + "z".repeat(19);
const BASE = "https://dossier-api.aec3.org";
const ROUTES = { market: "/api/tsa/market", me: "/api/tsa/me", history: "/api/tsa/history", reference: "/api/tsa/reference" };

function memStore(init = {}) {
  const m = { ...init };
  return { get: (k) => (k in m ? m[k] : null), set: (k, v) => { m[k] = v; }, m };
}

function fakeTimers() {
  const pending = [];
  return {
    set: (fn, ms) => { const t = { fn, ms, live: true }; pending.push(t); return t; },
    clear: (t) => { t.live = false; },
    fire: () => { pending.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }); },
    pending,
  };
}

// A fresh module with a licence key stored and an active cached licence.
function setup({ now = T0, store } = {}) {
  const calls = [];
  const ctx = vm.createContext({ console, GM_xmlhttpRequest: (o) => { calls.push(o); } });
  vm.runInContext(block("TSA-NET") + "\n" + block("TSA-LICENSE") + "\n" + block("TSA-DATA"), ctx);
  let clock = now;
  const timers = fakeTimers();
  const st = store || memStore({ tsa_license: JSON.stringify({ token: TOKEN }) });
  const deps = { xhr: (o) => ctx.gmXhr(o), store: st, now: () => clock, setTimer: timers.set, clearTimer: timers.clear };
  const answer = (code, body, headers = "", i = calls.length - 1) =>
    calls[i].onload({ status: code, responseText: typeof body === "string" ? body : JSON.stringify(body), responseHeaders: headers });
  return { ctx, calls, deps, timers, store: st, answer, tick: (ms) => { clock += ms; }, now: () => clock };
}

function get(s, name, maxAge = 0) {
  let out = null;
  s.ctx.TSAData.get(s.deps, name, maxAge, (r) => { out = r; });
  return () => out;
}

const OK = {
  market: { data: [{ stock: "FHG", price: "500.00", interval: { m30: { price: "499" } }, ohlc: {} }], missing_batches: 0, meta: {} },
  me: { player_id: 7, holdings_status: "ok", stocks: {}, money_onhand: 5, armory: { money_balance: 0, ok: false, as_of: null }, meta: { source_ts: 1 } },
  history: { symbols: { FHG: { lt: { days: 40 }, lt_ts: 1, h1: { closes: [1], stamps: [1] }, h1_ts: 1 } }, meta: {} },
  reference: { stocks: { 1: { acronym: "TSB" } }, items: { 206: { name: "Xanax", market_value: 800000 } }, meta: {} },
};

// ---------------------------------------------------------------- dossierGet, every route x every status

for (const [name, path] of Object.entries(ROUTES)) {
  test(`${name}: one GET to ${path}, only the Bearer header, no cookies`, () => {
    const s = setup();
    s.ctx.dossierGet(path, () => {}, s.deps);
    assert.equal(s.calls.length, 1);
    const o = s.calls[0];
    assert.equal(o.method, "GET");
    assert.equal(o.url, BASE + path);
    assert.deepEqual(Object.keys(o.headers), ["Authorization"]);
    assert.equal(o.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(o.anonymous, true);
    assert.ok(!/key=|torn\.com|tornsy/.test(o.url));
  });

  test(`${name}: 200 -> ok with the body`, () => {
    const s = setup();
    let r; s.ctx.dossierGet(path, (x) => { r = x; }, s.deps);
    s.answer(200, OK[name]);
    assert.equal(r.kind, "ok");
    assert.deepEqual(JSON.parse(JSON.stringify(r.body)), OK[name]);
  });

  test(`${name}: 401 -> licence_invalid; 403 licence inactive -> licence_inactive; 403 torn key required -> key_required`, () => {
    for (const [code, body, kind] of [[401, { error: "invalid licence" }, "licence_invalid"],
      [403, { error: "licence inactive" }, "licence_inactive"],
      [403, { error: "torn key required" }, "key_required"],
      [403, { error: "something else" }, "unreachable"]]) {
      const s = setup();
      let r; s.ctx.dossierGet(path, (x) => { r = x; }, s.deps);
      s.answer(code, body);
      assert.equal(r.kind, kind, code + " " + body.error);
    }
  });

  test(`${name}: 503 / 500 / unreadable 200 / network error / timeout -> unreachable, no retry`, () => {
    for (const fire of [
      (s) => s.answer(503, { error: "unavailable", ref: "x" }),
      (s) => s.answer(500, { error: "internal error", ref: "x" }),
      (s) => s.answer(200, "<html>proxy</html>"),
      (s) => s.answer(200, "[1,2]"),
      (s) => s.calls[0].onerror({}),
      (s) => s.calls[0].ontimeout({}),
      (s) => s.timers.fire(),
    ]) {
      const s = setup();
      let r, n = 0; s.ctx.dossierGet(path, (x) => { r = x; n++; }, s.deps);
      fire(s);
      s.timers.fire();                       // a late timer after the answer changes nothing
      assert.equal(r.kind, "unreachable");
      assert.equal(n, 1);
      assert.equal(s.calls.length, 1);       // never retried
    }
  });

  test(`${name}: 429 honours Retry-After — nothing is sent until it has passed`, () => {
    const s = setup();
    let r; s.ctx.dossierGet(path, (x) => { r = x; }, s.deps);
    s.answer(429, { error: "too many requests" }, "Content-Type: application/json\r\nRetry-After: 42\r\n");
    assert.equal(r.kind, "throttled");
    assert.equal(r.retryAfterMs, 42000);
    s.tick(41000);
    s.ctx.dossierGet(path, (x) => { r = x; }, s.deps);
    assert.equal(s.calls.length, 1);
    assert.equal(r.kind, "throttled");
    assert.equal(r.local, true);
    s.tick(1000);
    s.ctx.dossierGet(path, (x) => { r = x; }, s.deps);
    assert.equal(s.calls.length, 2);
  });
}

test("429 Retry-After: PDA-style header object, missing header -> 60 s, absurd value capped at 1 h", () => {
  const cases = [[{ "retry-after": "7" }, 7000], ["", 60000], ["Retry-After: 999999", 3600000], ["Retry-After: soon", 60000]];
  for (const [h, ms] of cases) {
    const s = setup();
    let r; s.ctx.dossierGet(ROUTES.me, (x) => { r = x; }, s.deps);
    s.answer(429, { error: "too many requests" }, h);
    assert.equal(r.retryAfterMs, ms, JSON.stringify(h));
  }
});

test("a path outside the four routes, or no licence key, sends nothing", () => {
  const s = setup();
  let r;
  for (const p of ["/api/state", "/api/license/check", "/api/tsa/me?x=1", "https://api.torn.com/user/"]) {
    s.ctx.dossierGet(p, (x) => { r = x; }, s.deps);
    assert.equal(r.kind, "unreachable");
  }
  const s2 = setup({ store: memStore({}) });
  s2.ctx.dossierGet(ROUTES.me, (x) => { r = x; }, s2.deps);
  assert.equal(r.kind, "licence_invalid");
  assert.equal(s.calls.length + s2.calls.length, 0);
});

test("a throwing transport maps to unreachable", () => {
  const s = setup();
  s.deps.xhr = () => { throw new Error("boom"); };
  let r; s.ctx.dossierGet(ROUTES.market, (x) => { r = x; }, s.deps);
  assert.equal(r.kind, "unreachable");
});

// ---------------------------------------------------------------- TSAData.get: reuse, sharing, storage

test("an answer younger than maxAge is reused with no request; concurrent callers share one", () => {
  const s = setup();
  const a = get(s, "market", 30000), b = get(s, "market", 30000);
  assert.equal(s.calls.length, 1);
  s.answer(200, OK.market);
  assert.equal(a().kind, "ok"); assert.equal(b().kind, "ok");
  s.tick(29999);
  const c = get(s, "market", 30000);
  assert.equal(c().cached, true);
  assert.equal(s.calls.length, 1);
  s.tick(1);
  get(s, "market", 30000);
  assert.equal(s.calls.length, 2);
});

test("/me and /market are stored; a later failure returns them as the fallback (fresh module, same store)", () => {
  const s = setup();
  get(s, "me"); s.answer(200, OK.me);
  get(s, "market"); s.answer(200, OK.market);
  const s2 = setup({ store: s.store, now: T0 + 60000 });
  const me = get(s2, "me"); s2.answer(503, { error: "unavailable" });
  assert.equal(me().kind, "unreachable");
  assert.equal(me().fallback.body.player_id, 7);
  assert.equal(me().fallback.ms, T0);
  const mk = get(s2, "market"); s2.calls[s2.calls.length - 1].onerror({});
  assert.equal(mk().fallback.body.data[0].stock, "FHG");
});

test("stored data older than 24 h is no fallback", () => {
  const s = setup();
  get(s, "me"); s.answer(200, OK.me);
  const s2 = setup({ store: s.store, now: T0 + 24 * 3600 * 1000 });
  const me = get(s2, "me"); s2.answer(503, {});
  assert.equal(me().fallback, null);
});

test("a cold Dossier (market data [], holdings warming) never overwrites the stored copy", () => {
  const s = setup();
  get(s, "me"); s.answer(200, OK.me);
  get(s, "market"); s.answer(200, OK.market);
  s.tick(60000);
  const me = get(s, "me", 30000); s.answer(200, { ...OK.me, holdings_status: "warming", stocks: {}, money_onhand: null, meta: { source_ts: null } });
  assert.equal(me().kind, "ok");
  assert.equal(me().fallback.body.holdings_status, "ok");
  const mk = get(s, "market", 30000); s.answer(200, { data: [], missing_batches: 4, meta: {} });
  assert.equal(mk().fallback.body.data.length, 1);
  assert.equal(JSON.parse(s.store.get("tsa_dossier_me")).body.holdings_status, "ok");
  assert.equal(JSON.parse(s.store.get("tsa_dossier_market")).body.data.length, 1);
  // and the warming answer is not reused: the next load asks again
  get(s, "me", 30000);
  assert.equal(s.calls.length, 5);
});

test("history/reference wait 5 min after a failure; resetWaits ends the wait", () => {
  for (const name of ["history", "reference"]) {
    const s = setup();
    get(s, name); s.answer(503, {});
    const r = get(s, name);
    assert.equal(r().kind, "unreachable");
    assert.equal(s.calls.length, 1);
    s.tick(s.ctx.TSAData.FAIL_WAIT_MS);
    get(s, name);
    assert.equal(s.calls.length, 2);
    s.answer(503, {});
    s.ctx.TSAData.resetWaits();
    get(s, name);
    assert.equal(s.calls.length, 3);
  }
});

test("clear() forgets memory, the stored /me and /market, and the trade log", () => {
  const s = setup();
  get(s, "me"); s.answer(200, OK.me);
  s.ctx.TSAData.logTrade(s.deps, "FHG", 10, 500);
  s.ctx.TSAData.clear(s.deps);
  assert.equal(s.ctx.TSAData.last(s.deps, "me"), null);
  assert.equal(s.ctx.TSAData.readLog(s.deps).length, 0);
  get(s, "me", 30000);
  assert.equal(s.calls.length, 2);
});

test("an answer still in flight when the key changes (clear) is neither kept nor shared with new callers", () => {
  const s = setup();
  const old = get(s, "me");
  s.ctx.TSAData.clear(s.deps);
  const fresh = get(s, "me");
  assert.equal(s.calls.length, 2);                      // the new caller did not join the old request
  s.answer(200, OK.me, "", 0);                          // the old key's answer lands
  assert.equal(old().kind, "unreachable");
  assert.equal(old().outcome.error, "stale");
  assert.equal(s.ctx.TSAData.last(s.deps, "me"), null);
  s.answer(200, OK.me, "", 1);
  assert.equal(fresh().kind, "ok");
  assert.equal(s.ctx.TSAData.last(s.deps, "me").body.player_id, 7);
});

test("history/reference after a 429 wait exactly Retry-After, not 5 min", () => {
  const s = setup();
  get(s, "history"); s.answer(429, { error: "too many requests" }, "Retry-After: 20");
  s.tick(19999);
  assert.notEqual(get(s, "history")().kind, "ok");
  assert.equal(s.calls.length, 1);                      // still waiting: nothing sent
  s.tick(1);
  get(s, "history");
  assert.equal(s.calls.length, 2);
});

// ---------------------------------------------------------------- plan

const P = (s) => s.ctx.TSAData.plan.bind(s.ctx.TSAData);
const okRes = (name, ms = T0, extra = {}) => ({ kind: "ok", body: OK[name], ms, ...extra });
const errRes = (kind, fallback = null, outcome = { kind }) => ({ kind, fallback, outcome });

test("plan: 401 or 403 licence inactive on either route locks the licence", () => {
  const s = setup(); const plan = P(s);
  for (const k of ["licence_invalid", "licence_inactive"]) {
    assert.equal(plan(errRes(k), okRes("market"), T0).lock, "licence");
    assert.equal(plan(okRes("me"), errRes(k), T0).lock, "licence");
    assert.equal(plan(errRes("key_required"), errRes(k), T0).lock, "licence");
  }
});

test("plan: 403 torn key required locks with the key screen — no data UI", () => {
  const s = setup(); const plan = P(s);
  assert.equal(plan(errRes("key_required"), okRes("market"), T0).lock, "key");
  assert.equal(plan(okRes("me"), errRes("key_required"), T0).lock, "key");
});

test("plan: both 200 -> live holdings and live market", () => {
  const p = P(setup())(okRes("me"), okRes("market"), T0);
  assert.equal(p.lock, null);
  assert.equal(p.holdingsLive, true);
  assert.equal(p.marketLive, true);
  assert.equal(p.dossier, null);
});

test("plan: 429 keeps the last data and carries Retry-After", () => {
  const fbMe = { body: OK.me, ms: T0 - 60000 }, fbMk = { body: OK.market, ms: T0 - 60000 };
  const p = P(setup())(errRes("throttled", fbMe, { kind: "throttled", retryAfterMs: 20000 }),
                       errRes("throttled", fbMk, { kind: "throttled", retryAfterMs: 40000 }), T0);
  assert.equal(p.dossier, "throttled");
  assert.equal(p.retryMs, 40000);
  assert.equal(p.me.player_id, 7);
  assert.equal(p.holdingsLive, false);
  assert.equal(p.market.data.length, 1);
  assert.equal(p.marketLive, false);
});

test("plan: 5xx/network/timeout -> stored holdings; stored market only if < 30 min old, else page prices", () => {
  const plan = P(setup());
  const fbMe = { body: OK.me, ms: T0 - 3 * 3600 * 1000 };
  let p = plan(errRes("unreachable", fbMe), errRes("unreachable", { body: OK.market, ms: T0 - 29 * 60000 }), T0);
  assert.equal(p.dossier, "unreachable");
  assert.equal(p.me.player_id, 7);
  assert.ok(p.market);
  p = plan(errRes("unreachable", fbMe), errRes("unreachable", { body: OK.market, ms: T0 - 30 * 60000 }), T0);
  assert.equal(p.market, null);
  p = plan(errRes("unreachable"), errRes("unreachable"), T0);
  assert.equal(p.me, null);
  assert.equal(p.market, null);
});

test("plan: holdings warming -> not live, the stored copy if any, flagged", () => {
  const plan = P(setup());
  const warm = { kind: "ok", body: { ...OK.me, holdings_status: "warming" }, ms: T0, fallback: { body: OK.me, ms: T0 - 600000 } };
  let p = plan(warm, okRes("market"), T0);
  assert.equal(p.warming, true);
  assert.equal(p.holdingsLive, false);
  assert.equal(p.meMs, T0 - 600000);
  p = plan({ ...warm, fallback: null }, okRes("market"), T0);
  assert.equal(p.me, null);
  assert.equal(p.warming, true);
});

test("plan: a 200 market with no rows (Dossier cold) is no live market", () => {
  const p = P(setup())(okRes("me"), { kind: "ok", body: { data: [], missing_batches: 4 }, ms: T0, fallback: null }, T0);
  assert.equal(p.market, null);
  assert.equal(p.dossier, null);
});

// ---------------------------------------------------------------- trade log overlay

const ID = { FHG: 1, SYM: 2 };
function meWith(stocks, source_ts) { return { player_id: 7, holdings_status: "ok", stocks, money_onhand: 1, meta: { source_ts } }; }

test("trade log: a buy newer than the poll adds a transaction; older trades are already in the poll", () => {
  const s = setup();
  const me = meWith({ 1: { stock_id: 1, total_shares: 100, dividend: { ready: 0, increment: 1, progress: 1, frequency: 7 },
                           transactions: { a: { shares: 100, bought_price: 10, time_bought: 1000 } } } }, 5000);
  const log = [{ sym: "FHG", delta: 50, price: 12, ts: 4000 }, { sym: "FHG", delta: 25, price: 13, ts: 6000 },
               { sym: "SYM", delta: 10, price: 3, ts: 6001 }];
  const out = s.ctx.TSAData.applyTradeLog(me, log, ID, 6100 * 1000);
  assert.equal(out.stocks[1].total_shares, 125);
  const txs = Object.values(out.stocks[1].transactions);
  assert.equal(txs.length, 2);
  assert.ok(txs.some((t) => t.shares === 25 && t.bought_price === 13 && t.time_bought === 6000));
  assert.ok(out.stocks[1].dividend);
  assert.equal(out.stocks[2].total_shares, 10);
  assert.equal(me.stocks[1].total_shares, 100);               // input untouched
  assert.equal(Object.keys(me.stocks[1].transactions).length, 1);
});

test("trade log: a sell takes the newest transactions first and drops an emptied holding", () => {
  const s = setup();
  const me = meWith({ 1: { stock_id: 1, total_shares: 300, transactions: {
    old: { shares: 200, bought_price: 5, time_bought: 100 }, mid: { shares: 60, bought_price: 7, time_bought: 200 },
    new: { shares: 40, bought_price: 9, time_bought: 300 } } } }, 1000);
  let out = s.ctx.TSAData.applyTradeLog(me, [{ sym: "FHG", delta: -70, price: 0, ts: 1100 }], ID, 1200 * 1000);
  assert.equal(out.stocks[1].total_shares, 230);
  assert.equal(out.stocks[1].transactions.new, undefined);
  assert.equal(out.stocks[1].transactions.mid.shares, 30);
  assert.equal(out.stocks[1].transactions.old.shares, 200);
  out = s.ctx.TSAData.applyTradeLog(me, [{ sym: "FHG", delta: -300, price: 0, ts: 1100 }], ID, 1200 * 1000);
  assert.equal(out.stocks[1], undefined);
  assert.equal(me.stocks[1].transactions.new.shares, 40);     // input untouched
});

test("trade log: cash follows the trades — a buy costs shares x price, a sell pays shares actually sold x price x fee", () => {
  const s = setup();
  const me = { ...meWith({ 1: { stock_id: 1, total_shares: 100, transactions: { a: { shares: 100, bought_price: 5, time_bought: 1 } } } }, 1000), money_onhand: 10000 };
  const out = s.ctx.TSAData.applyTradeLog(me, [
    { sym: "SYM", delta: 10, price: 50, ts: 1100 },          // -500
    { sym: "FHG", delta: -150, price: 20, ts: 1101 },        // only 100 held: +100*20*0.999 = +1998
    { sym: "FHG", delta: 5, price: 0, ts: 1102 }], ID, 1200 * 1000, 0.999);   // no price: shares only
  assert.equal(out.money_onhand, 10000 - 500 + 1998);
  assert.equal(me.money_onhand, 10000);
  const none = s.ctx.TSAData.applyTradeLog({ ...me, money_onhand: null }, [{ sym: "SYM", delta: 1, price: 9, ts: 1100 }], ID, 1200 * 1000, 0.999);
  assert.equal(none.money_onhand, null);
});

test("trade log: entries older than 30 min, unknown symbols and a missing meta are handled", () => {
  const s = setup();
  const me = meWith({}, null);
  const nowMs = 10000 * 1000;
  const out = s.ctx.TSAData.applyTradeLog(me, [
    { sym: "FHG", delta: 5, price: 1, ts: 10000 - 1800 },     // exactly 30 min: dropped
    { sym: "NOPE", delta: 5, price: 1, ts: 9999 },
    { sym: "SYM", delta: 5, price: 1, ts: 9999 }], ID, nowMs);
  assert.deepEqual(Object.keys(out.stocks), ["2"]);
  assert.equal(s.ctx.TSAData.applyTradeLog(null, [], ID, nowMs), null);
});

test("logTrade appends and trims entries older than 30 min", () => {
  const s = setup();
  s.ctx.TSAData.logTrade(s.deps, "fhg", 10, 500);
  s.tick(31 * 60000);
  s.ctx.TSAData.logTrade(s.deps, "SYM", -4, 0);
  const l = s.ctx.TSAData.readLog(s.deps);
  assert.equal(l.length, 1);
  assert.equal(l[0].sym, "SYM");
  assert.equal(l[0].delta, -4);
});

// ---------------------------------------------------------------- the script as a whole

test("source: no Torn API / tornsy call, no Torn key, @connect only dossier-api.aec3.org", () => {
  assert.equal((SRC.match(/api\.torn\.com|tornsy\.com/g) || []).length, 0);
  assert.equal((SRC.match(/getTornKey|TORN_API_KEY|KEY_BUILDER_URL|PDA-APIKEY/g) || []).length, 0);
  const connects = SRC.match(/^\/\/ @connect\s+\S+/gm);
  assert.deepEqual(connects, ["// @connect      dossier-api.aec3.org"]);
  assert.match(SRC, /^\/\/ @version\s+2\.52\.0$/m);
  // the only GM request left is dossierGet's (the licence check builds its own URL)
  const xhrUrls = SRC.match(/url:\s*[^,\n]+/g).map((x) => x.replace(/\s+/g, " "));
  assert.deepEqual(xhrUrls.sort(), ["url: CHECK_URL", "url: DOSSIER_API_BASE + path", "url: url"].sort());
});

test("source: the stored Torn key is deleted on start, and no interval timer fetches data", () => {
  assert.match(SRC, /\["tsa-torn-apikey",[^\]]*\]\.forEach\(function \(k\) \{\s*try \{ localStorage\.removeItem\(k\); \}/);
  const intervals = SRC.match(/setInterval\([^)]*\)/g) || [];
  assert.deepEqual(intervals, ["setInterval(updateCountdownLabel, 1000)"]);
});
