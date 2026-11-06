import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");
const start = SRC.indexOf("  function qtChartPoints(");
const end = SRC.indexOf("  function qtDrawChart(", start);
assert.ok(start >= 0 && end > start, "chart point helper missing");
const ctx = {};
vm.runInNewContext(SRC.slice(start, end) + "\nthis.qtChartPoints = qtChartPoints;", ctx);
const qtChartPoints = ctx.qtChartPoints;
const NOW = 1793973600000;

test("licence mode uses Dossier seconds, newer local points, then live as last point", () => {
  const result = qtChartPoints("TCT", "dossier", { TCT: { closes: [10, 11], stamps: [1793970000, 1793973600] } },
    { TCT: [{ ts: NOW - 120000, price: 8 }, { ts: NOW + 60000, price: 12 }] }, 13, NOW + 120000);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    points: [{ ts: 1793970000000, price: 10 }, { ts: NOW, price: 11 }, { ts: NOW + 60000, price: 12 }, { ts: NOW + 120000, price: 13 }],
    dossierUsed: true,
  });
});

test("free mode ignores h1Store", () => {
  const history = { TCT: [{ ts: 1000, price: 5 }, { ts: 2000, price: 6 }] };
  const expected = qtChartPoints("TCT", "free", {}, history, 0, NOW);
  const actual = qtChartPoints("TCT", "free", { TCT: { closes: [90, 91], stamps: [1, 2] } }, history, 0, NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  assert.equal(actual.dossierUsed, false);
});

test("fewer than two valid Dossier points falls back to local", () => {
  const result = qtChartPoints("TCT", "dossier", { TCT: { closes: [10, 0], stamps: [100, 200] } },
    { TCT: [{ ts: 1000, price: 4 }, { ts: 2000, price: 5 }] }, 0, NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { points: [{ ts: 1000, price: 4 }, { ts: 2000, price: 5 }], dossierUsed: false });
});

test("duplicate timestamps keep the later entry", () => {
  const result = qtChartPoints("TCT", "dossier", { TCT: { closes: [10, 11], stamps: [100, 100] } }, {}, 0, NOW);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { points: [{ ts: 100000, price: 11 }], dossierUsed: true });
});
