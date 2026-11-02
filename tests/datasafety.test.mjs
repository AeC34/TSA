// No user loses data across the 2.54 upgrade. Run: node --test tests/datasafety.test.mjs
//
// The whole userscript boots in a fake browser (tests/fixtures/browser.mjs) on three
// realistic stores (tests/fixtures/stores.mjs): (a) a 2.50 user with a Torn key,
// (b) a 2.53.1 user with a licence and Dossier caches but no Torn key, (c) a 2.53.1
// user with both. Then one full load runs, plus the history warm-up's timers.
//
// After that, for every store and data path:
//   - no stored key is gone, except the two removals 2.50 itself makes
//     (tsa_notified_signals, an expired qt_intent_*)
//   - settings and the user's own records are byte-identical
//   - append-only records (price/investor/signal history, dip journal, realized
//     profit) still hold every entry they held before
//   - any other changed key is a cache TSA rebuilds by itself
// and the requests go only where the mode allows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boot, settle } from "./fixtures/browser.mjs";
import * as F from "./fixtures/stores.mjs";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");

const HOUSEKEEPING = ["tsa_notified_signals", "qt_intent_TCT"];   // as in 2.50: orphan key + expired intent
const EXACT = [
  "tsa-torn-apikey", "tsa_dark", "tsa_profit_target", "tsa_stop_loss", "tsa_history_days", "tsa-auto-refresh-interval",
  "tsa_show_qt_bar", "tsa_show_qt_chart", "tsa_show_watch", "tsa_show_realized", "tsa_realized_days", "tsa_pills_always",
  "tsa_profit_swing_only", "tsa_require_positive_investors", "tsa_top5_min_score", "tsa_qt_buy_source", "tsa_show_top5",
  "tsa_qt_buy_source_migrated_253", "tsa_overlay_position", "tsa_btn_custom", "tsa_chart_timeframe", "tsa_benefit_collapsed",
  "tsa_swing_collapsed", "tsa_realized_expanded", "tsa_post_logged_count", "tsa_pinned", "tsa_roi_skipped", "tsa_roi_tier_cap",
  "qt_amounts", "qt_buy_pill_amount", "qt_sell_pill_amount", "qt_last_stock", "qt_minimized", "qt_intent_FHG",
  "tsa_price_alerts", "tsa_realized_events_backup", "tsa_prev_holdings", "tsa_item_names",
];
// value -> list of entries that must all survive
const APPEND_ONLY = {
  tsa_price_history: (v) => Object.entries(v).flatMap(([s, a]) => a.map((e) => s + ":" + JSON.stringify(e))),
  tsa_investor_history: (v) => Object.entries(v).flatMap(([s, a]) => a.map((e) => s + ":" + JSON.stringify(e))),
  tsa_signal_history: (v) => v.map((e) => JSON.stringify(e)),
  tsa_dip_calls: (v) => v.map((e) => e.sym + "@" + e.ts),
  tsa_dip_px: (v) => Object.entries(v).flatMap(([s, e]) => e.s.map((p) => s + ":" + JSON.stringify(p))),
  tsa_realized_events: (v) => v.map((e) => JSON.stringify(e)),
};
// Caches TSA fills and refreshes itself (tornsy summaries, Torn catalogues, Dossier
// answers, rate-limit markers, the licence check's own state).
const CACHES = new Set([
  "tsa_lt_context", "tsa_lt_context_ts", "tsa_h1_closes", "tsa_h1_closes_ts", "tsa_stock_catalogue", "tsa_stock_catalogue_ts",
  "tsa_stock_catalogue_fail_ts", "tsa_tornsy_blocked_until", "tsa_tornsy_throttle_step", "tsa_item_ids_by_name",
  "tsa_item_market_values", "tsa_dossier_me", "tsa_dossier_market", "tsa_trade_log", "tsa_reference_ts", "tsa_hist_fetch_ts",
  "tsa_prev_holdings_src_ms", "tsa_license",
]);

