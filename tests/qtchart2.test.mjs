import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");
const start = SRC.indexOf("  function niceTicks(");
const end = SRC.indexOf("  function applyQtTheme(", start);
const names = ["niceTicks", "qtReferencePrices", "qtChartDomain", "qtNearestPoint", "qtMarkersInRange", "qtSellMarkersInRange", "qtDossierTradeMarkers", "qtChartTradeMarkers", "qtSegmentPoints", "qtDecollideLabels", "qtTicksAwayFromLabels"];
const ctx = {};
vm.runInNewContext(SRC.slice(start, end) + "\nthis.f={" + names.map(n => n + ":" + n).join(",") + "};", ctx);
const f = ctx.f;

test("nice ticks use clean rounded steps", () => {
  assert.deepEqual(Array.from(f.niceTicks(1.1, 9.6, 4)), [2.5, 5, 7.5]);
});
test("target and stop formulas match the net return sell threshold; zero disables stop", () => {
  const [, target, stop] = f.qtReferencePrices(100, 1, 2, 0.999);
  assert.equal(target.price, 100 * (1 + 1 / 100) / 0.999);
  assert.equal(stop.price, 100 * (1 - 2 / 100) / 0.999);
  assert.deepEqual(Array.from(f.qtReferencePrices(100, 1, 0, 0.999), x => x.key), ["avg", "target"]);
  assert.match(SRC, /var targetPrice = avgForTarget \* \(1 \+ profitPct \/ 100\) \/ SELL_FEE;/);
});
test("far reference is pinned without stretching the data domain", () => {
  const d = f.qtChartDomain([100, 110], [{ key: "target", label: "Target", price: 200 }]);
  assert.equal(d.refs[0].pinned, "top");
  assert.ok(d.max < 200);
});
test("markers are limited to the visible timestamp range", () => {
  const got = f.qtMarkersInRange([{ time_bought: 1, bought_price: 4, shares: 2 }, { time_bought: 4, bought_price: 8 }], 1500, 4500);
  assert.equal(got.length, 1);
  assert.equal(got[0].price, 8);
});
test("reference label collision is nudged apart", () => {
  const got = f.qtDecollideLabels([{ label: "A", y: 20 }, { label: "B", y: 21 }], 0, 100, 15);
  assert.ok(got[1].y - got[0].y >= 15);
});
test("tick labels within 14px of a placed reference chip are skipped", () => {
  const got = f.qtTicksAwayFromLabels([{ value: 100, y: 20 }, { value: 105, y: 34 }, { value: 110, y: 35 }, { value: 115, y: 50 }], [20], 14);
  assert.deepEqual(Array.from(got, x => x.value), [110, 115]);
});
test("nearest point selects the closest timestamp", () => {
  const got = f.qtNearestPoint([{ ts: 10, price: 1 }, { ts: 20, price: 2 }, { ts: 40, price: 3 }], 23);
  assert.equal(got.price, 2);
});

test("sell markers match symbol and visible unix-second range", () => {
  const got = f.qtSellMarkersInRange([
    { ts: 2, sym: "TCT", sell_price: 9, shares: 3 },
    { ts: 4, sym: "TCT", sell_price: 11 },
    { ts: 3, sym: "FHG", sell_price: 7 },
    { ts: 3, sym: "TCT", sell_price: 0 },
  ], "TCT", 2000, 4000);
  assert.equal(got.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [
    { ts: 2000, price: 9, shares: 3 },
    { ts: 4000, price: 11, shares: 0 },
  ]);
});
test("Dossier trade markers map ids, preserve side and net, and filter symbol and visible range", () => {
  const got = f.qtDossierTradeMarkers([
    { ts: 2, side: "buy", stock_id: 1, shares: 3, price: 9, net_profit: null },
    { ts: 4, side: "sell", stock_id: 1, shares: 2, price: 11, net_profit: 5.5 },
    { ts: 3, side: "sell", stock_id: 2, shares: 1, price: 7, net_profit: -1 },
    { ts: 1, side: "buy", stock_id: 1, shares: 1, price: 8, net_profit: null },
  ], "TCT", { 1: "TCT", 2: "FHG" }, 2000, 4000);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [
    { ts: 2000, price: 9, shares: 3, side: "buy", net_profit: null },
    { ts: 4000, price: 11, shares: 2, side: "sell", net_profit: 5.5 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.qtDossierTradeMarkers([], "TCT", { 1: "TCT" }, 0, 10))), []);
  const fallback = f.qtChartTradeMarkers("dossier", [], "TCT", { 1: "TCT" },
    [{ time_bought: 2, bought_price: 8, shares: 1 }], [{ ts: 3, sym: "TCT", sell_price: 9, shares: 2 }], 1000, 4000);
  assert.equal(fallback.buys.length, 1);
  assert.equal(fallback.sells.length, 1);
});
test("point segmentation splits only when adjacent points exceed four hours", () => {
  const got = f.qtSegmentPoints([
    { ts: 0 }, { ts: 14400000 }, { ts: 28800001 }, { ts: 50000000 },
  ], 4 * 3600000);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [[{ ts: 0 }, { ts: 14400000 }], [{ ts: 28800001 }], [{ ts: 50000000 }]]);
});
