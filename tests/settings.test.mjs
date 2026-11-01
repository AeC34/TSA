// Tests for the Quick Buy pill source and the Top 5 visibility settings.
// Run: node --test tests/settings.test.mjs
//
// lsGet, getQtBuySource and getShowTop5 are lifted out of torn_stock_analyzer.js by
// name (same extraction as golden.test.mjs) and run in a vm with an in-memory
// localStorage stub, so the defaults are tested exactly as shipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// CRLF-normalised for the same reason as golden.test.mjs (git archive + autocrlf).
const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

// "  function NAME(" up to its closing "\n  }\n" (top level of the IIFE: 2 spaces).
function fn(name) {
  const a = SRC.indexOf("\n  function " + name + "(");
  assert.ok(a >= 0, "function " + name + " missing");
  const b = SRC.indexOf("\n  }\n", a);
  assert.ok(b > a, "function " + name + " has no closing '  }' line");
  return SRC.slice(a + 1, b + 4);
}

function load(stored = {}) {
  const m = { ...stored };
  const localStorage = {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
  };
  const ctx = vm.createContext({ localStorage });
  vm.runInContext([fn("lsGet"), fn("lsSet"), fn("getQtBuySource"), fn("getShowTop5")].join("\n"), ctx);
  return ctx;
}

test("Quick Buy pill source defaults to buyzone when nothing is stored", () => {
  assert.equal(load().getQtBuySource(), "buyzone");
});

test("an explicitly stored top5 is respected", () => {
  assert.equal(load({ tsa_qt_buy_source: "top5" }).getQtBuySource(), "top5");
});

test("an explicitly stored buyzone stays buyzone", () => {
  assert.equal(load({ tsa_qt_buy_source: "buyzone" }).getQtBuySource(), "buyzone");
});

test("an unknown stored source falls back to buyzone", () => {
  for (const v of ["", "Top5", "TOP5", "zone", "garbage", "null"]) {
    assert.equal(load({ tsa_qt_buy_source: v }).getQtBuySource(), "buyzone", JSON.stringify(v));
  }
});

test("a throwing localStorage still yields the buyzone default", () => {
  const ctx = vm.createContext({ localStorage: { getItem() { throw new Error("blocked"); }, setItem() {} } });
  vm.runInContext([fn("lsGet"), fn("getQtBuySource"), fn("getShowTop5")].join("\n"), ctx);
  assert.equal(ctx.getQtBuySource(), "buyzone");
  assert.equal(ctx.getShowTop5(), false);
});

test("Top 5 section is hidden by default", () => {
  assert.equal(load().getShowTop5(), false);
});

test("Top 5 section shows only for the literal true", () => {
  assert.equal(load({ tsa_show_top5: "true" }).getShowTop5(), true);
  assert.equal(load({ tsa_show_top5: "false" }).getShowTop5(), false);
  assert.equal(load({ tsa_show_top5: "1" }).getShowTop5(), false);
});

test("the Top 5 panel and its empty state are both behind getShowTop5", () => {
  const guard = SRC.indexOf("if (!getShowTop5()) {");
  const panel = SRC.indexOf("} else if (top5Buy.length > 0) {", guard);
  const empty = SRC.indexOf(">Buy signals\" + top5HiddenHtml(", panel);
  assert.ok(guard >= 0, "guard missing");
  assert.ok(panel > guard && panel - guard < 400, "Top 5 panel is not the else-branch of the guard");
  assert.ok(empty > panel, "Buy signals empty state missing after the panel");
});

test("dipScan is still called from exactly one place", () => {
  const calls = SRC.match(/[^\w.]dipScan\(/g) || [];
  const defs = SRC.match(/function dipScan\(/g) || [];
  assert.equal(defs.length, 1);
  assert.equal(calls.length - defs.length, 1);
});
