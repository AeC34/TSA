// Realistic stored state for the data-safety test, and canned answers for every
// host TSA may call. All values are invented; the Torn key is a dummy string.
export const TORN_KEY = "dummyTornKey0000";
export const TOKEN = "tsa1_" + "A".repeat(20) + "b-_9" + "z".repeat(19);
export const D = "https://dossier-api.aec3.org";

const J = (body, status = 200) => ({ status, body });
export { J };

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const r = (ms) => Math.round(ms / MIN) * MIN;

// Everything a 2.50 user can have stored (keys taken from v2.50.0's source).
export function store250(NOW) {
  const nowS = Math.floor(NOW / 1000);
  const ltFhg = { days: 400, first_ts: nowS - 400 * 86400, all_time_high: 900, all_time_low: 300, position_all_time: 33,
    vs_year_ago: -4, month: { high: 520, low: 470, position: 20 }, band_days: 0,
    quarter: { high: 600, low: 450, position: 20 }, year: { high: 800, low: 400, position: 20 }, price: 480 };
  return {
    "tsa-torn-apikey": TORN_KEY,
    // settings
    tsa_dark: "true", tsa_profit_target: "1.5", tsa_stop_loss: "5", tsa_history_days: "30",
    "tsa-auto-refresh-interval": "0", tsa_show_qt_bar: "true", tsa_show_qt_chart: "true", tsa_show_watch: "true",
    tsa_show_realized: "true", tsa_realized_days: "7", tsa_pills_always: "false", tsa_profit_swing_only: "false",
    tsa_require_positive_investors: "false", tsa_top5_min_score: "35", tsa_qt_buy_source: "top5",
    tsa_overlay_position: "bottom-right", tsa_btn_custom: JSON.stringify({ x: 10, y: 20 }), tsa_chart_timeframe: "all",
    tsa_benefit_collapsed: "true", tsa_swing_collapsed: "false", tsa_realized_expanded: "false", tsa_post_logged_count: "2",
    tsa_pinned: JSON.stringify(["FHG"]), tsa_roi_skipped: JSON.stringify(["TCT"]), tsa_roi_tier_cap: JSON.stringify({ WSU: 2 }),
    qt_amounts: JSON.stringify([1000000, 5000000]), qt_buy_pill_amount: "2500000", qt_sell_pill_amount: "0",
    qt_last_stock: "FHG", qt_minimized: "false",
    tsa_price_alerts: JSON.stringify([{ sym: "FHG", price: 1, dir: "below", repeat: false },
                                      { sym: "TCT", price: 99999, dir: "above", repeat: true }]),
    // the user's own records
    tsa_price_history: JSON.stringify({
      FHG: [{ ts: r(NOW - 2 * DAY), price: 470 }, { ts: r(NOW - DAY), price: 475 }, { ts: r(NOW - HOUR), price: 480 }],
      TCT: [{ ts: r(NOW - DAY), price: 300 }] }),
    tsa_investor_history: JSON.stringify({ FHG: [{ ts: NOW - 2 * DAY, investors: 1000 }, { ts: NOW - DAY, investors: 1010 }] }),
    tsa_signal_history: JSON.stringify([{ ts: r(NOW - DAY), sym: "FHG", signal: "BUY", score: 61, price: 475 }]),
    tsa_dip_calls: JSON.stringify([{ sym: "FHG", ts: NOW - 3 * DAY, price: 470, pos: 6.5 }]),
    tsa_dip_px: JSON.stringify({ FHG: { t: NOW - 2 * DAY, s: [[NOW - 3 * DAY, 470], [NOW - 2 * DAY, 472]] } }),
    tsa_realized_events: JSON.stringify([{ ts: nowS - 86400, profit: 5000, sym: "FHG", sell_price: 500 }, { profit: 7 }]),
    tsa_realized_events_backup: JSON.stringify([{ ts: nowS - 86400 * 40, profit: 1, sym: "TCT", sell_price: 1 }]),
    tsa_prev_holdings: JSON.stringify({ FHG: { shares: 10, avg_price: 400 } }),
    // caches 2.50 rebuilds on its own
    tsa_lt_context: JSON.stringify({ FHG: ltFhg }), tsa_lt_context_ts: JSON.stringify({ FHG: NOW - HOUR }),
    tsa_h1_closes: JSON.stringify({ FHG: { closes: [479, 480], stamps: [nowS - 7200, nowS - 3600] } }),
    tsa_h1_closes_ts: JSON.stringify({ FHG: NOW - HOUR }),
    tsa_stock_catalogue: JSON.stringify({ 15: { acronym: "FHG", benefit: { requirement: 2000000, frequency: 7, description: "x" } } }),
    tsa_stock_catalogue_ts: String(NOW - HOUR), tsa_stock_catalogue_fail_ts: "0",
    tsa_tornsy_blocked_until: "0", tsa_tornsy_throttle_step: "0",
    tsa_item_names: JSON.stringify({ 206: "Xanax" }), tsa_item_ids_by_name: JSON.stringify({ Xanax: 206 }),
    tsa_item_market_values: JSON.stringify({ Xanax: 800000 }),
    // housekeeping 2.50 itself removes: orphaned key, expired buy intent (a fresh one stays)
    tsa_notified_signals: "{}",
    qt_intent_TCT: JSON.stringify({ price: 300, ts: nowS - 2 * 86400 }),
    qt_intent_FHG: JSON.stringify({ price: 480, ts: nowS - 600 }),
  };
}

