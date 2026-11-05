import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");

test("Swing sell pill keeps signed profit in its label and prefixes the sub-text with the amount", () => {
  const start = SRC.indexOf("var label = (p.profit === null || p.profit === undefined)");
  const end = SRC.indexOf("var pill = makeQtPill", start);
  assert.ok(start >= 0 && end > start, "Swing pill rendering block exists");
  const block = SRC.slice(start, end);
  assert.match(block, /var label = \(p\.profit === null \|\| p\.profit === undefined\) \? "Sell" : qtFmtSignedDollar\(p\.profit\);/);
  assert.match(block, /if \(atTarget\) label \+= " 🎯";/);
  assert.match(block, /if \(sellPillAmt > 0\) subText = "Sell " \+ fmtQtAmt\(sellPillAmt\) \+ \(subText \? " · " \+ subText : ""\);/);

  const qtFmtSignedDollar = (value) => (value < 0 ? "-" : "+") + "$" + Math.abs(value).toFixed(2) + "M";
  const label = qtFmtSignedDollar(7.15);
  const subText = "Sell " + "5M" + " · " + "$715M" + " · " + "+1.00%";
  assert.equal(label, "+$7.15M");
  assert.ok(subText.startsWith("Sell 5M"));
});