async function run(store, routes, visible = true) {
  const b = boot(SRC, { store, routes, visible });
  assert.equal(b.error, null, String(b.error && b.error.stack));
  await settle(80);
  b.runTimers(3000);   // history warm-up tick
  await settle(80);
  b.runTimers(10000);  // request timeouts, failsafes
  await settle(80);
  return b;
}

function assertNoDataLoss(before, b, label) {
  const after = b.store;
  for (const k of Object.keys(before)) {
    if (HOUSEKEEPING.includes(k)) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(after, k), label + ": " + k + " was removed");
  }
  assert.deepEqual(b.removed.filter((k) => !HOUSEKEEPING.includes(k)), [], label + ": removeItem on a non-housekeeping key");
  for (const k of EXACT) {
    if (k in before) assert.equal(after[k], before[k], label + ": " + k + " changed");
  }
  for (const [k, entries] of Object.entries(APPEND_ONLY)) {
    if (!(k in before)) continue;
    const had = entries(JSON.parse(before[k])), has = new Set(entries(JSON.parse(after[k])));
    for (const e of had) assert.ok(has.has(e), label + ": " + k + " lost " + e);
  }
  for (const k of Object.keys(before)) {
    if (after[k] === before[k] || EXACT.includes(k) || k in APPEND_ONLY || HOUSEKEEPING.includes(k)) continue;
    assert.ok(CACHES.has(k), label + ": " + k + " changed and is not a cache");
  }
  if (before.tsa_license) assert.equal(JSON.parse(after.tsa_license).token, F.TOKEN, label + ": licence key lost");
}

const text = (b) => b.content().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const count = (b, host) => b.hosts().filter((h) => h === host).length;
const LOCK_WORDS = /TSA licence required|Torn API key needed in Dossier|Checking TSA licence/;
const dossierFails = (NOW, ans) => [[F.D + "/api/license/check", F.dossierRoutes(NOW)[0][1]], [F.D + "/api/tsa/", ans]]
  .concat(F.directRoutes(NOW));

// ---------------------------------------------------------------- (a) a 2.50 user

for (const visible of [true, false]) {
  test("(a) 2.50 store, " + (visible ? "visible" : "hidden") + " tab: free mode, Torn + tornsy only, no data lost", async () => {
    const NOW = Date.now(), before = F.store250(NOW);
    const b = await run(before, F.directRoutes(NOW), visible);
    assertNoDataLoss(before, b, "(a)");
    assert.equal(count(b, "dossier-api.aec3.org"), 0);
    assert.ok(b.hosts().every((h) => h === "api.torn.com" || h === "tornsy.com"), b.hosts().join(","));
    assert.ok(count(b, "api.torn.com") >= 1);
    b.calls.filter((c) => c.url.includes("api.torn.com")).forEach((c) => assert.ok(c.url.includes("key=" + F.TORN_KEY)));
    if (visible) {
      assert.ok(count(b, "tornsy.com") >= 4, "no tornsy batch");
      assert.match(text(b), /You own 1/);
    }
    assert.doesNotMatch(b.page(), LOCK_WORDS);
  });
}

// ---------------------------------------------------------------- (b) licence, no Torn key

