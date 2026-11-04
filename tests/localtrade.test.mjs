// Local trade reconciliation uses page data only. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { boot } from "./fixtures/browser.mjs";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function fn(name) {
  const start = SRC.search(new RegExp("\\n  (?:async )?function " + name + "\\("));
  assert.ok(start >= 0, name);
  const end = SRC.indexOf("\n  }\n", start);
  return SRC.slice(start + 1, end + 4);
}

function setup({ mobile = true, shares = 100, avg = 10, listPresent = true } = {}) {
  const frames = [], observers = [], renders = [], calls = [];
  const count = { value: shares, length: 1, text() { return String(this.value); } };
  const row = {
    find: () => mobile ? count : { length: 0 },
    children: () => [null, null, null, null, count],
    attr: () => "1",
  };
  const price = { value: 20, text() { return String(this.value); } };
  const domRows = { FHG: row };
  let present = listPresent;
  const document = { body: {}, querySelector: () => present ? Object.values(domRows)[0] : null };
  const ctx = vm.createContext({
    Date, console, document,
    $: (el, parent) => {
      if (el === "ul[class^='stock_']") return { each(cb) {
        if (present) Object.entries(domRows).forEach(([sym, r]) => { r.sym = sym; cb.call(r); });
      } };
      if (el === "img") return { attr: () => "logos/" + parent.sym + ".svg" };
      if (el === "div[class^='price_']") return price;
      return el;
    },
    _uiCreated: false, createUI() {}, initialLoad() {}, histStart() {},
    STOCK_ID_MAP: { 1: "FHG", 2: "WSU" }, BENEFIT_REQ: { FHG: 100, WSU: 100 }, PASSIVE_STOCKS: ["WSU"],
    roiSymSkipped: () => false, roiSymTierCap: () => Infinity,
    lastOwnedMap: {}, lastRaw: [{ stock: "FHG", price: "10", interval: {} }], lastMissingBatches: 0,
    qt_stockRows: { FHG: row }, qt_stocks: { FHG: price }, qt_localShareCache: {},
    qtOwnedObserver: null, qtOwnedCounts: {}, qtOwnedFrame: null, qt_stockId: {},
    requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; }
    },
    renderFromData: (...args) => renders.push(args), qtRenderConsequence() {},
    fetch: (...args) => { calls.push(args); throw Error("unexpected fetch"); },
    GM_xmlhttpRequest: (...args) => { calls.push(args); throw Error("unexpected XHR"); },
  });
  vm.runInContext([
    "buildOwnedMap", "enrichOwnedMap", "qtGetBenefitTier", "qtGetPrice", "qtReadOwnedFromDom",
    "qtGetOwnedShares", "qtUpdateLocalCache", "applyLocalTrade", "qtRenderLocalTrade", "qtObserveOwnedList", "qtBuildMaps", "createUIOnce",
  ].map(fn).join("\n"), ctx);
  ctx.lastOwnedMap = ctx.buildOwnedMap({ stocks: { 1: {
    dividend: { increment: 1, progress: 2, frequency: 7 },
    transactions: { a: { shares, bought_price: avg, time_bought: 123 } },
  } } });
  ctx.enrichOwnedMap(ctx.lastOwnedMap, null);
  return { ctx, count, price, row, observers, frames, renders, calls, domRows,
    showList() { present = true; },
    trade(delta) { ctx.qtUpdateLocalCache("FHG", delta); ctx.applyLocalTrade("FHG"); },
    flush() { frames.splice(0).forEach((cb) => cb()); },
  };
}

test("rapid cached buys blend cost, sell preserves average, and zero removes the position", () => {
  const s = setup();
  s.trade(100);
  assert.equal(s.ctx.lastOwnedMap.FHG.avg_price, 15);
  s.price.value = 30;
  s.trade(100);
  const o = s.ctx.lastOwnedMap.FHG;
  assert.equal(o.avg_price, 20);
  assert.equal(o.shares, 300);
  assert.equal(o.benefit_shares, 300);
  assert.equal(o.swing_shares, 0);
  assert.equal(o.transactions.reduce((n, t) => n + t.shares, 0), 300);
  s.trade(-50);
  assert.equal(o.avg_price, 20);
  assert.equal(o.benefit_shares, 100);
  assert.equal(o.swing_shares, 150);
  assert.equal(o.transactions[0].shares, 50);
  assert.equal(o.dividend_progress, 2);
  assert.equal(s.ctx.lastRaw[0].price, "30");
  s.trade(-250);
  assert.equal(s.ctx.lastOwnedMap.FHG, undefined);
  assert.equal(s.renders.length, 4);
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.renders[0].slice(3), [true, true]);
});

