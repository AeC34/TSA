import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");
const start = SRC.indexOf("  function qtScrollState(");
const end = SRC.indexOf("  function qtGetScrollMode(", start);
assert.ok(start >= 0 && end > start, "scroll state helper missing");
const ctx = {};
vm.runInNewContext(SRC.slice(start, end) + "\nthis.qtScrollState = qtScrollState;", ctx);
const qtScrollState = ctx.qtScrollState;

test("missing mode defaults to thin and collapses after 40px", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(qtScrollState(undefined, 0, false, false))), { sticky: true, thin: false, chartMin: false });
  assert.deepEqual(JSON.parse(JSON.stringify(qtScrollState(undefined, 41, false, false))), { sticky: true, thin: true, chartMin: true });
});
test("thin override holds full bar open while chart stays minimized", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(qtScrollState("thin", 100, true, false))), { sticky: true, thin: false, chartMin: false });
});
test("scroll mode never sticks or thins but still minimizes chart", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(qtScrollState("scroll", 100, false, false))), { sticky: false, thin: false, chartMin: true });
});
test("manual minimize wins over automatic thin collapse", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(qtScrollState("thin", 100, false, true))), { sticky: true, thin: false, chartMin: true });
});
