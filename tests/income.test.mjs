// Tests for the specified income statement (2.61.0). Run: node --test tests/income.test.mjs
//
// collectIncomeLines, buildIncomeStatement and incomeStatementHtml live between the
// TSA-INCOME markers and use escHtml from TSA-SAFE; both blocks are loaded here
// unchanged into a fresh vm context.
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

function load() {
  const ctx = vm.createContext({});
  vm.runInContext(block("TSA-SAFE") + "\n" + block("TSA-INCOME"), ctx);
  return ctx;
}

const fmt = (n) => "$" + Math.round(n);
// Arrays made inside the vm context have another Array prototype; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Six tiers per symbol, the way deriveBenefitTables writes ROI_TABLE.
function rows(sym, payout, freq, item) {
  return [1, 2, 3, 4, 5, 6].map((t) => ({ sym, tier: "T" + t, payout, freq, item }));
}
const ROI = [
  ...rows("FHG", 12_000_000, 7, 367),
  ...rows("CNC", 80_000_000, 31, 0),
  ...rows("TCT", 1_000_000, 31, 0),
  ...rows("PTS", 3_000_000, 7, 0),
];
const DESC = {
  FHG: "1x Feathery Hotel Coupon",
  CNC: "$80,000,000",
  TCT: "$1,000,000",
  PTS: "100 points",
  BAG: "1x Ammunition Pack",
  MCS: "100 energy",
  WSU: "a 10% education time reduction",
};
// Stand-in for the live parse dep (payoutKind/parsePayout/payoutItem).
function parse(desc) {
  let m;
  if ((m = /^\$([\d,]+)$/.exec(desc))) return { kind: "cash", amount: +m[1].replace(/,/g, ""), itemName: "" };
  if ((m = /^(\d+)\s+points?$/i.exec(desc))) return { kind: "points", amount: +m[1] * 30000, itemName: "" };
  if ((m = /^\d+\s*x\s+(.+)$/.exec(desc))) return { kind: "item", amount: 0, itemName: m[1] };
  return { kind: "perk", amount: 0, itemName: "" };
}
const holding = (inc, extra = {}) => ({ has_dividend: true, benefit_shares: 1000, dividend_increment: inc, dividend_frequency: 7, ...extra });
function deps(overrides = {}) {
  return {
    roiRows: ROI,
    perCycle: (e) => e.payout,
    cycleDays: (e) => e.freq,
    liveValue: (e) => (e.item ? 1 : 0),
    descOf: (sym) => DESC[sym] || "",
    parse,
    itemName: (e) => (e.item === 367 ? "Feathery Hotel Coupon" : ""),
    ...overrides,
  };
}

test("one line per OWNED tier, never a tier above the increment", () => {
  const { collectIncomeLines } = load();
  const lines = collectIncomeLines({ FHG: holding(2), CNC: holding(1) }, deps());
  assert.deepEqual(plain(lines.map((l) => l.sym + " " + l.tier)), ["CNC T1", "FHG T1", "FHG T2"]);
  assert.equal(lines.find((l) => l.sym === "FHG").kind, "item");
  assert.equal(lines.find((l) => l.sym === "FHG").detail, "Feathery Hotel Coupon");
  assert.equal(lines.find((l) => l.sym === "CNC").kind, "cash");
  assert.equal(lines.find((l) => l.sym === "CNC").perDay, 80_000_000 / 31);
});

test("holdings calcWeeklyIncome skips are skipped here too", () => {
  const { collectIncomeLines } = load();
  const lines = collectIncomeLines({
    FHG: holding(0),
    CNC: holding(1, { benefit_shares: 0 }),
    TCT: holding(1, { has_dividend: false }),
  }, deps());
  assert.equal(lines.length, 0);
});

test("the statement total is calcWeeklyIncome's sum in the chosen unit", () => {
  const { collectIncomeLines, buildIncomeStatement } = load();
  const owned = { FHG: holding(2), CNC: holding(1), TCT: holding(3) };
  const lines = collectIncomeLines(owned, deps());
  // calcWeeklyIncome: sum over owned tiers of perCycle / cycleDays * 7
  const weekly = 2 * 12_000_000 / 7 * 7 + 80_000_000 / 31 * 7 + 3 * 1_000_000 / 31 * 7;
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + " != " + b);
  close(buildIncomeStatement(lines, "week").total, weekly);
  close(buildIncomeStatement(lines, "day").total, weekly / 7);
  close(buildIncomeStatement(lines, "month").total, weekly / 7 * 365 / 12);
  close(buildIncomeStatement(lines, "year").total, weekly / 7 * 365);
});

