// Tests for the text TSA takes from Dossier before it reaches torn.com as HTML.
// Run: node --test tests/safe.test.mjs
//
// The helpers live between the TSA-SAFE markers in torn_stock_analyzer.js and are
// loaded here unchanged into a fresh vm context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");

function load() {
  const a = SRC.indexOf("// ==TSA-SAFE-BEGIN==");
  const b = SRC.indexOf("// ==TSA-SAFE-END==");
  assert.ok(a >= 0 && b > a, "TSA-SAFE markers missing");
  const ctx = vm.createContext({});
  vm.runInContext(SRC.slice(a, b), ctx);
  return ctx;
}

const XSS = "Feathery Hotel Coupon<img id=xssitem src=x onerror=alert(document.cookie)>";
const PAYLOADS = [
  XSS,
  "<script>alert(1)</script>",
  "\"><svg onload=alert(1)>",
  "' onmouseover='alert(1)",
  "</span><img src=x onerror=1>",
];

// innerHTML can only create an element from a "<". No "<" in the string = no element.
function assertInert(html) {
  assert.equal(html.includes("<"), false, "markup survived: " + html);
  assert.equal(html.includes(">"), false, "markup survived: " + html);
  assert.equal(html.includes("\""), false, "a quote survived: " + html);
  assert.equal(html.includes("'"), false, "a quote survived: " + html);
}

test("escHtml leaves no markup and no quote; the text reads the same once decoded", () => {
  const { escHtml } = load();
  for (const p of PAYLOADS) {
    const e = escHtml(p);
    assertInert(e);
    const decoded = e.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    assert.equal(decoded, p);
  }
  assert.equal(escHtml("Lawyer's Business Card & Co"), "Lawyer&#39;s Business Card &amp; Co");
});

test("the ROI planner's Breakdown entry: an item name with <img onerror> becomes text, not an element", () => {
  const { incomeBreakdownHtml } = load();
  for (const p of PAYLOADS) {
    const html = incomeBreakdownHtml("FHG", p, "$13.50M");
    assertInert(html);
    assert.ok(html.startsWith("FHG ("));
    assert.ok(html.endsWith(") $13.50M"));
  }
  assert.equal(incomeBreakdownHtml("FHG", XSS, "$13.50M"),
    "FHG (Feathery Hotel Coupon&lt;img id=xssitem src=x onerror=alert(document.cookie)&gt;) $13.50M");
  assert.equal(incomeBreakdownHtml("TCT", "", "$1K"), "TCT $1K");
});

test("source: the Breakdown is built only through incomeBreakdownHtml (the e2e sink)", () => {
  assert.match(SRC, /incomeBreakdown\.push\(incomeBreakdownHtml\(sym, itemName, fmRoi\(stockWeekly\)\)\);/);
  assert.equal(/" \(" \+ itemName \+ "\)"/.test(SRC), false, "a raw item-name concatenation is back");
  // getItemName is the one reader of item names, and its one caller feeds the helper above
  assert.equal((SRC.match(/getItemName\(/g) || []).length, 2);
});

test("safeItemName keeps Torn-style names and refuses markup, control characters and huge strings", () => {
  const { safeItemName } = load();
  for (const ok of ["Xanax", "Feathery Hotel Coupon", "Lawyer's Business Card", "Box of Grenades",
                    "Can of Munster", "Six-Pack of Alcohol", "S&W M29", "Pair of Glasses (Reading)", "Dahlia: Red"]) {
    assert.equal(safeItemName(ok), ok);
  }
  for (const bad of [...PAYLOADS.slice(0, 3), "a`b", "a\\b", "line\nbreak", "nul\u0000", "x".repeat(81), "", null, 5, {}]) {
    assert.equal(safeItemName(bad), null, JSON.stringify(bad));
  }
});

test("source: applyReference keys the item maps by safeItemName only", () => {
  assert.match(SRC, /var name = it \? safeItemName\(it\.name\) : null;\s*if \(!name \|\| !\(n > 0\)\) return;\s*byName\[name\] = n;/);
});

test("safeStockCatalogue drops every entry whose acronym is not 2-5 capitals", () => {
  const { safeStockCatalogue } = load();
  const out = safeStockCatalogue({
    1: { acronym: "TSB", benefit: {} },
    2: { acronym: "<img src=x onerror=1>" },
    3: { acronym: "tcI" },
    4: { acronym: "TOOLONG" },
    5: null,
    6: { acronym: 7 },
    35: { acronym: "PTS" },
  });
  assert.deepEqual(Object.keys(out).sort(), ["1", "35"]);
  assert.equal(safeStockCatalogue({ 2: { acronym: "<b>" } }), null);
  assert.equal(safeStockCatalogue(null), null);
  assert.match(SRC, /var stocks = safeStockCatalogue\(body && body\.stocks\);/);
  assert.match(SRC, /safeStockCatalogue\(JSON\.parse\(lsGet\("tsa_stock_catalogue", "null"\)\)\)/);
});

test("safeMarketBody keeps only rows of a known symbol; the input is not modified", () => {
  const { safeMarketBody } = load();
  const known = { FHG: 15, TCT: 9 };
  const body = { missing_batches: 1, meta: { x: 1 }, data: [
    { stock: "FHG", price: "1" }, { stock: "<img src=x onerror=1>", price: "2" },
    { stock: "toString", price: "3" }, { stock: 9 }, null, { stock: "TCT", price: "4" }] };
  const out = safeMarketBody(body, known);
  assert.deepEqual([...out.data].map((r) => r.stock), ["FHG", "TCT"]);
  assert.equal(out.missing_batches, 1);
  assert.equal(body.data.length, 6);
  assert.equal(safeMarketBody(null, known), null);
  assert.match(SRC, /if \(p\.market\) p\.market = safeMarketBody\(p\.market, STOCK_SYM_MAP\);/);
});
