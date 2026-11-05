// Licence mode is Dossier ONLY; free mode names the next block by Dossier's rule (2.56.0).
// Run: node --test tests/dossieronly.test.mjs
//
// Owner decision 2026-11-05:
//   - with an active licence TSA shows Dossier's Benefit Advisor answer
//     (/api/tsa/benefit) and never fetches api.torn.com or tornsy.com itself, not
//     even when Dossier is down and a Torn key is stored
//   - when the licence lapses, TSA is back on the user's own key and says so
//   - free mode picks the next block the way Dossier does: buy now -> via a sale ->
//     fewest days to afford (own swing excluded, ties to the earlier row) -> the
//     highest-income goal
//   - no stored key is removed or overwritten
// No network, no real Torn key: the key below is a dummy string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { boot, settle } from "./fixtures/browser.mjs";
import * as F from "./fixtures/stores.mjs";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// One top-level function of the userscript, by name: a one-liner, or up to its
// closing "  }" line.
function fn(name) {
  const start = SRC.search(new RegExp("\\n  function " + name + "\\("));
  assert.ok(start >= 0, name);
  const eol = SRC.indexOf("\n", start + 1);
  const line = SRC.slice(start + 1, eol);
  if (/\}\s*$/.test(line) && (line.match(/\{/g) || []).length === (line.match(/\}/g) || []).length) return line;
  const end = SRC.indexOf("\n  }\n", start);
  return SRC.slice(start + 1, end + 4);
}

const count = (b, host) => b.hosts().filter((h) => h === host).length;
const text = (b) => b.page().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// ---------------------------------------------------------------- free mode: the rule

function ruleCtx({ units = [], swing = {} } = {}) {
  const ctx = vm.createContext({
    Math, isFinite, Infinity,
    SELL_FEE: 0.999, BENEFIT_REQ: { AAA: 100, BBB: 100, CCC: 100, DDD: 100 },
    computeSellUnits: () => units,
    computeRoadmap: () => { throw new Error("rows are passed in"); },
  });
  vm.runInContext(["daysToAfford", "symSwingValue", "fundBySale", "computeFastestPath", "pickNextBlock", "blockTarget", "nextBlockWhy"]
    .map(fn).join("\n"), ctx);
  // ownedMap/raw that give each symbol `swing[sym]` dollars of swing at price 1
  ctx.owned = {}; ctx.raw = [];
  for (const [sym, v] of Object.entries(swing)) {
    ctx.owned[sym] = { swing_shares: v / 0.999, shares: v / 0.999 };
    ctx.raw.push({ stock: sym, price: "1" });
  }
  return ctx;
}
// A computeRoadmap row (the fields pickNextBlock and computeFastestPath read).
const row = (sym, cost, extra = {}) => ({ sym, tier: "T1", tierNum: 1, cost, sharesNeeded: cost, roi: 10, perCycle: 70, freq: 7,
  dailyInc: 10, monthlyInc: 300, payback: 100, owned: false, pending: false, ...extra });
const pick = (ctx, rows, capital, income) => {
  ctx.rows = rows; ctx.capital = capital; ctx.income = income;
  return vm.runInContext("pickNextBlock(owned, raw, capital, income, rows)", ctx);
};

test("free rule: buy = the FIRST affordable row in roadmap order, not the cheapest", () => {
  const ctx = ruleCtx();
  const a = pick(ctx, [row("AAA", 500), row("BBB", 90), row("CCC", 50)], 100, 70);
  assert.equal(a.kind, "buy");
  assert.equal(a.row.sym, "BBB");
  assert.equal(a.days, 0);
});

test("free rule: owned and pending rows are never the answer", () => {
  const ctx = ruleCtx();
  const a = pick(ctx, [row("AAA", 10, { owned: true }), row("BBB", 10, { pending: true }), row("CCC", 50)], 100, 70);
  assert.equal(a.row.sym, "CCC");
});

test("free rule: via a sale when nothing is affordable and selling a worse block pays for it", () => {
  const units = [{ sym: "DDD", tier: "T1", roi: 2, saleValue: 500, weekly: 1 }];
  const ctx = ruleCtx({ units });
  const a = pick(ctx, [row("AAA", 400)], 100, 70);
  assert.equal(a.kind, "viaSale");
  assert.equal(a.row.sym, "AAA");
  assert.deepEqual(JSON.parse(JSON.stringify(a.viaSale.sells.map((u) => u.sym))), ["DDD"]);
  assert.match(vm.runInContext("nextBlockWhy(" + JSON.stringify({ kind: "viaSale", viaSale: { sells: [{ sym: "DDD", tier: "T1" }] } }) + ")", ctx), /Sell DDD T1/);
});