test("groups come in statement order, biggest row first, each with its subtotal", () => {
  const { collectIncomeLines, buildIncomeStatement } = load();
  const owned = { FHG: holding(1), CNC: holding(1), TCT: holding(1), PTS: holding(1), MCS: holding(2) };
  const st = buildIncomeStatement(collectIncomeLines(owned, deps()), "week");
  assert.deepEqual(plain(st.groups.map((g) => g.kind)), ["cash", "item", "points", "perk"]);
  const cash = st.groups[0];
  assert.deepEqual(plain(cash.rows.map((r) => r.sym)), ["CNC", "TCT"]);
  assert.equal(cash.subtotal, cash.rows[0].amount + cash.rows[1].amount);
  assert.equal(st.groups[2].rows[0].detail, "100 points");
  assert.equal(st.groups[3].subtotal, null, "perks have no subtotal");
  assert.equal(st.total, st.groups[0].subtotal + st.groups[1].subtotal + st.groups[2].subtotal);
});

test("an empty group is not printed: no points held, no Points block", () => {
  const { collectIncomeLines, buildIncomeStatement } = load();
  const st = buildIncomeStatement(collectIncomeLines({ CNC: holding(1) }, deps()), "month");
  assert.deepEqual(plain(st.groups.map((g) => g.kind)), ["cash"]);
});

test("an item without a price is listed as price unknown, never as $0, and counted", () => {
  const { collectIncomeLines, buildIncomeStatement, incomeStatementHtml } = load();
  // BAG has no ROI rows at all (the planner cannot price it); FHG's price lookup fails.
  const lines = collectIncomeLines({ BAG: holding(2), FHG: holding(1) }, deps({ perCycle: () => 0 }));
  const st = buildIncomeStatement(lines, "month");
  const items = st.groups.find((g) => g.kind === "item");
  assert.equal(items.rows.length, 3);
  assert.ok(items.rows.every((r) => r.amount === null));
  assert.equal(st.unpriced, 3);
  assert.equal(st.total, 0);
  assert.equal(items.rows.find((r) => r.sym === "BAG").detail, "Ammunition Pack");
  const html = incomeStatementHtml(st, fmt);
  assert.equal((html.match(/price unknown/g) || []).length, 3);
  assert.match(html, /\+3 without a price/);
});

test("perks are listed as text, with no amount, and never reach the total", () => {
  const { collectIncomeLines, buildIncomeStatement, incomeStatementHtml } = load();
  const owned = { MCS: holding(1), WSU: holding(1, { is_passive_perk: true }), CNC: holding(1) };
  const st = buildIncomeStatement(collectIncomeLines(owned, deps()), "week");
  const perks = st.groups.find((g) => g.kind === "perk");
  assert.deepEqual(plain(perks.rows.map((r) => [r.sym, r.tier, r.detail, r.amount])),
    [["MCS", "T1", "100 energy", null], ["WSU", "", "a 10% education time reduction", null]]);
  assert.equal(st.total, 80_000_000 / 31 * 7);
  assert.equal(st.unpriced, 0, "a perk is not an unpriced item");
  const html = incomeStatementHtml(st, fmt);
  assert.match(html, /100 energy/);
  assert.doesNotMatch(html, /Subtotal perks/);
});

test("an unknown or missing unit falls back to month", () => {
  const { buildIncomeStatement, incomeUnit } = load();
  assert.equal(incomeUnit("fortnight").key, "month");
  assert.equal(incomeUnit(null).key, "month");
  assert.equal(buildIncomeStatement([], "nope").unit.label, "/mo");
});

test("the unit switch marks exactly the active unit", () => {
  const { buildIncomeStatement, incomeStatementHtml } = load();
  const html = incomeStatementHtml(buildIncomeStatement([], "year"), fmt);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /data-income-unit="year" aria-pressed="true"/);
});

test("text from Torn becomes text: markup in an item name or a perk is escaped", () => {
  const { collectIncomeLines, buildIncomeStatement, incomeStatementHtml } = load();
  const XSS = "Coupon<img id=xssitem src=x onerror=alert(1)>";
  const st = buildIncomeStatement(collectIncomeLines(
    { FHG: holding(1), MCS: holding(1) },
    deps({ itemName: () => XSS, descOf: (s) => (s === "MCS" ? "<script>alert(2)</script>" : DESC[s]) })
  ), "month");
  const html = incomeStatementHtml(st, fmt);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /Coupon&lt;img id=xssitem/);
});

