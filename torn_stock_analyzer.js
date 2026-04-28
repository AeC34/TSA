// ==UserScript==
// @name         Torn Stock Analyzer
// @namespace    https://greasyfork.org
// @version      2.15.18
// @author       AeC3
// @description  Analyzes all 35 Torn City stocks and scores them for buy signals using 4 data-backed indicators: drop from weekly peak (dynamic volatility threshold), position in short-term range, active price rise (m30>h1>h2), and MACD momentum. Backtested on 42 days of hourly data with 88% hit rate. Includes ROI planner, benefit block tracker, swing trade P/L, and Quick Trade bar.
// @match        https://www.torn.com/page.php?sid=stocks*
// @run-at       document-end
// @license      MIT
// @grant        GM_xmlhttpRequest
// @connect      tornsy.com
// @connect      api.torn.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js
// @updateURL    https://greasyfork.org/scripts/570460/code/Torn%20Stock%20Analyzer.meta.js
// @downloadURL  https://greasyfork.org/scripts/570460/code/Torn%20Stock%20Analyzer.user.js
// ==/UserScript==

(function () {
  function lsGet(key, fallback) {
    try { var v = localStorage.getItem(key); return v !== null ? v : (fallback !== undefined ? fallback : ""); }
    catch(e) { return fallback !== undefined ? fallback : ""; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch(e) {}
  }

  var TORN_API_KEY = lsGet("tsa-torn-apikey", "");

  function getTornKey() {
    return lsGet("tsa-torn-apikey", "");
  }

  var KEY_BUILDER_URL = "https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=basic,money,stocks&faction=donations&market=itemmarket&title=TORN%20STOCK%20ANALYZER";

  function showKeyOnboarding(contentEl, onSave) {
    var isDark = document.getElementById("tsa-overlay") ? document.getElementById("tsa-overlay").classList.contains("tsa-dark") : false;
    var bg   = isDark ? "#0f0f1a" : "#ffffff";
    var bg2  = isDark ? "#1a1a2e" : "#f7f9fc";
    var text = isDark ? "#c8c8d8" : "#222";
    var muted = isDark ? "#6a6a8a" : "#888";
    var border = isDark ? "#2a2a4a" : "#e0e0e0";
    contentEl.innerHTML =
      "<div style=\"padding:18px;background:" + bg + ";font-family:sans-serif\">" +
        "<div style=\"font-size:13px;font-weight:bold;color:" + text + ";margin-bottom:6px\">API Key Required</div>" +
        "<div style=\"font-size:11px;color:" + muted + ";margin-bottom:14px;line-height:1.5\">Torn Stock Analyzer needs a Torn API key to load stock and portfolio data. Your key is stored only in your browser and sent exclusively to api.torn.com.</div>" +
        "<a href=\"" + KEY_BUILDER_URL + "\" target=\"_blank\" style=\"display:block;text-align:center;padding:10px;border-radius:8px;background:#4a6fa5;color:#fff;font-size:12px;font-weight:bold;text-decoration:none;margin-bottom:14px\">Create custom key (recommended)</a>" +
        "<div style=\"font-size:10px;color:" + muted + ";margin-bottom:6px;text-align:center\">— or enter an existing key below —</div>" +
        "<div style=\"font-size:10px;color:" + muted + ";margin-bottom:6px\">Limited Access key or custom key</div>" +
        "<input id=\"tsa-key-input\" type=\"text\" placeholder=\"Paste API key here\" style=\"width:100%;box-sizing:border-box;padding:8px 10px;border-radius:7px;border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:12px;margin-bottom:10px\">" +
        "<button id=\"tsa-key-save\" style=\"width:100%;padding:9px;border-radius:7px;border:none;background:#4a6fa5;color:#fff;font-size:13px;font-weight:bold;cursor:pointer\">Save key</button>" +
      "</div>";
    document.getElementById("tsa-key-save").addEventListener("click", function() {
      var val = (document.getElementById("tsa-key-input").value || "").trim();
      if (!val) return;
      lsSet("tsa-torn-apikey", val);
      TORN_API_KEY = val;
      if (onSave) onSave();
    });
  }

  // On load: handle PDA key injection, do NOT prompt — onboarding shown inline when needed
  if (!TORN_API_KEY || TORN_API_KEY === "###PDA-APIKEY###") {
    var pdaKey = "###PDA-APIKEY###";
    if (pdaKey.indexOf("PDA-APIKEY") === -1) {
      // Running in PDA — key was injected
      TORN_API_KEY = pdaKey;
      lsSet("tsa-torn-apikey", TORN_API_KEY);
    }
  }
  var roiPlannerActive = false;
  var isDesktop = window.innerWidth > 768 || !/Mobi|Android/i.test(navigator.userAgent);
  var autoRefreshTimer = null;
  var autoRefreshEndTime = null;
  var autoRefreshCountdownInterval = null;
  var lastLoadPrices = {};
  var tsaPinned = (function() { try { return JSON.parse(localStorage.getItem("tsa_pinned") || "[]") || []; } catch(e) { return []; } })();

  function getAutoRefreshInterval() {
    return parseInt(lsGet("tsa-auto-refresh-interval", "0"), 10);
  }

  function scheduleAutoRefresh() {
    if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; }
    if (autoRefreshCountdownInterval) { clearInterval(autoRefreshCountdownInterval); autoRefreshCountdownInterval = null; }
    autoRefreshEndTime = null;
    var mins = getAutoRefreshInterval();
    if (mins > 0) {
      autoRefreshEndTime = Date.now() + mins * 60000;
      autoRefreshCountdownInterval = setInterval(updateCountdownLabel, 1000);
      autoRefreshTimer = setTimeout(function() {
        autoRefreshTimer = null;
        if (autoRefreshCountdownInterval) { clearInterval(autoRefreshCountdownInterval); autoRefreshCountdownInterval = null; }
        autoRefreshEndTime = null;
        loadData();
      }, mins * 60000);
    }
  }
  // ── Price Alerts ──────────────────────────────────────────────────────────
  var ALERTS_KEY = "tsa_price_alerts";

  function loadAlerts() {
    try { return JSON.parse(localStorage.getItem(ALERTS_KEY)) || []; } catch(e) { return []; }
  }

  function saveAlerts(alerts) {
    lsSet(ALERTS_KEY, JSON.stringify(alerts));
  }

  function addAlert(sym, price, dir, repeat) {
    var alerts = loadAlerts();
    // Remove any existing alert for same sym+dir
    alerts = alerts.filter(function(a) { return !(a.sym === sym && a.dir === dir); });
    alerts.push({ sym: sym.toUpperCase(), price: price, dir: dir, repeat: !!repeat });
    saveAlerts(alerts);
  }

  function removeAlert(sym, dir) {
    var alerts = loadAlerts().filter(function(a) { return !(a.sym === sym && a.dir === dir); });
    saveAlerts(alerts);
  }

  function checkAlerts(raw) {
    if (!raw || !raw.length) return;
    var alerts = loadAlerts();
    if (!alerts.length) return;
    var fired = [];
    alerts.forEach(function(a) {
      var entry = raw.find(function(r) { return r.stock === a.sym; });
      if (!entry) return;
      var live = parseFloat(entry.price) || 0;
      if (live <= 0) return;
      var triggered = (a.dir === "above" && live >= a.price) || (a.dir === "below" && live <= a.price);
      if (triggered) fired.push({ sym: a.sym, price: a.price, dir: a.dir, live: live });
    });
    if (!fired.length) return;
    // Remove one-shot fired alerts; keep repeat alerts active
    var firedKeys = fired.map(function(f) { return f.sym + f.dir; });
    saveAlerts(alerts.filter(function(a) { return a.repeat || firedKeys.indexOf(a.sym + a.dir) < 0; }));
    // Notify
    fired.forEach(function(f) {
      var msg = f.sym + " is " + (f.dir === "above" ? "above" : "below") + " $" + f.price.toFixed(2) + " (live: $" + f.live.toFixed(2) + ")";
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification("Torn Stock Alert", { body: msg, icon: "https://www.torn.com/favicon.ico" });
        } catch(e) {
          showToast("Price Alert: " + msg, "warn");
        }
      } else {
        showToast("Price Alert: " + msg, "warn");
      }
    });
  }

  function requestNotificationPermission() {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  var lastOwnedMap = null;
  var lastRaw = null;
  var lastBestRec = null; // Best ROI recommendation from last data load

  var STOCK_ID_MAP = {
    1:"TSB",  2:"TCI",  3:"SYS",  4:"LAG",  5:"IOU",
    6:"GRN",  7:"THS",  8:"YAZ",  9:"TCT", 10:"CNC",
    11:"MSG", 12:"TMI", 13:"TCP", 14:"IIL", 15:"FHG",
    16:"SYM", 17:"LSC", 18:"PRN", 19:"EWM", 20:"TCM",
    21:"ELT", 22:"HRG", 23:"TGP", 24:"MUN", 25:"WSU",
    26:"IST", 27:"BAG", 28:"EVL", 29:"MCS", 30:"WLT",
    31:"TCC", 32:"ASS", 33:"CBD", 34:"LOS", 35:"PTS"
  };

  var STOCK_SYM_MAP = {};
  (function() {
    for (var id in STOCK_ID_MAP) {
      STOCK_SYM_MAP[STOCK_ID_MAP[id]] = parseInt(id, 10);
    }
  })();

  var PASSIVE_STOCKS = ["ELT","IIL","IST","LOS","MSG","SYS","TCP","TCM","TCI","TGP","WSU","WLT","YAZ"];

  // Benefit requirement per stock (shares for 1 increment)
  var BENEFIT_REQ = {
    "TSB":3000000, "TCI":1500000, "SYS":3000000, "LAG":750000,  "IOU":3000000,
    "GRN":500000,  "THS":150000,  "YAZ":1000000,  "TCT":100000,  "CNC":7500000,
    "MSG":300000,  "TMI":6000000, "TCP":1000000,  "IIL":1000000, "FHG":2000000,
    "SYM":500000,  "LSC":500000,  "PRN":1000000,  "EWM":1000000, "TCM":1000000,
    "ELT":5000000, "HRG":10000000,"TGP":2500000,  "MUN":5000000, "WSU":1000000,
    "IST":100000,  "BAG":3000000, "EVL":100000,   "MCS":350000,  "WLT":9000000,
    "TCC":7500000, "ASS":1000000, "CBD":350000,   "LOS":7500000, "PTS":10000000
  };

  var STOCKS_LIST = ["ass","bag","cbd","cnc","elt","evl","ewm","fhg","grn","hrg",
    "iil","iou","ist","lag","los","lsc","mcs","msg","mun","prn",
    "pts","sym","sys","tcc","tci","tcm","tcp","tct","tgp","ths",
    "tmi","tsb","wlt","wsu","yaz"];

var STYLES = "\n\n    #tsa-btn {\n\n      position: fixed; bottom: 80px; right: 16px; z-index: 2147483647;\n\n      background: #4a6fa5; color: #ffffff; border: none;\n\n      border-radius: 50px; padding: 10px 18px; font-size: 13px;\n\n      font-family: Arial, sans-serif; cursor: pointer; font-weight: bold;\n\n      box-shadow: 0 2px 8px rgba(0,0,0,0.3);\n\n      -webkit-tap-highlight-color: transparent;\n\n    }\n\n    #tsa-btn:hover { background: #3a5f95; }\n\n    #tsa-overlay {\n\n      position: fixed; bottom: 130px; right: 16px; z-index: 2147483646;\n\n      max-height: 75vh; overflow-y: auto;\n\n      background: #ffffff; border: 1px solid #ddd; border-radius: 12px;\n\n      font-family: Arial, sans-serif; font-size: 12px; color: #222;\n\n      box-shadow: 0 4px 20px rgba(0,0,0,0.15); display: none;\n\n    }\n\n    #tsa-overlay::-webkit-scrollbar { width: 4px; }\n\n    #tsa-overlay::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }\n\n    .tsa-header {\n\n      display: flex; align-items: center; justify-content: space-between;\n\n      padding: 12px 14px; border-bottom: 1px solid #eee;\n\n      position: sticky; top: 0; background: #ffffff; z-index: 1;\n\n    }\n\n    .tsa-header-left { display: flex; align-items: center; gap: 8px; }\n\n    .tsa-title { font-size: 13px; font-weight: bold; color: #4a6fa5; letter-spacing: 0.05em; }\n\n    .tsa-theme-btn {\n\n      font-size: 14px; cursor: pointer; background: none; border: none;\n\n      padding: 2px 4px; line-height: 1; opacity: 0.7;\n\n    }\n\n    .tsa-theme-btn:hover { opacity: 1; }\n\n    .tsa-close { cursor: pointer; color: #777; font-size: 18px; padding: 0 4px; line-height: 1; }\n\n    .tsa-close:hover { color: #333; }\n\n    .tsa-stats {\n\n      display: grid; grid-template-columns: repeat(3, 1fr);\n\n      gap: 8px; padding: 12px 14px; border-bottom: 1px solid #eee;\n\n    }\n\n    .tsa-stat { background: #f7f9fc; border-radius: 8px; padding: 8px; text-align: center; border: 1px solid #e8edf5; }\n\n    .tsa-stat-label { font-size: 10px; color: #666; margin-bottom: 4px; }\n\n    .tsa-stat-value { font-size: 16px; font-weight: bold; color: #222; }\n\n    .tsa-stat-value.green { color: #1a8a45; }\n\n    .tsa-stat-value.red { color: #cc2222; }\n\n    .tsa-section { padding: 10px 14px 6px; }\n\n    .tsa-section-title { font-size: 10px; letter-spacing: 0.12em; color: #777; text-transform: uppercase; margin-bottom: 8px; font-weight: bold; }\n\n    .tsa-row {\n\n      display: flex; align-items: center; justify-content: space-between;\n\n      padding: 8px 10px; border-radius: 8px; margin-bottom: 5px; cursor: pointer;\n\n    }\n\n    .tsa-row.buy { background: #edfaf3; border: 1px solid #a8e6c0; }\n\n    .tsa-row.sell { background: #fff0f0; border: 1px solid #ffb3b3; }\n\n    .tsa-row.hold { background: #f0f4ff; border: 1px solid #c0d0ff; }\n\n    .tsa-row.buy:active { background: #d0f5e3; }\n\n    .tsa-row.sell:active { background: #ffd8d8; }\n\n    .tsa-row.hold:active { background: #dce6ff; }\n\n    .tsa-row-left { display: flex; flex-direction: column; gap: 2px; }\n\n    .tsa-symbol { font-size: 13px; font-weight: bold; }\n\n    .tsa-symbol.buy { color: #1a8a45; }\n\n    .tsa-symbol.sell { color: #cc2222; }\n\n    .tsa-symbol.hold { color: #4a6fa5; }\n\n    .tsa-detail { font-size: 10px; color: #666; }\n\n    .tsa-row-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }\n\n    .tsa-score { font-size: 14px; font-weight: bold; }\n\n    .tsa-score.buy { color: #1a8a45; }\n\n    .tsa-score.sell { color: #cc2222; }\n\n    .tsa-score.hold { color: #4a6fa5; }\n\n    .tsa-badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; font-weight: bold; }\n\n    .tsa-badge.benefit { background: #fff3cd; color: #856404; border: 1px solid #ffc107; }\n\n    .tsa-divider { border: none; border-top: 1px solid #eee; margin: 6px 14px; }\n\n    .tsa-footer {\n\n      padding: 10px 14px; display: flex; justify-content: space-between;\n\n      align-items: center; border-top: 1px solid #eee; background: #fafafa;\n\n      border-radius: 0 0 12px 12px;\n\n    }\n\n    .tsa-updated { font-size: 10px; color: #888; }\n\n    .tsa-refresh {\n\n      font-size: 11px; background: #4a6fa5; border: none;\n\n      color: #fff; border-radius: 6px; padding: 5px 12px; cursor: pointer;\n\n      font-family: Arial, sans-serif; font-weight: bold;\n\n    }\n\n    .tsa-refresh:hover { background: #3a5f95; }\n\n    .tsa-loading { padding: 30px; text-align: center; color: #888; font-size: 12px; }\n\n    @keyframes tsa-spin { to { transform: rotate(360deg); } }\n\n    .tsa-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: tsa-spin 0.7s linear infinite; vertical-align: middle; margin-right: 6px; opacity: 0.6; }\n\n    .tsa-error { padding: 16px; color: #cc2222; font-size: 11px; text-align: center; }\n\n    /* DARK MODE */\n\n    #tsa-overlay.tsa-dark {\n\n      background: #0f0f1a; border-color: #3a3a6a; color: #c8c8d8;\n\n    }\n\n    #tsa-overlay.tsa-dark::-webkit-scrollbar-thumb { background: #3a3a6a; }\n\n    #tsa-overlay.tsa-dark .tsa-header { background: #0f0f1a; border-color: #2a2a4a; }\n\n    #tsa-overlay.tsa-dark .tsa-stats { border-color: #2a2a4a; }\n\n    #tsa-overlay.tsa-dark .tsa-stat { background: #1a1a2e; border-color: #2a2a4a; }\n\n    #tsa-overlay.tsa-dark .tsa-stat-label { color: #888; }\n\n    #tsa-overlay.tsa-dark .tsa-stat-value { color: #e0e0ff; }\n\n    #tsa-overlay.tsa-dark .tsa-section-title { color: #888; }\n\n    #tsa-overlay.tsa-dark .tsa-detail { color: #888; }\n\n    #tsa-overlay.tsa-dark .tsa-row.buy { background: rgba(76,255,145,0.08); border-color: rgba(76,255,145,0.2); }\n\n    #tsa-overlay.tsa-dark .tsa-row.sell { background: rgba(255,76,106,0.08); border-color: rgba(255,76,106,0.2); }\n\n    #tsa-overlay.tsa-dark .tsa-row.hold { background: rgba(160,160,255,0.05); border-color: rgba(160,160,255,0.1); }\n\n    #tsa-overlay.tsa-dark .tsa-row.buy:active { background: rgba(76,255,145,0.18); }\n\n    #tsa-overlay.tsa-dark .tsa-row.sell:active { background: rgba(255,76,106,0.18); }\n\n    #tsa-overlay.tsa-dark .tsa-row.hold:active { background: rgba(160,160,255,0.14); }\n\n    #tsa-overlay.tsa-dark .tsa-symbol.buy { color: #4cff91; }\n\n    #tsa-overlay.tsa-dark .tsa-symbol.sell { color: #ff4c6a; }\n\n    #tsa-overlay.tsa-dark .tsa-symbol.hold { color: #a0a0ff; }\n\n    #tsa-overlay.tsa-dark .tsa-stat-value.green { color: #4cff91; }\n\n    #tsa-overlay.tsa-dark .tsa-stat-value.red { color: #ff4c6a; }\n\n    #tsa-overlay.tsa-dark .tsa-divider { border-color: #2a2a4a; }\n\n    #tsa-overlay.tsa-dark .tsa-footer { background: #0f0f1a; border-color: #2a2a4a; }\n\n    #tsa-overlay.tsa-dark .tsa-updated { color: #666; }\n\n    #tsa-overlay.tsa-dark .tsa-loading { color: #666; }\n\n    #tsa-overlay.tsa-dark .tsa-close { color: #888; }\n\n    #tsa-overlay.tsa-dark .tsa-close:hover { color: #aaa; }\n\n    #tsa-overlay.tsa-dark .tsa-theme-btn { color: #c8c8d8; opacity: 1; }\n\n    #tsa-overlay.tsa-dark .tsa-theme-btn:hover { color: #ffffff; }\n\n    #tsa-overlay.tsa-dark .tsa-title { color: #7a9fd4; }\n\n \\n"

  // ============================================================
  // ROI PLANNER
  // ============================================================

  var ROI_TABLE = [
    {sym:"SYM",tier:"T1",cost:353970000,payout:4153424,freq:7,type:"variable",item:370},
    {sym:"FHG",tier:"T1",cost:1735720000,payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T1",cost:32121000,payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"PRN",tier:"T1",cost:614190000,payout:4019972,freq:7,type:"variable",item:366},
    {sym:"SYM",tier:"T2",cost:707940000,payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T1",cost:154005000,payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T1",cost:537810000,payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"THS",tier:"T1",cost:58455000,payout:272431,freq:7,type:"variable",item:365},
    {sym:"MUN",tier:"T1",cost:2764800000,payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T1",cost:770100000,payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T1",cost:1395240000,payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T1",cost:2716600000,payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T1",cost:287840000,payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T2",cost:3471440000,payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T2",cost:64242000,payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"PRN",tier:"T2",cost:1228380000,payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T1",cost:3538500000,payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T1",cost:272735000,payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T3",cost:1415880000,payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T2",cost:308010000,payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T1",cost:6570750000,payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T2",cost:1075620000,payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T1",cost:356470000,payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T2",cost:116910000,payout:272431,freq:7,type:"variable",item:365},
    {sym:"MUN",tier:"T2",cost:5529600000,payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T2",cost:1540200000,payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T2",cost:2790480000,payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T2",cost:5433200000,payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T2",cost:575680000,payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T3",cost:6942880000,payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T3",cost:128484000,payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T1",cost:3850875000,payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T3",cost:2456760000,payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T2",cost:7077000000,payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T2",cost:545470000,payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T4",cost:2831760000,payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T3",cost:616020000,payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T2",cost:13141500000,payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T3",cost:2151240000,payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T2",cost:712940000,payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T3",cost:233820000,payout:272431,freq:7,type:"variable",item:365},
    {sym:"MUN",tier:"T3",cost:11059200000,payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T3",cost:3080400000,payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T3",cost:5580960000,payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T3",cost:10866400000,payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T3",cost:1151360000,payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T4",cost:13885760000,payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T4",cost:256968000,payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T2",cost:7701750000,payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T4",cost:4913520000,payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T3",cost:14154000000,payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T3",cost:1090940000,payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T5",cost:5663520000,payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T4",cost:1232040000,payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T3",cost:26283000000,payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T4",cost:4302480000,payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T3",cost:1425880000,payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T4",cost:467640000,payout:272431,freq:7,type:"variable",item:365},
    {sym:"LAG",tier:"T1",cost:353557500,payout:203827,freq:7,type:"variable",item:368},
    {sym:"MUN",tier:"T4",cost:22118400000,payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T4",cost:6160800000,payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T4",cost:11161920000,payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T4",cost:21732800000,payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T4",cost:2302720000,payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T5",cost:27771520000,payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T5",cost:513936000,payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T3",cost:15403500000,payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T5",cost:9827040000,payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T4",cost:28308000000,payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T4",cost:2181880000,payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T6",cost:11327040000,payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T5",cost:2464080000,payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T4",cost:52566000000,payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T5",cost:8604960000,payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T4",cost:2851760000,payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T5",cost:935280000,payout:272431,freq:7,type:"variable",item:365},
    {sym:"LAG",tier:"T2",cost:707115000,payout:203827,freq:7,type:"variable",item:368},
    {sym:"MUN",tier:"T5",cost:44236800000,payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T5",cost:12321600000,payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T5",cost:22323840000,payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T5",cost:43465600000,payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T5",cost:4605440000,payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T6",cost:55543040000,payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T6",cost:1027872000,payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T4",cost:30807000000,payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T6",cost:19654080000,payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T5",cost:56616000000,payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T5",cost:4363760000,payout:861423,freq:7,type:"variable",item:369}
  ];

  // Lookup map for O(1) ROI_TABLE access: key = "SYM|Tn"
  var ROI_MAP = {};
  function rebuildRoiMap() {
    Object.keys(ROI_MAP).forEach(function(k) { delete ROI_MAP[k]; });
    ROI_TABLE.forEach(function(e) { ROI_MAP[e.sym + "|" + e.tier] = e; });
  }
  rebuildRoiMap();

  // Item IDs with sellable market value
  var ITEM_IDS = [364, 365, 366, 367, 368, 369, 370, 817, 818];
  // PTS gives 100 points = $3M fixed
  var PTS_VALUE = 3000000;

  // Stocks with item-paying benefits that aren't hardcoded in ROI_TABLE — the
  // script discovers their item ID at runtime (one-shot) by name and synthesises
  // T1-T6 entries into ROI_TABLE.
  var DYNAMIC_BENEFIT_STOCKS = {
    "BAG": { itemName: "Ammunition Pack", freq: 7, type: "variable" }
  };

  var roiSkipped = (function() { try { return JSON.parse(localStorage.getItem("tsa_roi_skipped") || "[]") || []; } catch(e) { return []; } })();
  var itemPrices = {}; // cache: itemId -> price
  // itemNames are stable, persist them — saves an API call per id every reload.
  var itemNames = (function() {
    try { return JSON.parse(lsGet("tsa_item_names", "{}")) || {}; }
    catch(e) { return {}; }
  })();
  // itemIdsByName: name → id reverse map, populated by a one-time
  // /torn/?selections=items fetch. Used to resolve DYNAMIC_BENEFIT_STOCKS.
  var itemIdsByName = (function() {
    try { return JSON.parse(lsGet("tsa_item_ids_by_name", "{}")) || {}; }
    catch(e) { return {}; }
  })();
  // itemMarketValues: name → Torn's official baseline market_value, from the
  // same items fetch. Used to give synthesised DYNAMIC_BENEFIT_STOCKS entries
  // a real `payout` so income math has a sensible baseline.
  var itemMarketValues = (function() {
    try { return JSON.parse(lsGet("tsa_item_market_values", "{}")) || {}; }
    catch(e) { return {}; }
  })();

  function fmRoi(n) {
    if (n >= 1e9) return "$" + (n/1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n/1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n/1e3).toFixed(0) + "K";
    return "$" + n.toFixed(0);
  }

  function fetchItemPrice(itemId, cb) {
    if (itemPrices[itemId] !== undefined) { cb(itemPrices[itemId]); return; }
    var url = "https://api.torn.com/market/" + itemId + "?selections=itemmarket&key=" + getTornKey();
    GM_xmlhttpRequest({
      method: "GET", url: url,
      onload: function(r) {
        try {
          var d = JSON.parse(r.responseText);
          var listings = d.itemmarket && d.itemmarket.listings ? d.itemmarket.listings : [];
          if (listings.length > 0) {
            // Use lowest price
            var lowest = listings.reduce(function(a,b){ return a.price < b.price ? a : b; });
            itemPrices[itemId] = lowest.price;
            cb(lowest.price);
          } else { itemPrices[itemId] = 0; cb(0); }
        } catch(e) { itemPrices[itemId] = 0; cb(0); }
      },
      onerror: function() { itemPrices[itemId] = 0; cb(0); }
    });
  }

  function fetchItemName(itemId, cb) {
    if (itemNames[itemId]) { cb(itemNames[itemId]); return; }
    var url = "https://api.torn.com/torn/" + itemId + "?selections=items&key=" + getTornKey();
    GM_xmlhttpRequest({
      method: "GET", url: url,
      onload: function(r) {
        try {
          var d = JSON.parse(r.responseText);
          var entry = d.items && d.items[itemId];
          if (entry && entry.name) {
            itemNames[itemId] = entry.name;
            lsSet("tsa_item_names", JSON.stringify(itemNames));
            cb(entry.name);
          } else { cb(""); }
        } catch(e) { cb(""); }
      },
      onerror: function() { cb(""); }
    });
  }

  // One-shot fetch of the full Torn items dictionary to resolve any
  // DYNAMIC_BENEFIT_STOCKS item names → IDs. Skipped if every needed name is
  // already cached locally.
  function ensureDynamicItemIds(cb) {
    var allKnown = Object.keys(DYNAMIC_BENEFIT_STOCKS).every(function(sym) {
      return itemIdsByName[DYNAMIC_BENEFIT_STOCKS[sym].itemName];
    });
    if (allKnown) { cb(); return; }
    var url = "https://api.torn.com/torn/?selections=items&key=" + getTornKey();
    GM_xmlhttpRequest({
      method: "GET", url: url,
      onload: function(r) {
        try {
          var d = JSON.parse(r.responseText);
          if (d.items) {
            Object.keys(d.items).forEach(function(id) {
              var item = d.items[id];
              if (item && item.name) {
                itemIdsByName[item.name] = parseInt(id, 10);
                if (typeof item.market_value === "number") {
                  itemMarketValues[item.name] = item.market_value;
                }
              }
            });
            lsSet("tsa_item_ids_by_name", JSON.stringify(itemIdsByName));
            lsSet("tsa_item_market_values", JSON.stringify(itemMarketValues));
          }
        } catch(e) {}
        cb();
      },
      onerror: function() { cb(); }
    });
  }

  // Once item IDs are resolved, splice T1-T6 entries for each dynamic stock
  // into ROI_TABLE (and its lookup map) and register their item ID for price /
  // name fetching. Idempotent.
  function augmentRoiTableWithDynamicStocks() {
    Object.keys(DYNAMIC_BENEFIT_STOCKS).forEach(function(sym) {
      var def = DYNAMIC_BENEFIT_STOCKS[sym];
      var itemId = itemIdsByName[def.itemName];
      if (!itemId) return;
      if (ROI_TABLE.some(function(e) { return e.sym === sym; })) return;
      // Use Torn's official market_value as the per-cycle baseline payout —
      // matches what the rest of ROI_TABLE does for item-paying stocks.
      var baseline = itemMarketValues[def.itemName] || 0;
      for (var t = 1; t <= 6; t++) {
        ROI_TABLE.push({
          sym: sym, tier: "T" + t,
          cost: 0, payout: baseline, freq: def.freq, type: def.type, item: itemId
        });
      }
      if (ITEM_IDS.indexOf(itemId) < 0) ITEM_IDS.push(itemId);
    });
    rebuildRoiMap();
  }

  function fetchAllItemPrices(cb) {
    // Resolve any pending dynamic item IDs first, then add their entries to
    // ROI_TABLE, then fetch market price + display name for the (possibly
    // expanded) ITEM_IDS list.
    ensureDynamicItemIds(function() {
      augmentRoiTableWithDynamicStocks();
      var remaining = ITEM_IDS.length * 2;
      var done = false;
      function finish() { if (!done) { done = true; cb(); } }
      setTimeout(finish, 10000); // failsafe: call cb after 10s even if a request never returns
      ITEM_IDS.forEach(function(id) {
        fetchItemPrice(id, function() { remaining--; if (remaining === 0) finish(); });
        fetchItemName(id,  function() { remaining--; if (remaining === 0) finish(); });
      });
    });
  }

  function getItemValue(entry) {
    if (entry.sym === "PTS") return PTS_VALUE;
    if (entry.item && itemPrices[entry.item]) return itemPrices[entry.item];
    return 0;
  }

  function getItemName(itemId) {
    return (itemId && itemNames[itemId]) ? itemNames[itemId] : "";
  }

  // Calculate Bollinger Bands using all stored price history
  // Returns { upper, middle, lower, pctB } or null if insufficient data
  // pctB = position within bands: 0 = at lower, 1 = at upper, <0 = below lower
  function calcBollingerBands(sym, history, livePrice) {
    var entries = history ? history[sym.toUpperCase()] : null;
    if (!entries || entries.length < 20) return null;
    var prices = entries.map(function(e) { return e.price; });
    // Use last 20 prices for SMA and stddev
    var period = 20;
    var slice = prices.slice(-period);
    var sma = slice.reduce(function(a, b) { return a + b; }, 0) / period;
    var variance = slice.reduce(function(sum, p) { return sum + Math.pow(p - sma, 2); }, 0) / period;
    var stddev = Math.sqrt(variance);
    var upper = sma + 2 * stddev;
    var lower = sma - 2 * stddev;
    var range = upper - lower;
    if (range === 0) return null; // no volatility — bands are meaningless
    var pctB = (livePrice - lower) / range;
    return { upper: upper, middle: sma, lower: lower, pctB: pctB };
  }
  // Returns { macd, signal, histogram, crossover } or null if insufficient data
  function calcMACD(sym, history) {
    var entries = history ? history[sym.toUpperCase()] : null;
    if (!entries || entries.length < 35) return null;
    var sorted = entries.slice().sort(function(a, b) { return a.ts - b.ts; });
    var prices = sorted.map(function(e) { return e.price; });
    if (prices.length < 35) return null;

    function calcEMA(data, period) {
      var k = 2 / (period + 1);
      var ema = [data[0]];
      for (var i = 1; i < data.length; i++) {
        ema.push(data[i] * k + ema[i-1] * (1 - k));
      }
      return ema;
    }

    var ema12 = calcEMA(prices, 12);
    var ema26 = calcEMA(prices, 26);
    var macdLine = ema12.map(function(v, i) { return v - ema26[i]; });
    var signalLine = calcEMA(macdLine, 9); // signal line computed over full macdLine for aligned indices
    var lastMacd = macdLine[macdLine.length - 1];
    var lastSignal = signalLine[signalLine.length - 1];
    var prevMacd = macdLine[macdLine.length - 2];
    var prevSignal = signalLine[signalLine.length - 2];

    // Bullish crossover: MACD crossed above signal line
    var crossover = prevMacd < prevSignal && lastMacd >= lastSignal;

    return {
      macd: lastMacd,
      signal: lastSignal,
      histogram: lastMacd - lastSignal,
      crossover: crossover
    };
  }

  // Low-level RSI from a price array (min 15 prices, 14-period Wilder)
  function rsiFromPrices(prices) {
    if (!prices || prices.length < 15) return null;
    var changes = [];
    for (var i = 1; i < prices.length; i++) changes.push(prices[i] - prices[i - 1]);
    var period = 14;
    var gains = 0, losses = 0;
    for (var j = 0; j < period; j++) {
      if (changes[j] >= 0) gains += changes[j];
      else losses += Math.abs(changes[j]);
    }
    var avgGain = gains / period, avgLoss = losses / period;
    for (var k = period; k < changes.length; k++) {
      var g = changes[k] >= 0 ? changes[k] : 0;
      var l = changes[k] < 0 ? Math.abs(changes[k]) : 0;
      avgGain = (avgGain * 13 + g) / 14;
      avgLoss = (avgLoss * 13 + l) / 14;
    }
    if (avgGain === 0 && avgLoss === 0) return null;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  // Calculate RSI using all stored price history (kept for backward compat)
  function calcRSI(sym, history) {
    var entries = history ? history[sym.toUpperCase()] : null;
    if (!entries || entries.length < 15) return null;
    return rsiFromPrices(entries.map(function(e) { return e.price; }));
  }

  // Torn-specific RSI context: returns current RSI + its percentile within this
  // stock's own historical RSI range. Uses 28-price windows (28h of hourly data)
  // stepped every 4 prices through history — auto-calibrates to each stock's
  // normal RSI behaviour instead of relying on generic 30/70 real-market thresholds.
  function calcRSIContext(sym, history) {
    var entries = history ? history[sym.toUpperCase()] : null;
    if (!entries || entries.length < 28) return null;
    var sorted = entries.slice().sort(function(a, b) { return a.ts - b.ts; });
    var prices = sorted.map(function(e) { return e.price; });

    var current = rsiFromPrices(prices.slice(-28));
    if (current === null) return null;

    // Build historical RSI sample: one value per 4-price step
    var historicalRSI = [];
    for (var i = 28; i <= prices.length; i += 4) {
      var r = rsiFromPrices(prices.slice(i - 28, i));
      if (r !== null) historicalRSI.push(r);
    }

    if (historicalRSI.length < 5) {
      // Not enough history for percentile — return RSI only
      return { rsi: current, percentile: null };
    }

    historicalRSI.sort(function(a, b) { return a - b; });
    var below = historicalRSI.filter(function(r) { return r <= current; }).length;
    return { rsi: current, percentile: (below / historicalRSI.length) * 100 };
  }
  // Bollinger Band width context for Torn stocks.
  // BB width = (2 * stddev / SMA) * 100 over a 20-price window.
  // Returns the current width's percentile within the stock's own historical
  // BB widths so the caller knows if the stock is in a squeeze (narrow band,
  // low volatility — breakout pending) or an active/expanded band.
  // Percentile is always relative to this stock's own history, not a fixed scale.
  function calcBBWidth(sym, history) {
    var entries = history ? history[sym.toUpperCase()] : null;
    if (!entries || entries.length < 20) return null;
    var sorted = entries.slice().sort(function(a, b) { return a.ts - b.ts; });
    var prices = sorted.map(function(e) { return e.price; });

    function bbWidthFromSlice(slice) {
      if (slice.length < 20) return null;
      var n = 20;
      var window = slice.slice(-n);
      var sma = window.reduce(function(s, v) { return s + v; }, 0) / n;
      if (sma <= 0) return null;
      var variance = window.reduce(function(s, v) { return s + (v - sma) * (v - sma); }, 0) / n;
      var stddev = Math.sqrt(variance);
      return (2 * stddev / sma) * 100;
    }

    var current = bbWidthFromSlice(prices);
    if (current === null) return null;

    // Historical sample: one BB width every 4 prices
    var historicalWidths = [];
    for (var i = 20; i <= prices.length; i += 4) {
      var w = bbWidthFromSlice(prices.slice(0, i));
      if (w !== null) historicalWidths.push(w);
    }

    if (historicalWidths.length < 5) return { width: current, percentile: null };

    historicalWidths.sort(function(a, b) { return a - b; });
    var below = historicalWidths.filter(function(w) { return w <= current; }).length;
    var percentile = (below / historicalWidths.length) * 100;

    var label;
    if      (percentile <= 15) label = "Squeeze";
    else if (percentile <= 35) label = "Low volatility";
    else if (percentile <= 65) label = "Normal";
    else if (percentile <= 85) label = "Active";
    else                       label = "High volatility";

    return { width: current, percentile: percentile, label: label };
  }

  // Uses BENEFIT_REQ (fixed share counts) and dividend.increment from API
  // Next tier total shares = BENEFIT_REQ × (2^nextIncrement - 1)
  // Next tier cost = sharesNeeded × live_price
  function calcNextTier(sym, ownedMap, raw) {
    var req = BENEFIT_REQ[sym];
    if (!req) return null;
    var liveEntry = raw ? raw.find(function(x) { return x.stock === sym; }) : null;
    var livePrice = liveEntry ? (parseFloat(liveEntry.price) || 0) : 0;
    if (livePrice <= 0) return null;

    var o = ownedMap[sym];
    var currentIncrement = o ? (o.dividend_increment || 0) : 0;
    var currentShares = o ? (o.shares || 0) : 0;

    var nextIncrement = currentIncrement + 1;
    var totalSharesNeeded = (Math.pow(2, nextIncrement) - 1) * req;
    var sharesNeeded = Math.max(0, totalSharesNeeded - currentShares);
    var cost = sharesNeeded * livePrice;

    return {
      sym: sym,
      currentIncrement: currentIncrement,
      nextIncrement: nextIncrement,
      totalSharesNeeded: totalSharesNeeded,
      sharesNeeded: sharesNeeded,
      cost: cost,
      livePrice: livePrice
    };
  }
  // ownedMap: from buildOwnedMap, raw: from tornsy for live prices
  function calcWeeklyIncome(ownedMap, raw, extraEntry) {
    var weeklyTotal = 0;
    // Iterate over all owned stocks with benefit shares
    Object.keys(ownedMap).forEach(function(sym) {
      var o = ownedMap[sym];
      if (!o.has_dividend || o.benefit_shares <= 0) return;
      var increments = o.dividend_increment || 0;
      if (increments <= 0) return;
      // Sum every tier ≤ user's current increment. Torn benefit blocks stack:
      // owning T2 means you also receive the T1 reward each cycle, so weekly
      // income is the sum of every tier you've reached, not just the highest.
      // For item-paying stocks: prefer the live market price; fall back to the
      // baked-in baseline if the API hasn't returned a price yet. For cash
      // stocks (entry.item is 0) entry.payout is the income.
      ROI_TABLE.forEach(function(entry) {
        if (entry.sym !== sym) return;
        var tierNum = parseInt(entry.tier.replace("T",""), 10);
        if (tierNum > increments) return;
        var itemVal = getItemValue(entry);
        var perCycle = (entry.item && itemVal > 0) ? itemVal : entry.payout;
        weeklyTotal += (perCycle / entry.freq) * 7;
      });
    });
    // Add extra entry (bridgebuilder)
    if (extraEntry) {
      var exItemVal = getItemValue(extraEntry);
      var exPerCycle = (extraEntry.item && exItemVal > 0) ? exItemVal : extraEntry.payout;
      weeklyTotal += (exPerCycle / extraEntry.freq) * 7;
    }
    return weeklyTotal;
  }

  // Calculate days until target is affordable with given weekly income + capital
  function daysToAfford(target, capital, weeklyIncome) {
    if (capital >= target) return 0;
    if (weeklyIncome <= 0) return Infinity;
    var needed = target - capital;
    var dailyIncome = weeklyIncome / 7;
    return Math.ceil(needed / dailyIncome);
  }

  function renderROIPlanner(ownedMap, raw, cashBalance, armoryFunds) {
    if (!ownedMap || Object.keys(ownedMap).length === 0) {
      return '<div style="padding:20px;text-align:center;color:#888;font-size:11px;line-height:1.5">' +
             'No stocks owned yet.<br><br>' +
             'Buy shares of a benefit stock to see ROI rankings here.</div>';
    }
    if (!armoryFunds) armoryFunds = 0;
    // Calculate swing capital
    var swingCapital = 0;
    var swingDetails = [];
    Object.keys(ownedMap).forEach(function(sym) {
      var o = ownedMap[sym];
      if (o.swing_shares <= 0) return;
      var liveEntry = raw ? raw.find(function(x){ return x.stock === sym; }) : null;
      if (!liveEntry) return;
      var livePrice = parseFloat(liveEntry.price) || 0;
      var val = livePrice * o.swing_shares;
      swingCapital += val;
      if (val > 0) swingDetails.push({sym: sym, val: val});
    });

    var totalCapital = cashBalance + swingCapital + armoryFunds;

    // Find owned benefit blocks from the ROI table
    var ownedEntries = ROI_TABLE.filter(function(entry) {
      var o = ownedMap[entry.sym];
      if (!o || !o.has_dividend || o.benefit_shares <= 0) return false;
      var tierNum = parseInt(entry.tier.replace("T",""), 10);
      // Use Torn's own increment field
      return tierNum <= o.dividend_increment;
    });

    // Weekly income from current benefit blocks
    var weeklyIncome = calcWeeklyIncome(ownedMap, raw, null);

    // Find next 3 recommended purchases using dynamic tier costs
    var ownedKeys = ownedEntries.map(function(e){ return e.sym + e.tier; });

    // Build dynamic next tier list for all 35 stocks with benefit data
    var benefitSyms = Object.keys(BENEFIT_REQ);
    var dynamicNextTiers = [];
    benefitSyms.forEach(function(sym) {
      var tierInfo = calcNextTier(sym, ownedMap, raw);
      if (!tierInfo || tierInfo.cost <= 0) return;
      // Find payout data from ROI_MAP for this next increment
      var payoutEntry = ROI_MAP[sym + "|T" + tierInfo.nextIncrement] || null;
      // If no ROI_MAP entry — passive stock, skip (no sellable payout)
      dynamicNextTiers.push({
        sym: sym,
        tierInfo: tierInfo,
        payoutEntry: payoutEntry,
        cost: tierInfo.cost,
        roi: payoutEntry ? (payoutEntry.payout / tierInfo.cost * (365 / payoutEntry.freq) * 100) : 0
      });
    });

    // Sort by ROI descending, filter out skipped
    dynamicNextTiers = dynamicNextTiers.filter(function(e) {
      var key = e.sym + "T" + e.tierInfo.nextIncrement;
      return roiSkipped.indexOf(key) < 0;
    });
    dynamicNextTiers.sort(function(a, b) { return b.roi - a.roi; });

    // Target = best ROI entry regardless of affordability
    var target = dynamicNextTiers[0] || null;
    var nextEntries = target ? [target] : [];
    var nextEntry = target;

    // Bridgebuilder chain: buy multiple bridges you can afford (keep them, don't sell),
    // each one adds dividend income that accelerates reaching Next Move.
    var bridgeChain = [];
    var daysWait = target ? daysToAfford(target.cost, totalCapital, weeklyIncome) : 0;
    var daysBaseline = daysWait;

    if (target) {
      var chainCap    = totalCapital;
      var chainIncome = weeklyIncome;

      // Candidates: not the target itself, not skipped, must have dividend income
      var allBridgeCandidates = dynamicNextTiers.filter(function(e) {
        var key = e.sym + "T" + e.tierInfo.nextIncrement;
        if (roiSkipped.indexOf(key) >= 0) return false;
        if (e.sym === target.sym && e.tierInfo.nextIncrement === target.tierInfo.nextIncrement) return false;
        if (!e.payoutEntry) return false;
        var fItemVal = getItemValue(e.payoutEntry);
        var fPerCycle = (e.payoutEntry.item && fItemVal > 0) ? fItemVal : e.payoutEntry.payout;
        return (fPerCycle / e.payoutEntry.freq * 7) > 0;
      });

      allBridgeCandidates.forEach(function(e) {
        var bItemVal = getItemValue(e.payoutEntry);
        var bPerCycle = (e.payoutEntry.item && bItemVal > 0) ? bItemVal : e.payoutEntry.payout;
        var extraIncome = bPerCycle / e.payoutEntry.freq * 7;

        if (e.cost <= chainCap) {
          // Affordable now — buy it, reduce capital, increase income stream
          chainCap    -= e.cost;
          chainIncome += extraIncome;
          bridgeChain.push({
            sym: e.sym, tier: "T" + e.tierInfo.nextIncrement,
            cost: e.cost, extraIncome: extraIncome, roi: e.roi,
            status: "now", daysUntil: 0
          });
        }
        // "Later" bridges added separately below, sorted by soonest
      });

      // After buying all "now" bridges, find the next 2 soonest affordable ones
      // that actually save days vs just waiting — these are the ones to save up for
      var laterCandidates = [];
      allBridgeCandidates.forEach(function(e) {
        if (bridgeChain.some(function(b) { return b.sym === e.sym && b.tier === ("T" + e.tierInfo.nextIncrement); })) return; // already handled as "now"
        var lItemVal = getItemValue(e.payoutEntry);
        var lPerCycle = (e.payoutEntry.item && lItemVal > 0) ? lItemVal : e.payoutEntry.payout;
        var extraIncome = lPerCycle / e.payoutEntry.freq * 7;
        var daysUntil   = daysToAfford(e.cost, chainCap, chainIncome);
        if (daysUntil === Infinity || daysUntil > 365) return;
        // Simulate buying this bridge after daysUntil: does it save days to target?
        var simCap    = chainCap + (chainIncome / 7 * daysUntil) - e.cost;
        var simIncome = chainIncome + extraIncome;
        var daysAfter = daysUntil + daysToAfford(target.cost, simCap, simIncome);
        var saved     = daysBaseline - daysAfter;
        if (saved <= 0) return; // doesn't help
        laterCandidates.push({
          sym: e.sym, tier: "T" + e.tierInfo.nextIncrement,
          cost: e.cost, extraIncome: extraIncome, roi: e.roi,
          status: "later", daysUntil: daysUntil, daysSaved: saved
        });
      });
      // Sort by soonest affordable, keep top 2
      laterCandidates.sort(function(a, b) { return a.daysUntil - b.daysUntil; });
      laterCandidates.slice(0, 2).forEach(function(b) { bridgeChain.push(b); });

      // Recompute goal with all "now" bridges applied (capital reduced, income boosted)
      var daysWithBridges = daysToAfford(target.cost, chainCap, chainIncome);

      // Sell candidates: owned benefit blocks with lower ROI than target
      // ROI of target
      var targetRoi = target.roi || 0;
      var sellCandidates = [];
      ownedEntries.forEach(function(e) {
        var sItemVal = getItemValue(e);
        var sPerCycle = (e.item && sItemVal > 0) ? sItemVal : e.payout;
        var weekly = sPerCycle ? sPerCycle / (e.freq || 7) * 7 : 0;
        var liveEntry = raw ? raw.find(function(x) { return x.stock === e.sym; }) : null;
        var livePrice = liveEntry ? (parseFloat(liveEntry.price) || 0) : 0;
        var o = ownedMap[e.sym];
        var req = BENEFIT_REQ[e.sym] || 0;
        // Use this entry's specific tier number, not the overall increment
        var entryTierNum = parseInt(e.tier.replace("T",""), 10) || 0;
        // Shares belonging to THIS tier only: (2^n - 2^(n-1)) * BENEFIT_REQ
        var tierShares = entryTierNum > 0 ? (Math.pow(2, entryTierNum) - Math.pow(2, entryTierNum - 1)) * req : 0;
        var saleValue = tierShares * livePrice * 0.999;
        // Live cost of this tier's shares
        var liveTierCost = tierShares * livePrice;
        var entryRoi = liveTierCost > 0 && e.payout ? (e.payout / liveTierCost * (365 / (e.freq || 7)) * 100) : 0;
        if (entryRoi > 0 && entryRoi < targetRoi && saleValue > 0) {
          sellCandidates.push({
            sym: e.sym,
            tier: e.tier,
            roi: entryRoi,
            saleValue: saleValue,
            weekly: weekly
          });
        }
      });
      sellCandidates.sort(function(a, b) { return a.roi - b.roi; }); // lowest ROI first
    }

    // Build HTML
    var isDark = document.getElementById("tsa-overlay").classList.contains("tsa-dark");
    var c = isDark ? {
      bg:"#0f0f1a", border:"#2a2a4a", bg2:"#0d0d18", bg3:"#0c0c16",
      text:"#c8c8d8", muted:"#7a7a9a", mono:"JetBrains Mono,monospace",
      blue:"#7a9fd4", green:"#4cff91", red:"#cc4444", yellow:"#f5c542", owned_bg:"rgba(40,180,100,0.07)",
      owned_border:"rgba(76,255,145,0.4)", next_bg:"rgba(74,111,165,0.1)",
      next_border:"rgba(122,159,212,0.5)", skip_bg:"rgba(180,40,40,0.06)",
      skip_border:"rgba(255,80,80,0.3)", neutral:"#7a7a9a", row_border:"#13131f",
      divider:"#1a1a2e", tag_bg:"rgba(120,140,200,0.08)", tag_border:"rgba(120,140,200,0.15)", tag_text:"#8898bb",
      bridge_bg:"rgba(90,180,80,0.09)", bridge_border:"rgba(76,255,145,0.45)", bridge:"#5ab450"
    } : {
      bg:"#ffffff", border:"#ddd", bg2:"#f7f9fc", bg3:"#f0f4ff",
      text:"#222", muted:"#666", mono:"Arial,sans-serif",
      blue:"#4a6fa5", green:"#1a8a45", red:"#cc2222", yellow:"#b07800", owned_bg:"#edfaf3",
      owned_border:"#a8e6c0", next_bg:"#f0f4ff", next_border:"#c0d0ff",
      skip_bg:"#fff0f0", skip_border:"#ffb3b3", neutral:"#aaa", row_border:"#eee",
      divider:"#eee", tag_bg:"#f0f4ff", tag_border:"#c0d0ff", tag_text:"#4a6fa5",
      bridge_bg:"#edfff0", bridge_border:"#80c880", bridge:"#1a7a35"
    };

    var s = 'font-family:' + c.mono + ';';

    // Capital bar
    var swingTagsHtml = swingDetails.slice(0,4).map(function(d){
      return '<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:' + c.tag_bg + ';border:1px solid ' + c.tag_border + ';color:' + c.tag_text + ';' + s + 'margin-right:4px">' + d.sym + ' ' + fmRoi(d.val) + '</span>';
    }).join('');
    if (armoryFunds > 0) {
      swingTagsHtml = '<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:' + c.tag_bg + ';border:1px solid ' + c.tag_border + ';color:' + c.tag_text + ';' + s + 'margin-right:4px">Armory ' + fmRoi(armoryFunds) + '</span>' + swingTagsHtml;
    }
    if (cashBalance > 0) {
      swingTagsHtml = '<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:' + c.tag_bg + ';border:1px solid ' + c.tag_border + ';color:' + c.tag_text + ';' + s + 'margin-right:4px">Cash ' + fmRoi(cashBalance) + '</span>' + swingTagsHtml;
    }

    var html = '<div style="padding:8px 14px;border-bottom:1px solid ' + c.divider + ';background:' + c.bg2 + '">' +
      '<div style="font-size:9px;letter-spacing:0.1em;color:' + c.muted + ';text-transform:uppercase;margin-bottom:3px">Available capital</div>' +
      '<div style="' + s + 'font-size:14px;font-weight:700;color:' + c.text + '">' + fmRoi(totalCapital) + '</div>' +
      '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">' + swingTagsHtml + '</div>' +
      '</div>';

    // Next move section
    if (target) {
      var nmRow = function(label, val, color) {
        return '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
          '<span style="font-size:9px;color:' + c.muted + ';text-transform:uppercase;letter-spacing:0.08em;' + s + '">' + label + '</span>' +
          '<span style="font-size:10px;color:' + (color||c.text) + ';' + s + ';text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%">' + val + '</span>' +
          '</div>';
      };

      html += '<div style="padding:10px 14px;border-bottom:2px solid ' + c.divider + ';background:' + c.bg3 + '">';
      html += '<div style="font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:' + c.blue + ';' + s + ';font-weight:700;margin-bottom:8px">💡 Next move</div>';

      // Target
      var shortBy = Math.max(0, target.cost - totalCapital);
      var targetTier = target.tier || ("T" + target.tierInfo.nextIncrement);
      html += nmRow("Target", target.sym + " " + targetTier + " · " + (target.roi || 0).toFixed(2) + "% ROI", c.blue);
      html += nmRow("Cost", fmRoi(target.cost) + (shortBy > 0 ? " · short " + fmRoi(shortBy) : " ✓"), shortBy > 0 ? c.red : c.green);
      html += nmRow("Available", fmRoi(totalCapital), c.text);

      // Bridgebuilder chain — buy and hold, each block adds dividend income
      html += '<div style="border-top:1px solid ' + c.divider + ';margin:6px 0"></div>';
      html += '<div style="font-size:9px;color:#5a7a4a;letter-spacing:0.08em;' + s + ';margin-bottom:5px">🔗 Bridgebuilder</div>';

      var hasSell = sellCandidates && sellCandidates.length > 0;

      if (bridgeChain.length > 0) {
        bridgeChain.forEach(function(b) {
          var statusColor = b.status === "now" ? c.green : c.muted;
          var statusLabel = b.status === "now"
            ? "✓ Buy now"
            : "in ~" + b.daysUntil + "d · saves " + b.daysSaved + "d";
          var roiStr = b.roi > 0 ? " · " + b.roi.toFixed(1) + "%" : "";
          html += nmRow(
            "🔗 " + b.sym + " " + b.tier + roiStr,
            fmRoi(b.cost) + " · +" + fmRoi(b.extraIncome) + "/7d · " + statusLabel,
            statusColor
          );
        });
        var savedDays = daysBaseline - daysWithBridges;
        if (savedDays > 0) {
          html += nmRow(
            "Goal with bridges",
            "~" + daysWithBridges + "d (saves " + savedDays + "d)",
            c.green
          );
        }
      } else {
        html += nmRow("", "No bridgebuilder options", c.muted);
      }

      if (hasSell) {
        html += '<div style="margin:4px 0;border-top:1px dashed ' + c.divider + '"></div>';
        html += '<div style="font-size:9px;color:#5a6a7a;letter-spacing:0.08em;' + s + ';margin-bottom:5px">💸 Alt: Sell lower ROI blocks</div>';
        var cumulativeSale = 0;
        var cumulativeLostIncome = 0;
        sellCandidates.slice(0, 4).forEach(function(sc) {
          cumulativeSale += sc.saleValue;
          cumulativeLostIncome += sc.weekly;
          var daysIfSold = daysToAfford(target.cost - cumulativeSale, totalCapital, weeklyIncome - cumulativeLostIncome);
          html += nmRow("Sell " + sc.sym + " " + sc.tier + " · " + sc.roi.toFixed(1) + "%", fmRoi(sc.saleValue) + " → ~" + daysIfSold + "d", c.muted);
        });
      }

      // Alt: Wait
      html += '<div style="border-top:1px solid ' + c.divider + ';margin:6px 0"></div>';
      html += '<div style="font-size:9px;color:#5a6a7a;letter-spacing:0.08em;' + s + ';margin-bottom:5px">⏱ Alt: Wait</div>';
      html += nmRow("Income", fmRoi(weeklyIncome) + " / 7d (current benefits)");

      // Income breakdown
      var incomeBreakdown = [];
      Object.keys(ownedMap).forEach(function(sym) {
        var o = ownedMap[sym];
        if (!o.has_dividend || o.benefit_shares <= 0) return;
        var increments = o.dividend_increment || 0;
        if (increments <= 0) return;
        var stockWeekly = 0;
        var itemName = "";
        ROI_TABLE.forEach(function(entry) {
          if (entry.sym !== sym) return;
          var tierNum = parseInt(entry.tier.replace("T",""), 10);
          if (tierNum > increments) return;
          var bItemVal = getItemValue(entry);
          var bPerCycle = (entry.item && bItemVal > 0) ? bItemVal : entry.payout;
          stockWeekly += bPerCycle / entry.freq * 7;
          if (entry.item) itemName = getItemName(entry.item) || itemName;
        });
        if (stockWeekly > 0) {
          incomeBreakdown.push(sym + (itemName ? " (" + itemName + ")" : "") + " " + fmRoi(stockWeekly));
        }
      });
      if (incomeBreakdown.length > 0) {
        html += nmRow("Breakdown", incomeBreakdown.slice(0,3).join(" · "));
        if (incomeBreakdown.length > 3) html += nmRow("", incomeBreakdown.slice(3,6).join(" · "));
      }
      html += nmRow("Goal in", daysWait === 0 ? "Now!" : daysWait === Infinity ? "N/A" : "~" + daysWait + " days", c.text);
      html += '</div>';
    }

    // Hidden stocks dropdown
    if (roiSkipped.length > 0) {
      html += '<div id="tsa-hidden-stocks-bar" style="border-bottom:1px solid ' + c.divider + ';background:' + c.bg2 + '">' +
        '<button id="tsa-hidden-stocks-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:7px 14px;background:none;border:none;cursor:pointer;font-family:' + c.mono + '">' +
          '<span style="font-size:10px;color:' + c.red + ';font-weight:600;letter-spacing:0.06em;text-transform:uppercase">Hidden stocks (' + roiSkipped.length + ')</span>' +
          '<span id="tsa-hidden-stocks-caret" style="font-size:10px;color:' + c.muted + '">▶</span>' +
        '</button>' +
        '<div id="tsa-hidden-stocks-list" style="display:none">' +
          roiSkipped.map(function(key) {
            var sym = key.replace(/T\d+$/, "");
            var tier = key.match(/T\d+$/);
            tier = tier ? tier[0] : "";
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 14px;border-top:1px solid ' + c.divider + '">' +
              '<span style="' + s + ';font-size:12px;font-weight:700;color:' + c.red + '">' + sym + ' <span style="font-size:10px;font-weight:400;color:' + c.muted + '">' + tier + '</span></span>' +
              '<button class="tsa-roi-skip" data-key="' + key + '" data-owned="0" title="Restore" style="width:28px;height:28px;border-radius:50%;border:1px solid ' + c.divider + ';background:none;cursor:pointer;font-size:12px;color:' + c.muted + ';display:flex;align-items:center;justify-content:center">↩</button>' +
            '</div>';
          }).join("") +
        '</div>' +
      '</div>';
    }

    // Table header
    html += '<div style="display:grid;grid-template-columns:42px 26px 1fr 54px 32px;gap:4px;padding:5px 14px;font-size:9px;letter-spacing:0.1em;color:' + c.muted + ';text-transform:uppercase;border-bottom:1px solid ' + c.divider + ';' + s + ';position:sticky;top:0;background:' + c.bg + ';z-index:2;">' +
      '<span>Stock</span><span>Tier</span><span>Shares needed / Cost</span><span style="text-align:right">ROI</span><span></span></div>';


    // Show all benefit stocks: owned tiers first (green), then next tiers sorted by ROI
    var tableRows = [];
    // Add owned entries
    ownedEntries.forEach(function(e) {
      var o = ownedMap[e.sym];
      // Days remaining = frequency - progress (both already stored from API)
      var freq = (o && o.dividend_frequency) || e.freq || 0;
      var prog = (o && o.dividend_progress) || 0;
      var daysLeft = (freq > 0 && prog >= 0) ? Math.max(0, freq - prog) : -1;
      tableRows.push({ sym: e.sym, tier: e.tier, isOwned: true, cost: 0, roi: 0, sharesNeeded: 0, payout: e.payout || 0, freq: freq, daysLeft: daysLeft });
    });
    // Add next tier for each stock
    dynamicNextTiers.forEach(function(e) {
      var key = e.sym + "T" + e.tierInfo.nextIncrement;
      var isNext = nextEntries.some(function(ne) { return ne.sym === e.sym && ne.tier === "T" + e.tierInfo.nextIncrement; });
      var isBridge = bridgeChain.some(function(b) { return b.sym === e.sym && b.tier === "T" + e.tierInfo.nextIncrement; });
      var isSkipped = roiSkipped.indexOf(key) >= 0;
      tableRows.push({
        sym: e.sym,
        tier: "T" + e.tierInfo.nextIncrement,
        isOwned: false,
        isNext: isNext,
        isBridge: !!isBridge,
        isSkipped: isSkipped,
        cost: e.cost,
        roi: e.roi,
        sharesNeeded: e.tierInfo.sharesNeeded,
        payout: e.payoutEntry ? e.payoutEntry.payout : 0,
        freq: e.payoutEntry ? e.payoutEntry.freq : 7,
        item: e.payoutEntry ? e.payoutEntry.item : 0,
        key: key
      });
    });

    tableRows.forEach(function(row) {
      var rowBg = row.isOwned ? c.owned_bg : row.isNext ? c.next_bg : row.isBridge ? c.bridge_bg : row.isSkipped ? c.skip_bg : "transparent";
      var borderLeft = row.isOwned ? c.owned_border : row.isNext ? c.next_border : row.isBridge ? c.bridge_border : row.isSkipped ? c.skip_border : "transparent";
      var symColor = row.isOwned ? c.green : row.isNext ? c.blue : row.isBridge ? c.bridge : row.isSkipped ? c.red : c.neutral;
      var roiPct = row.isBridge ? "🔗 " + row.roi.toFixed(2) + "%" : row.roi > 0 ? row.roi.toFixed(2) + "%" : "—";
      var itemVal = row.item ? getItemValue({ sym: row.sym, item: row.item }) : 0;
      var nextPayoutStr = "";
      if (row.isOwned && row.daysLeft >= 0) {
        nextPayoutStr = row.daysLeft === 0 ? " · next <1d" : " · next " + row.daysLeft + "d";
      }
      var nextPayoutColor = (row.isOwned && row.daysLeft >= 0 && row.daysLeft <= 1) ? c.yellow : c.muted;
      var costLine = row.isOwned ? "Owned" :
        row.sharesNeeded.toLocaleString("en-US") + " shares · " + fmRoi(row.cost);
      var skipBtnStyle = 'width:28px;height:28px;border-radius:50%;border:1px solid ' + c.divider + ';background:none;cursor:pointer;font-size:10px;color:' + c.muted + ';display:flex;align-items:center;justify-content:center;justify-self:center;' + (row.isOwned ? 'opacity:0.2;pointer-events:none;' : '');
      var skipLabel = row.isSkipped ? "↩" : "✕";
      var key = row.key || (row.sym + row.tier);

      var buyAttrs = (!row.isOwned && row.sharesNeeded > 0)
        ? ' class="tsa-roi-buyrow" data-buy-sym="' + row.sym + '" data-buy-shares="' + row.sharesNeeded + '" data-buy-tier="' + row.tier + '" data-buy-state="0"'
        : '';
      html += '<div data-roi-key="' + key + '"' + buyAttrs + ' style="display:grid;grid-template-columns:42px 26px 1fr 54px 32px;gap:4px;align-items:center;padding:7px 14px;border-bottom:1px solid ' + c.row_border + ';background:' + rowBg + ';border-left:2px solid ' + borderLeft + ';cursor:' + (buyAttrs ? 'pointer' : 'default') + ';transition:background 0.15s">' +
        '<span style="' + s + ';font-weight:700;font-size:12px;color:' + symColor + '">' + row.sym + '</span>' +
        '<span style="' + s + ';font-size:9px;color:' + c.muted + '">' + row.tier + '</span>' +
        '<div style="display:flex;flex-direction:column;gap:1px;overflow:hidden;min-width:0">' +
          '<span style="' + s + ';font-size:10px;color:' + c.muted + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + costLine + (nextPayoutStr ? '<span style="color:' + nextPayoutColor + '">' + nextPayoutStr + '</span>' : '') + '</span>' +
          '<span style="font-size:9px;color:' + c.muted + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + fmRoi(row.payout) + " / " + row.freq + "d" + (itemVal > 0 ? " · live " + fmRoi(itemVal) : "") + "</span>" +
        '</div>' +
        '<span style="' + s + ';font-size:11px;font-weight:700;text-align:right;color:' + symColor + '">' + roiPct + '</span>' +
        '<button class="tsa-roi-skip" data-key="' + key + '" data-owned="' + (row.isOwned?1:0) + '" style="' + skipBtnStyle + '">' + skipLabel + '</button>' +
        '</div>';
    });

    return html;
  }

  function showROIPlanner(ownedMap, raw) {
    var content = document.getElementById("tsa-content");
    if (!content) return;
    var isDarkNow = document.getElementById("tsa-overlay").classList.contains("tsa-dark");
    content.style.background = isDarkNow ? "#0f0f1a" : "#ffffff";
    content.style.color = isDarkNow ? "#c8c8d8" : "#222";
    content.innerHTML = '<div style="padding:20px;text-align:center;color:' + (isDarkNow ? '#7a7a9a' : '#888') + ';font-size:12px"><span class="tsa-spinner"></span>Loading...</div>';

    // Shared listener setup — used by both success and catch paths
    function attachListeners() {
      content.querySelectorAll(".tsa-roi-skip").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          if (btn.dataset.owned === "1") return;
          var k = btn.dataset.key;
          var idx = roiSkipped.indexOf(k);
          if (idx >= 0) roiSkipped.splice(idx, 1);
          else roiSkipped.push(k);
          lsSet("tsa_roi_skipped", JSON.stringify(roiSkipped));
          showROIPlanner(ownedMap, raw);
        });
      });
      var toggleBtn = content.querySelector("#tsa-hidden-stocks-toggle");
      if (toggleBtn) {
        toggleBtn.addEventListener("click", function() {
          var list = content.querySelector("#tsa-hidden-stocks-list");
          var caret = content.querySelector("#tsa-hidden-stocks-caret");
          if (!list) return;
          var open = list.style.display !== "none";
          list.style.display = open ? "none" : "block";
          if (caret) caret.textContent = open ? "▶" : "▼";
        });
      }

      content.querySelectorAll(".tsa-roi-buyrow").forEach(function(row) {
        row.addEventListener("click", function(e) {
          if (e.target.closest(".tsa-roi-skip")) return;
          var sym    = row.dataset.buySym;
          var shares = parseInt(row.dataset.buyShares, 10);
          var tier   = row.dataset.buyTier;
          qtBuildMaps();
          var price  = qtGetPrice(sym);
          var cash   = qtGetMoneyFast();
          // Tier buys must hit the exact share count to unlock the benefit
          // block — refuse rather than partial-buy wasted shares.
          if (price > 0 && cash > 0 && shares * price > cash) {
            showToast("Need $" + (shares * price - cash).toLocaleString("en-US") + " more for " + sym + " " + tier, "warn");
            return;
          }
          qtUiTrade(sym, shares, "buyShares", "Bought " + shares.toLocaleString("en-US") + " " + sym + " (" + tier + ")");
          showROIPlanner(ownedMap, raw);
        });
      });
    }

    function renderAndAttach(cashBalance, armoryFunds) {
      fetchAllItemPrices(function() {
        content.innerHTML = renderROIPlanner(ownedMap, raw, cashBalance, armoryFunds);
        attachListeners();
        var isDarkFooter = document.getElementById("tsa-overlay").classList.contains("tsa-dark");
        var footerDivider = isDarkFooter ? "#1a1a2e" : "#eee";
        var footerBg      = isDarkFooter ? "#0f0f1a" : "#ffffff";
        content.insertAdjacentHTML("beforeend",
          '<div style="padding:7px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid ' + footerDivider + ';background:' + footerBg + '">' +
            '<span style="font-size:9px;color:#555">✕ skip &nbsp;·&nbsp; ↩ unskip</span>' +
            '<span style="font-size:9px;color:#555;font-family:monospace">Updated ' + new Date().toLocaleTimeString("en-GB") + '</span>' +
          '</div>'
        );
      });
    }

    var key = getTornKey();
    Promise.all([
      fetchJSON("https://api.torn.com/user/?selections=basic,money&key=" + key).catch(function() { return null; }),
      fetchJSON("https://api.torn.com/faction/?selections=donations&key=" + key).catch(function() { return null; })
    ]).then(function(results) {
      var cashBalance = 0;
      var armoryFunds = 0;
      var userData = results[0];
      var factionData = results[1];
      if (userData && !userData.error) {
        cashBalance = userData.money_onhand || 0;
        var playerId = userData.player_id;
        if (playerId && factionData && factionData.donations && factionData.donations[playerId]) {
          armoryFunds = factionData.donations[playerId].money_balance || 0;
        }
      }
      renderAndAttach(cashBalance, armoryFunds);
    }).catch(function() {
      renderAndAttach(0, 0);
    });
  }

  function injectStyles() {
    var el = document.createElement("style");
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  function fetchJSON(url, retries) {
    if (retries === undefined) retries = 3;
    return new Promise(function(resolve, reject) {
      var attempt = function(n) {
        GM_xmlhttpRequest({
          method: "GET", url: url,
          onload: function(r) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) {
              if (n > 1) { setTimeout(function() { attempt(n - 1); }, 2000); }
              else reject(new Error("Parse error: " + r.responseText.substring(0, 80)));
            }
          },
          onerror: function() {
            if (n > 1) { setTimeout(function() { attempt(n - 1); }, 2000); }
            else reject(new Error("Network error after 3 attempts: " + url));
          }
        });
      };
      attempt(retries);
    });
  }

  function buildOwnedMap(tornData) {
    var owned = {};
    if (!tornData || !tornData.stocks) return owned;
    Object.keys(tornData.stocks).forEach(function(id) {
      var s = tornData.stocks[id];
      var acronym = STOCK_ID_MAP[parseInt(id, 10)];
      if (!acronym) return;
      var transactions = s.transactions ? Object.keys(s.transactions).map(function(k) { return s.transactions[k]; }) : [];
      if (transactions.length === 0) return;
      // Total shares from ALL transactions regardless of bought_price
      var totalShares = 0, earliestTime = Infinity;
      transactions.forEach(function(t) {
        totalShares += t.shares || 0;
        if (t.time_bought && t.time_bought < earliestTime) earliestTime = t.time_bought;
      });
      // avg_price: only transactions with bought_price > 0
      // Torn API returns bought_price=0 for old/benefit-era purchases — skip those
      var validCostShares = 0, totalCost = 0;
      transactions.forEach(function(t) {
        if (t.bought_price && t.bought_price > 0) {
          validCostShares += t.shares || 0;
          totalCost += (t.shares || 0) * t.bought_price;
        }
      });
      var avg_price = validCostShares > 0 ? totalCost / validCostShares : 0;

      // Use Torn API's increment field — it is the active/confirmed tier
      var apiIncrement = (s.dividend && s.dividend.increment) || 0;

      // benefit_shares and swing_shares will be calculated by enrichOwnedMap
      // after live prices are available — store raw data only for now
      owned[acronym] = {
        shares: totalShares,
        swing_shares: 0,         // recalculated in enrichOwnedMap
        benefit_shares: 0,       // recalculated in enrichOwnedMap
        avg_price: avg_price,
        time_bought: earliestTime === Infinity ? null : earliestTime,
        has_dividend: apiIncrement > 0,
        has_swing: false,        // recalculated in enrichOwnedMap
        dividend_progress: (s.dividend && s.dividend.progress) || 0,
        dividend_frequency: (s.dividend && s.dividend.frequency) || 0,
        dividend_increment: apiIncrement,
        dividend_next: 0, // not exposed by API — calculated from progress/frequency
        transactions: transactions.sort(function(a, b) { return b.time_bought - a.time_bought; })
      };
    });
    return owned;
  }

  // Enrich ownedMap with correct benefit_shares and swing_shares
  // Uses BENEFIT_REQ (fixed share counts per BB — Torn game mechanic, never changes)
  // and dividend.increment from API
  // Formula: benefit_shares = BENEFIT_REQ[sym] × (2^increment - 1)
  // swing_shares = total_shares - benefit_shares
  function enrichOwnedMap(ownedMap, raw) {
    Object.keys(ownedMap).forEach(function(sym) {
      var o = ownedMap[sym];
      var increment = o.dividend_increment || 0;
      var totalShares = o.shares || 0;

      if (increment <= 0) {
        o.benefit_shares = 0;
        o.swing_shares = totalShares;
        o.has_dividend = false;
        o.has_swing = totalShares > 0;
        return;
      }

      var req = BENEFIT_REQ[sym] || 0;
      // If user has bought enough shares for a higher tier (pending next dividend day),
      // treat those extra shares as BB rather than swing.
      var effectiveIncrement = increment;
      if (req > 0) {
        while (totalShares >= (Math.pow(2, effectiveIncrement + 1) - 1) * req) {
          effectiveIncrement++;
        }
      }
      var benefitShares = req > 0 ? (Math.pow(2, effectiveIncrement) - 1) * req : 0;
      benefitShares = Math.min(benefitShares, totalShares);
      var swingShares = Math.max(0, totalShares - benefitShares);

      o.benefit_shares = benefitShares;
      o.swing_shares = swingShares;
      o.has_dividend = benefitShares > 0;
      o.has_swing = swingShares > 0;
    });
    return ownedMap;
  }

  function mergeIntervals(calls) {
    var merged = {};
    calls.forEach(function(call) {
      var stocks = call.data || call;
      if (!Array.isArray(stocks)) return;
      stocks.forEach(function(s) {
        if (!merged[s.stock]) {
          merged[s.stock] = Object.assign({}, s, {interval: {}});
        }
        Object.assign(merged[s.stock].interval, s.interval || {});
        if (s.price) merged[s.stock].price = s.price;
        if (s.investors) merged[s.stock].investors = s.investors;
      });
    });
    return Object.values(merged);
  }

  function calcScore(stock, raw, ownedMap, priceHistory) {
    var s = stock.toUpperCase();
    var r = raw ? raw.find(function(x) { return x.stock === s; }) : null;
    if (!r) return null;

    var owned = ownedMap[s];
    var isInBenefitCategory = owned && owned.has_dividend && owned.benefit_shares > 0;
    var p_live = parseFloat(r.price) || 0;

    // Extract all intervals
    var p_m30 = parseFloat((r.interval && r.interval.m30 && r.interval.m30.price)) || 0;
    var p_h1  = parseFloat((r.interval && r.interval.h1  && r.interval.h1.price))  || 0;
    var p_h2  = parseFloat((r.interval && r.interval.h2  && r.interval.h2.price))  || 0;
    var p_h3  = parseFloat((r.interval && r.interval.h3  && r.interval.h3.price))  || 0;
    var p_h4  = parseFloat((r.interval && r.interval.h4  && r.interval.h4.price))  || 0;
    var p_h6  = parseFloat((r.interval && r.interval.h6  && r.interval.h6.price))  || 0;
    var p_h8  = parseFloat((r.interval && r.interval.h8  && r.interval.h8.price))  || 0;
    var p_h12 = parseFloat((r.interval && r.interval.h12 && r.interval.h12.price)) || 0;
    var p_h16 = parseFloat((r.interval && r.interval.h16 && r.interval.h16.price)) || 0;
    var p_h20 = parseFloat((r.interval && r.interval.h20 && r.interval.h20.price)) || 0;
    var p_d1  = parseFloat((r.interval && r.interval.d1  && r.interval.d1.price))  || 0;
    var p_d2  = parseFloat((r.interval && r.interval.d2  && r.interval.d2.price))  || 0;
    var p_d3  = parseFloat((r.interval && r.interval.d3  && r.interval.d3.price))  || 0;
    var p_d4  = parseFloat((r.interval && r.interval.d4  && r.interval.d4.price))  || 0;
    var p_d5  = parseFloat((r.interval && r.interval.d5  && r.interval.d5.price))  || 0;
    var p_d7  = parseFloat((r.interval && r.interval.d7  && r.interval.d7.price))  || 0;
    var p_w1  = parseFloat((r.interval && r.interval.w1  && r.interval.w1.price))  || 0;

    var score = 0;
    var reasons = [];
    var scoreBreakdown = { drop: 0, position: 0, reversal: 0, macd: 0, rsi: 0 };

    // ── DOWNTREND DETECTION ───────────────────────────────────────────
    // Check if stock is in a sustained downtrend across 3 timeframe groups.
    // Each group requires all 3 intervals to be consecutively declining.
    var trendDownShort  = p_m30 > 0 && p_h1 > 0 && p_h2 > 0  && p_m30 < p_h1 && p_h1 < p_h2;
    var trendDownMedium = p_h2  > 0 && p_h4 > 0 && p_h8 > 0  && p_h2  < p_h4 && p_h4 < p_h8;
    var trendDownLong   = p_h8  > 0 && p_h12> 0 && p_d1 > 0  && p_h8  < p_h12 && p_h12 < p_d1;
    var downtrendCount  = (trendDownShort ? 1 : 0) + (trendDownMedium ? 1 : 0) + (trendDownLong ? 1 : 0);
    var sustainedDowntrend = downtrendCount >= 2;

    // Pre-compute weekly peak (used by both the hard filter and indicator 1)
    var weekPrices = [p_d1,p_d2,p_d3,p_d4,p_d5,p_d7,p_w1].filter(function(x){ return x > 0; });
    var weekPeak = weekPrices.length > 0 ? Math.max.apply(null, weekPrices) : 0;

    // ── HARD FILTER: must be below the weekly high ────────────────────
    // Live must be below the recent weekly peak — blocks scoring once the
    // opportunity has passed. Uses the actual highest price seen this week
    // (max of d1-d7/w1), NOT just w1, so mid-week peaks are captured correctly.
    if (weekPeak > 0 && p_live >= weekPeak) {
      return {
        symbol: s, score: 0, signal: "WAIT", sellSignal: null,
        scoreBreakdown: { drop: 0, position: 0, reversal: 0 },
        owned: !!owned, alreadyRallied: false, priceAboveWeek: true,
        has_swing: (owned && owned.has_swing) || false,
        has_benefit: (owned && owned.has_dividend) || false,
        hasDividend: (owned && owned.has_dividend) || false,
        dividendProgress: (owned && owned.dividend_progress) || 0,
        dividendFrequency: (owned && owned.dividend_frequency) || 0,
        p_live, reasons: "Above weekly peak",
        netProfitPct: (owned && owned.avg_price > 0) ? ((p_live * 0.999 - owned.avg_price) / owned.avg_price * 100) : null,
        hoursHeld: (owned && owned.time_bought) ? ((Date.now()/1000 - owned.time_bought)/3600).toFixed(0) : null,
        shares: (owned && owned.shares) || 0,
        avg_price: (owned && owned.avg_price) || 0,
        transactions: (owned && owned.transactions) || []
      };
    }

    // ── 1. DROP FROM WEEKLY PEAK (max 60p) ───────────────────────────
    // How far has price dropped from its weekly high?
    // Drop threshold is dynamic: based on stock's average daily volatility (1x)
    var dropFromWeekPeak = 0;

    // Calculate dynamic drop threshold from localStorage history (avg hourly % change × 24)
    var dynamicDropThreshold = -1.0; // fallback
    var histPrices = priceHistory && priceHistory[s.toUpperCase()];
    if (histPrices && histPrices.length >= 48) {
      var sortedHist = histPrices.slice().sort(function(a,b){ return a.ts - b.ts; });
      var hPrices = sortedHist.map(function(e){ return e.price; });
      var changes = [];
      for (var hi = 1; hi < hPrices.length; hi++) {
        if (hPrices[hi-1] > 0) changes.push(Math.abs(hPrices[hi] - hPrices[hi-1]) / hPrices[hi-1] * 100);
      }
      if (changes.length > 0) {
        var avgHourlyVol = changes.reduce(function(a,b){ return a+b; }, 0) / changes.length;
        dynamicDropThreshold = -Math.max(0.5, avgHourlyVol * 24);
      }
    }

    if (weekPrices.length > 0) {
      dropFromWeekPeak = ((p_live - weekPeak) / weekPeak) * 100;
      // Score relative to dynamic threshold; halved during sustained downtrend
      var dt = dynamicDropThreshold; // negative value e.g. -1.2
      var dropMult = sustainedDowntrend ? 0.5 : 1.0;
      var dp = 0;
      if      (dropFromWeekPeak <= dt * 4.0) dp = Math.round(60 * dropMult);
      else if (dropFromWeekPeak <= dt * 2.5) dp = Math.round(50 * dropMult);
      else if (dropFromWeekPeak <= dt * 1.5) dp = Math.round(40 * dropMult);
      else if (dropFromWeekPeak <= dt * 1.0) dp = Math.round(30 * dropMult);
      else if (dropFromWeekPeak <= dt * 0.5) dp = Math.round(15 * dropMult);
      score += dp; scoreBreakdown.drop = dp; reasons.push("Drop " + dropFromWeekPeak.toFixed(1) + "%");
    }

    // ── 2. NEAR SHORT-TERM BOTTOM (max 35p) ──────────────────────────
    // Is live near the bottom of its recent (h1-d2) range?
    var shortPrices = [p_h1,p_h2,p_h3,p_h4,p_h6,p_h8,p_h12,p_h16,p_h20,p_d1,p_d2].filter(function(x){ return x > 0; });
    if (shortPrices.length >= 2) {
      var shortLow  = Math.min.apply(null, shortPrices);
      var shortHigh = Math.max.apply(null, shortPrices);
      var shortRange = shortHigh - shortLow;
      if (shortRange > 0) {
        if (p_live < shortLow) {
          // Stock is below its own recent range — still making new lows, not at support
          reasons.push("New low — still falling");
        } else {
          var posInShort = ((p_live - shortLow) / shortRange) * 100;
          if      (posInShort <= 10) { score += 35; scoreBreakdown.position = 35; reasons.push("Near bottom " + posInShort.toFixed(0) + "%"); }
          else if (posInShort <= 25) { score += 25; scoreBreakdown.position = 25; reasons.push("Low pos " + posInShort.toFixed(0) + "%"); }
          else if (posInShort <= 40) { score += 15; scoreBreakdown.position = 15; reasons.push("Pos " + posInShort.toFixed(0) + "%"); }
          else if (posInShort <= 55) { score += 5;  scoreBreakdown.position = 5;  reasons.push("Pos " + posInShort.toFixed(0) + "%"); }
          else                       {              reasons.push("High pos " + posInShort.toFixed(0) + "%"); }
        }
      }
    }

    // ── 3. TREND REVERSAL / UPTREND (max 40p) ────────────────────────
    // Detects upward trend at multiple timeframes — 5 tiers in priority order:
    //   40p  m30>h1>h2>h4  Active uptrend confirmed across 4 intervals
    //   30p  m30>h1>h2     Active rise (2h confirmed, not yet 4h)
    //   25p  h1>h2>h4      Multi-hour recovery — small m30 dip is ok (uptrend with dip)
    //   15p  m30>h1        Just started rising
    //    5p  flat ≤0.1%    Stabilizing
    //    0p  falling       Still falling
    var m30Valid = p_m30 > 0, h1Valid = p_h1 > 0, h2Valid = p_h2 > 0, h4Valid = p_h4 > 0;
    if (m30Valid && h1Valid && h2Valid && h4Valid) {
      var r_m30_h1 = p_m30 > p_h1;
      var r_h1_h2  = p_h1  > p_h2;
      var r_h2_h4  = p_h2  > p_h4;
      if (r_m30_h1 && r_h1_h2 && r_h2_h4) {
        score += 40; scoreBreakdown.reversal = 40; reasons.push("Active uptrend (4h)");
      } else if (r_m30_h1 && r_h1_h2) {
        score += 30; scoreBreakdown.reversal = 30; reasons.push("Active rise");
      } else if (r_h1_h2 && r_h2_h4) {
        score += 25; scoreBreakdown.reversal = 25; reasons.push("Recovering +" + ((p_h1 - p_h2) / p_h2 * 100).toFixed(2) + "%");
      } else if (r_m30_h1) {
        score += 15; scoreBreakdown.reversal = 15; reasons.push("Rising +" + ((p_m30 - p_h1) / p_h1 * 100).toFixed(2) + "%");
      } else if (Math.abs(p_m30 - p_h1) / p_h1 * 100 <= 0.1) {
        score += 5; scoreBreakdown.reversal = 5; reasons.push("Stabilizing");
      } else {
        reasons.push("Still falling " + ((p_m30 - p_h1) / p_h1 * 100).toFixed(2) + "%");
      }
    } else if (m30Valid && h1Valid && h2Valid) {
      var r_m30_h1 = p_m30 > p_h1;
      var r_h1_h2  = p_h1  > p_h2;
      if (r_m30_h1 && r_h1_h2) {
        score += 30; scoreBreakdown.reversal = 30; reasons.push("Active rise");
      } else if (r_m30_h1) {
        score += 15; scoreBreakdown.reversal = 15; reasons.push("Rising +" + ((p_m30 - p_h1) / p_h1 * 100).toFixed(2) + "%");
      } else if (Math.abs(p_m30 - p_h1) / p_h1 * 100 <= 0.1) {
        score += 5; scoreBreakdown.reversal = 5; reasons.push("Stabilizing");
      } else {
        reasons.push("Still falling " + ((p_m30 - p_h1) / p_h1 * 100).toFixed(2) + "%");
      }
    } else if (m30Valid && h1Valid) {
      if (p_m30 > p_h1) {
        score += 15; scoreBreakdown.reversal = 15; reasons.push("Rising");
      } else {
        reasons.push("Falling");
      }
    }

    // ── 4. MACD (max 25p) ────────────────────────────────────────────
    var macdResult = calcMACD(s, priceHistory);
    if (macdResult !== null) {
      if (macdResult.crossover) {
        score += 25; scoreBreakdown.macd = 25; reasons.push("MACD crossover");
      } else if (macdResult.macd > macdResult.signal) {
        score += 12; scoreBreakdown.macd = 12; reasons.push("MACD bullish");
      } else {
        reasons.push("MACD bearish");
      }
    }

    // ── 5. RSI (max 20p) — Torn-calibrated via percentile ───────────
    // Uses the stock's own RSI history to define "oversold" for that specific
    // stock, instead of generic 30/70 real-market thresholds.
    var rsiCtx = calcRSIContext(s, priceHistory);
    var rsi = rsiCtx ? rsiCtx.rsi : null;
    var rsiPercentile = rsiCtx ? rsiCtx.percentile : null;

    if (rsiPercentile !== null) {
      // Percentile-based: how low is current RSI vs this stock's own RSI history
      if      (rsiPercentile <= 10) { score += 20; scoreBreakdown.rsi = 20; reasons.push("RSI " + rsi.toFixed(0) + " (btm 10%)"); }
      else if (rsiPercentile <= 25) { score += 12; scoreBreakdown.rsi = 12; reasons.push("RSI " + rsi.toFixed(0) + " (btm 25%)"); }
      else if (rsiPercentile <= 40) { score += 6;  scoreBreakdown.rsi = 6;  reasons.push("RSI " + rsi.toFixed(0)); }
      else                          {                                         reasons.push("RSI " + rsi.toFixed(0)); }
    } else if (rsi !== null) {
      // Fallback: absolute RSI with Torn-adjusted thresholds (conservative — Torn
      // stocks lack the liquidity floor that real markets provide)
      if      (rsi <= 35) { score += 15; scoreBreakdown.rsi = 15; reasons.push("RSI " + rsi.toFixed(0)); }
      else if (rsi <= 45) { score += 7;  scoreBreakdown.rsi = 7;  reasons.push("RSI " + rsi.toFixed(0)); }
      else                {                                         reasons.push("RSI " + rsi.toFixed(0)); }
    }

    // ── HARD FILTERS ─────────────────────────────────────────────────
    // Include m30: Torn prices can swing and bounce within a single hour — without
    // m30 the "already rallied" filter would miss intra-hour dip-and-recover moves.
    var recentPrices = [p_m30,p_h1,p_h2,p_h4,p_h8,p_h12,p_d1].filter(function(x){ return x > 0; });
    var recentLow = recentPrices.length > 0 ? Math.min.apply(null, recentPrices) : 0;
    // Already rallied if price has recovered more than half of the weekly drop
    var rallyPct = recentLow > 0 && p_live > recentLow ? ((p_live - recentLow) / recentLow * 100) : 0;
    var rallyThreshold = dropFromWeekPeak < 0 ? Math.abs(dropFromWeekPeak) / 2 : 0.3;
    var alreadyRallied = rallyPct > rallyThreshold;
    // RSI overbought: use top-85th percentile when available, else absolute >65
    var rsiOverbought = rsiPercentile !== null ? rsiPercentile >= 85 : (rsi !== null && rsi > 65);
    var priceAboveWeek = p_w1 > 0 && p_live > p_w1;

    if (sustainedDowntrend) reasons.unshift("Downtrend (" + downtrendCount + "/3)");

    // SIGNAL THRESHOLDS
    // Reversal is gated at two levels:
    //   hasReversal       = reversal >= 25p  (h1>h2>h4 — 4h recovery confirmed, small m30 dip ok)
    //   hasStrongReversal = reversal >= 30p  (m30>h1>h2 — active rise, current momentum confirmed)
    //
    // A single 30-min bounce (15p) only qualifies for CONSIDER, not BUY.
    // STRONG BUY: needs active rise + MACD crossover + high score.
    // BUY (downtrend):  needs active rise (30p) — 4h recovery alone is not enough.
    // BUY (no downtrend): needs 4h recovery (25p) or better.
    // CONSIDER: no reversal required — watch list for potential setups.
    var hasReversal       = scoreBreakdown.reversal >= 25;
    var hasStrongReversal = scoreBreakdown.reversal >= 30;
    var signal;
    if (score >= 100 && scoreBreakdown.macd >= 25 && hasStrongReversal) signal = "STRONG BUY";
    else if (score >= 75 && (hasStrongReversal || (hasReversal && !sustainedDowntrend))) signal = "BUY";
    else if (score >= 45) signal = "CONSIDER";
    else                  signal = "WAIT";

    // Hard-filter cap: if the entry is already rallied / above weekly average /
    // RSI overbought, the technical setup may exist but the entry window is poor.
    // Downgrade STRONG BUY and BUY → CONSIDER so the label reflects the caution
    // (rather than excluding the stock from the Top 5 list entirely).
    if (alreadyRallied || priceAboveWeek || rsiOverbought) {
      if (signal === "STRONG BUY" || signal === "BUY") signal = "CONSIDER";
    }

    // SELL LOGIC
    var sellSignal = null, netProfitPct = null, hoursHeld = null;
    var isBenefitBlock = isInBenefitCategory;

    // Calculate profit % for ALL owned stocks — include 0.1% sell fee for accurate P/L
    if (owned && owned.avg_price > 0) {
      netProfitPct = ((p_live * 0.999 - owned.avg_price) / owned.avg_price * 100);
      hoursHeld = owned.time_bought
        ? ((Date.now() / 1000 - owned.time_bought) / 3600).toFixed(0)
        : null;
    }

    // Sell signal ONLY for swing trades
    if (owned && owned.avg_price > 0 && !isBenefitBlock) {
      var profitTarget = getProfitTarget();
      var stopLossThreshold = getStopLoss();
      if (netProfitPct >= profitTarget)              sellSignal = "PROFIT";
      else if (netProfitPct <= -stopLossThreshold)   sellSignal = "STOP LOSS";
    }

    return {
      symbol: s, score, signal, sellSignal,
      scoreBreakdown: scoreBreakdown,
      sustainedDowntrend: sustainedDowntrend,
      owned: !!owned,
      alreadyRallied: alreadyRallied,
      rsiOverbought: rsiOverbought,
      priceAboveWeek: p_w1 > 0 && p_live > p_w1,
      has_swing: (owned && owned.has_swing) || false,
      has_benefit: (owned && owned.has_dividend) || false,
      hasDividend: (owned && owned.has_dividend) || false,
      dividendProgress: (owned && owned.dividend_progress) || 0,
      dividendFrequency: (owned && owned.dividend_frequency) || 0,
      p_live, reasons: reasons.join(" | "), netProfitPct, hoursHeld,
      shares: (owned && owned.shares) || 0,
      avg_price: (owned && owned.avg_price) || 0,
      transactions: (owned && owned.transactions) || []
    };
  }

  function getProfitTarget() {
    return parseFloat(lsGet("tsa_profit_target", "0.3"));
  }

  function getStopLoss() {
    return parseFloat(lsGet("tsa_stop_loss", "1.0"));
  }

  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // Dedup identical toasts within 3 seconds. Stops Benefit-Lock-cap and similar
  // warnings from spamming the screen on rapid clicks.
  var lastToastMsg = "";
  var lastToastTs = 0;
  function showToast(msg, type) {
    var now = Date.now();
    if (msg === lastToastMsg && (now - lastToastTs) < 3000) return;
    lastToastMsg = msg;
    lastToastTs = now;
    var colors = {
      success: { bg:"rgba(20,160,70,0.93)",  border:"#4cff91", icon:"✓" },
      error:   { bg:"rgba(170,20,50,0.93)",  border:"#ff4c6a", icon:"✕" },
      warn:    { bg:"rgba(150,110,0,0.93)",  border:"#ffc107", icon:"!" },
      info:    { bg:"rgba(40,70,140,0.93)",  border:"#7a9fd4", icon:"i" }
    };
    var c = colors[type] || colors.info;
    var toast = document.createElement("div");
    toast.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:2147483648;" +
      "max-width:280px;padding:10px 14px;border-radius:10px;border-left:3px solid " + c.border + ";" +
      "background:" + c.bg + ";color:#fff;font-family:JetBrains Mono,monospace;font-size:12px;" +
      "font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.4);display:flex;align-items:center;" +
      "gap:8px;animation:tsaToastIn 0.2s ease";
    toast.innerHTML = "<span style='font-size:14px;flex-shrink:0'>" + c.icon + "</span><span>" + escHtml(msg) + "</span>";
    document.body.appendChild(toast);
    setTimeout(function() {
      toast.style.opacity = "0";
      toast.style.transition = "opacity 0.3s";
      setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 320);
    }, 3000);
  }

  function updateCountdownLabel() {
    var el = document.getElementById("tsa-countdown");
    if (!el) return;
    if (!autoRefreshEndTime) { el.textContent = ""; return; }
    var rem = Math.max(0, autoRefreshEndTime - Date.now());
    var m = Math.floor(rem / 60000);
    var s = Math.floor((rem % 60000) / 1000);
    el.textContent = " · " + m + "m " + (s < 10 ? "0" : "") + s + "s";
  }

  var API_ERRORS = {
    "Incorrect key":  "Invalid API key — click 🔑 to update it.",
    "Access level":   "API key is missing required permissions — click 🔑 to create a new key.",
    "Too many":       "Too many requests — wait a moment and try again.",
    "Player not found": "Player profile not found. Check the API key."
  };

  function friendlyApiError(msg) {
    var keys = Object.keys(API_ERRORS);
    for (var i = 0; i < keys.length; i++) {
      if (msg && msg.indexOf(keys[i]) !== -1) return API_ERRORS[keys[i]];
    }
    return msg;
  }

  function getTsaStorageSize() {
    var total = 0;
    try {
      Object.keys(localStorage).forEach(function(key) {
        if (key.indexOf("tsa") === 0 || key.indexOf("qt_") === 0) {
          total += (lsGet(key) || "").length;
        }
      });
    } catch(e) {}
    if (total < 1024) return total + " B";
    if (total < 1024 * 1024) return (total / 1024).toFixed(1) + " KB";
    return (total / (1024 * 1024)).toFixed(2) + " MB";
  }

  function getProfitSwingOnly() {
    return lsGet("tsa_profit_swing_only", "true") !== "false";
  }
  function getShowWatch() {
    return lsGet("tsa_show_watch", "true") !== "false";
  }
  function getShowQtChart() {
    return lsGet("tsa_show_qt_chart", "true") !== "false";
  }
  function getTop5MinScore() {
    var v = parseInt(lsGet("tsa_top5_min_score", "35"), 10);
    return isNaN(v) ? 35 : v;
  }
  function getRequirePositiveInvestors() {
    return lsGet("tsa_require_positive_investors", "false") === "true";
  }
  function getShowRealized() {
    return lsGet("tsa_show_realized", "false") === "true";
  }

  function getOverlayPosition() {
    return lsGet("tsa_overlay_position", "bottom-right");
  }

  function applyOverlayPosition(pos) {
    var p = {
      "bottom-right": { btn: { bottom:"80px",  top:"auto", right:"16px", left:"auto" }, overlay: { bottom:"130px", top:"auto", right:"16px", left:"auto" } },
      "bottom-left":  { btn: { bottom:"80px",  top:"auto", right:"auto", left:"16px" }, overlay: { bottom:"130px", top:"auto", right:"auto", left:"16px" } },
      "top-right":    { btn: { bottom:"auto",  top:"16px", right:"16px", left:"auto" }, overlay: { bottom:"auto",  top:"60px", right:"16px", left:"auto" } },
      "top-left":     { btn: { bottom:"auto",  top:"16px", right:"auto", left:"16px" }, overlay: { bottom:"auto",  top:"60px", right:"auto", left:"16px" } }
    }[pos] || { btn: { bottom:"80px", top:"auto", right:"16px", left:"auto" }, overlay: { bottom:"130px", top:"auto", right:"16px", left:"auto" } };
    var btn = document.getElementById("tsa-btn");
    var ov  = document.getElementById("tsa-overlay");
    if (btn) { btn.style.bottom = p.btn.bottom; btn.style.top = p.btn.top; btn.style.right = p.btn.right; btn.style.left = p.btn.left; }
    if (ov)  { ov.style.bottom  = p.overlay.bottom; ov.style.top = p.overlay.top; ov.style.right = p.overlay.right; ov.style.left = p.overlay.left; }
  }
  function getRealizedDays() {
    return parseInt(lsGet("tsa_realized_days", "7"), 10);
  }
  function getRealizedEvents() {
    try { return JSON.parse(localStorage.getItem("tsa_realized_events") || "[]"); }
    catch(e) { return []; }
  }
  function getRealizedTotal() {
    var days = getRealizedDays();
    var cutoff = (Date.now() / 1000) - (days * 86400);
    return getRealizedEvents()
      .filter(function(e) { return e.ts >= cutoff; })
      .reduce(function(sum, e) { return sum + (e.profit || 0); }, 0);
  }

  function getRealizedByStock() {
    var days = getRealizedDays();
    var cutoff = (Date.now() / 1000) - (days * 86400);
    var byStock = {};
    getRealizedEvents()
      .filter(function(e) { return e.ts >= cutoff; })
      .forEach(function(e) { byStock[e.sym] = (byStock[e.sym] || 0) + (e.profit || 0); });
    return byStock;
  }

  // Remove buy intents older than 24 hours to avoid stale slippage warnings
  function cleanOldIntents() {
    var cutoff = Math.floor(Date.now() / 1000) - 86400;
    try {
      Object.keys(localStorage).forEach(function(key) {
        if (key.indexOf("qt_intent_") !== 0) return;
        var v = JSON.parse(localStorage.getItem(key) || "null");
        if (!v || v.ts < cutoff) localStorage.removeItem(key);
      });
    } catch(e) {}
  }

  function loadData() {
    cleanOldIntents();
    var content = document.getElementById("tsa-content");
    var isDarkMode = document.getElementById("tsa-overlay").classList.contains("tsa-dark");
    content.style.background = isDarkMode ? "#0f0f1a" : "#ffffff";

    // Check for API key
    var key = getTornKey();
    if (!key || key === "###PDA-APIKEY###") {
      showKeyOnboarding(content, function() { loadData(); });
      return;
    }

    content.innerHTML = "<div class=\"tsa-loading\">Fetching data...</div>";

    Promise.all([
      fetchJSON("https://api.torn.com/user/?selections=stocks&key=" + getTornKey()),
      fetchJSON("https://tornsy.com/api/stocks?interval=m30,h1,h2,h3,h4"),
      fetchJSON("https://tornsy.com/api/stocks?interval=h6,h8,h10,h12,h16"),
      fetchJSON("https://tornsy.com/api/stocks?interval=h20,d1,d2,d3,d4"),
      fetchJSON("https://tornsy.com/api/stocks?interval=d5,d6,d7,w1,h5")
    ]).then(function(results) {
      var tornData = results[0];
      var t1 = results[1];
      var t2 = results[2];
      var t3 = results[3];
      var t4 = results[4];

      if (tornData.error) { throw new Error(friendlyApiError(tornData.error.error)); }

      var ownedMap = buildOwnedMap(tornData);
      var ownedSymbols = Object.keys(ownedMap);
      var raw = mergeIntervals([t1, t2, t3, t4]);

      // Enrich ownedMap with correct benefit_shares/swing_shares using live prices
      enrichOwnedMap(ownedMap, raw);

      // Track realized profit from sold positions
      if (getShowRealized()) {
        try {
          var prevHoldings = JSON.parse(localStorage.getItem("tsa_prev_holdings") || "{}");
          var realizedEvents = getRealizedEvents();
          var nowTs = Math.floor(Date.now() / 1000);
          var prevSyms = Object.keys(prevHoldings);
          for (var rpi = 0; rpi < prevSyms.length; rpi++) {
            var rpSym = prevSyms[rpi];
            var prevEntry = prevHoldings[rpSym];
            if (!prevEntry) continue;
            var curEntry = ownedMap[rpSym];
            var prevShares = prevEntry.shares || 0;
            var curShares = curEntry ? (curEntry.shares || 0) : 0;
            var soldShares = prevShares - curShares;
            if (soldShares <= 0) continue;
            var rpRaw = raw ? raw.find(function(x) { return x.stock === rpSym; }) : null;
            var liveP = rpRaw ? (parseFloat(rpRaw.price) || 0) : 0;
            var costP = prevEntry.avg_price || 0;
            if (liveP <= 0 || costP <= 0) continue;
            var realizedProfit = (liveP * 0.999 - costP) * soldShares;
            realizedEvents.push({ ts: nowTs, profit: realizedProfit, sym: rpSym, sell_price: liveP });
          }
          // Trim events older than 90 days. Keep entries that are missing `ts`
          // (legacy data from older TSA versions that didn't record a timestamp)
          // — discarding them silently would lose the user's realized-P/L history.
          var trim90 = nowTs - 90 * 86400;
          realizedEvents = realizedEvents.filter(function(e) { return !e.ts || e.ts >= trim90; });
          localStorage.setItem("tsa_realized_events", JSON.stringify(realizedEvents));
        } catch(e) {}
        // Save current holdings snapshot for next comparison
        var holdingsSnap = {};
        Object.keys(ownedMap).forEach(function(s) {
          holdingsSnap[s] = { shares: ownedMap[s].shares || 0, avg_price: ownedMap[s].avg_price || 0 };
        });
        lsSet("tsa_prev_holdings", JSON.stringify(holdingsSnap));
      }

      // Store for ROI planner
      lastOwnedMap = ownedMap;
      lastRaw = raw;

      // Calculate best ROI recommendation for Quick Trade bar
      var benefitSymsForRec = Object.keys(BENEFIT_REQ);
      var recCandidates = [];
      benefitSymsForRec.forEach(function(sym) {
        var tierInfo = calcNextTier(sym, ownedMap, raw);
        if (!tierInfo || tierInfo.sharesNeeded <= 0) return;
        var payoutEntry = ROI_MAP[sym + "|T" + tierInfo.nextIncrement] || null;
        if (!payoutEntry) {
          // Fallback: find highest available tier for this sym
          for (var ri2 = ROI_TABLE.length - 1; ri2 >= 0; ri2--) {
            if (ROI_TABLE[ri2].sym === sym) { payoutEntry = ROI_TABLE[ri2]; break; }
          }
        }
        var roi = payoutEntry ? (payoutEntry.payout / tierInfo.cost * (365 / payoutEntry.freq) * 100) : 0;
        recCandidates.push({ sym: sym, tierInfo: tierInfo, cost: tierInfo.cost, roi: roi });
      });
      recCandidates.sort(function(a, b) { return b.roi - a.roi; });
      lastBestRec = recCandidates[0] || null;
      updateQtRecommendation(null);

      // Check price alerts
      checkAlerts(raw);

      // Record live prices to history — returns saved object to avoid re-parsing
      var _savedHistory = recordPrices(raw);

      // Update chart with selected stock
      var currentStock = lsGet("qt_last_stock", "");
      if (currentStock) qtDrawChart(currentStock);

      // If ROI planner is active, show it instead
      if (roiPlannerActive) { showROIPlanner(ownedMap, raw); return; }
      function safeParseArr(key) { try { return JSON.parse(localStorage.getItem(key) || "[]") || []; } catch(e) { return []; } }
      var hiddenStocks = safeParseArr("tsa_hidden");

      var cachedPriceHistory = _savedHistory || loadHistory();
      var stockResults = STOCKS_LIST
        .map(function(s) { return calcScore(s, raw, ownedMap, cachedPriceHistory); })
        .filter(Boolean)
        .sort(function(a, b) { return b.score - a.score; });

      // Log buy signals to history
      recordSignals(stockResults);

      // Snapshot prices for trend arrows on next load
      var prevPrices = {};
      Object.keys(lastLoadPrices).forEach(function(k) { prevPrices[k] = lastLoadPrices[k]; });
      stockResults.forEach(function(s) { if (s.p_live > 0) lastLoadPrices[s.symbol] = s.p_live; });

      var top5MinScore = getTop5MinScore();
      var cachedInvHistory = loadInvestorHistory();
      stockResults.forEach(function(s) {
        s.invDelta = getInvestorDelta(s.symbol, cachedInvHistory);
      });
      // Hard filters (rallied / above-week / overbought) no longer exclude here —
      // they're now reflected in the signal label (capped at CONSIDER) so the
      // user still sees the stock with a clear "don't buy now" indicator.
      var top5BuyAll = stockResults.filter(function(s) {
        if (s.score < top5MinScore) return false;
        if (getRequirePositiveInvestors() && (s.invDelta === null || s.invDelta <= 0)) return false;
        if (!s.owned) return true;
        // Owned stocks only show in top 5 if BUY or above (score >= 75)
        return s.score >= 75;
      });
      // Pinned stocks bubble to top
      top5BuyAll.sort(function(a, b) {
        var ap = tsaPinned.indexOf(a.symbol) >= 0 ? 0 : 1;
        var bp = tsaPinned.indexOf(b.symbol) >= 0 ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return b.score - a.score;
      });
      var top5Buy = top5BuyAll.slice(0, 5);

      // WATCH: all owned stocks with score 45-74 not already in top5Buy.
      // Hard filters are now expressed via the signal label, not exclusion.
      var watchList = stockResults.filter(function(s) {
        if (!s.owned) return false;
        if (s.score < 45 || s.score >= 75) return false;
        return !top5Buy.some(function(b) { return b.symbol === s.symbol; });
      });

      var bbWidthCache = {};
      top5Buy.concat(watchList).forEach(function(s) {
        bbWidthCache[s.symbol] = calcBBWidth(s.symbol, cachedPriceHistory);
      });

      var fm = function(n) {
        var abs = Math.abs(n), sign = n < 0 ? "-" : "+";
        if (abs >= 1e9) return sign + "$" + (abs/1e9).toFixed(1) + "B";
        if (abs >= 1e6) return sign + "$" + (abs/1e6).toFixed(1) + "M";
        if (abs >= 1e3) return sign + "$" + (abs/1e3).toFixed(0) + "K";
        return sign + "$" + abs.toFixed(0);
      };

      var totalProfit = 0;
      var ownedKeys = Object.keys(ownedMap);
      for (var ki = 0; ki < ownedKeys.length; ki++) {
        var profitSym = ownedKeys[ki];
        var ownedEntry = ownedMap[profitSym];
        // Filter by swing-only setting
        if (getProfitSwingOnly() && (!ownedEntry.has_swing || ownedEntry.swing_shares <= 0)) continue;
        var rawEntry = raw ? raw.find(function(x) { return x.stock === profitSym; }) : null;
        if (!rawEntry) continue;
        var livePrice = parseFloat(rawEntry.price) || 0;
        if (livePrice <= 0) continue;

        // For mixed stocks (benefit + swing) in swing-only mode, count only the swing portion
        var isMixedStock = ownedEntry.has_dividend && ownedEntry.swing_shares > 0 && ownedEntry.benefit_shares > 0;
        if (getProfitSwingOnly() && isMixedStock) {
          var swingCost = ownedEntry.avg_price || 0;
          if (swingCost > 0) {
            totalProfit += (livePrice * 0.999 - swingCost) * ownedEntry.swing_shares;
          }
        } else {
          // Calculate profit per transaction using bought_price if available,
          // otherwise fall back to avg_price for transactions with bought_price=0
          var fallbackAvg = ownedEntry.avg_price || 0;
          var txProfit = 0;
          var txCounted = false;
          if (ownedEntry.transactions && ownedEntry.transactions.length > 0) {
            ownedEntry.transactions.forEach(function(t) {
              var shares = t.shares || 0;
              if (shares <= 0) return;
              var costPrice = (t.bought_price && t.bought_price > 0) ? t.bought_price : fallbackAvg;
              if (costPrice <= 0) return;
              txProfit += (livePrice * 0.999 - costPrice) * shares;
              txCounted = true;
            });
          }
          if (txCounted) totalProfit += txProfit;
        }
      }

      // Colour palette based on dark mode
      var isDark2 = document.getElementById("tsa-overlay").classList.contains("tsa-dark");
      var d = isDark2 ? {
        bg:"#0f0f1a", bg2:"#0d0d18", bg3:"#1a1a2e", border:"#2a2a4a",
        text:"#c8c8d8", muted:"#7a7a9a", blue:"#7a9fd4",
        green:"#4cff91", red:"#ff4c6a", yellow:"#ffc107",
        rowBuy:"rgba(76,255,145,0.08)", rowBuyBorder:"rgba(76,255,145,0.2)",
        rowSell:"rgba(255,76,106,0.08)", rowSellBorder:"rgba(255,76,106,0.2)",
        rowBenefit:"rgba(160,160,255,0.05)", rowBenefitBorder:"rgba(160,160,255,0.1)",
        divider:"#1a1a2e", txBg:"#0d0d18", txBorder:"#2a2a4a",
        moveBg:"rgba(255,193,7,0.1)", moveBorder:"rgba(255,193,7,0.3)", moveColor:"#ffc107",
        moveBg2:"rgba(122,159,212,0.1)", moveBorder2:"rgba(122,159,212,0.3)", moveColor2:"#7a9fd4",
        mono:"JetBrains Mono,monospace"
      } : {
        bg:"#ffffff", bg2:"#f7f9fc", bg3:"#f0f4ff", border:"#eee",
        text:"#222", muted:"#888", blue:"#4a6fa5",
        green:"#1a8a45", red:"#cc2222", yellow:"#856404",
        rowBuy:"#edfaf3", rowBuyBorder:"#a8e6c0",
        rowSell:"#fff0f0", rowSellBorder:"#ffb3b3",
        rowBenefit:"#f0f4ff", rowBenefitBorder:"#c0d0ff",
        divider:"#eee", txBg:"#f9f9f9", txBorder:"#e0e0e0",
        moveBg:"#fff3cd", moveBorder:"#ffc107", moveColor:"#856404",
        moveBg2:"#f0f4ff", moveBorder2:"#c0d0ff", moveColor2:"#4a6fa5",
        mono:"Arial,sans-serif"
      };
      var ms = "font-family:" + d.mono + ";";

      var html = "<div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 14px;border-bottom:1px solid " + d.border + ";background:" + d.bg + "\">" +
        "<div style=\"background:" + d.bg2 + ";border-radius:8px;padding:8px;text-align:center;border:1px solid " + d.border + "\">" +
          "<div style=\"font-size:10px;color:" + d.muted + ";margin-bottom:4px\">Analyzed</div>" +
          "<div style=\"font-size:16px;font-weight:bold;color:" + d.text + ";" + ms + "\">" + stockResults.length + "</div></div>" +
        "<div style=\"background:" + d.bg2 + ";border-radius:8px;padding:8px;text-align:center;border:1px solid " + d.border + "\">" +
          "<div style=\"font-size:10px;color:" + d.muted + ";margin-bottom:4px\">You own</div>" +
          "<div style=\"font-size:16px;font-weight:bold;color:" + d.text + ";" + ms + "\">" + ownedSymbols.length + "</div></div>" +
        (function() {
          var showRealized = getShowRealized();
          var realizedTotal = showRealized ? getRealizedTotal() : 0;
          var realDays = getRealizedDays();
          if (showRealized) {
            var realExpanded = lsGet("tsa_realized_expanded", "false") === "true";
            var byStock = realExpanded ? getRealizedByStock() : {};
            var stockKeys = Object.keys(byStock).sort(function(a, b) { return Math.abs(byStock[b]) - Math.abs(byStock[a]); });
            var detailHtml = stockKeys.map(function(sym) {
              var p = byStock[sym];
              return "<div style=\"display:flex;justify-content:space-between;padding:1px 0;\">" +
                "<span style=\"font-size:9px;color:" + d.muted + "\">" + sym + "</span>" +
                "<span style=\"font-size:9px;font-weight:bold;color:" + (p >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(p) + "</span>" +
              "</div>";
            }).join("");
            return "<div style=\"background:" + d.bg2 + ";border-radius:8px;padding:8px;border:1px solid " + d.border + "\">" +
              "<div style=\"display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px\">" +
                "<div style=\"font-size:9px;color:" + d.muted + "\">Open P/L</div>" +
                "<div style=\"font-size:13px;font-weight:bold;color:" + (totalProfit >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(totalProfit) + "</div>" +
              "</div>" +
              "<div id=\"tsa-realized-row\" style=\"display:flex;justify-content:space-between;align-items:baseline;cursor:pointer;\">" +
                "<div style=\"font-size:9px;color:" + d.muted + "\">Real. " + realDays + "d " + (realExpanded ? "&#9660;" : "&#9658;") + "</div>" +
                "<div style=\"font-size:13px;font-weight:bold;color:" + (realizedTotal >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(realizedTotal) + "</div>" +
              "</div>" +
              (realExpanded && stockKeys.length > 0 ? "<div style=\"margin-top:4px;border-top:1px solid " + d.border + ";padding-top:4px\">" + detailHtml + "</div>" : "") +
            "</div>";
          } else {
            return "<div style=\"background:" + d.bg2 + ";border-radius:8px;padding:8px;text-align:center;border:1px solid " + d.border + "\">" +
              "<div style=\"font-size:10px;color:" + d.muted + ";margin-bottom:4px\">Trading profit</div>" +
              "<div style=\"font-size:16px;font-weight:bold;color:" + (totalProfit >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(totalProfit) + "</div></div>";
          }
        })() +
        "</div>";

      function buildBreakdownHtml(bd) {
        var rows = [
          { label: "Drop from weekly peak",    pts: bd.drop || 0,     max: 60 },
          { label: "Position in range",         pts: bd.position || 0, max: 35 },
          { label: "Trend reversal / uptrend",  pts: bd.reversal || 0, max: 40 },
          { label: "MACD",                      pts: bd.macd || 0,     max: 25 },
          { label: "RSI (Torn-calibrated)",     pts: bd.rsi || 0,      max: 20 },
        ];
        return rows.map(function(row) {
          var barW = row.max > 0 ? Math.round((row.pts / row.max) * 100) : 0;
          var barColor = row.pts >= row.max * 0.75 ? d.green : row.pts >= row.max * 0.4 ? d.yellow : d.muted;
          var maxBadge = row.pts === row.max ? " <span style=\"color:" + d.green + ";font-size:9px\">★ MAX</span>" : "";
          return "<div style=\"margin-bottom:6px\">" +
            "<div style=\"display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px\">" +
            "<span style=\"color:" + d.muted + "\">" + row.label + "</span>" +
            "<span style=\"color:" + d.text + ";font-weight:bold;" + ms + "\">" + row.pts + " / " + row.max + "p" + maxBadge + "</span>" +
            "</div>" +
            "<div style=\"height:4px;background:" + d.border + ";border-radius:2px\">" +
            "<div style=\"height:4px;width:" + barW + "%;background:" + barColor + ";border-radius:2px\"></div>" +
            "</div></div>";
        }).join("");
      }

      function buildBbHtml(bbCtx) {
        if (!bbCtx || bbCtx.percentile === null) return "";
        var bbBarW = Math.round(bbCtx.percentile);
        var bbColor = bbCtx.percentile <= 15 ? d.yellow :
                      bbCtx.percentile <= 65 ? d.muted :
                      bbCtx.percentile <= 85 ? d.green : d.red;
        return "<div style=\"margin-bottom:6px;border-top:1px solid " + d.divider + ";padding-top:6px\">" +
          "<div style=\"display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px\">" +
          "<span style=\"color:" + d.muted + "\">Volatility</span>" +
          "<span style=\"color:" + bbColor + ";font-weight:bold;" + ms + "\">" + bbCtx.label + " · " + bbBarW + "%</span>" +
          "</div>" +
          "<div style=\"height:4px;background:" + d.border + ";border-radius:2px\">" +
          "<div style=\"height:4px;width:" + bbBarW + "%;background:" + bbColor + ";border-radius:2px\"></div>" +
          "</div></div>";
      }

      // Builds a "gap to next signal" hint line for the score breakdown panel.
      // Shows how many points are missing and which indicators have the most
      // unrealized potential to get there.
      function buildGapHtml(bd, score, signal, inDowntrend) {
        var SCORE_FOR_NEXT = { "WAIT": 45, "CONSIDER": 75, "BUY": 100 };
        var nextLabel = signal === "WAIT" ? "CONSIDER" : signal === "CONSIDER" ? "BUY" : signal === "BUY" ? "STRONG BUY" : null;
        if (!nextLabel) return "";
        var nextThreshold = SCORE_FOR_NEXT[signal];
        var gap = nextThreshold - score;
        if (gap <= 0) gap = 0;

        // Reversal requirement note for BUY and STRONG BUY transitions
        var reversalNote = "";
        if (nextLabel === "BUY") {
          reversalNote = inDowntrend ? " + active rise (30p)" : " + 4h recovery (25p)";
        } else if (nextLabel === "STRONG BUY") {
          reversalNote = " + active rise (30p) + MACD crossover";
        }

        // Indicators sorted by unrealized potential
        var indicators = [
          { label: "stronger drop",          max: 60, pts: bd.drop     || 0 },
          { label: "trend reversal/uptrend", max: 40, pts: bd.reversal || 0 },
          { label: "lower range position",   max: 35, pts: bd.position || 0 },
          { label: "MACD crossover",         max: 25, pts: bd.macd     || 0 },
          { label: "lower RSI",              max: 20, pts: bd.rsi      || 0 },
        ];
        indicators.sort(function(a, b) { return (b.max - b.pts) - (a.max - a.pts); });
        var useful = indicators.filter(function(i) { return gap > 0 && (i.max - i.pts) >= 5; }).slice(0, 2);
        var needsStr = useful.length
          ? " — needs " + useful.map(function(i) { return i.label; }).join(" OR ")
          : "";

        var gapColor = gap <= 15 ? d.green : gap <= 30 ? d.yellow : d.muted;
        var gapText = gap === 0 ? "score ok" : gap + "p";
        return "<div style=\"margin-bottom:4px;padding:5px 8px;border-radius:6px;" +
          "background:" + (isDark2 ? "rgba(122,159,212,0.07)" : "#f0f4ff") + ";" +
          "border:1px solid " + (isDark2 ? "rgba(122,159,212,0.15)" : "#c0d0ff") + "\">" +
          "<span style=\"font-size:10px;color:" + d.muted + "\">To " + nextLabel + ": </span>" +
          "<span style=\"font-size:10px;font-weight:bold;color:" + gapColor + ";" + ms + "\">" + gapText + "</span>" +
          (reversalNote ? "<span style=\"font-size:10px;color:" + d.yellow + "\">" + reversalNote + "</span>" : "") +
          "<span style=\"font-size:10px;color:" + d.muted + "\">" + needsStr + "</span>" +
          "</div>";
      }

      if (top5Buy.length > 0) {
        html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
          "<div style=\"font-size:10px;letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">" +
          "Top " + top5Buy.length + " buy</div>";
        top5Buy.forEach(function(s) {
          var breakdownId = "tsa-breakdown-" + s.symbol;
          var bd = s.scoreBreakdown || {};
          var invDelta = s.invDelta;
          var invHtml = "";
          if (invDelta !== null) {
            var invColor = invDelta > 0 ? d.green : invDelta < 0 ? d.red : d.muted;
            var invSign = invDelta > 0 ? "+" : "";
            invHtml = " <span style=\"font-size:9px;color:" + invColor + ";font-weight:bold\">" + invSign + invDelta.toLocaleString("en-US") + " inv 24h</span>";
          }
          var bdHtml = buildBreakdownHtml(bd);
          var signalColor = s.signal === "STRONG BUY" ? "#FFD700" : s.signal === "BUY" ? d.green : s.signal === "CONSIDER" ? "#FFA500" : d.muted;
          // Color based on ownership: unowned=green, owned swing=amber, owned benefit=blue
          var symColor = !s.owned ? d.green : s.has_benefit ? d.blue : d.yellow;
          var rowBg = !s.owned ? d.rowBuy : s.has_benefit ? d.rowBenefit : (isDark2 ? "rgba(255,193,7,0.07)" : "#fffbeb");
          var rowBorder = !s.owned ? d.rowBuyBorder : s.has_benefit ? d.rowBenefitBorder : (isDark2 ? "rgba(255,193,7,0.25)" : "#fde68a");

          // Trend arrow vs previous load
          var prevP = prevPrices[s.symbol];
          var trendHtml = "";
          if (prevP && prevP > 0 && s.p_live > 0) {
            var diff = ((s.p_live - prevP) / prevP * 100);
            if (Math.abs(diff) >= 0.01) {
              var trendCol = diff > 0 ? d.green : d.red;
              var trendArr = diff > 0 ? "↑" : "↓";
              trendHtml = "<span style=\"font-size:9px;color:" + trendCol + ";font-weight:bold;margin-left:4px\">" + trendArr + Math.abs(diff).toFixed(2) + "%</span>";
            }
          }
          var isPinned = tsaPinned.indexOf(s.symbol) >= 0;
          var pinBtnHtml = "<button class=\"tsa-pin-btn" + (isPinned ? " pinned" : "") + "\" data-sym=\"" + s.symbol + "\" title=\"" + (isPinned ? "Unpin" : "Pin to top") + "\">📌</button>";

          var bbHtml = buildBbHtml(bbWidthCache[s.symbol]);

          html += "<div style=\"margin-bottom:5px\">" +
            "<div class=\"tsa-buy-row\" data-symbol=\"" + s.symbol + "\" data-breakdown=\"" + breakdownId + "\" style=\"display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;cursor:pointer;background:" + rowBg + ";border:1px solid " + rowBorder + "\">" +
            "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
            "<span style=\"font-size:13px;font-weight:bold;color:" + symColor + ";" + ms + "\">" + s.symbol + trendHtml + " " + pinBtnHtml + "</span>" +
            "<span style=\"font-size:10px;color:" + d.muted + "\">" + s.reasons.split(" | ").slice(0,2).join(" · ") + invHtml + "</span>" +
            "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
            "<span style=\"font-size:14px;font-weight:bold;color:" + symColor + ";" + ms + "\">" + s.score + "</span>" +
            "<span style=\"font-size:9px;color:" + signalColor + ";font-weight:bold\">" + s.signal + "</span>" +
            "<span id=\"" + breakdownId + "-caret\" style=\"font-size:9px;color:" + d.muted + "\">▶</span>" +
            "</div></div>" +
            "<div id=\"" + breakdownId + "\" style=\"display:none;background:" + d.txBg + ";border:1px solid " + d.txBorder + ";border-top:none;border-radius:0 0 8px 8px;padding:10px 12px 8px;margin-top:-4px\">" +
            bdHtml +
            bbHtml +
            buildGapHtml(bd, s.score, s.signal, s.sustainedDowntrend) +
            "<div style=\"border-top:1px solid " + d.divider + ";margin-top:4px;padding-top:6px;display:flex;justify-content:space-between;align-items:center\">" +
            "<span style=\"font-size:10px;color:" + d.muted + "\">Total</span>" +
            "<span style=\"font-size:12px;font-weight:bold;color:" + symColor + ";" + ms + "\">" + s.score + "p · " + s.signal + "</span>" +
            "<button class=\"tsa-goto-chart\" data-symbol=\"" + s.symbol + "\" style=\"padding:5px 10px;border-radius:6px;border:1px solid " + d.border + ";background:" + d.bg2 + ";color:" + d.muted + ";font-size:10px;cursor:pointer;font-weight:bold;\">📈 Chart</button>" +
            "</div></div>" +
            "</div>";
        });
        html += "</div>";
      } else {
        html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
          "<div style=\"font-size:10px;letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">Buy signals</div>" +
          "<div style=\"color:" + d.muted + ";font-size:11px;padding:8px 0\">No signals right now</div></div>";
      }

      // WATCH section — owned stocks with CONSIDER score
      if (getShowWatch() && watchList.length > 0) {
        html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
          "<div style=\"font-size:10px;letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">Watch (" + watchList.length + ")</div>";
        watchList.forEach(function(s) {
          var watchBreakdownId = "tsa-watch-breakdown-" + s.symbol;
          var bd = s.scoreBreakdown || {};
          var bdHtml = buildBreakdownHtml(bd);
          var watchSymColor = s.has_benefit ? d.blue : d.yellow;
          var watchRowBg = s.has_benefit ? d.rowBenefit : (isDark2 ? "rgba(255,193,7,0.07)" : "#fffbeb");
          var watchRowBorder = s.has_benefit ? d.rowBenefitBorder : (isDark2 ? "rgba(255,193,7,0.25)" : "#fde68a");
          var watchBbHtml = buildBbHtml(bbWidthCache[s.symbol]);

          html += "<div style=\"margin-bottom:5px\">" +
            "<div class=\"tsa-watch-row\" data-symbol=\"" + s.symbol + "\" data-breakdown=\"" + watchBreakdownId + "\" style=\"display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;cursor:pointer;background:" + watchRowBg + ";border:1px solid " + watchRowBorder + "\">" +
            "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
            "<span style=\"font-size:13px;font-weight:bold;color:" + watchSymColor + ";" + ms + "\">" + s.symbol + "</span>" +
            "<span style=\"font-size:10px;color:" + d.muted + "\">" + s.reasons.split(" | ").slice(0,2).join(" · ") + "</span>" +
            "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
            "<span style=\"font-size:14px;font-weight:bold;color:" + watchSymColor + ";" + ms + "\">" + s.score + "</span>" +
            "<span style=\"font-size:9px;color:" + watchSymColor + ";font-weight:bold\">CONSIDER</span>" +
            "<span id=\"" + watchBreakdownId + "-caret\" style=\"font-size:9px;color:" + d.muted + "\">▶</span>" +
            "</div></div>" +
            "<div id=\"" + watchBreakdownId + "\" style=\"display:none;background:" + d.txBg + ";border:1px solid " + d.txBorder + ";border-top:none;border-radius:0 0 8px 8px;padding:10px 12px 8px;margin-top:-4px\">" +
            bdHtml +
            watchBbHtml +
            buildGapHtml(bd, s.score, s.signal, s.sustainedDowntrend) +
            "<div style=\"border-top:1px solid " + d.divider + ";margin-top:4px;padding-top:6px;display:flex;justify-content:space-between;align-items:center\">" +
            "<span style=\"font-size:10px;color:" + d.muted + "\">Total</span>" +
            "<span style=\"font-size:12px;font-weight:bold;color:" + watchSymColor + ";" + ms + "\">" + s.score + "p · CONSIDER</span>" +
            "<button class=\"tsa-goto-chart\" data-symbol=\"" + s.symbol + "\" style=\"padding:5px 10px;border-radius:6px;border:1px solid " + d.border + ";background:" + d.bg2 + ";color:" + d.muted + ";font-size:10px;cursor:pointer;font-weight:bold;\">📈 Chart</button>" +
            "</div></div>" +
            "</div>";
        });
        html += "</div>";
      }

      var allOwned = stockResults.filter(function(s) { return s.owned; });

      var isBenefitCategory = function(checkSym) {
        var o = ownedMap[checkSym];
        if (!o) return false;
        return o.has_dividend && o.benefit_shares > 0;
      };

      var isSwingCategory = function(checkSym) {
        var o = ownedMap[checkSym];
        if (!o) return false;
        return o.swing_shares > 0;
      };

      var swingTrades = allOwned.filter(function(s) { return isSwingCategory(s.symbol); });
      // Pre-compute swing-specific profit % so mixed stocks sort by the same value that is displayed
      swingTrades.forEach(function(s) {
        var owned = ownedMap[s.symbol];
        var swingPct = s.netProfitPct;
        if (owned && owned.benefit_shares > 0 && owned.swing_shares > 0 && s.p_live > 0 && s.transactions && s.transactions.length > 0) {
          var swRem = owned.swing_shares;
          var swCost = 0, swCount = 0;
          s.transactions.forEach(function(t) {
            if (swRem <= 0) return;
            var take = Math.min(t.shares || 0, swRem);
            var price = (t.bought_price && t.bought_price > 0) ? t.bought_price : (s.avg_price || 0);
            if (price > 0) { swCost += take * price; swCount += take; }
            swRem -= (t.shares || 0);
          });
          if (swCount > 0) { swingPct = (s.p_live * 0.999 - swCost / swCount) / (swCost / swCount) * 100; }
        }
        s._swingDisplayPct = swingPct;
      });
      swingTrades.sort(function(a, b) { return (b._swingDisplayPct || -Infinity) - (a._swingDisplayPct || -Infinity); });

      // Browser notifications for PROFIT / STOP LOSS signals on swing trades
      (function() {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        var notified;
        try { notified = JSON.parse(localStorage.getItem("tsa_notified_signals") || "{}"); } catch(e) { notified = {}; }
        // Remove stale entries for signals that are no longer active
        var activeKeys = {};
        swingTrades.forEach(function(s) { if (s.sellSignal) activeKeys[s.symbol + "|" + s.sellSignal] = true; });
        Object.keys(notified).forEach(function(k) { if (!activeKeys[k]) delete notified[k]; });
        // Notify for new signals not yet seen
        swingTrades.forEach(function(s) {
          if (!s.sellSignal) return;
          var key = s.symbol + "|" + s.sellSignal;
          if (notified[key]) return;
          notified[key] = Date.now();
          var pct = (s.netProfitPct !== undefined ? (s.netProfitPct >= 0 ? "+" : "") + s.netProfitPct.toFixed(2) + "%" : "");
          try {
            new Notification("Torn Stock Signal", {
              body: s.symbol + " — " + s.sellSignal + (pct ? " (" + pct + ")" : ""),
              icon: "https://www.torn.com/favicon.ico"
            });
          } catch(e) {
            showToast(s.symbol + " — " + s.sellSignal + (pct ? " (" + pct + ")" : ""), "warn");
          }
        });
        lsSet("tsa_notified_signals", JSON.stringify(notified));
      })();

      var benefitBlocks = allOwned.filter(function(s) { return isBenefitCategory(s.symbol); });
      benefitBlocks.sort(function(a, b) { return (b.dividendProgress || 0) - (a.dividendProgress || 0); });

      var renderStockRow = function(s, category) {
        var owned = ownedMap[s.symbol];
        var isBenefit = category === "benefit";
        var displayShares = isBenefit
          ? ((owned && owned.benefit_shares) || s.shares)
          : ((owned && owned.swing_shares) > 0 ? owned.swing_shares : s.shares);

        // For mixed stocks in swing section: compute swing-specific avg price
        // Transactions are sorted newest-first; swing shares come from newest blocks
        var swingNetProfitPct = null;
        var swingAvgPrice = null;
        if (!isBenefit && owned && owned.benefit_shares > 0 && owned.swing_shares > 0 && s.p_live > 0 && s.transactions && s.transactions.length > 0) {
          var swRem = owned.swing_shares;
          var swCost = 0, swCount = 0;
          s.transactions.forEach(function(t) {
            if (swRem <= 0) return;
            var take = Math.min(t.shares || 0, swRem);
            var price = (t.bought_price && t.bought_price > 0) ? t.bought_price : (s.avg_price || 0);
            if (price > 0) { swCost += take * price; swCount += take; }
            swRem -= (t.shares || 0);
          });
          if (swCount > 0) {
            swingAvgPrice = swCost / swCount;
            swingNetProfitPct = (s.p_live * 0.999 - swingAvgPrice) / swingAvgPrice * 100;
          }
        }
        var displayNetProfitPct = swingNetProfitPct !== null ? swingNetProfitPct : s.netProfitPct;
        var displayValue = displayShares > 0 && s.p_live ? "$" + Math.round(displayShares * s.p_live).toLocaleString("en-US") : "";
        var sharesStr = displayShares > 0 ? displayShares.toLocaleString("en-US") + " shares" + (displayValue ? " · " + displayValue : "") : "?";
        var targetLine = "";
        if (!isBenefit && s.avg_price > 0) {
          var profitPct = getProfitTarget();
          var avgForTarget = swingAvgPrice !== null ? swingAvgPrice : s.avg_price;
          var targetPrice = avgForTarget * (1 + profitPct / 100);
          var currentPctStr = displayNetProfitPct !== null ? (displayNetProfitPct >= 0 ? "+" : "") + displayNetProfitPct.toFixed(2) + "%" : "";
          var currentPctColor = (displayNetProfitPct || 0) >= 0 ? d.green : d.red;
          targetLine = "<span style=\"font-size:10px;color:" + d.muted + "\">Avg $" + avgForTarget.toFixed(2) + " → Target <strong style=\"color:" + d.green + "\">$" + targetPrice.toFixed(2) + "</strong> (+" + profitPct.toFixed(1) + "%)" +
            (currentPctStr ? " · <strong style=\"color:" + currentPctColor + "\">" + currentPctStr + "</strong>" : "") +
            "</span><br>";
        }
        var pct = displayNetProfitPct !== null
          ? (displayNetProfitPct >= 0 ? "+" : "") + displayNetProfitPct.toFixed(2) + "%"
          : (s.avg_price > 0 && s.p_live > 0
            ? (((s.p_live * 0.999 - s.avg_price) / s.avg_price * 100) >= 0 ? "+" : "") + ((s.p_live * 0.999 - s.avg_price) / s.avg_price * 100).toFixed(2) + "%"
            : "");
        var effectiveProfitPct = displayNetProfitPct !== null ? displayNetProfitPct
          : (s.avg_price > 0 && s.p_live > 0 ? (s.p_live * 0.999 - s.avg_price) / s.avg_price * 100 : null);
        var isProfit = (effectiveProfitPct || 0) >= 0;
        var col = isBenefit
          ? (effectiveProfitPct !== null ? (isProfit ? d.green : d.red) : d.blue)
          : (isProfit ? d.green : d.red);
        var rowBgStr = isBenefit ? "background:" + d.rowBenefit + ";border:1px solid " + d.rowBenefitBorder
          : isProfit ? "background:" + d.rowBuy + ";border:1px solid " + d.rowBuyBorder
          : "background:" + d.rowSell + ";border:1px solid " + d.rowSellBorder;
        var detailId = "tsa-detail-" + s.symbol + "-" + category;
        var txHtml = "";
        if (s.transactions && s.transactions.length > 0) {
          var txSwingLeft = (!isBenefit && owned && owned.swing_shares > 0) ? owned.swing_shares : Infinity;
          s.transactions.forEach(function(t, idx) {
            var txDate = t.time_bought ? new Date(t.time_bought * 1000).toLocaleDateString("en-GB", {day:"2-digit",month:"2-digit",year:"2-digit"}) : "?";
            var txShares = (t.shares || 0).toLocaleString("en-US");
            var txPrice = t.bought_price ? "$" + t.bought_price.toFixed(2) : "?";
            var txCurrentVal = t.shares && s.p_live ? t.shares * s.p_live : 0;
            var txInvested = t.shares && t.bought_price ? t.shares * t.bought_price : 0;
            var txProfit = txCurrentVal - txInvested - txCurrentVal * 0.001;
            var txPct = txInvested > 0 ? ((txProfit / txInvested) * 100).toFixed(2) : "?";
            var txSign = txProfit >= 0 ? "+" : "";
            var txColD = txProfit >= 0 ? d.green : d.red;
            // In swing section: transactions beyond swing_shares are benefit blocks
            var isBenefitTx = !isBenefit && owned && owned.benefit_shares > 0 && txSwingLeft <= 0;
            txSwingLeft -= (t.shares || 0);
            var txLabel = isBenefitTx ? "Benefit block" : "Block " + (idx + 1);
            var txLabelColor = isBenefitTx ? d.blue : d.muted;
            txHtml += "<div " + (!isBenefitTx ? "id=\"tsa-swing-tx-" + s.symbol + "-" + idx + "\" class=\"tsa-swing-tx-row\" data-sym=\"" + s.symbol + "\" data-shares=\"" + (t.shares || 0) + "\" data-label=\"Block " + (idx + 1) + "\" data-state=\"0\" " : "") + "style=\"display:flex;justify-content:space-between;align-items:center;padding:6px 4px;border-bottom:1px solid " + d.divider + ";font-size:11px;" + (!isBenefitTx ? "cursor:pointer;border-radius:4px;" : "") + "\">" +
              "<div><span style=\"color:" + txLabelColor + ";" + ms + "\">" + txLabel + "</span><span style=\"color:" + d.muted + ";margin-left:6px\">" + txDate + "</span><br>" +
              "<span style=\"color:" + d.text + ";" + ms + "\">" + txShares + " @ " + txPrice + "</span></div>" +
              "<div style=\"text-align:right\">" +
              "<span style=\"font-weight:bold;color:" + txColD + ";font-size:12px;\">" + txSign + "$" + Math.abs(Math.round(txProfit)).toLocaleString("en-US") + "</span><br>" +
              "<span style=\"font-weight:bold;color:" + txColD + ";font-size:11px;\">" + txSign + txPct + "%</span></div></div>";
          });
        }

        var totalInvested = 0, totalCurrentVal = 0;
        if (s.transactions && s.transactions.length > 0) {
          s.transactions.forEach(function(t) {
            var costPrice = (t.bought_price && t.bought_price > 0) ? t.bought_price : (s.avg_price || 0);
            if (costPrice > 0) {
              totalInvested += (t.shares || 0) * costPrice;
              totalCurrentVal += (t.shares || 0) * (s.p_live || 0);
            }
          });
        }
        var totalProfit = totalCurrentVal - totalInvested - totalCurrentVal * 0.001;
        var totalPct = totalInvested > 0 ? ((totalProfit / totalInvested) * 100).toFixed(2) : null;
        var totalCol = (totalPct === null) ? d.muted : (totalProfit >= 0 ? d.green : d.red);
        var totalSign = totalProfit >= 0 ? "+" : "";

        return "<div style=\"margin-bottom:5px;\">" +
          "<div style=\"display:flex;align-items:center;gap:6px;\">" +
          "<div style=\"" + rowBgStr + ";flex:1;margin-bottom:0;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;\" data-detail=\"" + detailId + "\" data-symbol=\"" + s.symbol + "\">" +
          "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
          "<span style=\"font-size:13px;font-weight:bold;color:" + col + ";" + ms + "\">" + s.symbol + "</span>" +
          "<span style=\"font-size:10px;color:" + d.muted + "\">" + sharesStr + "</span><br>" +
          targetLine +
          "<span style=\"font-size:10px;color:" + d.muted + "\">Score " + s.score + (s.hasDividend ? " · DIV" : "") + (s.reasons ? " · " + s.reasons.split(" | ").slice(0,2).join(" · ") : "") + "</span>" +
          "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
          "<span style=\"font-size:13px;font-weight:bold;color:" + col + ";" + ms + "\">" + pct + "</span>" +
          (s.hasDividend ? "<span style=\"font-size:9px;padding:2px 6px;border-radius:10px;font-weight:bold;background:rgba(255,193,7,0.12);color:" + d.yellow + ";border:1px solid rgba(255,193,7,0.3)\">DIV " + s.dividendProgress + "/" + s.dividendFrequency + "d</span>" : "") +
          (s.sellSignal ? "<span style=\"font-size:9px;font-weight:bold;color:" + d.red + "\">" + s.sellSignal + "</span>" : "") +
          "</div></div>" +
          "</div>" +
          "<div id=\"" + detailId + "\" style=\"display:none;background:" + d.txBg + ";border:1px solid " + d.txBorder + ";border-radius:0 0 8px 8px;padding:8px 10px;margin-top:-4px;\">" +
          // Total P/L summary
          "<div style=\"display:flex;justify-content:space-between;align-items:center;background:" + d.bg + ";border-radius:6px;padding:8px 10px;margin-bottom:8px;border:1px solid " + d.border + "\">" +
          "<div><div style=\"font-size:9px;color:" + d.muted + ";text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px\">Total P/L</div>" +
          "<div style=\"font-size:15px;font-weight:bold;color:" + totalCol + "\">" + (totalPct !== null ? totalSign + "$" + Math.abs(Math.round(totalProfit)).toLocaleString("en-US") : "N/A") + "</div></div>" +
          "<div style=\"text-align:right\"><div style=\"font-size:9px;color:" + d.muted + ";text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px\">Return</div>" +
          "<div style=\"font-size:15px;font-weight:bold;color:" + totalCol + "\">" + (totalPct !== null ? totalSign + totalPct + "%" : "N/A") + "</div></div>" +
          "<button class=\"tsa-goto-chart\" data-symbol=\"" + s.symbol + "\" style=\"padding:6px 10px;border-radius:6px;border:1px solid " + d.border + ";background:" + d.bg2 + ";color:" + d.muted + ";font-size:10px;cursor:pointer;font-weight:bold;\">📈 Chart</button>" +
          "</div>" +
          (function() {
            // Entry slippage: compare QT buy intent price vs actual avg_price
            try {
              var intentRaw = localStorage.getItem("qt_intent_" + s.symbol);
              if (intentRaw && s.avg_price > 0) {
                var intent = JSON.parse(intentRaw);
                var ageSecs = Math.floor(Date.now() / 1000) - (intent.ts || 0);
                if (ageSecs < 86400 && intent.price > 0) {
                  var slipPct = (s.avg_price - intent.price) / intent.price * 100;
                  if (Math.abs(slipPct) >= 0.5) {
                    var slipColor = slipPct > 0 ? d.red : d.green;
                    var slipSign  = slipPct > 0 ? "+" : "";
                    return "<div style=\"display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:6px;border-radius:6px;background:" + (slipPct > 0 ? "rgba(255,76,106,0.08)" : "rgba(76,255,145,0.08)") + ";border:1px solid " + (slipPct > 0 ? "rgba(255,76,106,0.25)" : "rgba(76,255,145,0.25)") + "\">" +
                      "<span style=\"font-size:11px\">" + (slipPct > 0 ? "⚠" : "✓") + "</span>" +
                      "<span style=\"font-size:10px;color:" + d.muted + "\">Entry slippage: intended <strong style=\"color:" + d.text + "\">$" + intent.price.toFixed(2) + "</strong> · paid <strong style=\"color:" + slipColor + "\">$" + s.avg_price.toFixed(2) + "</strong> <strong style=\"color:" + slipColor + "\">(" + slipSign + slipPct.toFixed(1) + "%)</strong></span>" +
                      "</div>";
                  }
                }
              }
            } catch(e) {}
            return "";
          })() +
          "<div style=\"font-size:10px;color:" + d.muted + ";margin-bottom:4px;font-weight:bold;text-transform:uppercase;letter-spacing:0.08em;" + ms + "\">Transactions</div>" +
          "<div style=\"font-size:11px;color:" + d.muted + ";margin-bottom:6px;" + ms + "\">Avg: <strong style=\"color:" + d.text + "\">" + (s.avg_price > 0 ? "$" + s.avg_price.toFixed(2) : "N/A") + "</strong> · Live: <strong style=\"color:" + d.text + "\">$" + s.p_live.toFixed(2) + "</strong>" + (s.hoursHeld ? " · <span style=\"color:" + d.muted + "\">held " + s.hoursHeld + "h</span>" : "") + "</div>" +
          txHtml + "</div></div>";
      };

      if (allOwned.length > 0) {
        html += "<hr style=\"border:none;border-top:1px solid " + d.divider + ";margin:6px 14px\">";

        if (swingTrades.length > 0) {
          var swingCollapsed = lsGet("tsa_swing_collapsed", "false") === "true";
          html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
            "<div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;cursor:pointer;\" id=\"tsa-swing-header\">" +
            "<span style=\"font-size:10px;letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;font-weight:bold;" + ms + "\">Swing trades (" + swingTrades.length + ")</span>" +
            "<span style=\"font-size:14px;color:" + d.muted + ";\">" + (swingCollapsed ? "&#9658;" : "&#9660;") + "</span></div>" +
            "<div id=\"tsa-swing-body\" style=\"display:" + (swingCollapsed ? "none" : "block") + "\">";
          swingTrades.forEach(function(s) { html += renderStockRow(s, "swing"); });
          html += "</div></div>";
        }

        if (benefitBlocks.length > 0) {
          if (swingTrades.length > 0) html += "<hr style=\"border:none;border-top:1px solid " + d.divider + ";margin:6px 14px\">";
          var benefitCollapsed = lsGet("tsa_benefit_collapsed", "false") === "true";
          html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
            "<div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;cursor:pointer;\" id=\"tsa-benefit-header\">" +
            "<span style=\"font-size:10px;letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;font-weight:bold;" + ms + "\">Benefit blocks (" + benefitBlocks.length + ")</span>" +
            "<span style=\"font-size:14px;color:" + d.muted + ";\">" + (benefitCollapsed ? "&#9658;" : "&#9660;") + "</span></div>" +
            "<div id=\"tsa-benefit-body\" style=\"display:" + (benefitCollapsed ? "none" : "block") + "\">";
          benefitBlocks.forEach(function(s) { html += renderStockRow(s, "benefit"); });
          html += "</div></div>";
        }
      }

      var autoRefreshMins = getAutoRefreshInterval();
      var autoRefreshLabel = autoRefreshMins > 0 ? " · Auto " + autoRefreshMins + "m" : "";
      var histSyms = Object.keys(cachedPriceHistory);
      var maxHistHours = 0;
      histSyms.forEach(function(sym) {
        var entries = cachedPriceHistory[sym];
        if (!entries || entries.length < 2) return;
        var hrs = Math.round((entries[entries.length - 1].ts - entries[0].ts) / 3600000);
        if (hrs > maxHistHours) maxHistHours = hrs;
      });
      var histLabel = histSyms.length > 0 ? " · " + histSyms.length + " stocks · " + maxHistHours + "h hist" : "";
      html += "<div style=\"padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid " + d.divider + ";background:" + d.bg + "\">" +
        "<span style=\"font-size:10px;color:" + d.muted + "\">Updated: " + new Date().toLocaleTimeString("en-GB") + autoRefreshLabel + "<span id='tsa-countdown'></span></span>" +
        "<span style=\"font-size:10px;color:" + d.muted + "\">Storage: " + getTsaStorageSize() + histLabel + "</span>" +
        "</div>" +
        "<button id='tsa-scroll-top' title='Scroll to top'>↑</button>";
      scheduleAutoRefresh();

      content.innerHTML = html;

      // Buy signal chart click handler
      function drawChart(sym, chartId, stockData) {
        var chartDiv = document.getElementById(chartId);
        if (!chartDiv) return;
        var canvas = document.getElementById("canvas-" + sym);
        if (!canvas) return;

        var r = stockData ? stockData.find(function(x){ return x.stock === sym; }) : null;
        if (!r) { chartDiv.innerHTML += "<div style='font-size:9px;color:#888;text-align:center'>No data</div>"; return; }

        // Chronological order of spread prices
        var pts = [
          {l:"1W", p: parseFloat((r.interval && r.interval.w1 && r.interval.w1.price)) || 0},
          {l:"4D", p: parseFloat((r.interval && r.interval.d4 && r.interval.d4.price)) || 0},
          {l:"2D", p: parseFloat((r.interval && r.interval.d2 && r.interval.d2.price)) || 0},
          {l:"1D", p: parseFloat((r.interval && r.interval.d1 && r.interval.d1.price)) || 0},
          {l:"12H", p: parseFloat((r.interval && r.interval.h12 && r.interval.h12.price)) || 0},
          {l:"8H", p: parseFloat((r.interval && r.interval.h8 && r.interval.h8.price)) || 0},
          {l:"4H", p: parseFloat((r.interval && r.interval.h4 && r.interval.h4.price)) || 0},
          {l:"2H", p: parseFloat((r.interval && r.interval.h2 && r.interval.h2.price)) || 0},
          {l:"1H", p: parseFloat((r.interval && r.interval.h1 && r.interval.h1.price)) || 0},
          {l:"Now", p: parseFloat(r.price) || 0}
        ].filter(function(pt){ return pt.p > 0; });

        if (pts.length < 2) return;

        var isDarkC = document.getElementById("tsa-overlay").classList.contains("tsa-dark");
        var lineColor = isDarkC ? "#4cff91" : "#1a8a45";
        var gridColor = isDarkC ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
        var textColor = isDarkC ? "#7a7a9a" : "#888";

        var w = canvas.offsetWidth || 280;
        var h = 80;
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        if (!ctx) return;

        var prices = pts.map(function(pt){ return pt.p; });
        var minP = Math.min.apply(null, prices);
        var maxP = Math.max.apply(null, prices);
        var range = maxP - minP || 1;
        var pad = 8;

        ctx.clearRect(0, 0, w, h);

        // Grid lines
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        [0.25, 0.5, 0.75].forEach(function(f) {
          var y = pad + (1-f) * (h - pad*2);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        });

        // Price line
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.beginPath();
        pts.forEach(function(pt, i) {
          var x = pad + (i / (pts.length-1)) * (w - pad*2);
          var y = pad + (1 - (pt.p - minP) / range) * (h - pad*2);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // Fill under line
        ctx.fillStyle = isDarkC ? "rgba(76,255,145,0.06)" : "rgba(26,138,69,0.06)";
        ctx.lineTo(pad + (pts.length-1)/(pts.length-1) * (w-pad*2), h-pad);
        ctx.lineTo(pad, h-pad);
        ctx.closePath();
        ctx.fill();

        // Last point dot
        var lastX = w - pad;
        var lastY = pad + (1 - (pts[pts.length-1].p - minP) / range) * (h - pad*2);
        ctx.beginPath();
        ctx.arc(lastX, lastY, 3, 0, Math.PI*2);
        ctx.fillStyle = lineColor;
        ctx.fill();

        // Min/Max labels
        ctx.fillStyle = textColor;
        ctx.font = "9px Arial";
        ctx.textAlign = "right";
        ctx.fillText("$" + maxP.toFixed(2), w-2, pad+8);
        ctx.fillText("$" + minP.toFixed(2), w-2, h-pad+1);
      }

      // Helper: set stock in Quick Trade dropdown
      function qtSetStock(sym) {
        var hidden = document.getElementById("qt-stock");
        var search = document.getElementById("qt-stock-search");
        if (hidden) hidden.value = sym;
        if (search) search.value = sym;
        lsSet("qt_last_stock", sym);
        qtDrawChart(sym);
        qtUpdateExec();
      }

      document.querySelectorAll(".tsa-watch-row").forEach(function(row) {
        row.addEventListener("click", function() {
          var sym = row.dataset.symbol;
          qtSetStock(sym);
          var bdId = row.dataset.breakdown;
          if (bdId) {
            var panel = document.getElementById(bdId);
            if (panel) {
              var open = panel.style.display !== "none";
              panel.style.display = open ? "none" : "block";
              var caret = document.getElementById(bdId + "-caret");
              if (caret) caret.textContent = open ? "▶" : "▼";
            }
          }
        });
      });

      document.querySelectorAll(".tsa-buy-row").forEach(function(row) {
        row.addEventListener("click", function() {
          var sym = row.dataset.symbol;
          qtSetStock(sym);

          // Toggle score breakdown panel
          var bdId = row.dataset.breakdown;
          if (bdId) {
            var panel = document.getElementById(bdId);
            if (panel) {
              var open = panel.style.display !== "none";
              panel.style.display = open ? "none" : "block";
              var caret = document.getElementById(bdId + "-caret");
              if (caret) caret.textContent = open ? "▶" : "▼";
            }
          }
        });
      });

      // Pin button — stop propagation so row click doesn't also fire
      document.querySelectorAll(".tsa-pin-btn").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          var sym = btn.dataset.sym;
          var idx = tsaPinned.indexOf(sym);
          if (idx >= 0) { tsaPinned.splice(idx, 1); } else { tsaPinned.push(sym); }
          lsSet("tsa_pinned", JSON.stringify(tsaPinned));
          loadData();
        });
      });

      // Scroll-to-top button visibility
      var overlayEl = document.getElementById("tsa-overlay");
      var scrollTopBtn = document.getElementById("tsa-scroll-top");
      if (scrollTopBtn) {
        scrollTopBtn.style.display = "flex";
        scrollTopBtn.style.opacity = overlayEl && overlayEl.scrollTop > 80 ? "1" : "0";
        scrollTopBtn.style.transition = "opacity 0.2s";
        scrollTopBtn.addEventListener("click", function() {
          if (overlayEl) overlayEl.scrollTo({ top: 0, behavior: "smooth" });
        });
        if (overlayEl) {
          overlayEl.addEventListener("scroll", function() {
            if (!scrollTopBtn) return;
            scrollTopBtn.style.opacity = overlayEl.scrollTop > 80 ? "1" : "0";
          }, { passive: true });
        }
      }

      // Chart button in detail panel
      document.querySelectorAll(".tsa-goto-chart").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          var sym = btn.dataset.symbol;
          if (!isDesktop) {
            var overlay = document.getElementById("tsa-overlay");
            if (overlay) overlay.style.display = "none";
          }
          var imgs = document.querySelectorAll("img[src*='/logos/']");
          for (var i = 0; i < imgs.length; i++) {
            if (imgs[i].src.toLowerCase().indexOf("/" + sym.toLowerCase() + ".svg") < 0) continue;
            var nameTab = imgs[i].closest("[data-name='nameTab']");
            if (!nameTab) continue;
            var priceTab = nameTab.parentElement && nameTab.parentElement.querySelector("[data-name='priceTab']");
            if (!priceTab) continue;
            priceTab.scrollIntoView({ behavior: "smooth", block: "center" });
            priceTab.click();
            var stockSection = nameTab.parentElement && nameTab.parentElement.parentElement;
            if (stockSection) {
              var obs = new MutationObserver(function() {
                var weekTab = stockSection.querySelector("[data-name='Last week']");
                if (weekTab) {
                  obs.disconnect();
                  var weekInput = weekTab.querySelector("input[type='radio']");
                  (weekInput || weekTab).click();
                }
              });
              obs.observe(stockSection, { childList: true, subtree: true, attributes: true });
              setTimeout(function() { obs.disconnect(); }, 2000);
            }
            return;
          }
        });
      });

      document.querySelectorAll("[data-detail]").forEach(function(row) {
        row.addEventListener("click", function() {
          if (row.dataset.symbol) qtSetStock(row.dataset.symbol);
          var panel = document.getElementById(row.dataset.detail);
          if (!panel) return;
          var opening = panel.style.display === "none";
          panel.style.display = opening ? "block" : "none";
          if (opening) {
            var overlay = document.getElementById("tsa-overlay");
            if (overlay) {
              var targetTop = row.offsetTop - 50; // 50px offset for sticky header
              overlay.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
            }
          }
        });
      });

      var realizedRow = document.getElementById("tsa-realized-row");
      if (realizedRow) realizedRow.addEventListener("click", function() {
        lsSet("tsa_realized_expanded", String(lsGet("tsa_realized_expanded", "false") !== "true"));
        loadData();
      });

      var swingHeader = document.getElementById("tsa-swing-header");
      if (swingHeader) swingHeader.addEventListener("click", function() {
        lsSet("tsa_swing_collapsed", String(lsGet("tsa_swing_collapsed", "false") !== "true"));
        loadData();
      });

      // Click-twice-to-confirm safety on swing-tx rows. Selling a specific
      // historical buy lot is destructive, and on Torn configs that fire
      // trades in one step (no Confirm Transaction prompt) the lot would
      // sell on the very first click without any chance to back out. First
      // click arms the row (visual highlight + warn toast); second click
      // within 8 s actually fires the sell. Clicking a different armed row
      // disarms the previous one.
      var armedSwingRow = null;
      var armedSwingTimer = null;
      function disarmSwingRow() {
        if (!armedSwingRow) return;
        armedSwingRow.dataset.state = "0";
        armedSwingRow.style.background = "";
        armedSwingRow.style.boxShadow = "";
        armedSwingRow = null;
        if (armedSwingTimer) { clearTimeout(armedSwingTimer); armedSwingTimer = null; }
      }
      content.querySelectorAll(".tsa-swing-tx-row").forEach(function(row) {
        row.addEventListener("click", async function(e) {
          e.stopPropagation();

          // First click: arm the row, ask for confirmation, return.
          if (armedSwingRow !== row) {
            disarmSwingRow();
            armedSwingRow = row;
            row.dataset.state = "1";
            row.style.background = "rgba(255,76,106,0.18)";
            row.style.boxShadow = "inset 0 0 0 1px rgba(255,76,106,0.6)";
            var armSym    = row.dataset.sym;
            var armShares = parseInt(row.dataset.shares, 10);
            var armLabel  = row.dataset.label;
            showToast("Tap again to sell " + armShares.toLocaleString("en-US") + " " + armSym + " (" + armLabel + ")", "warn");
            armedSwingTimer = setTimeout(function() { disarmSwingRow(); }, 8000);
            return;
          }

          // Second click on the same row: disarm, then actually sell.
          disarmSwingRow();
          var sym    = row.dataset.sym;
          var shares = parseInt(row.dataset.shares, 10);
          var label  = row.dataset.label;
          qtBuildMaps();
          var owned = qtGetOwnedShares(sym);
          if (owned <= 0) { showToast("You have no shares of " + sym, "warn"); return; }
          if (shares > owned) shares = owned;
          shares = qtApplyBenefitLock(sym, shares);
          if (shares === null) return;
          var fired = await qtUiTrade(sym, shares, "sellShares", "Sold " + shares.toLocaleString("en-US") + " " + sym + " (" + label + ")");
          if (fired) {
            var parent = row.parentNode;
            if (parent) parent.removeChild(row);
          }
        });
      });

      var benefitHeader = document.getElementById("tsa-benefit-header");
      if (benefitHeader) benefitHeader.addEventListener("click", function() {
        lsSet("tsa_benefit_collapsed", String(lsGet("tsa_benefit_collapsed", "false") !== "true"));
        loadData();
      });

    }).catch(function(e) {
      content.innerHTML = "<div class=\"tsa-error\">Error: " + escHtml(e.message) + "</div>" +
        "<div class=\"tsa-footer\"><span></span><button class=\"tsa-refresh\" id=\"tsa-refresh-btn\">Retry</button></div>";
      var retryBtn = document.getElementById("tsa-refresh-btn");
      if (retryBtn) retryBtn.addEventListener("click", loadData);
    });
  }

  // ── Signal history: logs buy signals with timestamp to localStorage ──
  var SIGNAL_HISTORY_KEY = "tsa_signal_history";
  var SIGNAL_HISTORY_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

  function loadSignalHistory() {
    try { return JSON.parse(localStorage.getItem(SIGNAL_HISTORY_KEY)) || []; } catch(e) { return []; }
  }

  function saveSignalHistory(history) {
    try { localStorage.setItem(SIGNAL_HISTORY_KEY, JSON.stringify(history)); } catch(e) {}
  }

  function recordSignals(stockResults) {
    var now = Date.now();
    var nowMin = Math.round(now / 60000) * 60000;
    var cutoff = now - SIGNAL_HISTORY_MAX_AGE;
    var history = loadSignalHistory().filter(function(e) { return e.ts >= cutoff; });
    // Build set of sym+minute combos already logged
    var existing = {};
    history.forEach(function(e) {
      existing[e.sym + "_" + Math.round(e.ts / 60000)] = true;
    });
    stockResults.forEach(function(s) {
      if (s.signal === "STRONG BUY" || s.signal === "BUY") {
        var key = s.symbol + "_" + Math.round(nowMin / 60000);
        if (!existing[key]) {
          history.push({ ts: nowMin, sym: s.symbol, signal: s.signal, score: s.score, price: s.p_live });
          existing[key] = true;
        }
      }
    });
    saveSignalHistory(history);
  }

  // ── Price + investors history storage ──
  var HISTORY_KEY = "tsa_price_history";
  var INVESTOR_HISTORY_KEY = "tsa_investor_history";
  var HISTORY_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // default 30 days

  function getHistoryMaxAge() {
    var days = parseInt(lsGet("tsa_history_days", "30"), 10);
    if (isNaN(days) || days < 1) days = 1;
    if (days > 30) days = 30;
    return days * 24 * 60 * 60 * 1000;
  }

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {}; } catch(e) { return {}; }
  }

  function saveHistory(history) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch(e) {
      // Quota exceeded — try pruning to progressively shorter windows before giving up
      var fallbackDays = [3, 1];
      var saved = false;
      for (var fi = 0; fi < fallbackDays.length; fi++) {
        var cutoff = Date.now() - fallbackDays[fi] * 24 * 60 * 60 * 1000;
        var reduced = {};
        Object.keys(history).forEach(function(sym) {
          var filtered = history[sym].filter(function(p) { return p.ts >= cutoff; });
          if (filtered.length > 0) reduced[sym] = filtered;
        });
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(reduced));
          saved = true;
          break;
        } catch(e2) {}
      }
      if (!saved && !saveHistory._warned) {
        saveHistory._warned = true;
        showToast("Storage full — price history could not be saved", "warn");
      }
    }
  }

  function loadInvestorHistory() {
    try { return JSON.parse(localStorage.getItem(INVESTOR_HISTORY_KEY)) || {}; } catch(e) { return {}; }
  }

  function saveInvestorHistory(history) {
    try { localStorage.setItem(INVESTOR_HISTORY_KEY, JSON.stringify(history)); } catch(e) {}
  }

  function pruneInvestorHistory(history) {
    var cutoff = Date.now() - getHistoryMaxAge();
    Object.keys(history).forEach(function(sym) {
      history[sym] = history[sym].filter(function(p) { return p.ts >= cutoff; });
      if (history[sym].length === 0) delete history[sym];
    });
    return history;
  }

  // Returns investor delta vs ~24h ago for a given symbol, or null if no data
  // Pass pre-loaded history to avoid repeated localStorage reads
  function getInvestorDelta(sym, cachedHistory) {
    var history = cachedHistory || loadInvestorHistory();
    var entries = history[sym.toUpperCase()];
    if (!entries || entries.length < 2) return null;
    var now = Date.now();
    var target = now - 24 * 3600 * 1000;
    var closest = null, closestDiff = Infinity;
    entries.forEach(function(e) {
      var diff = Math.abs(e.ts - target);
      if (diff < closestDiff) { closestDiff = diff; closest = e; }
    });
    if (!closest) return null;
    if (closest.ts > now - 30 * 60 * 1000) return null;
    var latest = entries[entries.length - 1];
    return latest.investors - closest.investors;
  }

  function pruneHistory(history) {
    var cutoff = Date.now() - getHistoryMaxAge();
    Object.keys(history).forEach(function(sym) {
      history[sym] = history[sym].filter(function(p) { return p.ts >= cutoff; });
      if (history[sym].length === 0) delete history[sym];
    });
    return history;
  }

  function recordPrices(raw) {
    var history = pruneHistory(loadHistory());
    var now = Date.now();
    var intervalMs = { "w1":7*24*3600*1000,"d7":7*24*3600*1000,"d6":6*24*3600*1000,"d5":5*24*3600*1000,"d4":4*24*3600*1000,"d3":3*24*3600*1000,"d2":2*24*3600*1000,"d1":24*3600*1000,"h20":20*3600*1000,"h16":16*3600*1000,"h12":12*3600*1000,"h10":10*3600*1000,"h8":8*3600*1000,"h6":6*3600*1000,"h5":5*3600*1000,"h4":4*3600*1000,"h3":3*3600*1000,"h2":2*3600*1000,"h1":3600*1000,"m30":30*60*1000 };
    var INTERVALS = Object.keys(intervalMs);

    raw.forEach(function(r) {
      var sym = r.stock;
      if (!sym) return;
      if (!history[sym]) history[sym] = [];

      // Build a map of existing ts values for fast dedup
      var existingTs = {};
      history[sym].forEach(function(p) { existingTs[p.ts] = true; });

      // Store all 20 intervals — skip if this exact ts already exists
      INTERVALS.forEach(function(key) {
        var p = parseFloat((r.interval && r.interval[key] && r.interval[key].price)) || 0;
        if (p <= 0) return;
        var ts = now - (intervalMs[key] || 0);
        // Round to nearest minute to allow dedup across sessions
        ts = Math.round(ts / 60000) * 60000;
        if (!existingTs[ts]) {
          history[sym].push({ ts: ts, price: p });
          existingTs[ts] = true;
        }
      });

      // Store live price — always overwrite if same-minute ts exists
      var p_live = parseFloat(r.price) || 0;
      if (p_live > 0) {
        var liveTs = Math.round(now / 60000) * 60000;
        // Remove old entry for this ts if exists, then add fresh
        history[sym] = history[sym].filter(function(p) { return p.ts !== liveTs; });
        history[sym].push({ ts: liveTs, price: p_live });
      }

      // Sort by time
      history[sym].sort(function(a, b) { return a.ts - b.ts; });
    });

    saveHistory(history);

    // Record investor counts
    var invHistory = pruneInvestorHistory(loadInvestorHistory());
    var nowMin = Math.round(now / 60000) * 60000;
    raw.forEach(function(r) {
      var sym = r.stock;
      if (!sym || !r.investors) return;
      var investors = parseInt(r.investors, 10) || 0;
      if (investors <= 0) return;
      if (!invHistory[sym]) invHistory[sym] = [];
      // Dedup by minute
      var existingTs = {};
      invHistory[sym].forEach(function(e) { existingTs[e.ts] = true; });
      if (!existingTs[nowMin]) {
        invHistory[sym].push({ ts: nowMin, investors: investors });
        invHistory[sym].sort(function(a, b) { return a.ts - b.ts; });
      }
    });
    saveInvestorHistory(invHistory);

    // Return history so caller can reuse without a second localStorage parse
    return history;
  }

  // Track recommendation tap state per symbol

  function updateQtRecommendation(sym) {
    var recDiv = document.getElementById("qt-rec");
    if (!recDiv) {
      // Bar not ready yet — retry after delay
      setTimeout(function() { updateQtRecommendation(sym); }, 500);
      return;
    }
    if (!lastBestRec) { recDiv.style.display = "none"; return; }

    var rec = lastBestRec;
    var cash = typeof qtGetMoneyFast === "function" ? qtGetMoneyFast() : 0;
    var canAfford = cash >= rec.cost;
    var color = canAfford ? "#4cff91" : "#ff4c6a";
    var border = canAfford ? "rgba(76,255,145,0.3)" : "rgba(255,76,106,0.3)";
    var bg = canAfford ? "rgba(76,255,145,0.07)" : "rgba(255,76,106,0.06)";
    var recSym = rec.sym;
    var recTier = "T" + rec.tierInfo.nextIncrement;
    var recShares = rec.tierInfo.sharesNeeded;
    var recCost = rec.cost;

    var label = "💡 " + recSym + " " + recTier + " · " + recShares.toLocaleString("en-US") + " shares · " + fmRoi(recCost);

    recDiv.style.display = "block";
    recDiv.innerHTML = "<button id='qt-rec-btn' style='width:100%;padding:6px 10px;border-radius:7px;border:1px solid " + border + ";background:" + bg + ";color:" + color + ";font-family:JetBrains Mono,monospace;font-size:11px;font-weight:700;cursor:pointer;text-align:left;'>" + label + "</button>";

    document.getElementById("qt-rec-btn").addEventListener("click", function() {
      var liveCash = qtGetMoneyFast();
      // Tier rec buys must hit the exact share count to unlock the benefit
      // block — refuse rather than partial-buy wasted shares.
      if (liveCash > 0 && recCost > liveCash) {
        showToast("Need $" + (recCost - liveCash).toLocaleString("en-US") + " more for " + recSym + " " + recTier, "warn");
        return;
      }
      qtUiTrade(recSym, recShares, "buyShares", "Bought " + recShares.toLocaleString("en-US") + " " + recSym + " (" + recTier + ")");
      updateQtRecommendation(null);
    });
  }
  function getRoiRecommendation(sym) {
    if (!lastOwnedMap || !lastRaw) return null;
    var tierInfo = calcNextTier(sym, lastOwnedMap, lastRaw);
    if (!tierInfo || tierInfo.sharesNeeded <= 0) return null;
    // Check capital
    var liveEntry = lastRaw.find(function(x) { return x.stock === sym.toUpperCase(); });
    if (!liveEntry) return null;
    // Estimate available capital from cash (rough — exact is in ROI planner)
    return {
      sym: sym,
      sharesNeeded: tierInfo.sharesNeeded,
      cost: tierInfo.cost,
      tier: "T" + tierInfo.nextIncrement,
      livePrice: tierInfo.livePrice
    };
  }

  var QT_DEFAULT_AMOUNTS = [1000000, 3000000, 5000000, 10000000, 25000000, 50000000, 100000000];
  var qtAmounts = (function() {
    try {
      var stored = localStorage.getItem("qt_amounts");
      var parsed = stored ? JSON.parse(stored) : null;
      return (Array.isArray(parsed) && parsed.length > 0) ? parsed : QT_DEFAULT_AMOUNTS.slice();
    } catch(e) { return QT_DEFAULT_AMOUNTS.slice(); }
  })();
  var qtMode = "buy";
  var qtSelAmt = null;
  var qtEditMode = false;

  var QT_STOCKS = ["ASS","BAG","CBD","CNC","ELT","EVL","EWM","FHG","GRN","HRG",
    "IIL","IOU","IST","LAG","LOS","LSC","MCS","MSG","MUN","PRN",
    "PTS","SYM","SYS","TCC","TCI","TCM","TCP","TCT","TGP","THS",
    "TMI","TSB","WLT","WSU","YAZ"];

  var qt_stocks = {}, qt_stockRows = {}, qt_localShareCache = {};
  var qtPendingTrade = null;

  function qtBuildMaps() {
    $("ul[class^='stock_']").each(function() {
      var sym = $("img", $(this)).attr("src").split("logos/")[1].split(".svg")[0];
      qt_stocks[sym] = $("div[class^='price_']", $(this));
      qt_stockRows[sym] = $(this);
    });
  }

  function qtParseTornNumber(val) {
    if (typeof val !== "string") return 0;
    val = val.trim().toLowerCase();
    if (!val) return 0;
    var n;
    if (val.endsWith("k")) { n = parseFloat(val.replace("k", "")); return isNaN(n) ? 0 : n * 1000; }
    if (val.endsWith("m")) { n = parseFloat(val.replace("m", "")); return isNaN(n) ? 0 : n * 1000000; }
    if (val.endsWith("b")) { n = parseFloat(val.replace("b", "")); return isNaN(n) ? 0 : n * 1000000000; }
    n = parseFloat(val.replace(/,/g, ""));
    return isNaN(n) ? 0 : n;
  }

  function qtGetPrice(id) {
    if (!qt_stocks[id]) return 0;
    return parseFloat($(qt_stocks[id]).text().replace(/,/g, "")) || 0;
  }

  function qtGetOwnedShares(id, bypassCache) {
    if (!bypassCache && qt_localShareCache[id] !== undefined) return qt_localShareCache[id];
    var row = qt_stockRows[id];
    if (!row) return 0;
    var mobileEl = row.find("p[class^='count']");
    if (mobileEl.length > 0) return parseFloat(mobileEl.text().replace(/,/g, "")) || 0;
    var cols = row.children("div");
    if (cols.length >= 5) return parseFloat($(cols[4]).text().replace(/,/g, "")) || 0;
    return 0;
  }

  function qtUpdateLocalCache(sym, amt) {
    var current = qtGetOwnedShares(sym);
    qt_localShareCache[sym] = Math.max(0, current + amt);
  }

  function qtGetMoneyFast() {
    var dataMoney = $("#user-money").attr("data-money");
    if (dataMoney) return parseFloat(dataMoney);
    var textMoney = $("#user-money").text();
    return textMoney ? qtParseTornNumber(textMoney) : 0;
  }

  // Exact copy of TheALFA's getBenefitTier()
  function qtGetBenefitTier(sym, shares) {
    var data = BENEFIT_REQ[sym];
    if (!data) return { tier: 0, next: 0 };
    // TheALFA uses STOCK_DATA which has type "P" for passive stocks
    // Our BENEFIT_REQ only stores the base number, so we check our own map
    if (PASSIVE_STOCKS.indexOf(sym) >= 0) {
      return (shares >= data) ? { tier: 1, next: data } : { tier: 0, next: data };
    }
    var multiplier = 1;
    while (shares >= data * (multiplier * 2)) { multiplier *= 2; }
    return (shares < data) ? { tier: 0, next: data } : { tier: multiplier, next: data * multiplier * 2 };
  }

  // Trades go through Torn's own UI: open the Owned tab, set the share count
  // via the input's React fiber onChange, then click the form's submit button
  // via its fiber onClick. The first click advances Torn's UI to the
  // "Confirm Transaction" step; the second click executes the trade. The
  // userscript makes zero non-API HTTP requests — Torn's own React handlers
  // are what contact api.torn.com.

  function qtFindFiberProp(el, propName) {
    var fiberKey = Object.keys(el).find(function(k) { return k.indexOf("__reactFiber") === 0; });
    if (!fiberKey) return null;
    var f = el[fiberKey];
    while (f) {
      if (f.memoizedProps && typeof f.memoizedProps[propName] === "function") {
        return f.memoizedProps[propName];
      }
      f = f.return;
    }
    return null;
  }

  function qtWaitForElement(parent, selector, timeoutMs) {
    return new Promise(function(resolve) {
      var existing = parent.querySelector(selector);
      if (existing) return resolve(existing);
      var obs = new MutationObserver(function() {
        var el = parent.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(parent, { childList: true, subtree: true });
      setTimeout(function() { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function qtWaitForButton(parent, textRegex, timeoutMs) {
    return new Promise(function(resolve) {
      var find = function() {
        var btns = parent.querySelectorAll("button");
        for (var i = 0; i < btns.length; i++) {
          if (textRegex.test(btns[i].textContent)) return btns[i];
        }
        return null;
      };
      var existing = find();
      if (existing) return resolve(existing);
      var obs = new MutationObserver(function() {
        var el = find();
        if (el) { obs.disconnect(); resolve(el); }
      });
      // characterData: catches text-only updates (e.g. Torn rewriting the same
      // button from "sell" → "Confirm Transaction" without replacing the node).
      obs.observe(parent, { childList: true, subtree: true, characterData: true });
      setTimeout(function() { obs.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  function qtSleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Event-driven wait — resolves as soon as `predicate()` returns truthy after
  // any DOM mutation under `observeRoot`. Resolves true on success, false on
  // timeout. If predicate is already true at call time, resolves immediately.
  // Replaces fixed `qtSleep` waits so the script reacts as fast as Torn's UI
  // is ready, no slower and no faster.
  function qtWaitForCondition(observeRoot, predicate, maxMs) {
    return new Promise(function(resolve) {
      if (predicate()) return resolve(true);
      var done = false;
      var t;
      var obs;
      var finish = function(val) {
        if (done) return;
        done = true;
        try { if (obs) obs.disconnect(); } catch(e) {}
        try { clearTimeout(t); } catch(e) {}
        resolve(val);
      };
      obs = new MutationObserver(function() {
        if (predicate()) finish(true);
      });
      obs.observe(observeRoot, { childList: true, subtree: true, attributes: true, characterData: true });
      t = setTimeout(function() { finish(predicate()); }, maxMs);
    });
  }

  // Resolves true on the first DOM mutation under `observeRoot`, or false on
  // timeout. Used to wait for any React re-render after a state-change call.
  function qtWaitForAnyMutation(observeRoot, maxMs) {
    return new Promise(function(resolve) {
      var done = false;
      var t;
      var obs;
      var finish = function(val) {
        if (done) return;
        done = true;
        try { if (obs) obs.disconnect(); } catch(e) {}
        try { clearTimeout(t); } catch(e) {}
        resolve(val);
      };
      obs = new MutationObserver(function() { finish(true); });
      obs.observe(observeRoot, { childList: true, subtree: true, attributes: true, characterData: true });
      t = setTimeout(function() { finish(false); }, maxMs);
    });
  }

  // Step 1: scroll, open Owned tab, set value via fiber.onChange, click submit
  // via fiber.onClick to advance to the "Confirm Transaction" step.
  async function qtUiPrepare(pending) {
    var symb = pending.symb;
    var shareCount = pending.shareCount;
    var action = pending.action;

    qtBuildMaps();
    var card$ = qt_stockRows[symb];
    if (!card$ || !card$[0]) { showToast("Stock card not found for " + symb, "error"); return false; }
    var cardEl = card$[0];

    cardEl.scrollIntoView({ behavior: "smooth", block: "center" });

    var ownedTab = cardEl.querySelector('[data-name="ownedTab"]');
    if (!ownedTab) { showToast("Owned tab not found for " + symb, "error"); return false; }
    if (!/active___/.test(ownedTab.className)) {
      ownedTab.click();
    }

    var sideClass = action === "buyShares" ? "buyBlock___" : "sellBlock___";
    var verbClass = action === "buyShares" ? "buy___"      : "sell___";

    var form = await qtWaitForElement(document.body, '[class*="' + sideClass + '"] [class*="manageBlock___"]', 2000);
    if (!form) { showToast("Trade form did not open for " + symb, "error"); return false; }

    // Wait for the input — after a previous trade, the form briefly stays in
    // "Confirm Transaction" state (no input) before resetting. A MutationObserver
    // catches the moment the input mounts back, instead of erroring instantly.
    var inp = await qtWaitForElement(form, 'input[data-testid="legacy-money-input"]:not([type="hidden"])', 3000);
    if (!inp) { showToast("Trade input not found", "error"); return false; }

    var onChange = qtFindFiberProp(inp, "onChange");
    if (!onChange) { showToast("Trade input handler not found — Torn UI changed?", "error"); return false; }

    // Just fiber.onChange — verified end-to-end in console that this single
    // call is sufficient to set value cleanly. Adding keypress/setter/dispatch
    // events triggered extra React re-renders that put sell-side state in a
    // configuration where the subsequent Confirm onClick took the wrong branch.
    var sStr = String(shareCount);
    try {
      onChange({ error: false, value: sStr });
    } catch(e) {
      showToast("Trade input rejected: " + e.message, "error");
      return false;
    }

    // Event-driven: proceed as soon as the input reflects the target value
    // (compare with commas stripped — Torn formats the rendered value with
    // thousands separators). Resolves immediately if the input is already at
    // the target (e.g. user re-clicks the same amount), so no wasted 2s wait.
    await qtWaitForCondition(form, function() {
      return inp.value.replace(/,/g, "") === sStr;
    }, 2000);

    var stepBtn = form.querySelector('[class*="' + verbClass + '"]');
    if (!stepBtn) { showToast("Submit button not found", "error"); return false; }
    var stepClick = qtFindFiberProp(stepBtn, "onClick");
    if (!stepClick) { showToast("Submit handler not found — Torn UI changed?", "error"); return false; }

    // Snapshot live owned-share count BEFORE clicking. If Torn has the
    // confirmation prompt disabled (or otherwise fires the trade in a single
    // step), the Confirm Transaction button never appears — but the share
    // count changes. We use the count delta as a fallback success signal.
    var preTradeOwned = qtGetOwnedShares(symb, true);

    // Call with no args — matches the working console call pattern. Passing a
    // synthetic event arg interfered with sell-side state advancement.
    try {
      stepClick();
    } catch(e) {
      showToast("Advance to confirm failed: " + e.message, "error");
      return false;
    }

    // Wait for either:
    //   "confirm" — Confirm Transaction button appears (two-step flow, normal),
    //   "fired"   — owned shares changed in the expected direction
    //               (one-step flow, e.g. Torn confirmation prompt disabled),
    //   null      — neither happens within 5s (real failure).
    var stockRoot = document.getElementById('stockmarketroot') || document.body;
    var resolution = await new Promise(function(resolve) {
      var done = false;
      var t = setTimeout(function() { if (!done) { done = true; obs.disconnect(); resolve(null); } }, 5000);
      var check = function() {
        if (done) return;
        var btns = form.querySelectorAll("button");
        for (var i = 0; i < btns.length; i++) {
          if (/confirm/i.test(btns[i].textContent)) {
            done = true; clearTimeout(t); obs.disconnect(); resolve("confirm"); return;
          }
        }
        var post = qtGetOwnedShares(symb, true);
        var fired = action === "buyShares" ? post > preTradeOwned : post < preTradeOwned;
        if (fired) {
          done = true; clearTimeout(t); obs.disconnect(); resolve("fired");
        }
      };
      var obs = new MutationObserver(check);
      obs.observe(stockRoot, { childList: true, subtree: true, characterData: true });
      check(); // initial
    });

    if (resolution === "fired") {
      // Trade completed in one tap — sync local cache, success toast, no
      // pending second tap needed. Return the "fired" sentinel so qtUiTrade
      // can tell its caller the trade actually happened (vs a real failure).
      qtUpdateLocalCache(symb, action === "buyShares" ? shareCount : -shareCount);
      showToast(label, "success");
      return "fired";
    }
    if (!resolution) {
      showToast("Confirm Transaction did not appear (amount invalid?)", "error");
      return false;
    }
    return true;
  }

  // Step 2: re-find the Confirm Transaction button (the actions area gets
  // replaced when transitioning, so the prepare-time reference is stale) and
  // fire its fiber onClick to execute the trade.
  async function qtUiExecute(pending) {
    var symb = pending.symb;
    var shareCount = pending.shareCount;
    var action = pending.action;
    var label = pending.label;

    var sideClass = action === "buyShares" ? "buyBlock___" : "sellBlock___";
    var form = document.querySelector('[class*="' + sideClass + '"] [class*="manageBlock___"]');
    if (!form) { showToast("Trade form closed — restart trade", "error"); return false; }

    var btns = form.querySelectorAll("button");
    var confirmBtn = null;
    for (var i = 0; i < btns.length; i++) {
      if (/confirm/i.test(btns[i].textContent)) { confirmBtn = btns[i]; break; }
    }
    if (!confirmBtn) { showToast("Confirm Transaction not visible — restart trade", "error"); return false; }

    var finalClick = qtFindFiberProp(confirmBtn, "onClick");
    if (!finalClick) { showToast("Confirm handler not found", "error"); return false; }

    if (action === "buyShares") {
      var intentPrice = qtGetPrice(symb);
      if (intentPrice > 0) {
        lsSet("qt_intent_" + symb, JSON.stringify({ price: intentPrice, ts: Math.floor(Date.now() / 1000) }));
      }
    }

    // Helper: is Confirm Transaction still visible? If not, trade fired.
    var stillStuck = function() {
      var f = document.querySelector('[class*="' + sideClass + '"] [class*="manageBlock___"]');
      if (!f) return false;
      var bs = f.querySelectorAll("button");
      for (var i = 0; i < bs.length; i++) {
        if (/confirm/i.test(bs[i].textContent)) return true;
      }
      return false;
    };

    // Re-find confirm button right before clicking — handler closures depend
    // on the latest render's state.
    var refind = function() {
      var f = document.querySelector('[class*="' + sideClass + '"] [class*="manageBlock___"]');
      if (!f) return null;
      var bs = f.querySelectorAll("button");
      for (var i = 0; i < bs.length; i++) {
        if (/confirm/i.test(bs[i].textContent)) return bs[i];
      }
      return null;
    };

    var stockRoot = document.getElementById('stockmarketroot') || document.body;
    var notStuck = function() { return !stillStuck(); };

    // Each method waits via MutationObserver — exits as soon as the form
    // transitions away from Confirm Transaction (trade fired) OR after 3s
    // of no relevant change (try next method). No fixed sleeps.

    // Method 1: fiber.onClick (proven to work for sells when called from a
    // post-real-interaction state).
    try { finalClick(); } catch(e) {}
    await qtWaitForCondition(stockRoot, notStuck, 3000);

    // Method 2: DOM .click() on the (re-found) confirm button.
    if (stillStuck()) {
      var b2 = refind();
      if (b2) try { b2.click(); } catch(e) {}
      await qtWaitForCondition(stockRoot, notStuck, 3000);
    }

    // Method 3: Full PointerEvent + MouseEvent sequence on a fresh button.
    if (stillStuck()) {
      var b3 = refind();
      if (b3) {
        try {
          b3.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, button: 0, isPrimary: true }));
          b3.dispatchEvent(new MouseEvent('mousedown',     { bubbles: true, cancelable: true, view: window, button: 0 }));
          b3.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true, view: window, button: 0, isPrimary: true }));
          b3.dispatchEvent(new MouseEvent('mouseup',       { bubbles: true, cancelable: true, view: window, button: 0 }));
          b3.dispatchEvent(new MouseEvent('click',         { bubbles: true, cancelable: true, view: window, button: 0 }));
        } catch(e) {}
      }
      await qtWaitForCondition(stockRoot, notStuck, 3000);
    }

    // Method 4: Re-find fiber.onClick on the now-current button.
    if (stillStuck()) {
      var b4 = refind();
      if (b4) {
        var freshFiberClick = qtFindFiberProp(b4, "onClick");
        if (freshFiberClick) try { freshFiberClick(); } catch(e) {}
      }
      await qtWaitForCondition(stockRoot, notStuck, 3000);
    }

    // Method 5: focus + Enter keypress.
    if (stillStuck()) {
      var b5 = refind();
      if (b5) {
        try { b5.focus(); } catch(e) {}
        try {
          var ek = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
          b5.dispatchEvent(new KeyboardEvent('keydown',  ek));
          b5.dispatchEvent(new KeyboardEvent('keypress', ek));
          b5.dispatchEvent(new KeyboardEvent('keyup',    ek));
        } catch(e) {}
      }
      await qtWaitForCondition(stockRoot, notStuck, 3000);
    }

    // Method 6: focus + DOM .click() on a freshly-focused button.
    if (stillStuck()) {
      var b6 = refind();
      if (b6) {
        try { b6.focus(); } catch(e) {}
        try { b6.click(); } catch(e) {}
      }
      await qtWaitForCondition(stockRoot, notStuck, 3000);
    }

    // Method 7: walk React fiber state hooks and force boolean state to true,
    // wait for the resulting re-render, then call onClick on the fresh button.
    if (stillStuck()) {
      var b7 = refind();
      if (b7) {
        try {
          var fk = Object.keys(b7).find(function(k){return k.indexOf("__reactFiber")===0;});
          var f7 = b7[fk];
          while (f7) {
            var hook = f7.memoizedState;
            while (hook) {
              if (typeof hook.memoizedState === 'boolean' && hook.queue && typeof hook.queue.dispatch === 'function') {
                try { hook.queue.dispatch(true); } catch(e) {}
              }
              hook = hook.next;
            }
            f7 = f7.return;
          }
        } catch(e) {}
        // Wait for the dispatched state changes to commit before re-finding & clicking.
        await qtWaitForAnyMutation(stockRoot, 500);
        var freshFiberClick7 = qtFindFiberProp(refind() || b7, "onClick");
        if (freshFiberClick7) try { freshFiberClick7(); } catch(e) {}
      }
      await qtWaitForCondition(stockRoot, notStuck, 3000);
    }

    if (stillStuck()) {
      showToast("Auto-fire didn't take — tap Torn's 'Confirm Transaction' to complete: " + label, "warn");
      return false;
    }

    qtUpdateLocalCache(symb, action === "buyShares" ? shareCount : -shareCount);
    showToast(label, "success");

    var execBtn = document.getElementById("qt-exec");
    if (execBtn) {
      execBtn.textContent = "✓ " + label;
      setTimeout(function() { qtUpdateExec(); }, 3000);
    }

    return true;
  }

  // Public entry. Two-tap to comply with Torn's "1 user click = 1 action" rule:
  //   Tap 1 → qtUiPrepare (open Owned tab, set value, advance to Confirm
  //           Transaction state). One initiation, one preparation action.
  //   Tap 2 → qtUiExecute (fire Confirm Transaction). Second initiation,
  //           one trade-firing action.
  // Returns true if the trade was actually fired (tap 2 success), false on
  // tap 1 prepare or any failure — callers can use this to remove the row /
  // re-render after a successful trade.
  async function qtUiTrade(symb, shares, action, label, options) {
    if (!shares || !isFinite(shares) || shares < 1) {
      showToast("Invalid share count for " + symb, "error");
      return false;
    }
    var key = symb + "|" + action;

    // Two-tap match: same key AND same shareCount. If shares differ, the user
    // is re-aiming — fall through to a fresh prepare with the new amount. No
    // time expiry: pending lives until fired, overwritten, or page reload.
    if (qtPendingTrade && qtPendingTrade.key === key && qtPendingTrade.shareCount === shares) {
      var p = qtPendingTrade;
      qtPendingTrade = null;
      return await qtUiExecute({ symb: p.symb, shareCount: p.shareCount, action: p.action, label: p.label });
    }

    qtPendingTrade = { key: key, symb: symb, shareCount: shares, action: action, label: label };
    var prepared = await qtUiPrepare(qtPendingTrade);
    if (prepared === "fired") {
      // One-step Torn config: trade already completed inside qtUiPrepare.
      // Tell the caller so it can clean up (e.g. remove a swing-tx row).
      qtPendingTrade = null;
      return true;
    }
    if (prepared === true) {
      showToast("Tap again to fire: " + label, "warn");
    } else {
      qtPendingTrade = null;
    }
    return false;
  }

  // ── TheALFA's exact vault() ──
  function qtVault(symb) {
    var money = qtGetMoneyFast();
    if (money === 0) { showToast("No money found", "warn"); return; }
    var price = qtGetPrice(symb);
    if (price <= 0) { showToast("Could not read price for " + symb, "error"); return; }
    var amt = Math.floor(money / price);
    if (amt <= 0) { showToast("Amount too small", "warn"); return; }
    qtUiTrade(symb, amt, "buyShares", "Vaulted $" + (amt*price).toLocaleString() + " (" + amt + " shares)");
  }

  // ── TheALFA's exact withdraw() ──
  // ── Shared benefit lock check — used by all three sell paths ──
  // Returns max shares that can be safely sold (Infinity = no restriction).
  // Blocks by returning 0 when all shares are locked or count is unverifiable.
  function qtBenefitLockMax(symb) {
    var currentOwned = qtGetOwnedShares(symb);
    var oe = lastOwnedMap ? lastOwnedMap[symb.toUpperCase()] : null;
    if (oe && oe.benefit_shares > 0) {
      // Precise path: live count minus static benefit_shares (benefit_shares never
      // decreases from selling, only from losing a tier which requires buying first)
      return Math.max(0, currentOwned - oe.benefit_shares);
    }
    if (BENEFIT_REQ[symb]) {
      // Fallback: tier-based check (TSA panel not yet loaded)
      if (currentOwned === 0) return -1; // sentinel: cannot verify → block
      var curTier = qtGetBenefitTier(symb, currentOwned);
      if (curTier.tier === 0) return Infinity; // no benefit tier → no restriction
      // Max sellable = current owned minus shares needed to stay at current tier
      var keepShares = PASSIVE_STOCKS.indexOf(symb) >= 0
        ? BENEFIT_REQ[symb]
        : BENEFIT_REQ[symb] * curTier.tier;
      return Math.max(0, currentOwned - keepShares);
    }
    return Infinity; // not a benefit stock
  }

  // Single source of truth for the Benefit Lock gate. Every sell path MUST
  // call this before qtUiTrade so the three sites (swing-tx row, qtWithdrawAll,
  // qtExecuteSell) can't drift out of sync. Calls qtBuildMaps internally so
  // qtBenefitLockMax → qtGetOwnedShares has the latest qt_stockRows.
  // Returns the share count to sell (possibly capped), or null if the lock
  // refused the trade entirely (caller must not call qtUiTrade).
  function qtApplyBenefitLock(sym, shares) {
    if (!$("#qt-lock-benefit").is(":checked")) return shares;
    qtBuildMaps();
    var maxSell = qtBenefitLockMax(sym);
    if (maxSell === -1) {
      showToast("Benefit Lock: Cannot verify share count — blocked for safety", "warn");
      return null;
    }
    if (maxSell === 0) {
      showToast("Benefit Lock: All shares are benefit block shares — cannot sell", "warn");
      return null;
    }
    if (maxSell !== Infinity && shares > maxSell) {
      showToast("Benefit Lock: Capped to " + maxSell.toLocaleString() + " swing shares", "warn");
      return maxSell;
    }
    return shares;
  }

  function qtWithdrawAll(symb) {
    var owned = qtGetOwnedShares(symb);
    if (owned <= 0) { showToast("You have no shares of " + symb, "warn"); return; }
    var sellAmt = qtApplyBenefitLock(symb, owned);
    if (sellAmt === null) return;
    qtUiTrade(symb, sellAmt, "sellShares", "Sold all " + sellAmt.toLocaleString() + " shares");
  }

  function fmtQtAmt(n) {
    n = Math.abs(n || 0);
    if (n >= 1e9) return (n/1e9 % 1 === 0 ? n/1e9 : (n/1e9).toFixed(1)) + "B";
    if (n >= 1e6) return (n/1e6 % 1 === 0 ? n/1e6 : (n/1e6).toFixed(1)) + "M";
    if (n >= 1e3) return Math.round(n/1e3) + "K";
    return "$" + n;
  }

  function saveQtAmounts() { lsSet("qt_amounts", JSON.stringify(qtAmounts)); }

  function renderQtAmounts() {
    var grid = document.getElementById("qt-amounts");
    if (!grid) return;
    grid.innerHTML = "";
    var userMoney = qtGetMoneyFast();
    qtAmounts.forEach(function(amt, i) {
      var btn = document.createElement("button");
      var isActive = qtSelAmt === amt;
      var cantAfford = qtMode === "buy" && userMoney > 0 && amt > userMoney;
      btn.style.cssText = "position:relative;padding:6px 9px;border-radius:7px;border:1px solid " +
        (isActive ? (qtMode === "buy" ? "#4cff91" : "#ff4c6a") : "#2a2a4a") +
        ";background:" + (isActive ? (qtMode === "buy" ? "rgba(76,255,145,0.08)" : "rgba(255,76,106,0.08)") : "#13131f") +
        ";color:" + (isActive ? (qtMode === "buy" ? "#4cff91" : "#ff4c6a") : "#5a5a8a") +
        ";font-family:JetBrains Mono,monospace;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;" +
        (cantAfford ? "opacity:0.35;" : "");
      if (cantAfford) btn.title = "Need $" + (amt - userMoney).toLocaleString("en-US") + " more";
      btn.textContent = fmtQtAmt(amt);
      if (qtEditMode) {
        var del = document.createElement("span");
        del.textContent = "✕";
        del.style.cssText = "position:absolute;top:-6px;right:-6px;width:16px;height:16px;border-radius:50%;background:#ff4c6a;color:#fff;font-size:9px;line-height:16px;text-align:center;cursor:pointer;";
        del.onclick = function(e) {
          e.stopPropagation();
          qtAmounts.splice(i, 1);
          if (qtSelAmt === amt) qtSelAmt = null;
          saveQtAmounts(); renderQtAmounts(); qtUpdateExec();
        };
        btn.appendChild(del);
      }
      btn.onclick = function() {
        if (qtEditMode) return;
        qtSelAmt = (qtSelAmt === amt) ? null : amt;
        renderQtAmounts(); qtUpdateExec();
      };
      grid.appendChild(btn);
    });
    if (qtEditMode) {
      var addBtn = document.createElement("button");
      addBtn.textContent = "+";
      addBtn.style.cssText = "padding:6px 10px;border-radius:7px;border:1px dashed #2a2a4a;background:transparent;color:#6a6a9a;font-family:JetBrains Mono,monospace;font-size:14px;cursor:pointer;flex-shrink:0;";
      addBtn.onclick = function() {
        var val = prompt("Enter amount in $ (e.g. 25000000):");
        val = parseInt(val, 10);
        if (val > 0) { qtAmounts.push(val); qtAmounts.sort(function(a,b){return a-b;}); saveQtAmounts(); renderQtAmounts(); }
      };
      grid.appendChild(addBtn);
    }
  }

  function qtUpdateExec() {
    var btn = document.getElementById("qt-exec");
    var stock = document.getElementById("qt-stock") ? document.getElementById("qt-stock").value : "";
    if (!btn) return;
    btn.disabled = false;
    btn.style.background = qtMode === "buy" ? "rgba(76,255,145,0.15)" : "rgba(255,76,106,0.12)";
    btn.style.color = qtMode === "buy" ? "#4cff91" : "#ff4c6a";
    btn.style.borderColor = qtMode === "buy" ? "rgba(76,255,145,0.25)" : "rgba(255,76,106,0.25)";
    btn.style.opacity = (!stock || !qtSelAmt) ? "0.4" : "1";
    btn.textContent = (qtMode === "buy" ? "▲ Buy " : "▼ Sell ") +
      (qtSelAmt ? fmtQtAmt(qtSelAmt) : "?") +
      (stock ? " of " + stock : " — select stock");
    // Swing shares available label (only when lock is on + stock is a benefit stock)
    var swingLabel = document.getElementById("qt-swing-available");
    var swingInfo  = document.getElementById("qt-benefit-info");
    if (swingLabel && swingInfo) {
      var lockOn = document.getElementById("qt-lock-benefit") && document.getElementById("qt-lock-benefit").checked;
      var maxSellDisp = (lockOn && stock) ? qtBenefitLockMax(stock) : Infinity;
      if (lockOn && stock && maxSellDisp !== Infinity) {
        var dispText = maxSellDisp === -1 ? "Cannot read share count"
                     : maxSellDisp === 0  ? "No swing shares — fully locked"
                     : maxSellDisp.toLocaleString("en-US") + " swing shares available to sell";
        swingLabel.textContent = "🔒 " + dispText;
        swingInfo.style.display = "block";
      } else {
        swingInfo.style.display = "none";
      }
    }
  }

  function qtExecuteBuy(sym, dollarAmt) {
    qtBuildMaps();
    if (!sym) { showToast("Select a stock first.", "warn"); return; }
    var price = qtGetPrice(sym);
    if (price <= 0) { showToast("Could not read price for " + sym, "error"); return; }
    var money = qtGetMoneyFast();
    var spend = (money > 0 && dollarAmt > money) ? money : dollarAmt;
    var amt = Math.floor(spend / price);
    if (amt <= 0) { showToast("Amount too small.", "warn"); return; }
    qtUiTrade(sym, amt, "buyShares", "Bought " + amt.toLocaleString() + " " + sym);
  }

  function qtExecuteSell(sym, dollarAmt) {
    qtBuildMaps();
    if (!sym) { showToast("Select a stock first.", "warn"); return; }
    var price = qtGetPrice(sym);
    if (price <= 0) { showToast("Could not read price for " + sym, "error"); return; }
    var owned = qtGetOwnedShares(sym);
    if (owned <= 0) { showToast("You have no shares of " + sym, "warn"); return; }
    var shares = Math.ceil((dollarAmt / 0.999) / price);
    if (shares > owned) shares = owned;
    shares = qtApplyBenefitLock(sym, shares);
    if (shares === null) return;
    qtUiTrade(sym, shares, "sellShares", "Sold " + shares.toLocaleString() + " " + sym);
  }

  function createAmountBtn(label, amt, mode, idx) {
    var btn = document.createElement("button");
    var isBuy = mode === "buy";
    var isDark = lsGet("tsa_dark", "false") === "true";
    var buyBorder  = isDark ? "rgba(76,255,145,0.3)"  : "#1a8a45";
    var buyBg      = isDark ? "rgba(76,255,145,0.08)" : "rgba(26,138,69,0.08)";
    var buyColor   = isDark ? "#4cff91"               : "#1a8a45";
    var sellBorder = isDark ? "rgba(255,76,106,0.3)"  : "#cc2222";
    var sellBg     = isDark ? "rgba(255,76,106,0.08)" : "rgba(204,34,34,0.08)";
    var sellColor  = isDark ? "#ff4c6a"               : "#cc2222";
    btn.style.cssText = "position:relative;padding:6px 9px;border-radius:7px;border:1px solid " +
      (isBuy ? buyBorder : sellBorder) +
      ";background:" + (isBuy ? buyBg : sellBg) +
      ";color:" + (isBuy ? buyColor : sellColor) +
      ";font-family:JetBrains Mono,monospace;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;";
    btn.textContent = label;

    if (qtEditMode) {
      // Del button
      var del = document.createElement("span");
      del.textContent = "✕";
      del.style.cssText = "position:absolute;top:-6px;right:-6px;width:16px;height:16px;border-radius:50%;background:#ff4c6a;color:#fff;font-size:9px;line-height:16px;text-align:center;cursor:pointer;";
      del.onclick = function(e) {
        e.stopPropagation();
        qtAmounts.splice(idx, 1);
        saveQtAmounts(); renderQtRows();
      };
      btn.appendChild(del);
      // Click to edit value
      btn.onclick = function() {
        var newVal = prompt("Edit amount:", amt);
        newVal = parseInt(newVal, 10);
        if (newVal > 0) {
          qtAmounts[idx] = newVal;
          qtAmounts.sort(function(a,b){return a-b;});
          saveQtAmounts(); renderQtRows();
        }
      };
    } else {
      btn.onclick = function() {
        var s = $("#qt-stock").val();
        if (!s) { showToast("Select a stock first.", "warn"); return; }
        if (isBuy) qtExecuteBuy(s, amt);
        else qtExecuteSell(s, amt);
      };
    }
    return btn;
  }

  function renderQtRows() {
    var buyRow = document.getElementById("qt-buy-row");
    var sellRow = document.getElementById("qt-sell-row");
    if (!buyRow || !sellRow) return;
    buyRow.innerHTML = "";
    sellRow.innerHTML = "";

    qtAmounts.forEach(function(amt, idx) {
      buyRow.appendChild(createAmountBtn(fmtQtAmt(amt), amt, "buy", idx));
      sellRow.appendChild(createAmountBtn(fmtQtAmt(amt), amt, "sell", idx));
    });

    // ALL buy btn
    var allBuyBtn = document.createElement("button");
    allBuyBtn.title = "Vault — buy max shares with all available cash";
    var isDarkNow = lsGet("tsa_dark", "false") === "true";
    allBuyBtn.style.cssText = "padding:6px 9px;border-radius:7px;border:1px solid " + (isDarkNow ? "rgba(76,255,145,0.5)" : "#1a8a45") + ";background:" + (isDarkNow ? "rgba(76,255,145,0.15)" : "rgba(26,138,69,0.1)") + ";color:" + (isDarkNow ? "#4cff91" : "#1a8a45") + ";font-family:JetBrains Mono,monospace;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;";
    allBuyBtn.textContent = "ALL";
    allBuyBtn.onclick = function() {
      var s = $("#qt-stock").val();
      if (!s) { showToast("Select a stock first.", "warn"); return; }
      qtBuildMaps(); qtVault(s);
    };
    buyRow.appendChild(allBuyBtn);

    // ALL sell btn
    var allSellBtn = document.createElement("button");
    allSellBtn.title = "Withdraw all — sell every share of this stock (respects Benefit Lock)";
    allSellBtn.style.cssText = "padding:6px 9px;border-radius:7px;border:1px solid " + (isDarkNow ? "rgba(255,76,106,0.5)" : "#cc2222") + ";background:" + (isDarkNow ? "rgba(255,76,106,0.12)" : "rgba(204,34,34,0.08)") + ";color:" + (isDarkNow ? "#ff4c6a" : "#cc2222") + ";font-family:JetBrains Mono,monospace;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;";
    allSellBtn.textContent = "ALL";
    allSellBtn.onclick = function() {
      var s = $("#qt-stock").val();
      if (!s) { showToast("Select a stock first.", "warn"); return; }
      qtBuildMaps(); qtWithdrawAll(s);
    };
    sellRow.appendChild(allSellBtn);

    if (qtEditMode) {
      var addBtn = document.createElement("button");
      addBtn.style.cssText = "padding:6px 10px;border-radius:7px;border:1px dashed #2a2a4a;background:transparent;color:#4a6fa5;font-family:JetBrains Mono,monospace;font-size:14px;cursor:pointer;flex-shrink:0;";
      addBtn.textContent = "+";
      addBtn.onclick = function() {
        var val = prompt("Enter amount in $ (e.g. 25000000):");
        val = parseInt(val, 10);
        if (val > 0) { qtAmounts.push(val); qtAmounts.sort(function(a,b){return a-b;}); saveQtAmounts(); renderQtRows(); }
      };
      buyRow.appendChild(addBtn);
    }
  }

  function qtDrawChart(sym) {
    var container = document.getElementById("qt-chart-container");
    var canvas = document.getElementById("qt-chart-canvas");
    var title = document.getElementById("qt-chart-title");
    var liveEl = document.getElementById("qt-chart-live");
    var labelsEl = document.getElementById("qt-chart-labels");
    if (!container || !canvas) return;

    if (!sym || !getShowQtChart()) { container.style.display = "none"; return; }

    var p_live = 0;
    if (lastRaw) {
      var r = lastRaw.find(function(x) { return x.stock === sym.toUpperCase(); });
      if (r) p_live = parseFloat(r.price) || 0;
    }

    // Load ALL stored history for this stock
    var history = loadHistory();
    var points = (history[sym.toUpperCase()] || []).map(function(h) {
      return { ts: h.ts, price: h.price };
    });

    // Add live price as final point if it differs from last stored
    var now = Date.now();
    if (p_live > 0) {
      var liveTs = Math.round(now / 60000) * 60000;
      // Remove any duplicate ts at this minute, then push fresh live
      points = points.filter(function(p) { return p.ts !== liveTs; });
      points.push({ ts: liveTs, price: p_live });
    }

    // Sort chronologically
    points.sort(function(a, b) { return a.ts - b.ts; });

    // Apply selected timeframe filter
    var tf = lsGet("tsa_chart_timeframe", "all");
    (function() {
      var tfMs = { "1d": 86400000, "3d": 259200000, "7d": 604800000 }[tf];
      if (tfMs) {
        var cutoff = Date.now() - tfMs;
        points = points.filter(function(p) { return p.ts >= cutoff; });
      }
      // Highlight active button
      var btns = document.querySelectorAll(".qt-tf-btn");
      btns.forEach(function(b) {
        var active = b.getAttribute("data-tf") === tf;
        b.style.background = active ? "#2a2a4a" : "none";
        b.style.color = active ? "#e0e0ff" : "#7a7a9a";
      });
    })();

    // ── Outlier filter: drop points > 12% away from local 5-pt median ──────
    if (points.length >= 5) {
      points = points.filter(function(pt, i, arr) {
        var win = [];
        for (var j = Math.max(0, i - 2); j <= Math.min(arr.length - 1, i + 2); j++) {
          if (j !== i) win.push(arr[j].price);
        }
        if (!win.length) return true;
        win.sort(function(a, b) { return a - b; });
        var med = win[Math.floor(win.length / 2)];
        return med <= 0 || Math.abs(pt.price - med) / med < 0.12;
      });
    }

    // ── Bucket-downsample: 1 median price per 30-min slot ───────────────────
    // (collapses clustered points that cause vertical spike artifacts)
    (function() {
      var BUCKET = 30 * 60000;
      var map = {};
      points.forEach(function(pt) {
        var k = Math.floor(pt.ts / BUCKET);
        if (!map[k]) map[k] = [];
        map[k].push(pt.price);
      });
      var keys = Object.keys(map).map(Number).sort(function(a, b) { return a - b; });
      points = keys.map(function(k) {
        var arr = map[k].slice().sort(function(a, b) { return a - b; });
        return { ts: k * BUCKET + BUCKET / 2, price: arr[Math.floor(arr.length / 2)] };
      });
    })();

    if (points.length < 2) {
      container.style.display = "block";
      canvas.style.display = "none";
      var noDataEl = document.getElementById("qt-chart-nodata");
      if (!noDataEl) {
        noDataEl = document.createElement("div");
        noDataEl.id = "qt-chart-nodata";
        noDataEl.style.cssText = "padding:18px;text-align:center;font-size:11px;color:#888";
        container.appendChild(noDataEl);
      }
      noDataEl.style.display = "block";
      noDataEl.textContent = "Not enough history for " + sym + " — check back after next refresh";
      return;
    }
    canvas.style.display = "";
    var noDataEl2 = document.getElementById("qt-chart-nodata");
    if (noDataEl2) noDataEl2.style.display = "none";

    container.style.display = "block";
    if (title) title.textContent = sym + " · " + points.length + " pts · " + tf;
    if (liveEl) liveEl.textContent = p_live > 0 ? "$" + p_live.toFixed(2) : "";

    // Canvas — taller to show more detail, full width
    var w = canvas.offsetWidth || 300;
    var h = 110;
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    var prices = points.map(function(p) { return p.price; });
    var minP = Math.min.apply(null, prices);
    var maxP = Math.max.apply(null, prices);
    var range = maxP - minP || maxP * 0.001 || 1;
    var padT = 14, padB = 10, padL = 2, padR = 2;
    var chartH = h - padT - padB;
    var chartW = w - padL - padR;

    // Time range for proportional x positioning
    var tMin = points[0].ts;
    var tMax = points[points.length - 1].ts;
    var tRange = tMax - tMin || 1;

    function xOf(ts) { return padL + ((ts - tMin) / tRange) * chartW; }
    function yOf(price) { return padT + (1 - (price - minP) / range) * chartH; }

    // Grid — 4 horizontal lines
    ctx.strokeStyle = "rgba(60,60,100,0.25)";
    ctx.lineWidth = 0.5;
    for (var g = 0; g <= 3; g++) {
      var gy = padT + chartH * g / 3;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    }

    // Recalculate scales after filtering/downsampling
    if (points.length < 2) return; // guard: filtering may have removed too many
    prices = points.map(function(p) { return p.price; });
    minP = Math.min.apply(null, prices);
    maxP = Math.max.apply(null, prices);
    // Add 4% padding so line never touches the very top/bottom edge
    var pricePad = (maxP - minP) * 0.04 || maxP * 0.004 || 0.01;
    minP -= pricePad; maxP += pricePad;
    range = maxP - minP || 1;
    // Re-anchor time scale to downsampled timestamps
    tMin = points[0].ts;
    tMax = points[points.length - 1].ts;
    tRange = tMax - tMin || 1;

    // Trend color
    var isUp = prices[prices.length - 1] >= prices[0];
    var lineColor = isUp ? "#4cff91" : "#ff4c6a";
    var fillColor = isUp ? "rgba(76,255,145,0.07)" : "rgba(255,76,106,0.06)";

    // Gap threshold: segments more than 4 h apart are not connected
    var GAP = 4 * 3600000;

    // Split into continuous segments respecting gaps
    var segments = [];
    var seg = [];
    for (var si = 0; si < points.length; si++) {
      if (seg.length > 0 && points[si].ts - points[si - 1].ts > GAP) {
        if (seg.length >= 2) segments.push(seg);
        seg = [];
      }
      seg.push(points[si]);
    }
    if (seg.length >= 2) segments.push(seg);

    // Helper: draw smooth open path through segment using midpoint curves
    function drawSmoothPath(pts) {
      var x0 = xOf(pts[0].ts), y0 = yOf(pts[0].price);
      ctx.moveTo(x0, y0);
      for (var i = 1; i < pts.length; i++) {
        var x1 = xOf(pts[i].ts), y1 = yOf(pts[i].price);
        var mx = (xOf(pts[i - 1].ts) + x1) / 2;
        var my = (yOf(pts[i - 1].price) + y1) / 2;
        ctx.quadraticCurveTo(xOf(pts[i - 1].ts), yOf(pts[i - 1].price), mx, my);
      }
      // End exactly at last point
      ctx.lineTo(xOf(pts[pts.length - 1].ts), yOf(pts[pts.length - 1].price));
    }

    // Fill under each segment
    segments.forEach(function(pts) {
      ctx.beginPath();
      drawSmoothPath(pts);
      ctx.lineTo(xOf(pts[pts.length - 1].ts), h - padB);
      ctx.lineTo(xOf(pts[0].ts), h - padB);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();
    });

    // Price line over each segment
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    segments.forEach(function(pts) {
      ctx.beginPath();
      ctx.strokeStyle = lineColor;
      drawSmoothPath(pts);
      ctx.stroke();
    });

    // Buy markers (green ▲) from transaction history
    var ownedForChart = lastOwnedMap && lastOwnedMap[sym.toUpperCase()];
    if (ownedForChart && ownedForChart.transactions) {
      ownedForChart.transactions.forEach(function(t) {
        if (!t.bought_price || t.bought_price <= 0) return;
        var txMs = (t.time_bought || 0) * 1000;
        if (txMs < tMin || txMs > tMax) return;
        var x = xOf(txMs), y = yOf(t.bought_price);
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x - 4, y + 3);
        ctx.lineTo(x + 4, y + 3);
        ctx.closePath();
        ctx.fillStyle = "#4cff91";
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }

    // Sell markers (red ▼) from realized events
    var chartSellEvents = getRealizedEvents().filter(function(e) {
      return e.sym === sym.toUpperCase() && e.sell_price > 0;
    });
    chartSellEvents.forEach(function(e) {
      var evMs = e.ts * 1000;
      if (evMs < tMin || evMs > tMax) return;
      var x = xOf(evMs), y = yOf(e.sell_price);
      ctx.beginPath();
      ctx.moveTo(x, y + 5);
      ctx.lineTo(x - 4, y - 3);
      ctx.lineTo(x + 4, y - 3);
      ctx.closePath();
      ctx.fillStyle = "#ff4c6a";
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    // Min/Max price labels top-right (use actual data extremes, not padded)
    var dataMax = Math.max.apply(null, prices);
    var dataMin = Math.min.apply(null, prices);
    ctx.fillStyle = "#7a7a9a";
    ctx.font = "8px JetBrains Mono, monospace";
    ctx.textAlign = "right";
    ctx.fillText("$" + dataMax.toFixed(2), w - padR - 1, padT - 3);
    ctx.fillText("$" + dataMin.toFixed(2), w - padR - 1, h - padB + 8);

    // Time labels below — first, 25%, 50%, 75%, last
    if (labelsEl) {
      function fmtTs(ts) {
        var d = new Date(ts);
        var now2 = Date.now();
        var age = now2 - ts;
        if (age < 3600000) return Math.round(age / 60000) + "m";
        if (age < 86400000) return Math.round(age / 3600000) + "h";
        return d.getDate() + "/" + (d.getMonth() + 1);
      }
      var picks = [0, Math.floor(points.length * 0.25), Math.floor(points.length * 0.5), Math.floor(points.length * 0.75), points.length - 1];
      // Deduplicate picks
      picks = picks.filter(function(v, i, a) { return a.indexOf(v) === i; });
      labelsEl.style.position = "relative";
      labelsEl.innerHTML = picks.map(function(idx) {
        var pt = points[idx];
        var xPct = ((pt.ts - tMin) / tRange * 100).toFixed(1);
        var isLast = idx === points.length - 1;
        return '<span style="position:absolute;left:' + xPct + '%;transform:translateX(-50%);' + (isLast ? 'color:#4cff91' : '') + '">' +
          (isLast ? 'Now' : fmtTs(pt.ts)) + '</span>';
      }).join('');
    }

    // Hover tooltip
    (function() {
      var tip = document.getElementById("qt-chart-tip");
      if (!tip) {
        tip = document.createElement("div");
        tip.id = "qt-chart-tip";
        tip.style.cssText = "position:absolute;pointer-events:none;display:none;background:rgba(10,10,20,0.92);border:1px solid #3a3a6a;border-radius:6px;padding:5px 8px;font-family:JetBrains Mono,monospace;font-size:10px;color:#e0e0ff;z-index:9999;white-space:nowrap;";
        container.style.position = "relative";
        container.appendChild(tip);
      }
      canvas.onmousemove = function(ev) {
        var rect = canvas.getBoundingClientRect();
        var mx = ev.clientX - rect.left;
        var scaleX = canvas.width / rect.width;
        var px = mx * scaleX;
        // Find nearest point
        var best = null, bestDist = Infinity;
        points.forEach(function(pt) {
          var x = padL + ((pt.ts - tMin) / tRange) * chartW;
          var dist = Math.abs(x - px);
          if (dist < bestDist) { bestDist = dist; best = pt; }
        });
        if (!best) { tip.style.display = "none"; return; }
        var tipX = mx + 10;
        if (tipX + 120 > rect.width) tipX = mx - 130;
        tip.style.left = tipX + "px";
        tip.style.top = "4px";
        tip.style.display = "block";
        var d2 = new Date(best.ts);
        var timeStr = d2.getDate() + "/" + (d2.getMonth()+1) + " " +
          ("0"+d2.getHours()).slice(-2) + ":" + ("0"+d2.getMinutes()).slice(-2);
        tip.textContent = "$" + best.price.toFixed(2) + "  " + timeStr;
      };
      canvas.onmouseleave = function() { tip.style.display = "none"; };
    })();
  }

  function applyQtTheme(isDark) {
    var bar = document.getElementById("qt-bar");
    if (!bar) return;
    var bg       = isDark ? "#0c0c14"        : "#f0f4ff";
    var border   = isDark ? "#3a3a6a"        : "#c0d0ff";
    var selBg    = isDark ? "#13131f"        : "#ffffff";
    var selColor = isDark ? "#e0e0ff"        : "#222222";
    var selBord  = isDark ? "#2a2a4a"        : "#c0d0ee";
    var chartBg  = isDark ? "#0a0a12"        : "#f7f9fc";
    var chartBrd = isDark ? "#2a2a4a"        : "#dde3f0";
    var labelCol = isDark ? "#7a7a9a"        : "#666666";
    var liveCol  = isDark ? "#e0e0ff"        : "#222222";

    bar.style.cssText = bar.style.cssText
      .replace(/background:[^;]+/, "background:" + bg)
      .replace(/border-bottom:[^;]+/, "border-bottom:2px solid " + border);

    var chart = document.getElementById("qt-chart-container");
    if (chart) {
      chart.style.background = chartBg;
      chart.style.border = "1px solid " + chartBrd;
    }
    var sel = document.getElementById("qt-stock-search");
    if (sel) {
      sel.style.background = selBg;
      sel.style.color = selColor;
      sel.style.border = "1px solid " + selBord;
    }
    var listEl = document.getElementById("qt-stock-list");
    if (listEl) {
      listEl.style.background = selBg;
      listEl.style.border = "1px solid " + selBord;
    }
    var titleEl = document.getElementById("qt-chart-title");
    if (titleEl) titleEl.style.color = labelCol;
    var liveEl = document.getElementById("qt-chart-live");
    if (liveEl) liveEl.style.color = liveCol;
    var labelsEl = document.getElementById("qt-chart-labels");
    if (labelsEl) labelsEl.style.color = labelCol;
    // Benefit Lock label — yellow is invisible on light backgrounds
    var lockLabel = document.getElementById("qt-lock-label");
    var lockText  = document.getElementById("qt-lock-text");
    if (lockLabel) {
      lockLabel.style.border      = isDark ? "1px solid rgba(255,193,7,0.35)" : "1px solid #c8930a";
      lockLabel.style.background  = isDark ? "rgba(255,193,7,0.08)"           : "rgba(180,120,0,0.08)";
    }
    if (lockText) {
      lockText.style.color = isDark ? "#ffc107" : "#8a5c00";
    }
    var minBtn = document.getElementById("qt-min-btn");
    if (minBtn) {
      minBtn.style.color = isDark ? "#6a6a9a" : "#555577";
      minBtn.style.borderColor = isDark ? "#2a2a4a" : "#c0d0ee";
    }
    // Re-render buttons with new theme colors
    renderQtRows();
  }

  function createQuickTradeBar() {
    var bar = document.createElement("div");
    bar.id = "qt-bar";
    bar.style.cssText = "background:#0c0c14;border-bottom:2px solid #3a3a6a;padding:8px 12px;box-shadow:0 4px 16px rgba(0,0,0,0.5);font-family:JetBrains Mono,monospace;position:sticky;top:0;z-index:9999;";
    bar.innerHTML =
      // Row 1: Minimize button + Stock searchable combobox + edit + lock
      "<div style='display:flex;gap:7px;margin-bottom:6px;align-items:center'>" +
        "<button id='qt-min-btn' title='Minimize Quick Trade bar' style='padding:4px 7px;border-radius:7px;border:1px solid #2a2a4a;background:transparent;color:#6a6a9a;font-family:JetBrains Mono,monospace;font-size:10px;cursor:pointer;flex-shrink:0;'>&#9660;</button>" +
        "<div id='qt-stock-wrap' style='position:relative;flex:1'>" +
          "<input id='qt-stock-search' type='text' placeholder='Search stock…' autocomplete='off' style='width:100%;box-sizing:border-box;background:#13131f;border:1px solid #2a2a4a;border-radius:7px;color:#e0e0ff;font-family:JetBrains Mono,monospace;font-size:12px;font-weight:700;padding:7px 26px 7px 10px;outline:none;'>" +
          "<input type='hidden' id='qt-stock' value=''>" +
          "<span style='position:absolute;right:9px;top:50%;transform:translateY(-50%);color:#6a6a9a;font-size:9px;pointer-events:none'>▼</span>" +
          "<div id='qt-stock-list' style='display:none;position:absolute;top:calc(100% + 3px);left:0;right:0;background:#13131f;border:1px solid #2a2a4a;border-radius:7px;z-index:99999;max-height:200px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.5);'></div>" +
        "</div>" +
        "<button id='qt-edit' title='Edit trade amounts' style='padding:6px 8px;border-radius:7px;border:1px solid #2a2a4a;background:transparent;color:#6a6a9a;font-family:JetBrains Mono,monospace;font-size:10px;cursor:pointer;flex-shrink:0;'>✎</button>" +
        "<label id='qt-lock-label' title='When ON, sells are capped to swing shares so benefit-tier blocks are protected' style='display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0;padding:8px 10px;border-radius:7px;border:1px solid rgba(255,193,7,0.35);background:rgba(255,193,7,0.08);min-height:32px;'>" +
          "<input type='checkbox' id='qt-lock-benefit' checked style='accent-color:#ffc107;width:18px;height:18px;cursor:pointer;flex-shrink:0;'>" +
          "<span id='qt-lock-text' style='font-size:10px;font-weight:700;color:#ffc107;font-family:JetBrains Mono,monospace;letter-spacing:0.04em;white-space:nowrap;'>🔒 Benefit Lock</span>" +
        "</label>" +
      "</div>" +
      // Collapsible body: benefit info + buy/sell rows + rec + chart
      "<div id='qt-body'>" +
        "<div id='qt-benefit-info' style='display:none;margin-bottom:4px;padding:0 2px;'>" +
          "<span id='qt-swing-available' style='font-size:10px;color:#ffc107;font-family:JetBrains Mono,monospace;font-weight:600;'></span>" +
        "</div>" +
        // Row 2: BUY buttons
        "<div style='display:flex;gap:5px;align-items:center;margin-bottom:5px'>" +
          "<span style='font-size:9px;font-weight:700;color:#4cff91;font-family:JetBrains Mono,monospace;flex-shrink:0;letter-spacing:0.06em;'>▲</span>" +
          "<div id='qt-buy-row' style='display:flex;gap:5px;flex:1;overflow-x:auto;padding-bottom:2px'></div>" +
        "</div>" +
        // Row 3: SELL buttons
        "<div style='display:flex;gap:5px;align-items:center'>" +
          "<span style='font-size:9px;font-weight:700;color:#ff4c6a;font-family:JetBrains Mono,monospace;flex-shrink:0;letter-spacing:0.06em;'>▼</span>" +
          "<div id='qt-sell-row' style='display:flex;gap:5px;flex:1;overflow-x:auto;padding-bottom:2px'></div>" +
        "</div>" +
        // ROI recommendation
        "<div id='qt-rec' style='display:none;margin-top:6px;'></div>" +
        // Chart
        "<div id='qt-chart-container' style='display:none;margin-top:8px;background:#0a0a12;border-radius:8px;border:1px solid #2a2a4a;padding:8px 10px 6px;'>" +
          "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;'>" +
            "<span id='qt-chart-title' style='font-size:9px;font-weight:700;color:#7a7a9a;font-family:JetBrains Mono,monospace;letter-spacing:0.08em;text-transform:uppercase;'></span>" +
            "<span id='qt-chart-live' style='font-size:10px;font-weight:700;font-family:JetBrains Mono,monospace;color:#e0e0ff;'></span>" +
          "</div>" +
          "<canvas id='qt-chart-canvas' height='110' style='width:100%;height:110px;display:block;'></canvas>" +
          "<div id='qt-chart-labels' style='position:relative;height:14px;font-size:8px;color:#6a6a9a;font-family:JetBrains Mono,monospace;margin-top:2px;'></div>" +
          "<div id='qt-tf-row' style='display:flex;gap:3px;margin-top:5px;'>" +
            "<button class='qt-tf-btn' data-tf='1d' style='flex:1;min-height:32px;padding:7px 0;border-radius:4px;border:1px solid #2a2a4a;background:none;color:#7a7a9a;font-size:10px;font-family:JetBrains Mono,monospace;cursor:pointer;'>1d</button>" +
            "<button class='qt-tf-btn' data-tf='3d' style='flex:1;min-height:32px;padding:7px 0;border-radius:4px;border:1px solid #2a2a4a;background:none;color:#7a7a9a;font-size:10px;font-family:JetBrains Mono,monospace;cursor:pointer;'>3d</button>" +
            "<button class='qt-tf-btn' data-tf='7d' style='flex:1;min-height:32px;padding:7px 0;border-radius:4px;border:1px solid #2a2a4a;background:none;color:#7a7a9a;font-size:10px;font-family:JetBrains Mono,monospace;cursor:pointer;'>7d</button>" +
            "<button class='qt-tf-btn' data-tf='all' style='flex:1;min-height:32px;padding:7px 0;border-radius:4px;border:1px solid #2a2a4a;background:none;color:#7a7a9a;font-size:10px;font-family:JetBrains Mono,monospace;cursor:pointer;'>All</button>" +
          "</div>" +
        "</div>" +
      "</div>";

    var target = document.getElementById("stockmarketroot") ||
                 document.querySelector(".content-wrapper") ||
                 document.querySelector("#page-wrapper > div") ||
                 document.body;
    if (target && target.firstChild) target.insertBefore(bar, target.firstChild);
    else document.body.insertBefore(bar, document.body.firstChild);

    renderQtRows();
    setTimeout(qtBuildMaps, 1000);
    setTimeout(function() { updateQtRecommendation(null); }, 1500);
    // Apply initial theme
    applyQtTheme(lsGet("tsa_dark", "false") === "true");
    // Apply initial minimized state
    (function() {
      var minimized = lsGet("qt_minimized", "false") === "true";
      var qtBody = document.getElementById("qt-body");
      var qtMinBtn = document.getElementById("qt-min-btn");
      if (qtBody) qtBody.style.display = minimized ? "none" : "block";
      if (qtMinBtn) qtMinBtn.textContent = minimized ? "\u25B6" : "\u25BC";
    })();

    // Timeframe button click handlers
    document.querySelectorAll(".qt-tf-btn").forEach(function(btn) {
      btn.addEventListener("click", function() {
        lsSet("tsa_chart_timeframe", this.getAttribute("data-tf"));
        var sym = lsGet("qt_last_stock", "");
        if (sym) qtDrawChart(sym);
      });
    });

    // Searchable combobox logic
    (function() {
      var searchEl  = document.getElementById("qt-stock-search");
      var hiddenEl  = document.getElementById("qt-stock");
      var listEl    = document.getElementById("qt-stock-list");
      if (!searchEl || !hiddenEl || !listEl) return;

      function buildList(filter) {
        var f = (filter || "").toUpperCase().trim();
        var items = f ? QT_STOCKS.filter(function(s){ return s.indexOf(f) >= 0; }) : QT_STOCKS;
        var isDarkList = lsGet("tsa_dark", "false") === "true";
        listEl.innerHTML = "";
        items.forEach(function(sym) {
          var item = document.createElement("div");
          item.className = "qt-stock-list-item";
          item.textContent = sym;
          item.style.color = isDarkList ? "#e0e0ff" : "#222222";
          item.onmousedown = function(e) {
            e.preventDefault(); // prevent blur before click fires
            hiddenEl.value = sym;
            searchEl.value = sym;
            listEl.style.display = "none";
            lsSet("qt_last_stock", sym);
            qtDrawChart(sym);
            qtUpdateExec();
          };
          listEl.appendChild(item);
        });
        listEl.style.display = items.length ? "block" : "none";
      }

      searchEl.addEventListener("focus", function() { this.select(); buildList(""); });
      searchEl.addEventListener("input", function() {
        hiddenEl.value = "";
        buildList(searchEl.value);
        qtUpdateExec();
      });
      searchEl.addEventListener("blur", function() {
        // Small delay so mousedown on item fires first
        setTimeout(function() { listEl.style.display = "none"; }, 150);
      });
      searchEl.addEventListener("keydown", function(e) {
        if (e.key === "Escape") { listEl.style.display = "none"; searchEl.blur(); }
      });

      // Restore last selected stock
      var lastStock = lsGet("qt_last_stock", "");
      if (lastStock) {
        hiddenEl.value = lastStock;
        searchEl.value = lastStock;
        qtDrawChart(lastStock);
      }
    })();

    $("#qt-edit").on("click", function() {
      qtEditMode = !qtEditMode;
      $(this).css({color: qtEditMode ? "#4a6fa5" : "#6a6a9a", borderColor: qtEditMode ? "#4a6fa5" : "#2a2a4a"});
      $(this).text(qtEditMode ? "✓" : "✎");
      renderQtRows();
    });

    document.getElementById("qt-lock-benefit") && document.getElementById("qt-lock-benefit").addEventListener("change", function() {
      qtUpdateExec();
    });

    document.getElementById("qt-min-btn") && document.getElementById("qt-min-btn").addEventListener("click", function() {
      var minimized = lsGet("qt_minimized", "false") === "true";
      minimized = !minimized;
      lsSet("qt_minimized", String(minimized));
      var body = document.getElementById("qt-body");
      if (body) body.style.display = minimized ? "none" : "block";
      this.textContent = minimized ? "\u25B6" : "\u25BC";
    });
  }

  function createUI() {
    injectStyles();
    // Extra CSS for v1.8.0 UI features
    var extraStyle = document.createElement("style");
    extraStyle.textContent = [
      "@keyframes tsaToastIn{from{opacity:0;transform:translateX(-20px)}to{opacity:1;transform:translateX(0)}}",
      "@keyframes tsaSlideIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}",
      "#tsa-overlay.tsa-visible{animation:tsaSlideIn 0.18s ease forwards}",
      ".tsa-pin-btn{background:none;border:none;cursor:pointer;font-size:12px;padding:0 2px;opacity:0.35;transition:opacity 0.15s;line-height:1;vertical-align:middle}",
      ".tsa-pin-btn.pinned{opacity:1}",
      ".tsa-pin-btn:hover{opacity:1}",
      "#tsa-scroll-top{position:sticky;bottom:8px;float:right;margin-right:8px;z-index:10;background:#4a6fa5;color:#fff;border:none;border-radius:50%;width:26px;height:26px;font-size:13px;cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.35);line-height:1}",
      "#tsa-scroll-top:hover{background:#3a5f95}",
      "#tsa-overlay.tsa-dark #tsa-scroll-top{background:#2a2a5a;color:#a0a0ff}",
      ".qt-stock-list-item{padding:7px 10px;cursor:pointer;font-size:12px;font-weight:700;font-family:JetBrains Mono,monospace}",
      ".qt-stock-list-item:hover{background:rgba(122,159,212,0.15)}"
    ].join("\n");
    document.head.appendChild(extraStyle);

    // Create Quick Trade bar embedded in page
    createQuickTradeBar();
    var btn = document.createElement("button");
    btn.id = "tsa-btn";
    btn.textContent = "Stocks";
    document.body.appendChild(btn);

    var overlay = document.createElement("div");
    overlay.id = "tsa-overlay";
    // Dynamic width: mobile uses available screen width, desktop capped at 420px
    var isMobile = /Mobi|Android/i.test(navigator.userAgent);
    overlay.style.width = isMobile ? (window.innerWidth - 32) + "px" : "420px";
    if (lsGet("tsa_dark", "false") === "true") overlay.classList.add("tsa-dark");
    var isDarkInit = lsGet("tsa_dark", "false") === "true";
    overlay.innerHTML =
      "<div class=\"tsa-header\">" +
        "<div class=\"tsa-header-left\">" +
          "<span class=\"tsa-title\">TORN STOCK ANALYZER</span>" +
          "<button class=\"tsa-theme-btn\" id=\"tsa-roi-btn\" title=\"ROI Planner\">📊</button>" +
          "<button class=\"tsa-theme-btn\" id=\"tsa-alerts-btn\" title=\"Price Alerts\">🔔</button>" +
          "<button class=\"tsa-theme-btn\" id=\"tsa-settings-btn\" title=\"Settings\">⚙️</button>" +
          "<button class=\"tsa-theme-btn\" id=\"tsa-update-btn\" title=\"Update all\">↻</button>" +
        "</div>" +
        "<span class=\"tsa-close\" id=\"tsa-close\">x</span>" +
      "</div>" +
      "<div id=\"tsa-content\">" +
        "<div class=\"tsa-loading\">Ready to analyze</div>" +
        "<div class=\"tsa-footer\"><span></span><button class=\"tsa-refresh\" id=\"tsa-init-btn\">Start</button></div>" +
      "</div>";
    document.body.appendChild(overlay);
    applyOverlayPosition(getOverlayPosition());

    // Apply theme + API key changes from the Settings panel.
    function applyThemeChange(isDark) {
      if (isDark) overlay.classList.add("tsa-dark");
      else overlay.classList.remove("tsa-dark");
      lsSet("tsa_dark", isDark.toString());
      applyQtTheme(isDark);
    }

    document.getElementById("tsa-settings-btn").addEventListener("click", function() {
      var content = document.getElementById("tsa-content");
      var isDarkNow = overlay.classList.contains("tsa-dark");
      var bg  = isDarkNow ? "#0f0f1a" : "#ffffff";
      var bg2 = isDarkNow ? "#1a1a2e" : "#f7f9fc";
      var border = isDarkNow ? "#2a2a4a" : "#eee";
      var text = isDarkNow ? "#c8c8d8" : "#222";
      var muted = isDarkNow ? "#7a7a9a" : "#666";

      var inputStyle = "width:100%;padding:7px 10px;border-radius:7px;border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:13px;";
      var labelTitle = "font-size:11px;color:" + muted + ";margin-bottom:4px";
      var hint       = "font-size:10px;color:" + muted + ";margin-top:4px;line-height:1.4";
      var section    = "border-top:1px solid " + border + ";margin-bottom:12px;padding-top:12px";
      var sectionH   = "font-size:10px;letter-spacing:0.1em;color:" + muted + ";text-transform:uppercase;font-weight:bold;margin-bottom:10px";
      var checkLabel = "display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px";

      content.innerHTML =
        "<div style=\"padding:14px\">" +
        "<div style=\"font-size:10px;letter-spacing:0.12em;color:" + muted + ";text-transform:uppercase;font-weight:bold;margin-bottom:14px\">Settings</div>" +

        // ── Trades & alerts ─────────────────────
        "<div style=\"" + sectionH + "\">Trades & alerts</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Profit target (%)</div>" +
          "<input id=\"tsa-setting-profit\" type=\"number\" step=\"0.1\" min=\"0.1\" max=\"10\" value=\"" + getProfitTarget() + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">Typical: 1–3%. Higher = wait for bigger profits, sells trigger less often.</div>" +
        "</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Stop loss (%)</div>" +
          "<input id=\"tsa-setting-stoploss\" type=\"number\" step=\"0.1\" min=\"0.1\" max=\"20\" value=\"" + getStopLoss() + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">Typical: 2–5%. Lower = exit faster on a loss, but more false alarms.</div>" +
        "</div>" +

        // ── Refresh & data ─────────────────────
        "<div style=\"" + section + "\">" +
        "<div style=\"" + sectionH + "\">Refresh & data</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Auto-refresh (min, 0 = off)</div>" +
          "<input id=\"tsa-setting-autorefresh\" type=\"number\" step=\"1\" min=\"0\" max=\"60\" value=\"" + getAutoRefreshInterval() + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">Typical: 5–15 min. 0 disables auto-refresh — only manual refresh.</div>" +
        "</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Price history (days, 1–30)</div>" +
          "<input id=\"tsa-setting-histdays\" type=\"number\" step=\"1\" min=\"1\" max=\"30\" value=\"" + parseInt(lsGet("tsa_history_days", "30"), 10) + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">How many days of price history to fetch and chart. 30 = max detail, 7 = faster load.</div>" +
        "</div>" +
        "</div>" +

        // ── Display ─────────────────────
        "<div style=\"" + section + "\">" +
        "<div style=\"" + sectionH + "\">Display</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Theme</div>" +
          "<select id=\"tsa-setting-theme\" style=\"" + inputStyle + "\">" +
            "<option value=\"light\"" + (!isDarkNow ? " selected" : "") + ">Light</option>" +
            "<option value=\"dark\""  + (isDarkNow  ? " selected" : "") + ">Dark</option>" +
          "</select>" +
        "</div>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-show-watch\"" + (getShowWatch() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:12px;color:" + text + "\">Show Watch section</span>" +
        "</label>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-show-qt-chart\"" + (getShowQtChart() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:12px;color:" + text + "\">Show Quick Trade chart</span>" +
        "</label>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Min score for Top 5 (0–160)</div>" +
          "<input id=\"tsa-setting-top5-min\" type=\"number\" step=\"1\" min=\"0\" max=\"160\" value=\"" + getTop5MinScore() + "\" style=\"" + inputStyle + "\">" +
        "</div>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-req-investors\"" + (getRequirePositiveInvestors() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer;accent-color:#4a6fa5\">" +
          "<span style=\"font-size:12px;color:" + text + "\">Require positive investor-delta in Top 5 Buy</span>" +
        "</label>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Overlay position</div>" +
          "<select id=\"tsa-setting-position\" style=\"" + inputStyle + "\">" +
            "<option value=\"bottom-right\"" + (getOverlayPosition() === "bottom-right" ? " selected" : "") + ">Bottom right</option>" +
            "<option value=\"bottom-left\""  + (getOverlayPosition() === "bottom-left"  ? " selected" : "") + ">Bottom left</option>" +
            "<option value=\"top-right\""    + (getOverlayPosition() === "top-right"    ? " selected" : "") + ">Top right</option>" +
            "<option value=\"top-left\""     + (getOverlayPosition() === "top-left"     ? " selected" : "") + ">Top left</option>" +
          "</select>" +
        "</div>" +
        "</div>" +

        // ── Realized profits ─────────────────────
        "<div style=\"" + section + "\">" +
        "<div style=\"" + sectionH + "\">Realized profits</div>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-swing-only\"" + (getProfitSwingOnly() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:12px;color:" + text + "\">Swing trade profit only</span>" +
        "</label>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-show-realized\"" + (getShowRealized() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:12px;color:" + text + "\">Show realized profit</span>" +
        "</label>" +
        "<div id=\"tsa-realized-options\" style=\"display:" + (getShowRealized() ? "block" : "none") + ";padding-left:23px\">" +
          "<div style=\"" + labelTitle + "\">Period (days, 1–90)</div>" +
          "<input id=\"tsa-setting-realized-days\" type=\"number\" step=\"1\" min=\"1\" max=\"90\" value=\"" + getRealizedDays() + "\" style=\"" + inputStyle + ";margin-bottom:8px\">" +
          "<button id=\"tsa-realized-reset\" style=\"width:100%;padding:7px;border-radius:7px;border:1px solid " + border + ";background:none;color:" + muted + ";font-size:12px;cursor:pointer\">Reset realized profit</button>" +
        "</div>" +
        "</div>" +

        // ── Account ─────────────────────
        "<div style=\"" + section + "\">" +
        "<div style=\"" + sectionH + "\">Account</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Torn API key</div>" +
          "<input id=\"tsa-setting-apikey\" type=\"password\" autocomplete=\"off\" value=\"" + (TORN_API_KEY || "") + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">Stored in your browser only — never sent anywhere except <code>api.torn.com</code>. Get a key at torn.com/preferences.php#tab=api.</div>" +
        "</div>" +
        "</div>" +

        "<div style=\"display:flex;gap:8px\">" +
        "<button id=\"tsa-settings-save\" style=\"flex:1;padding:8px;border-radius:7px;border:none;background:#4a6fa5;color:#fff;font-size:13px;font-weight:bold;cursor:pointer\">Save</button>" +
        "<button id=\"tsa-settings-cancel\" style=\"flex:1;padding:8px;border-radius:7px;border:1px solid " + border + ";background:none;color:" + muted + ";font-size:13px;cursor:pointer\">Cancel</button>" +
        "</div>" +
        "</div>";

      // Toggle realized options visibility
      document.getElementById("tsa-setting-show-realized").addEventListener("change", function() {
        document.getElementById("tsa-realized-options").style.display = this.checked ? "block" : "none";
      });

      document.getElementById("tsa-realized-reset").addEventListener("click", function() {
        lsSet("tsa_realized_events", "[]");
        lsSet("tsa_prev_holdings", "{}");
        showToast("Realized profit reset");
        loadData();
      });

      document.getElementById("tsa-settings-save").addEventListener("click", function() {
        var profit = parseFloat(document.getElementById("tsa-setting-profit").value);
        var stop = parseFloat(document.getElementById("tsa-setting-stoploss").value);
        var ar = parseInt(document.getElementById("tsa-setting-autorefresh").value, 10);
        var hd = parseInt(document.getElementById("tsa-setting-histdays").value, 10);
        var swingOnly = document.getElementById("tsa-setting-swing-only").checked;
        var showRealized = document.getElementById("tsa-setting-show-realized").checked;
        var showWatch = document.getElementById("tsa-setting-show-watch").checked;
        var showQtChart = document.getElementById("tsa-setting-show-qt-chart").checked;
        var top5Min = parseInt(document.getElementById("tsa-setting-top5-min").value, 10);
        var reqInv = document.getElementById("tsa-setting-req-investors").checked;
        var rd = parseInt((document.getElementById("tsa-setting-realized-days") || {}).value || "7", 10);
        var posVal = document.getElementById("tsa-setting-position").value;
        var themeVal = document.getElementById("tsa-setting-theme").value;
        var keyVal = (document.getElementById("tsa-setting-apikey").value || "").trim();
        if (isNaN(profit) || profit <= 0) { showToast("Invalid profit target", "warn"); return; }
        if (isNaN(stop) || stop <= 0) { showToast("Invalid stop loss", "warn"); return; }
        if (isNaN(ar) || ar < 0) { showToast("Invalid auto-refresh interval", "warn"); return; }
        if (isNaN(hd) || hd < 1 || hd > 30) { showToast("History must be 1–30 days", "warn"); return; }
        if (isNaN(top5Min) || top5Min < 0 || top5Min > 160) { showToast("Min score must be 0–160", "warn"); return; }
        if (showRealized && (isNaN(rd) || rd < 1 || rd > 90)) { showToast("Period must be 1–90 days", "warn"); return; }
        lsSet("tsa_profit_target", profit.toString());
        lsSet("tsa_stop_loss", stop.toString());
        lsSet("tsa-auto-refresh-interval", ar.toString());
        lsSet("tsa_history_days", hd.toString());
        lsSet("tsa_profit_swing_only", swingOnly ? "true" : "false");
        lsSet("tsa_show_watch", showWatch ? "true" : "false");
        lsSet("tsa_show_qt_chart", showQtChart ? "true" : "false");
        lsSet("tsa_top5_min_score", top5Min.toString());
        lsSet("tsa_show_realized", showRealized ? "true" : "false");
        lsSet("tsa_require_positive_investors", reqInv ? "true" : "false");
        if (showRealized && !isNaN(rd)) lsSet("tsa_realized_days", rd.toString());
        lsSet("tsa_overlay_position", posVal);
        applyOverlayPosition(posVal);
        // Theme: only re-apply if it actually changed.
        var wasDark = lsGet("tsa_dark", "false") === "true";
        var nowDark = themeVal === "dark";
        if (wasDark !== nowDark) applyThemeChange(nowDark);
        // API key: only persist if changed and non-empty.
        if (keyVal && keyVal !== TORN_API_KEY) {
          TORN_API_KEY = keyVal;
          lsSet("tsa-torn-apikey", keyVal);
        }
        var saveBtn = document.getElementById("tsa-settings-save");
        if (saveBtn) {
          saveBtn.textContent = "Saved ✓";
          saveBtn.style.background = "#1a8a45";
          setTimeout(function() { loadData(); }, 700);
        } else {
          loadData();
        }
      });

      document.getElementById("tsa-settings-cancel").addEventListener("click", function() {
        loadData();
      });
    });

    document.getElementById("tsa-update-btn").addEventListener("click", function() {
      loadData();
    });

    document.getElementById("tsa-alerts-btn").addEventListener("click", function() {
      requestNotificationPermission();
      var content = document.getElementById("tsa-content");
      var isDarkNow = overlay.classList.contains("tsa-dark");
      var bg2 = isDarkNow ? "#1a1a2e" : "#f7f9fc";
      var border = isDarkNow ? "#2a2a4a" : "#eee";
      var text = isDarkNow ? "#c8c8d8" : "#222";
      var muted = isDarkNow ? "#7a7a9a" : "#666";
      var alerts = loadAlerts();

      var rows = alerts.length ? alerts.map(function(a) {
        var repeatBadge = a.repeat
          ? "<span title=\"Repeating alert\" style=\"font-size:10px;margin-left:4px;opacity:0.7\">🔁</span>"
          : "";
        return "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid " + border + ";font-size:12px;\">" +
          "<span style=\"color:" + text + ";font-weight:bold\">" + a.sym + repeatBadge + "</span>" +
          "<span style=\"color:" + muted + "\">" + (a.dir === "above" ? "≥" : "≤") + " $" + parseFloat(a.price).toFixed(2) + "</span>" +
          "<button data-sym=\"" + a.sym + "\" data-dir=\"" + a.dir + "\" class=\"tsa-alert-del\" style=\"border:none;background:none;color:#cc2222;cursor:pointer;font-size:14px;\">✕</button>" +
          "</div>";
      }).join("") : "<div style=\"color:" + muted + ";font-size:11px;padding:8px 0\">No active alerts</div>";

      var stockOpts = ["ASS","BAG","CBD","CNC","ELT","EVL","EWM","FHG","GRN","HRG","IIL","IOU","IST","LAG","LOS","LSC","MCS","MSG","MUN","PRN","PTS","SYM","SYS","TCC","TCI","TCM","TCP","TCT","TGP","THS","TMI","TSB","WLT","WSU","YAZ"]
        .map(function(s) { return "<option value=\"" + s + "\">" + s + "</option>"; }).join("");

      content.innerHTML =
        "<div style=\"padding:14px\">" +
        "<div style=\"font-size:10px;letter-spacing:0.12em;color:" + muted + ";text-transform:uppercase;font-weight:bold;margin-bottom:14px\">Price Alerts</div>" +
        "<div style=\"margin-bottom:14px\">" + rows + "</div>" +
        "<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin-bottom:6px;align-items:center\">" +
        "<select id=\"tsa-alert-sym\" style=\"padding:6px;border-radius:7px;border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:12px\">" + stockOpts + "</select>" +
        "<input id=\"tsa-alert-price\" type=\"number\" step=\"0.01\" min=\"0\" placeholder=\"Price\" style=\"padding:6px;border-radius:7px;border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:12px\">" +
        "<select id=\"tsa-alert-dir\" style=\"padding:6px;border-radius:7px;border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:12px\"><option value=\"above\">≥ Over</option><option value=\"below\">≤ Under</option></select>" +
        "<button id=\"tsa-alert-add\" style=\"padding:6px 10px;border-radius:7px;border:none;background:#4a6fa5;color:#fff;font-size:13px;font-weight:bold;cursor:pointer\">+</button>" +
        "</div>" +
        "<label style=\"display:flex;align-items:center;gap:6px;font-size:11px;color:" + muted + ";margin-bottom:10px;cursor:pointer\">" +
        "<input type=\"checkbox\" id=\"tsa-alert-repeat\" style=\"cursor:pointer\"> 🔁 Repeat — keep alert active after it fires" +
        "</label>" +
        "<button id=\"tsa-alerts-back\" style=\"width:100%;padding:8px;border-radius:7px;border:1px solid " + border + ";background:none;color:" + muted + ";font-size:13px;cursor:pointer\">Back</button>" +
        "</div>";

      document.getElementById("tsa-alert-add").addEventListener("click", function() {
        var sym = document.getElementById("tsa-alert-sym").value;
        var price = parseFloat(document.getElementById("tsa-alert-price").value);
        var dir = document.getElementById("tsa-alert-dir").value;
        var repeat = document.getElementById("tsa-alert-repeat").checked;
        if (!sym || isNaN(price) || price <= 0) { showToast("Enter a stock and valid price", "warn"); return; }
        addAlert(sym, price, dir, repeat);
        document.getElementById("tsa-alerts-btn").click();
      });

      document.querySelectorAll(".tsa-alert-del").forEach(function(btn) {
        btn.addEventListener("click", function() {
          removeAlert(btn.dataset.sym, btn.dataset.dir);
          document.getElementById("tsa-alerts-btn").click();
        });
      });

      document.getElementById("tsa-alerts-back").addEventListener("click", function() { loadData(); });
    });

    document.getElementById("tsa-roi-btn").addEventListener("click", function() {
      roiPlannerActive = !roiPlannerActive;
      document.getElementById("tsa-roi-btn").style.opacity = roiPlannerActive ? "1" : "0.7";
      if (roiPlannerActive && lastOwnedMap) {
        showROIPlanner(lastOwnedMap, lastRaw);
      } else if (!roiPlannerActive) {
        loadData();
      }
    });

    document.body.appendChild(overlay);

    btn.addEventListener("click", function() {
      var isOpen = overlay.style.display === "block";
      if (isOpen) {
        overlay.style.display = "none";
        overlay.classList.remove("tsa-visible");
      } else {
        overlay.style.display = "block";
        overlay.classList.remove("tsa-visible");
        // Force reflow so animation triggers fresh
        void overlay.offsetWidth;
        overlay.classList.add("tsa-visible");
        loadData();
      }
    });
    document.getElementById("tsa-close").addEventListener("click", function() {
      overlay.style.display = "none";
      overlay.classList.remove("tsa-visible");
    });

    // Swipe-down to close on mobile — only triggers when the swipe starts in
    // the top 60px of the overlay (the header area), so normal scrolling inside
    // the list is never accidentally intercepted.
    if (/Mobi|Android/i.test(navigator.userAgent)) {
      var swipeTouchStartY = 0;
      var swipeTouchStartOverlayY = 0;
      overlay.addEventListener("touchstart", function(e) {
        var overlayTop = overlay.getBoundingClientRect().top;
        swipeTouchStartY = e.touches[0].clientY;
        swipeTouchStartOverlayY = swipeTouchStartY - overlayTop;
      }, { passive: true });
      overlay.addEventListener("touchend", function(e) {
        if (swipeTouchStartOverlayY > 60) return; // started below header — ignore
        var deltaY = e.changedTouches[0].clientY - swipeTouchStartY;
        if (deltaY >= 80) {
          overlay.style.display = "none";
          overlay.classList.remove("tsa-visible");
        }
      }, { passive: true });
    }
    var initBtn = document.getElementById("tsa-init-btn"); if (initBtn) initBtn.addEventListener("click", loadData);
  }

  var _uiCreated = false;
  function createUIOnce() {
    if (_uiCreated) return;
    _uiCreated = true;
    createUI();
    // Silently prefetch owned stock data on load so benefit lock, swing shares
    // label, and all sell guards work immediately without opening the TSA panel.
    (function prefetchOwnedMap() {
      var key = getTornKey();
      if (!key || key === "###PDA-APIKEY###") return;
      fetchJSON("https://api.torn.com/user/?selections=stocks&key=" + key)
        .then(function(tornData) {
          if (!tornData || tornData.error) return;
          var map = buildOwnedMap(tornData);
          enrichOwnedMap(map, null);
          lastOwnedMap = map;
          qtUpdateExec(); // refresh swing shares label in QT bar
        })
        .catch(function() {});
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createUIOnce);
  } else if (document.readyState === "interactive") {
    window.addEventListener("load", createUIOnce);
  } else {
    createUIOnce();
  }
})();