test("free rule: a sale that loses more income than the buy brings is no plan, and a block as good as the buy is never sold", () => {
  const ctx = ruleCtx({ units: [{ sym: "DDD", tier: "T1", roi: 2, saleValue: 500, weekly: 999 }] });
  assert.notEqual(pick(ctx, [row("AAA", 400)], 100, 70).kind, "viaSale");
  const ctx2 = ruleCtx({ units: [{ sym: "DDD", tier: "T1", roi: 10, saleValue: 500, weekly: 1 }] });
  assert.notEqual(pick(ctx2, [row("AAA", 400)], 100, 70).kind, "viaSale");
});

test("free rule: closest = the fewest days to afford, not the biggest income goal", () => {
  const ctx = ruleCtx();
  // capital 100, 70/week = 10/day. AAA needs 400 more (40 d), BBB 200 more (20 d).
  const a = pick(ctx, [row("AAA", 500, { monthlyInc: 9e9 }), row("BBB", 300)], 100, 70);
  assert.equal(a.kind, "closest");
  assert.equal(a.row.sym, "BBB");
  assert.equal(a.days, 20);
  assert.equal(vm.runInContext("nextBlockWhy({kind:'closest', days:20})", ctx), "Closest to afford: ~20d");
});

test("free rule: closest ties go to the earlier row", () => {
  const ctx = ruleCtx();
  const a = pick(ctx, [row("AAA", 300), row("BBB", 300)], 100, 70);
  assert.equal(a.row.sym, "AAA");
});

test("free rule: a stock's own swing does not fund its own block (own_days_to_afford)", () => {
  // AAA holds 150 of the 200 capital as its own swing: it is judged against 50.
  const ctx = ruleCtx({ swing: { AAA: 150 } });
  const a = pick(ctx, [row("AAA", 300), row("BBB", 320)], 200, 70);
  // AAA: (300 - 50) / 10 = 25 d; BBB: (320 - 200) / 10 = 12 d
  assert.equal(a.kind, "closest");
  assert.equal(a.row.sym, "BBB");
  assert.equal(a.days, 12);
});

test("free rule: no income and nothing affordable -> save toward the highest-income goal; nothing open -> none", () => {
  const ctx = ruleCtx();
  const a = pick(ctx, [row("AAA", 500, { monthlyInc: 100 }), row("BBB", 600, { monthlyInc: 900 })], 100, 0);
  assert.equal(a.kind, "save");
  assert.equal(a.row.sym, "BBB");
  assert.equal(a.days, null);
  assert.equal(pick(ctx, [row("AAA", 1, { owned: true })], 100, 70).kind, "none");
  assert.equal(pick(ctx, [], 100, 70).kind, "empty");
});

test("free rule: blockTarget carries the exact share count still missing, so a click never overshoots", () => {
  const ctx = ruleCtx();
  ctx.r = row("AAA", 300, { tier: "T2", tierNum: 2, sharesNeeded: 250 });
  ctx.raw = [{ stock: "AAA", price: "1.2" }];
  const t = vm.runInContext("blockTarget(r, {}, raw)", ctx);
  assert.equal(t.sym, "AAA");
  assert.equal(t.tier, "T2");
  assert.equal(t.tierInfo.nextIncrement, 2);
  assert.equal(t.tierInfo.sharesNeeded, 250);
  assert.equal(t.tierInfo.totalSharesNeeded, 300);
  assert.equal(t.tierInfo.livePrice, 1.2);
});

// ---------------------------------------------------------------- licence mode: the adapter

function dossierCtx() {
  const ctx = vm.createContext({ Math, Number, isFinite, Infinity, Array, Object,
    BENEFIT_REQ: { TCT: 100000, FHG: 2000000, WSU: 1000000 }, PASSIVE_STOCKS: ["WSU"] });
  vm.runInContext(["dNum", "dDays", "dTier", "dossierBlock", "dossierBenefitStatus", "dossierBenefitPlan"].map(fn).join("\n"), ctx);
  return ctx;
}
const plan = (ctx, res, owned = {}, raw = []) => { ctx.res = res; ctx.owned = owned; ctx.raw = raw; return vm.runInContext("dossierBenefitPlan(res, owned, raw)", ctx); };