test("source: the panel builds the section from TSA-INCOME and the old Breakdown line is gone", () => {
  assert.match(SRC, /collectIncomeLines\(ownedMap, incomeDeps\(ownedMap\)\)/);
  assert.match(SRC, /incomeStatementHtml\(incomeSt, fmIncome\)/);
  assert.match(SRC, /incomeHeaderHtml\(incomeSt, fmIncome\)/);
  assert.match(SRC, /lsGet\("tsa_income_collapsed", "true"\)/, "collapsed by default");
  assert.equal(/incomeBreakdown/.test(SRC), false);
  // getItemName's callers: its definition and the income deps
  assert.equal((SRC.match(/getItemName\(/g) || []).length, 2);
});

test("an item whose live price has not loaded keeps the planner's baseline, flagged as an old price", () => {
  const { collectIncomeLines, buildIncomeStatement, incomeStatementHtml, incomeHeaderHtml } = load();
  const st = buildIncomeStatement(collectIncomeLines({ FHG: holding(1) }, deps({ liveValue: () => 0 })), "week");
  const row = st.groups[0].rows[0];
  assert.equal(row.amount, 12_000_000);
  assert.equal(row.estimate, true);
  assert.equal(st.estimated, 1);
  assert.equal(st.total, 12_000_000, "same stand-in calcWeeklyIncome counts");
  assert.match(incomeStatementHtml(st, fmt), /≈\$12000000 old price/);
  assert.match(incomeStatementHtml(st, fmt), /1 on an old price/);
  assert.match(incomeHeaderHtml(st, fmt), /≈/);
  const live = buildIncomeStatement(collectIncomeLines({ FHG: holding(1) }, deps()), "week");
  assert.equal(live.estimated, 0);
});

test("the collapsed header never shows a green $0 when nothing has a price", () => {
  const { collectIncomeLines, buildIncomeStatement, incomeHeaderHtml } = load();
  const none = buildIncomeStatement(collectIncomeLines({ BAG: holding(1) }, deps()), "month");
  const h = incomeHeaderHtml(none, fmt);
  assert.match(h, /price unknown/);
  assert.doesNotMatch(h, /\$0/);
  const mixed = buildIncomeStatement(collectIncomeLines({ BAG: holding(1), CNC: holding(1) }, deps()), "month");
  assert.match(incomeHeaderHtml(mixed, fmt), /\+1 unpriced/);
  const perks = buildIncomeStatement(collectIncomeLines({ MCS: holding(1) }, deps()), "month");
  assert.match(incomeHeaderHtml(perks, fmt), /perks only/);
});

test("a held passive perk is listed even when Torn reports no increment (enrichOwnedMap fail-safe)", () => {
  const { collectIncomeLines } = load();
  const lines = collectIncomeLines({ WSU: holding(0, { is_passive_perk: true }) }, deps());
  assert.deepEqual(plain(lines.map((l) => [l.sym, l.kind])), [["WSU", "perk"]]);
});

test("a cash stock with no ROI rows uses the amount Torn states", () => {
  const { collectIncomeLines } = load();
  const lines = collectIncomeLines({ NEW: holding(1, { dividend_frequency: 31 }) },
    deps({ descOf: (s) => (s === "NEW" ? "$31,000,000" : "") }));
  assert.equal(lines[0].kind, "cash");
  assert.equal(lines[0].perDay, 1_000_000);
});

test("benefit_shares follows calcWeeklyIncome's test exactly (<= 0 skips, anything else counts)", () => {
  const { collectIncomeLines } = load();
  assert.equal(collectIncomeLines({ CNC: holding(1, { benefit_shares: 0 }) }, deps()).length, 0);
  assert.equal(collectIncomeLines({ CNC: holding(1, { benefit_shares: undefined }) }, deps()).length, 1);
  assert.match(SRC, /if \(!o\.has_dividend \|\| o\.benefit_shares <= 0\) return;/);
});

test("fmIncome keeps a decimal on thousands so small rows still add up", () => {
  const { fmIncome } = load();
  assert.equal(fmIncome(1500), "$1.5K");
  assert.equal(fmIncome(32258.06), "$32.3K");
  assert.equal(fmIncome(80_000_000), "$80.00M");
  assert.equal(fmIncome(2_500_000_000), "$2.50B");
  assert.equal(fmIncome(12), "$12");
});

test("the statement's month is the planner's month", () => {
  const { incomeUnit } = load();
  assert.match(SRC, /var DAYS_PER_MONTH = 365 \/ 12;/);
  assert.equal(incomeUnit("month").days, 365 / 12);
});