test("(b) 2.53.1 store, no Torn key, licence no longer active: not locked, the API-key prompt, no data lost", async () => {
  const NOW = Date.now(), before = F.store2531(NOW);
  before.tsa_license = F.activeLicence(NOW, { status: "inactive", ok_ms: null });
  const b = await run(before, F.directRoutes(NOW));
  b.click("tsa-btn");
  await settle(40);
  assertNoDataLoss(before, b, "(b) inactive");
  assert.equal(count(b, "api.torn.com"), 0);
  assert.equal(b.calls.filter((c) => c.url.includes("/api/tsa/")).length, 0);
  assert.match(b.content(), /API Key Required/);
  assert.match(b.content(), /id="tsa-key-input"/);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

test("(b) 2.53.1 store, no Torn key, Dossier rejects the licence (401): the API-key prompt with the reason, no data lost", async () => {
  const NOW = Date.now(), before = F.store2531(NOW);
  const b = await run(before, [[F.D + "/api/license/check", F.J({}, 401)], [F.D + "/api/tsa/", F.J({ error: "unauthorized" }, 401)]]
    .concat(F.directRoutes(NOW)));
  assertNoDataLoss(before, b, "(b) 401");
  assert.equal(count(b, "api.torn.com"), 0);
  assert.match(b.content(), /API Key Required/);
  assert.match(b.content(), /Dossier did not accept the TSA licence/);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

test("(b) 2.53.1 store, no Torn key, active licence: Dossier data, no Torn/tornsy call, no data lost", async () => {
  const NOW = Date.now(), before = F.store2531(NOW);
  const b = await run(before, F.dossierRoutes(NOW).concat(F.directRoutes(NOW)));
  assertNoDataLoss(before, b, "(b) active");
  assert.deepEqual([...new Set(b.hosts())], ["dossier-api.aec3.org"]);
  assert.match(text(b), /You own 1/);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

// ---------------------------------------------------------------- (c) licence + Torn key

for (const visible of [true, false]) {
  test("(c) 2.53.1 store with both, valid licence, " + (visible ? "visible" : "hidden") + " tab: Dossier only, 0 Torn/tornsy calls", async () => {
    const NOW = Date.now(), before = F.storeBoth(NOW);
    const b = await run(before, F.dossierRoutes(NOW).concat(F.directRoutes(NOW)), visible);
    assertNoDataLoss(before, b, "(c)");
    assert.equal(count(b, "api.torn.com"), 0, b.hosts().join(","));
    assert.equal(count(b, "tornsy.com"), 0, b.hosts().join(","));
    assert.ok(count(b, "dossier-api.aec3.org") >= 1);
    b.calls.forEach((c) => {
      assert.equal(c.headers.Authorization, "Bearer " + F.TOKEN);
      assert.equal(c.url.includes(F.TORN_KEY), false);
    });
  });
}

for (const [name, ans] of [["503", F.J({ error: "down" }, 503)], ["403 licence inactive", F.J({ error: "licence inactive" }, 403)],
  ["403 torn key required", F.J({ error: "torn key required" }, 403)], ["401", F.J({ error: "unauthorized" }, 401)],
  ["a network error", "error"]]) {
  test("(c) Dossier answering " + name + ": falls back to Torn + tornsy for the load, no data lost", async () => {
    const NOW = Date.now(), before = F.storeBoth(NOW);
    const b = await run(before, dossierFails(NOW, ans));
    assertNoDataLoss(before, b, "(c) " + name);
    assert.ok(count(b, "api.torn.com") >= 2, b.hosts().join(","));
    assert.ok(count(b, "tornsy.com") >= 4, b.hosts().join(","));
    assert.match(b.content(), /this load used your own Torn API key/);
    assert.match(text(b), /You own 1/);
    assert.doesNotMatch(b.page(), LOCK_WORDS);
  });
}

// ---------------------------------------------------------------- review fixes (2.54.0)

test("licence mode, no Torn key, Dossier down with nothing usable stored: the error names the free-mode way out", async () => {
  const NOW = Date.now(), before = F.store2531(NOW);   // its stored market is 1 h old: too old to score
  const b = await run(before, [[F.D + "/api/license/check", F.dossierRoutes(NOW)[0][1]], [F.D + "/api/tsa/", F.J({ error: "down" }, 503)]]);
  assertNoDataLoss(before, b, "dossier down, no key");
  assert.match(text(b), /Dossier unreachable/);
  assert.match(text(b), /Or use TSA free with your own Torn API key: Settings → Account\./);
  assert.equal(count(b, "api.torn.com"), 0);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

test("source: a Quick Trade is logged for Dossier whenever a licence key is stored, not only on a licence-mode load", () => {
  assert.match(SRC, /if \(licenceKeyStored\(\)\) TSAData\.logTrade\(/);
  assert.doesNotMatch(SRC, /dataMode === "dossier"\) TSAData\.logTrade/);
});