test("first buy uses trade price, unlocks benefits, and buying below a block stays swing", () => {
  const s = setup({ shares: 0 });
  delete s.ctx.lastOwnedMap.FHG;
  s.trade(50);
  const o = s.ctx.lastOwnedMap.FHG;
  assert.equal(o.avg_price, 20);
  assert.equal(o.benefit_shares, 0);
  assert.equal(o.swing_shares, 50);
  assert.equal(o.is_passive_perk, false);
  s.trade(75);
  assert.equal(o.dividend_increment, 0);
  assert.equal(o.has_dividend, false);
  assert.equal(o.benefit_shares, 0);
  assert.equal(o.swing_shares, 125);
  s.trade(-50);
  assert.equal(o.benefit_shares, 0);
  assert.equal(o.swing_shares, 75);
});

test("local estimates retain shared passive, skip, and tier-cap rules", () => {
  const s = setup();
  s.ctx.qt_stockRows.WSU = s.row;
  s.ctx.qt_stocks.WSU = s.price;
  s.ctx.applyLocalTrade("WSU");
  assert.equal(s.ctx.lastOwnedMap.WSU.is_passive_perk, true);
  assert.equal(s.ctx.lastOwnedMap.WSU.benefit_shares, 100);
  s.count.value = 700;
  s.ctx.applyLocalTrade("WSU");
  assert.equal(s.ctx.lastOwnedMap.WSU.benefit_shares, 100);
  assert.equal(s.ctx.lastOwnedMap.WSU.swing_shares, 600);
  s.ctx.roiSymTierCap = () => 1;
  s.ctx.applyLocalTrade("FHG");
  assert.equal(s.ctx.lastOwnedMap.FHG.benefit_shares, 100);
  s.ctx.roiSymSkipped = () => true;
  s.trade(1);
  assert.equal(s.ctx.lastOwnedMap.FHG.benefit_shares, 0);
  assert.equal(s.ctx.lastOwnedMap.FHG.swing_shares, 701);
});

for (const mobile of [true, false]) {
  test(`native ${mobile ? "mobile" : "desktop"} count mutations coalesce and ignore null/unchanged/Quick Trade echoes`, () => {
    const s = setup({ mobile });
    // Startup is the only entry point: no hover, click, or prior map build.
    s.ctx.qt_stockRows = {};
    s.ctx.createUIOnce();
    s.ctx.createUIOnce();
    assert.equal(s.observers.length, 1);
    const observer = s.observers[0];
    observer.cb();
    s.flush();
    assert.equal(s.renders.length, 0);
    delete s.domRows.FHG;
    observer.cb();
    s.flush();
    assert.equal(s.renders.length, 0);
    s.domRows.FHG = s.row;
    s.count.value = 150;
    observer.cb();
    s.count.value = 200;
    observer.cb();
    assert.equal(s.frames.length, 1);
    s.flush();
    assert.equal(s.renders.length, 1);
    assert.equal(s.ctx.lastOwnedMap.FHG.avg_price, 15);
    s.count.value = 125;
    observer.cb();
    s.flush();
    assert.equal(s.ctx.lastOwnedMap.FHG.avg_price, 15);
    assert.equal(s.ctx.lastOwnedMap.FHG.swing_shares, 25);
    s.trade(25);
    const rendered = s.renders.length;
    s.count.value = 150;
    observer.cb();
    s.flush();
    assert.equal(s.renders.length, rendered);
    assert.equal(s.ctx.lastOwnedMap.FHG.shares, 150);
    assert.equal(s.ctx.qt_localShareCache.FHG, undefined);
    assert.deepEqual(s.calls, []);
  });
}

test("no loaded map is a no-op; an owned-only prefetch never triggers a load", () => {
  const s = setup();
  s.ctx.lastOwnedMap = null;
  assert.equal(s.ctx.applyLocalTrade("FHG"), false);
  s.ctx.lastOwnedMap = {};
  s.ctx.lastRaw = null;
  s.ctx.applyLocalTrade("FHG");
  assert.equal(s.ctx.lastOwnedMap.FHG.shares, 100);
  assert.equal(s.renders.length, 0);
  assert.deepEqual(s.calls, []);
});

test("one animation frame refreshes several symbols and skips a count that becomes unreadable", () => {
  const s = setup();
  s.domRows.WSU = s.row;
  s.ctx.createUIOnce();
  s.count.value = 200;
  s.observers.forEach((o) => o.cb());
  assert.equal(s.frames.length, 1);
  s.flush();
  assert.equal(s.renders.length, 1);
  assert.equal(s.ctx.lastOwnedMap.FHG.shares, 200);
  assert.equal(s.ctx.lastOwnedMap.WSU.shares, 200);
  assert.equal(s.ctx.lastRaw.find((r) => r.stock === "WSU").price, "20");
  s.count.value = 250;
  s.observers[0].cb();
  delete s.domRows.FHG;
  delete s.domRows.WSU;
  s.flush();
  assert.equal(s.ctx.lastOwnedMap.FHG.shares, 200);
  assert.equal(s.renders.length, 1);
});