export function activeLicence(NOW, extra = {}) {
  return JSON.stringify({ token: TOKEN, status: "active", checked_ms: NOW - MIN, ok_ms: NOW - MIN,
    expires_ts: Math.floor(NOW / 1000) + 30 * 86400, name: "test", renew: null, retry_ms: null, fail: null, ...extra });
}

// A 2.53.1 user: licence + Dossier caches, the 2.53 settings, and (since 2.52.0
// deleted it on start) no Torn key.
export function store2531(NOW) {
  const s = { ...store250(NOW) };
  delete s["tsa-torn-apikey"];
  delete s.tsa_stock_catalogue_fail_ts; delete s.tsa_tornsy_blocked_until; delete s.tsa_tornsy_throttle_step;
  delete s.tsa_notified_signals;
  Object.assign(s, {
    tsa_license: activeLicence(NOW),
    tsa_qt_buy_source: "buyzone", tsa_qt_buy_source_migrated_253: "1", tsa_show_top5: "false",
    tsa_reference_ts: String(NOW - HOUR), tsa_hist_fetch_ts: String(NOW - HOUR),
    tsa_dossier_me: JSON.stringify({ ms: NOW - HOUR, body: { player_id: 7, holdings_status: "ok", money_onhand: 5,
      stocks: { 15: { stock_id: 15, total_shares: 10, transactions: { 1: { shares: 10, bought_price: 400, time_bought: 1 } } } },
      armory: { ok: false, money_balance: 0 }, meta: { source_ts: Math.floor(NOW / 1000) - 3600 } } }),
    tsa_dossier_market: JSON.stringify({ ms: NOW - HOUR, body: { data: [{ stock: "FHG", price: "480" }] } }),
    tsa_trade_log: JSON.stringify([{ sym: "FHG", delta: 1, price: 480, ts: Math.floor(NOW / 1000) - 60 }]),
    tsa_prev_holdings_src_ms: String(NOW - HOUR),
  });
  return s;
}

export function storeBoth(NOW) { return { ...store2531(NOW), "tsa-torn-apikey": TORN_KEY }; }

const TORN_USER = { player_id: 7, money_onhand: 1000,
  stocks: { 15: { stock_id: 15, total_shares: 10, transactions: { 1: { shares: 10, bought_price: 400, time_bought: 1 } } } } };
function tornsyBatch(keys) {
  const iv = {}; keys.forEach((k) => { iv[k] = { price: "478.00" }; });
  return { data: [
    { stock: "FHG", price: "480.00", investors: 1020, interval: iv, ohlc: { w1: { open: "470", high: "500", low: "460" } } },
    { stock: "TCT", price: "301.00", investors: 500, interval: iv },
  ] };
}
export function directRoutes(NOW) {
  const nowS = NOW / 1000;
  return [
    ["https://api.torn.com/user/", J(TORN_USER)],
    ["https://api.torn.com/faction/", J({ donations: { 7: { money_balance: 42 } } })],
    ["https://api.torn.com/torn/", J({ stocks: { 15: { acronym: "FHG", benefit: { requirement: 2000000, frequency: 7, description: "x" } } },
                                       items: { 206: { name: "Xanax", market_value: 800000 } } })],
    ["https://api.torn.com/market/", J({ itemmarket: { listings: [{ price: 790000 }] } })],
    ["https://tornsy.com/api/stocks?interval=m30", J(tornsyBatch(["m30", "h1", "h2", "h3", "h4"]))],
    ["https://tornsy.com/api/stocks?interval=h6", J(tornsyBatch(["h6", "h8", "h10", "h12", "h16"]))],
    ["https://tornsy.com/api/stocks?interval=h20", J(tornsyBatch(["h20", "d1", "d2", "d3", "d4"]))],
    ["https://tornsy.com/api/stocks?interval=d5", J(tornsyBatch(["d5", "d6", "d7", "w1", "h5"]))],
    ["https://tornsy.com/api/", J({ data: Array.from({ length: 40 }, (_, i) => [nowS - (39 - i) * 86400, "470", "500", "460", String(470 + i), 1]) })],
  ];
}
export function dossierRoutes(NOW) {
  const nowS = Math.floor(NOW / 1000);
  return [
    [D + "/api/license/check", J({ active: true, expires_ts: nowS + 30 * 86400, name: "test" })],
    [D + "/api/tsa/me", J({ player_id: 7, holdings_status: "ok", money_onhand: 5, armory: { ok: false, money_balance: 0 },
      stocks: TORN_USER.stocks, meta: { source_ts: nowS - 60 } })],
    [D + "/api/tsa/market", J({ data: tornsyBatch(["m30", "h1", "d1", "w1"]).data, missing_batches: 0, meta: {} })],
    [D + "/api/tsa/history", J({ symbols: {}, meta: {} })],
    [D + "/api/tsa/reference", J({ stocks: null, items: null, meta: {} })],
  ];
}