test("licence adapter: the target IS Dossier's answer row, for every kind that names a block", () => {
  const ctx = dossierCtx();
  for (const [sym, tier, kind] of [["TCT", 1, "closest"], ["FHG", 2, "buy"], ["WSU", 1, "save"], ["TCT", 3, "viaSale"]]) {
    const p = plan(ctx, { kind: "ok", body: F.benefitBody(Date.now(), { sym, tier, kind }) });
    assert.equal(p.fromDossier, true);
    assert.equal(p.status, null);
    assert.equal(p.target.sym, sym);
    assert.equal(p.target.tier, "T" + tier);
    assert.equal(p.answer.kind, kind);
    assert.equal(p.fundCapital, 5);
  }
});

test("licence adapter: shares still missing come from the holdings shown (a Quick Trade since Dossier's poll counts)", () => {
  const ctx = dossierCtx();
  const body = F.benefitBody(Date.now(), { sym: "TCT", tier: 1 });   // Dossier: 100,000 missing at $301
  let p = plan(ctx, { kind: "ok", body }, {}, [{ stock: "TCT", price: "301" }]);
  assert.equal(p.target.tierInfo.sharesNeeded, 100000);
  assert.equal(p.target.cost, 30100000);                               // Dossier's own figure
  p = plan(ctx, { kind: "ok", body }, { TCT: { shares: 100000 } }, [{ stock: "TCT", price: "301" }]);
  assert.equal(p.target.tierInfo.sharesNeeded, 0);                     // bought here already: nothing to buy twice
});

test("licence adapter: no block named -> no target, and a Dossier status instead of a local pick", () => {
  const ctx = dossierCtx();
  const cases = [
    [{ kind: "ok", body: F.benefitBody(Date.now(), { kind: "unavailable" }) }, /not available right now/],
    [{ kind: "ok", body: F.benefitBody(Date.now(), { kind: "none" }) }, /nothing to recommend/],
    [{ kind: "ok", body: F.benefitBody(Date.now(), { kind: "empty" }) }, /no benefit blocks/],
    [{ kind: "unreachable" }, /Dossier unreachable/],
    [{ kind: "throttled" }, /Dossier throttled/],
    [{ kind: "key_required" }, /no working Torn API key/],
    [null, /Waiting for Dossier/],
  ];
  for (const [res, re] of cases) {
    const p = plan(ctx, res);
    assert.equal(p.target, null);
    assert.match(p.status, re);
    assert.equal(p.bridgeChain.length, 0);
    assert.equal(p.swap, null);
  }
});

test("licence adapter: only the 35 known symbols pass — no Dossier string reaches the page", () => {
  const ctx = dossierCtx();
  for (const sym of ["<img src=x onerror=alert(1)>", "__proto__", "XYZ", ""]) {
    const p = plan(ctx, { kind: "ok", body: F.benefitBody(Date.now(), { sym }) });
    assert.equal(p.target, null, sym);
  }
  const bad = plan(ctx, { kind: "ok", body: F.benefitBody(Date.now(), { sym: "TCT", tier: "1<b>" }) });
  assert.equal(bad.target, null);
});

test("licence adapter: Dossier's bridge chain, fastest path and swap are mapped, not recomputed", () => {
  const ctx = dossierCtx();
  const body = F.benefitBody(Date.now(), { sym: "TCT", tier: 1 });
  body.payload.ranking.push({ sym: "FHG", tier: 1, shares_needed: 2000000, cost: 9.6e8 });
  body.payload.bridge = { goal: { sym: "WSU", tier: 1, cost: 5e8, shares_needed: 1000000 }, reason: null, horizon_days: 90,
    baseline_days: 80, days_with_bridges: 60,
    chain: [{ sym: "FHG", tier: 1, cost: 9.6e8, roi: 12, extra_weekly: 7e6, status: "now", days_until: 0, days: 60, days_saved: 20 }] };
  body.payload.fastest_path = { goal: { sym: "WSU", tier: 2, cost: 1e9, roi: 9, monthly_inc: 4e7 }, baseline_days: null,
    steps: [{ sym: "FHG", tier: 1, cost: 9.6e8, days: 300, days_saved: null }] };
  body.payload.swap = { best: { buy: { sym: "FHG", tier: 1, shares: 2000000, cost: 9.6e8, roi: 12 },
    sells: [{ sym: "TCT", tier: 1, shares: 100000, sale_value: 3e7, weekly_lost: 1e5, roi: 3 }], net_weekly: 5e6, leftover_cash: 1e6 } };
  const p = plan(ctx, { kind: "ok", body }, {}, [{ stock: "FHG", price: "480" }]);
  assert.equal(p.bridgeGoal.sym, "WSU");
  assert.equal(p.bridgeChain.length, 1);
  assert.equal(p.bridgeChain[0].sym, "FHG");
  assert.equal(p.bridgeChain[0].status, "now");
  assert.equal(p.bridgeChain[0].daysSaved, 20);
  assert.equal(p.bridgeChain[0].tierInfo.sharesNeeded, 2000000);
  assert.equal(p.bridgeBaselineDays, 80);
  assert.equal(p.bridgeDaysWith, 60);
  assert.equal(p.fastest.goal.sym, "WSU");
  assert.equal(p.fastest.baselineDays, Infinity);
  assert.equal(p.fastest.steps[0].daysSaved, Infinity);
  assert.equal(p.swap.buy.sym, "FHG");
  assert.equal(p.swap.sells[0].saleValue, 3e7);
  assert.equal(p.swap.netWeekly, 5e6);
  assert.equal(p.swap.sells[0].shares, 100000);
  // a sell share count that is not one tier's parcel never reaches a trade
  body.payload.swap.best.sells[0].shares = 150000;
  assert.equal(plan(ctx, { kind: "ok", body }, {}, [{ stock: "FHG", price: "480" }]).swap, null);
});