test("buys leave higher tiers pending and sells lower credited tiers", () => {
  const s = setup();
  s.trade(200);
  assert.equal(s.ctx.lastOwnedMap.FHG.dividend_increment, 1);
  assert.equal(s.ctx.lastOwnedMap.FHG.has_dividend, true);
  s.ctx.lastOwnedMap.FHG.dividend_increment = 2; // Torn credits the payout.
  s.trade(-50);
  assert.equal(s.ctx.lastOwnedMap.FHG.dividend_increment, 1);
  s.trade(-200);
  assert.equal(s.ctx.lastOwnedMap.FHG.dividend_increment, 0);
  assert.equal(s.ctx.lastOwnedMap.FHG.has_dividend, false);
});

test("React row replacement with the same count never applies a trade", () => {
  const s = setup();
  s.ctx.createUIOnce();
  let applied = 0;
  s.ctx.applyLocalTrade = () => { applied++; return true; };
  const replacement = { ...s.row };
  s.domRows.FHG = replacement;
  s.observers[0].cb();
  s.flush();
  assert.equal(s.ctx.qt_stockRows.FHG, replacement);
  assert.equal(applied, 0);
  assert.equal(s.renders.length, 0);
  assert.equal(s.observers.length, 1);
  assert.equal(s.observers[0].target, s.ctx.document.body);
});

test("startup waits for the list with one observer, then seeds counts", () => {
  const s = setup({ listPresent: false });
  s.ctx.createUIOnce();
  const observer = s.observers[0];
  assert.equal(observer.target, s.ctx.document);
  observer.cb();
  assert.equal(s.frames.length, 0);
  s.showList();
  observer.cb();
  assert.equal(observer.disconnected, true);
  assert.equal(observer.target, s.ctx.document.body);
  assert.equal(s.observers.length, 1);
  assert.equal(s.renders.length, 0);
  s.count.value = 150;
  observer.cb();
  s.flush();
  assert.equal(s.ctx.lastOwnedMap.FHG.shares, 150);
  assert.equal(s.renders.length, 1);
});

test("successful Quick Trade refreshes after the cache update; a failed trade does nothing", async () => {
  const s = setup();
  let success = true;
  Object.assign(s.ctx, {
    qtBuildMaps() {}, qt_stockId: { FHG: 1 }, qtPostTrade: async () => ({ success }),
    lsGet: () => "3", lsSet() {}, showToast() {}, licenceKeyStored: () => false,
  });
  vm.runInContext(fn("qtFireTrade"), s.ctx);
  const pending = { symb: "FHG", shareCount: 50, action: "buyShares", label: "Bought" };
  assert.equal(await s.ctx.qtFireTrade(pending), true);
  assert.equal(s.ctx.lastOwnedMap.FHG.shares, 150);
  assert.equal(s.ctx.lastOwnedMap.FHG.avg_price, (1000 + 1000) / 150);
  success = false;
  assert.equal(await s.ctx.qtFireTrade(pending), false);
  assert.equal(s.ctx.lastOwnedMap.FHG.shares, 150);
  assert.equal(s.renders.length, 1);
  assert.deepEqual(s.calls, []);
});

test("real cached renderer updates holdings, swing pills and ROI view without any network", () => {
  // Expose only test controls inside the IIFE; the production renderer stays intact.
  const exposed = SRC.replace(/\}\)\(\);\s*$/, `
    window.localTradeTest = {
      init: function(planner) {
        lastOwnedMap = buildOwnedMap({stocks: {1: {dividend: {increment: 1},
          transactions: {a: {shares: 1000000, bought_price: 10, time_bought: 123}}}}});
        lastRaw = [{stock: "TSB", price: "20", interval: {}}];
        roiPlannerActive = planner;
        qtReadOwnedFromDom = function() { return 1500000; };
        qtGetPrice = function() { return 20; };
        fetchJSON = fetchAllItemPrices = function() { throw Error("unexpected network path"); };
      },
      apply: function() { applyLocalTrade("TSB"); },
      owned: function() { return lastOwnedMap.TSB; },
      pills: function() { return lastSwingPills; }
    };
  })();`);
  for (const planner of [false, true]) {
    const b = boot(exposed);
    assert.equal(b.error, null);
    b.ctx.fetch = b.ctx.GM_xmlhttpRequest = () => { throw Error("unexpected transport"); };
    const before = b.calls.length;
    b.ctx.localTradeTest.init(planner);
    b.ctx.localTradeTest.apply();
    assert.equal(b.ctx.localTradeTest.owned().shares, 1500000);
    assert.ok(b.ctx.localTradeTest.pills().some((p) => p.sym === "TSB" && p.shares > 0));
    assert.match(b.content(), /TSB/);
    assert.doesNotMatch(b.content(), /Fetching data|Loading\.\.\./);
    assert.equal(b.calls.length, before);
  }
});
