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
  vm.runInContext([fn("lsGet"), fn("lsSet"), fn("getQtBuySource"), fn("getShowTop5"),
    fn("top5SectionVisible"), fn("migrateQtBuySource")].join("\n"), ctx);
  ctx.m = m;
  return ctx;
}

const MARK = "tsa_qt_buy_source_migrated_253";

test("migration resets a stored top5 to buyzone once and sets the marker", () => {
  const ctx = load({ tsa_qt_buy_source: "top5" });
  ctx.migrateQtBuySource();
  assert.equal(ctx.m.tsa_qt_buy_source, "buyzone");
  assert.equal(ctx.m[MARK], "1");
  assert.equal(ctx.getQtBuySource(), "buyzone");
});

test("migration also runs for a user with nothing stored", () => {
  const ctx = load();
  ctx.migrateQtBuySource();
  assert.equal(ctx.m.tsa_qt_buy_source, "buyzone");
  assert.equal(ctx.m[MARK], "1");
});

test("after the migration, a top5 picked again is left alone on later starts", () => {
  const ctx = load({ tsa_qt_buy_source: "top5" });
  ctx.migrateQtBuySource();
  ctx.m.tsa_qt_buy_source = "top5"; // user re-picks Top 5 in Settings
  ctx.migrateQtBuySource();
  ctx.migrateQtBuySource();
  assert.equal(ctx.getQtBuySource(), "top5");
});

test("migration is skipped when the marker is already set", () => {
  const ctx = load({ tsa_qt_buy_source: "top5", [MARK]: "1" });
  ctx.migrateQtBuySource();
  assert.equal(ctx.getQtBuySource(), "top5");
});

test("migration is called once, at top level of the start sequence", () => {
  const CODE_ = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const calls = CODE_.match(/[^\w.]migrateQtBuySource\(\)/g) || [];
  const defs = CODE_.match(/function migrateQtBuySource\(\)/g) || [];
  assert.equal(defs.length, 1);
  assert.equal(calls.length - defs.length, 1);
  assert.match(CODE_, /\n  migrateQtBuySource\(\);\n/);
  // it runs before the first render can read the pill source
  assert.ok(CODE_.indexOf("\n  migrateQtBuySource();\n") < CODE_.indexOf("function renderFromData("));
});

test("Top 5 section: hidden by default, shown by the toggle", () => {
  assert.equal(load().top5SectionVisible(), false);
  assert.equal(load({ tsa_show_top5: "true" }).top5SectionVisible(), true);
});

test("Top 5 section is drawn whenever the pill source is top5, toggle or not", () => {
  assert.equal(load({ tsa_qt_buy_source: "top5" }).top5SectionVisible(), true);
  assert.equal(load({ tsa_qt_buy_source: "top5", tsa_show_top5: "false" }).top5SectionVisible(), true);
  assert.equal(load({ tsa_qt_buy_source: "buyzone", tsa_show_top5: "false" }).top5SectionVisible(), false);
});

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

// Source with whole-line // comments removed, so prose mentions never count as code.
const CODE = SRC.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("the Top 5 panel and its empty state are both behind top5SectionVisible", () => {
  // One guard, whose else-branches are the panel and then the empty state. Only
  // comment lines may sit between the guard and the panel branch.
  assert.equal((CODE.match(/if \(!top5SectionVisible\(\)\)/g) || []).length, 1, "expected exactly one guard");
  const m = CODE.match(/if \(!top5SectionVisible\(\)\) \{\s*\} else if \(top5Buy\.length > 0\) \{/);
  assert.ok(m, "Top 5 panel is not the else-branch of the guard");
  const empty = CODE.indexOf(">Buy signals\" + top5HiddenHtml(", m.index);
  assert.ok(empty > m.index, "Buy signals empty state missing after the panel");
  assert.equal((CODE.match(/>Buy signals" \+ top5HiddenHtml\(/g) || []).length, 1);
  assert.equal((CODE.match(/"Top " \+ top5Buy\.length \+ " buy"/g) || []).length, 1);
});

test("dipScan is still called from exactly one place", () => {
  const calls = CODE.match(/[^\w.]dipScan\(/g) || [];
  const defs = CODE.match(/function dipScan\(/g) || [];
  assert.equal(defs.length, 1);
  assert.equal(calls.length - defs.length, 1);
});