// ---------------------------------------------------------------- the network guard

test("guard: while licensed, gmXhr and fetchJSON refuse api.torn.com and tornsy.com; Dossier still goes out", async () => {
  const sent = [];
  const ctx = vm.createContext({ setTimeout: (f) => f(), Promise, Error,
    GM_xmlhttpRequest: (o) => sent.push(o.url), licensed: true });
  vm.runInContext(fn("gmXhr") + "\n" + fn("fetchJSON") + "\n" + fn("tsaSelfFetchBlocked") +
    "\nfunction licenceModeOn() { return licensed; }", ctx);
  const errs = [];
  for (const url of ["https://api.torn.com/user/?selections=stocks&key=x", "https://tornsy.com/api/stocks?interval=m30",
    "https://www.tornsy.com/api/FHG", "HTTPS://API.TORN.COM/torn/"]) {
    vm.runInContext("gmXhr", ctx)({ method: "GET", url, onerror: (e) => errs.push(e.error) });
    await assert.rejects(vm.runInContext("fetchJSON", ctx)(url), /Dossier only/);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(errs, ["licence_mode", "licence_mode", "licence_mode", "licence_mode"]);
  vm.runInContext("gmXhr", ctx)({ method: "GET", url: "https://dossier-api.aec3.org/api/tsa/me" });
  vm.runInContext("gmXhr", ctx)({ method: "GET", url: "https://api.torn.com.evil.example/" });
  assert.deepEqual(sent, ["https://dossier-api.aec3.org/api/tsa/me", "https://api.torn.com.evil.example/"]);
  ctx.licensed = false;   // licence lapsed: free mode fetches again
  vm.runInContext("gmXhr", ctx)({ method: "GET", url: "https://api.torn.com/user/" });
  assert.equal(sent[sent.length - 1], "https://api.torn.com/user/");
});

// ---------------------------------------------------------------- whole script

async function run(store, routes) {
  const b = boot(SRC, { store, routes });
  assert.equal(b.error, null, String(b.error && b.error.stack));
  await settle(80);
  for (const ms of [3000, 10000, 100000, 600000]) { b.runTimers(ms); await settle(60); }  // warm-up, timeouts, retries
  return b;
}
function assertKeysKept(before, b) {
  for (const k of Object.keys(before)) {
    if (k === "tsa_notified_signals" || k === "qt_intent_TCT") continue;          // 2.50's own housekeeping
    assert.ok(Object.prototype.hasOwnProperty.call(b.store, k), k + " was removed");
  }
  assert.equal(b.store["tsa-torn-apikey"], before["tsa-torn-apikey"]);
  if (before.tsa_license) assert.equal(JSON.parse(b.store.tsa_license).token, F.TOKEN);
  for (const k of ["tsa_roi_skipped", "tsa_roi_tier_cap", "qt_amounts", "tsa_realized_events_backup", "tsa_pinned"]) {
    if (k in before) assert.equal(b.store[k], before[k], k + " changed");
  }
}

test("licensed, Dossier fine: the recommendation is Dossier's answer — two answers, two recommendations", async () => {
  for (const [sym, tier] of [["TCT", 1], ["FHG", 1]]) {
    const NOW = Date.now(), before = F.storeBoth(NOW);
    const routes = F.dossierRoutes(NOW).map(([u, a]) => u.endsWith("/api/tsa/benefit")
      ? [u, F.J(F.benefitBody(NOW, { sym, tier, extra: { shares_needed: sym === "FHG" ? 2000000 * (2 ** tier - 1) - 11 : 100000 } }))] : [u, a])
      .concat(F.directRoutes(NOW));
    const b = await run(before, routes);
    assert.equal(count(b, "api.torn.com"), 0);
    assert.equal(count(b, "tornsy.com"), 0);
    assert.ok(b.calls.some((c) => c.url === F.D + "/api/tsa/benefit"), "no /api/tsa/benefit call");
    const rec = b.reg["qt-rec"];
    assert.ok(rec, "rec widget missing");
    assert.match(rec.innerHTML, new RegExp("💡 " + sym + " T" + tier + " "), rec.innerHTML);
    assertKeysKept(before, b);
  }
});

for (const [name, ans] of [["503", F.J({ error: "down" }, 503)], ["a network error", "error"],
  ["429", { status: 429, body: { error: "slow down" }, headers: "retry-after: 60\r\ncontent-type: application/json\r\n" }],
  ["403 torn key required", F.J({ error: "torn key required" }, 403)], ["401 (licence check still active)", F.J({ error: "unauthorized" }, 401)]]) {
  test("licensed + Torn key stored, Dossier answering " + name + ": zero requests to api.torn.com / tornsy.com, keys kept", async () => {
    const NOW = Date.now(), before = F.storeBoth(NOW);
    const b = await run(before, [[F.D + "/api/license/check", F.dossierRoutes(NOW)[0][1]], [F.D + "/api/tsa/", ans]].concat(F.directRoutes(NOW)));
    assert.equal(count(b, "api.torn.com"), 0, b.hosts().join(","));
    assert.equal(count(b, "tornsy.com"), 0, b.hosts().join(","));
    assert.match(text(b), /Dossier/);
    const rec = b.reg["qt-rec"];
    assert.ok(!rec || rec.style.display === "none" || !/💡/.test(rec.innerHTML), "a recommendation without Dossier's answer");
    assertKeysKept(before, b);
  });
}

test("licensed, /api/tsa/benefit alone failing: holdings from Dossier, no recommendation, no local pick", async () => {
  const NOW = Date.now(), before = F.storeBoth(NOW);
  const routes = F.dossierRoutes(NOW).map(([u, a]) => u.endsWith("/api/tsa/benefit") ? [u, F.J({ error: "down" }, 503)] : [u, a])
    .concat(F.directRoutes(NOW));
  const b = await run(before, routes);
  assert.equal(count(b, "api.torn.com"), 0);
  assert.equal(count(b, "tornsy.com"), 0);
  assert.match(text(b), /You own 1/);
  const rec = b.reg["qt-rec"];
  assert.ok(rec && rec.style.display === "none", "rec widget shows a block Dossier did not name");
  assertKeysKept(before, b);
});

test("licence lapses (Dossier 401, licence check 401): TSA is back on the own key, says so, and fetches for itself", async () => {
  const NOW = Date.now(), before = F.storeBoth(NOW);
  const b = await run(before, [[F.D + "/api/license/check", F.J({}, 401)], [F.D + "/api/tsa/", F.J({ error: "unauthorized" }, 401)]]
    .concat(F.directRoutes(NOW)));
  assert.ok(count(b, "api.torn.com") >= 2, b.hosts().join(","));
  assert.ok(count(b, "tornsy.com") >= 4, b.hosts().join(","));
  assert.match(text(b), /back on your own Torn API key/);
  assertKeysKept(before, b);
});

test("licence expired before the load (check says active:false): free mode on the own key, with the status line", async () => {
  const NOW = Date.now(), before = F.storeBoth(NOW);
  before.tsa_license = F.activeLicence(NOW, { checked_ms: NOW - 13 * 3600 * 1000 });   // cache over: a check is due
  const b = await run(before, [[F.D + "/api/license/check", F.J({ active: false, renew: "renew on Dossier" })]].concat(F.directRoutes(NOW)));
  assert.equal(b.calls.filter((c) => c.url.includes("/api/tsa/")).length, 0);
  assert.ok(count(b, "api.torn.com") >= 2, b.hosts().join(","));
  assert.match(text(b), /back on your own Torn API key/);
  assertKeysKept(before, b);
});

test("free mode (no licence): the recommendation follows the local rule and makes no Dossier call", async () => {
  const NOW = Date.now(), before = F.store250(NOW);
  const b = await run(before, F.directRoutes(NOW));
  assert.equal(count(b, "dossier-api.aec3.org"), 0);
  assert.ok(count(b, "api.torn.com") >= 2);
  // No benefit block pays yet (weekly income 0), so no wait is finite: the rule's
  // "save" step names the highest-income goal, FHG T6, as Dossier's would.
  assert.match(b.reg["qt-rec"].innerHTML, /💡 FHG T6 /);
  assertKeysKept(before, b);
});
