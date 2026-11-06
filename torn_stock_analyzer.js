// ==UserScript==
// @name         Torn Stock Analyzer
// @namespace    https://greasyfork.org
// @version      2.59.0
// @author       AeC3
// @description  Analyzes all 35 Torn City stocks and scores them for buy signals using 4 data-backed indicators: drop from weekly peak (dynamic volatility threshold), position in short-term range, active price rise (m30>h1>h2), and MACD momentum. Drop is measured against the week's actual high from Torn's own w1 candle, not a max of daily snapshots. A Buy zone section flags stocks that have sat in the bottom of their own 30-day range for several days, and by default its BUY calls fill the Quick Buy pills. An optional Top-5 buy list (off by default, enable it in Settings; always shown while it feeds the Quick Buy pills) only shows a stock priced in the lower half of its own 30-day range, states each row's position in that range, and says how many stocks were hidden for sitting above the middle. Includes an ROI planner that names the next benefit block to buy (affordable now, else by selling worse blocks, else the one closest to affordable) and whose roadmap is ranked by time to the highest-income block (the goal is the biggest absolute payout per month, not the best raw ROI), a benefit block tracker, swing trade P/L, benefit-block upgrade swaps, and a Quick Trade bar with a BUY/SELL direction toggle and a preview line stating what the next click will trade. Free to use with your own Torn API key: TSA reads your holdings from api.torn.com and prices and history from tornsy.com, and the key stays in your browser. Optional, paid: a TSA licence key from dossier.aec3.org (Xanax) lets TSA read the same data, and Dossier's Benefit Advisor recommendation, from Dossier instead (only the licence key is sent, only to dossier-api.aec3.org). While the licence is active TSA reads from Dossier only and never calls Torn or tornsy itself; without a licence, or if it lapses, TSA keeps working on your own key.
// @match        https://www.torn.com/page.php?sid=stocks*
// @run-at       document-end
// @license      MIT
// @antifeature  payment     Optional: a TSA licence (Xanax, via dossier.aec3.org) adds Dossier as a data source; TSA is free with your own Torn API key
// @antifeature  membership  Optional: the licence key is issued to a Dossier account (dossier.aec3.org); not needed for free use
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      tornsy.com
// @connect      api.torn.com
// @connect      dossier-api.aec3.org
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

  // Cross-manager XHR adapter. Prefers the legacy GM_xmlhttpRequest (Tampermonkey/
  // Violentmonkey), falls back to the GM4-style GM.xmlHttpRequest (some TornPDA /
  // manager builds expose only this), then a best-effort native fetch (works only
  // for hosts that send permissive CORS headers). typeof guards avoid the
  // ReferenceError of touching an undefined bare symbol. Same options object
  // {method,url,headers,onload,onerror} passes straight through to either GM API.
  // The TSA-NET markers let the node tests load this adapter unchanged.
  // ==TSA-NET-BEGIN==
  var gmXhrWarned = false;
  function gmXhr(opts) {
    // Licence mode is Dossier ONLY (owner decision 2026-11-05): while a licence is
    // active, no request may reach api.torn.com or tornsy.com, whichever code path
    // asks. The check lives outside the TSA-NET block (it needs the licence state),
    // hence the typeof guard: the node tests load this adapter on its own.
    if (typeof tsaSelfFetchBlocked === "function" && tsaSelfFetchBlocked(opts && opts.url)) {
      setTimeout(function () { if (opts.onerror) opts.onerror({ error: "licence_mode" }); }, 0);
      return;
    }
    if (typeof GM_xmlhttpRequest !== "undefined") { return GM_xmlhttpRequest(opts); }
    if (typeof GM !== "undefined" && GM && typeof GM.xmlHttpRequest === "function") { return GM.xmlHttpRequest(opts); }
    // TornPDA exposes no GM API, but provides PDA_httpGet, which forwards the
    // request to native code OUTSIDE the WebView's Content Security Policy, so a
    // host the Torn page CSP does not list in connect-src is still reachable.
    // PDA_httpGet returns a Promise resolving to
    // {responseText, status, statusText, responseHeaders}.
    // GET only — every TSA call site is a GET. Add PDA_httpPost if a POST site is ever introduced.
    // Signature is PDA_httpGet(url, headers = {}) — VERIFIED 2026-10-31 in
    // Manuito83/torn-pda userscripts/TornPDA_API.js:10, and the native handler
    // (lib/utils/webview/webview_handlers.dart:410) passes args[1] to http.get as
    // headers. Callers without headers send {} — the same as PDA's own default.
    if (typeof PDA_httpGet === "function") {
      PDA_httpGet(opts.url, opts.headers || {})
        .then(function (r) { if (opts.onload) opts.onload({ responseText: r.responseText, status: r.status, responseHeaders: r.responseHeaders }); })
        .catch(function (err) { if (opts.onerror) opts.onerror({ error: String(err) }); });
      return;
    }
    // Last resort: native fetch. Subject to the page CSP and to CORS, so it only
    // reaches a host that allows both; GM_xmlhttpRequest / PDA_httpGet are not.
    if (typeof fetch === "function") {
      fetch(opts.url, opts.headers ? { method: opts.method || "GET", headers: opts.headers } : { method: opts.method || "GET" })
        .then(function (res) {
          var hdrs = "";
          try { if (res.headers && typeof res.headers.forEach === "function") res.headers.forEach(function (v, k) { hdrs += k + ": " + v + "\r\n"; }); } catch (e) {}
          return res.text().then(function (t) { return { status: res.status, text: t, headers: hdrs }; });
        })
        .then(function (o) { if (opts.onload) opts.onload({ responseText: o.text, status: o.status, responseHeaders: o.headers }); })
        .catch(function (err) { if (opts.onerror) opts.onerror({ error: String(err) }); });
      return;
    }
    // Truly nothing available to make the request — surface it once.
    if (!gmXhrWarned) {
      gmXhrWarned = true;
      try { showToast("No network API available (GM_xmlhttpRequest, GM.xmlHttpRequest, PDA_httpGet and fetch all missing)", "error"); } catch (e) {}
    }
    if (opts.onerror) opts.onerror({ error: "No XHR API available" });
  }

  // ---- Dossier data client ----
  // Licence mode only (an optional, paid extra): with an active TSA licence, TSA
  // reads its data from these five read-only routes on Dossier, which already polls
  // Torn and tornsy for its own users. Without one, TSA fetches api.torn.com and
  // tornsy.com itself with the user's own key (free mode, see loadDirect). The
  // request carries ONLY the TSA licence key, as a Bearer header, to
  // dossier-api.aec3.org — never a Torn key, never a cookie.
  //
  // No retry, by design: a 401/403/429 repeated three times is three wasted hits on
  // a server that already answered. One request, a 10 s timeout of our own (PDA_httpGet
  // and fetch have none), and the status mapped to one outcome:
  //   ok               200 with a JSON object body
  //   licence_invalid  401 (the licence module's own 401 rule decides what follows)
  //   licence_inactive 403 {"error":"licence inactive"}
  //   key_required     403 {"error":"torn key required"} — no usable Torn key in Dossier
  //   throttled        429; Retry-After is honoured locally: nothing is sent until it passes
  //   unreachable      anything else: 5xx, network, timeout, an unreadable body
  var DOSSIER_API_BASE = "https://dossier-api.aec3.org";
  var DOSSIER_PATHS = ["/api/tsa/market", "/api/tsa/me", "/api/tsa/history", "/api/tsa/reference", "/api/tsa/benefit"];
  var DOSSIER_TIMEOUT_MS = 10000;
  var DOSSIER_RETRY_DEFAULT_S = 60;     // a 429 without a readable Retry-After
  var DOSSIER_RETRY_MAX_S = 3600;       // never trust a Retry-After for longer than this
  var dossierRetryUntil = 0;            // ms; while now < this, a 429 is answered locally

  // One response header, case-insensitively, from either a raw header block (GM,
  // fetch) or an object (PDA). "" when absent.
  function dossierHeader(headers, name) {
    var want = String(name).toLowerCase();
    if (!headers) return "";
    if (typeof headers === "string") {
      var lines = headers.split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var c = lines[i].indexOf(":");
        if (c > 0 && lines[i].slice(0, c).trim().toLowerCase() === want) return lines[i].slice(c + 1).trim();
      }
      return "";
    }
    if (typeof headers === "object") {
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && String(k).toLowerCase() === want) {
          var v = headers[k];
          return Array.isArray(v) ? String(v[0] == null ? "" : v[0]) : String(v == null ? "" : v);
        }
      }
    }
    return "";
  }

  // Pure: (status, parsed body or null, response headers) -> outcome.
  function dossierClassify(status, body, headers) {
    var isObj = body !== null && typeof body === "object" && !Array.isArray(body);
    if (status === 200 && isObj) return { kind: "ok", status: 200, body: body };
    if (status === 401) return { kind: "licence_invalid", status: 401 };
    if (status === 403 && isObj && body.error === "licence inactive") return { kind: "licence_inactive", status: 403 };
    if (status === 403 && isObj && body.error === "torn key required") return { kind: "key_required", status: 403 };
    if (status === 429) {
      var ra = parseInt(dossierHeader(headers, "Retry-After"), 10);
      if (!(ra > 0)) ra = DOSSIER_RETRY_DEFAULT_S;
      if (ra > DOSSIER_RETRY_MAX_S) ra = DOSSIER_RETRY_MAX_S;
      return { kind: "throttled", status: 429, retryAfterMs: ra * 1000 };
    }
    return { kind: "unreachable", status: status, error: status ? ("http " + status) : "no status" };
  }

  // GET one /api/tsa/* route. cb(outcome) is called exactly once. deps = the licence deps
  // ({xhr, store, now, setTimer, clearTimer}); the Bearer token is the stored licence key.
  function dossierGet(path, cb, deps) {
    var d = deps || licenseDeps;
    var done = false, timer = null;
    function finish(o) {
      if (done) return;
      done = true;
      if (timer != null) { try { d.clearTimer(timer); } catch (e) {} }
      cb(o);
    }
    if (DOSSIER_PATHS.indexOf(path) < 0) { finish({ kind: "unreachable", error: "bad_path" }); return; }
    var token = null;
    try { token = TSALicense.peek(d).state.token; } catch (e) { token = null; }
    // No valid key: nothing to send. The licence module locks on its own rules.
    if (!TSALicense.validToken(token)) { finish({ kind: "licence_invalid", error: "no_token" }); return; }
    var now = d.now();
    if (now < dossierRetryUntil) {
      finish({ kind: "throttled", retryAfterMs: dossierRetryUntil - now, local: true });
      return;
    }
    timer = d.setTimer(function () { finish({ kind: "unreachable", error: "timeout" }); }, DOSSIER_TIMEOUT_MS);
    try {
      d.xhr({
        method: "GET",
        url: DOSSIER_API_BASE + path,
        headers: { "Authorization": "Bearer " + token },
        anonymous: true,   // no cookies: the server reads only the header
        timeout: DOSSIER_TIMEOUT_MS,
        onload: function (r) {
          var body = null;
          try { body = JSON.parse(r && r.responseText); } catch (e) { body = null; }
          var o = dossierClassify(r ? Number(r.status) : 0, body, r && r.responseHeaders);
          if (o.kind === "throttled") dossierRetryUntil = d.now() + o.retryAfterMs;
          finish(o);
        },
        onerror: function () { finish({ kind: "unreachable", error: "network" }); },
        ontimeout: function () { finish({ kind: "unreachable", error: "timeout" }); }
      });
    } catch (e) {
      finish({ kind: "unreachable", error: "network" });
    }
  }
  // ==TSA-NET-END==

  // ============================================================
  // TSA LICENCE — pure decision logic + a small I/O part
  // ============================================================
  // TSA is free with the user's own Torn API key. A TSA licence (Xanax, via Dossier)
  // is an OPTIONAL extra: the user gets a tsa1_ key on dossier.aec3.org (user menu →
  // TSA licence) and pastes it into TSA Settings; while it is active, TSA reads its
  // data from Dossier instead of calling Torn and tornsy itself. Only that key is
  // sent to dossier-api.aec3.org, and only in a header. "locked" below means only
  // "licence mode is off": TSA itself is never locked — it runs in free mode
  // (owner decision 2026-11-02).
  //
  // decide(state, now, outcome) is pure (no clock, no storage, no network), so the
  // rules can be tested in node: tests/license.test.mjs loads the text between the
  // TSA-LICENSE markers with vm. The rules:
  //   - only tsa1_ + 43 url-safe characters is ever sent; anything else locks locally
  //   - an active answer is trusted for 12 h, or until its expires_ts passes, whichever
  //     is first. At exactly 12 h it is stale and re-checked.
  //   - network error / timeout / 5xx / unreadable answer: fail-open for 72 h counted
  //     from the last successful ACTIVE check (exactly 72 h = locked). Never verified =
  //     locked.
  //   - 401: locked at once and the cached status is dropped. The key itself is kept
  //     (marked rejected, re-asked after INACTIVE_MS or on "Check again"), so one
  //     stray 401 from a proxy or a bad deploy cannot wipe every user's key.
  //   - active:false: locked, showing the server's renew text
  //   - 429: keep what the cached state gives, try again after RETRY_MS
  // ==TSA-LICENSE-BEGIN==
  var TSALicense = (function () {
    var CHECK_URL   = "https://dossier-api.aec3.org/api/license/check";
    var TOKEN_RE    = /^tsa1_[A-Za-z0-9_-]{43}$/;  // dossier mints tsa1_ + secrets.token_urlsafe(32)
    var CACHE_MS    = 12 * 3600 * 1000;
    var GRACE_MS    = 72 * 3600 * 1000;
    var RETRY_MS    = 5 * 60 * 1000;   // pause after a 429 or a failed check
    var INACTIVE_MS = 10 * 60 * 1000;  // an expired licence is re-asked this often, so a renewal shows up soon
    var TIMEOUT_MS  = 10000;
    var STORE_KEY   = "tsa_license";

    function validToken(t) { return typeof t === "string" && TOKEN_RE.test(t); }

    function blank(token) {
      return { token: token || null, status: null, expires_ts: null, name: null, renew: null,
               checked_ms: null, ok_ms: null, retry_ms: null, fail: null };
    }

    // Copies only known fields, so a hand-edited or old stored blob cannot add any.
    function copy(src) {
      var o = blank(null);
      if (src && typeof src === "object") {
        for (var k in o) { if (Object.prototype.hasOwnProperty.call(src, k)) o[k] = src[k]; }
      }
      return o;
    }

    // expires_ts bounds the cache only if it lay in the future when it was received;
    // otherwise an active:true answer carrying a past expires_ts would re-check on every call.
    function expiryMs(s) {
      if (s.expires_ts == null || s.checked_ms == null) return null;
      var ms = Number(s.expires_ts) * 1000;
      if (!isFinite(ms) || ms <= s.checked_ms) return null;
      return ms;
    }

    function inGrace(s, now) {
      return s.status === "active" && s.ok_ms != null && now - s.ok_ms < GRACE_MS;
    }

    function res(s, now, locked, reason, nextCheck) {
      return { locked: locked, reason: reason, nextCheck: nextCheck,
               needsCheck: nextCheck != null && nextCheck <= now, state: s };
    }

    // No fresh answer to go on: the last known state decides, a check is due at
    // nextCheck (now, unless a 429 / failure asked to wait).
    function fallback(s, now) {
      var next = (s.retry_ms != null && s.retry_ms > now) ? s.retry_ms : now;
      if (s.status === "inactive" || s.status === "rejected") return res(s, now, true, s.status, next);
      if (inGrace(s, now)) return res(s, now, false, "grace", next);
      return res(s, now, true, s.ok_ms != null ? "grace_over" : "unverified", next);
    }

    function fromCache(s, now) {
      if (s.status === "active" && s.checked_ms != null && now - s.checked_ms < CACHE_MS) {
        var exp = expiryMs(s);
        if (exp == null || now < exp) {
          var next = s.checked_ms + CACHE_MS;
          if (exp != null && exp < next) next = exp;
          return res(s, now, false, "active", next);
        }
      }
      if ((s.status === "inactive" || s.status === "rejected") && s.checked_ms != null && now - s.checked_ms < INACTIVE_MS) {
        return res(s, now, true, s.status, s.checked_ms + INACTIVE_MS);
      }
      return fallback(s, now);
    }

    // outcome: null (judge the cache only), {kind:"response", status, body}, or
    // {kind:"error", error}. Returns {locked, reason, nextCheck, needsCheck, state};
    // state is what to persist.
    function decide(state, now, outcome) {
      var s = copy(state);
      if (!s.token) return res(s, now, true, "no_key", null);
      if (!validToken(s.token)) return res(s, now, true, "bad_format", null);
      if (outcome == null) return fromCache(s, now);

      if (outcome.kind === "response") {
        var st = outcome.status, b = outcome.body;
        var isObj = b !== null && typeof b === "object";
        if (st === 401) {
          var r = blank(s.token);
          r.status = "rejected";
          r.checked_ms = now;
          return fromCache(r, now);
        }
        if (st === 429) {
          s.retry_ms = now + RETRY_MS;
          s.fail = "rate_limited";
          return fallback(s, now);
        }
        if (st === 200 && isObj && (b.active === true || b.active === false)) {
          s.status = b.active ? "active" : "inactive";
          s.checked_ms = now;
          s.ok_ms = b.active ? now : null;
          s.expires_ts = typeof b.expires_ts === "number" ? b.expires_ts : null;
          s.name = typeof b.name === "string" ? b.name : null;
          s.renew = (!b.active && typeof b.renew === "string") ? b.renew : null;
          s.retry_ms = null;
          s.fail = null;
          return fromCache(s, now);
        }
      }
      // network error, timeout, 5xx, any other status, an unreadable 200
      s.retry_ms = now + RETRY_MS;
      s.fail = "unreachable";
      return fallback(s, now);
    }

    // ---- I/O ----
    // deps = {xhr, store:{get,set}, now(), setTimer(fn,ms), clearTimer(t)}
    // Storage is re-read on every load, so a key changed or removed in another tab
    // is seen here too. Once a read or write has failed, the in-memory copy is the
    // source of truth instead, so "save failed" can never turn into "check again"
    // in a loop.
    var mem = blank(null);
    var storeBroken = false;
    var waiting = null;   // callbacks of the check in flight: one request however often ensure() runs

    function load(deps) {
      if (!storeBroken) {
        try { mem = copy(JSON.parse(deps.store.get(STORE_KEY) || "null")); }
        catch (e) { storeBroken = true; }
      }
      return copy(mem);
    }

    function save(deps, s) {
      mem = copy(s);
      if (storeBroken) return;
      try { deps.store.set(STORE_KEY, JSON.stringify(mem)); } catch (e) { storeBroken = true; }
    }

    function request(deps, token, cb) {
      var done = false, timer = null;
      function finish(o) {
        if (done) return;
        done = true;
        if (timer != null) { try { deps.clearTimer(timer); } catch (e) {} }
        cb(o);
      }
      // Own timeout: PDA_httpGet and fetch have none, and GM's ontimeout is not universal.
      timer = deps.setTimer(function () { finish({ kind: "error", error: "timeout" }); }, TIMEOUT_MS);
      try {
        deps.xhr({
          method: "GET",
          url: CHECK_URL,
          headers: { "Authorization": "Bearer " + token },
          anonymous: true,   // no cookies: the server reads only the header
          timeout: TIMEOUT_MS,
          onload: function (r) {
            var body = null;
            try { body = JSON.parse(r && r.responseText); } catch (e) { body = null; }
            finish({ kind: "response", status: r ? Number(r.status) : 0, body: body });
          },
          onerror: function () { finish({ kind: "error", error: "network" }); },
          ontimeout: function () { finish({ kind: "error", error: "timeout" }); }
        });
      } catch (e) {
        finish({ kind: "error", error: "network" });
      }
    }

    // Calls cb(decision). Synchronous (and returns the decision) when the cache
    // answers; returns null while a check is out. force = check now even if the
    // cache is fresh (a user pressing Check again) — but not inside a 429 backoff.
    function ensure(deps, force, cb) {
      var s = load(deps);
      var now = deps.now();
      var d = decide(s, now, null);
      var backoff = s.fail === "rate_limited" && s.retry_ms != null && now < s.retry_ms;
      var due = d.needsCheck || (force && validToken(s.token) && !backoff);
      if (!due) { cb(d); return d; }
      if (waiting) { waiting.push(cb); return null; }
      waiting = [cb];
      request(deps, s.token, function (outcome) {
        var list = waiting;
        waiting = null;
        var cur = load(deps);
        if (cur.token !== s.token) {
          // the key was replaced while this answer was out: it says nothing about the new one
          ensure(deps, true, function (d3) { for (var i = 0; i < list.length; i++) list[i](d3); });
          return;
        }
        var d2 = decide(cur, deps.now(), outcome);
        save(deps, d2.state);
        for (var j = 0; j < list.length; j++) list[j](d2);
      });
      return null;
    }

    // Checks a NEW key before it replaces anything. It is stored when it opens TSA,
    // or when the current key does not (then a key that could not be confirmed yet
    // is still worth keeping, so it is retried without pasting it again). A working
    // key is never replaced by one that failed. cb({applied, decision}).
    function tryToken(deps, token, cb) {
      var t = typeof token === "string" ? token.trim() : "";
      if (!validToken(t)) { cb({ applied: false, decision: decide(blank(t), deps.now(), null) }); return; }
      request(deps, t, function (outcome) {
        var now = deps.now();
        var d = decide(blank(t), now, outcome);
        var current = decide(load(deps), now, null);
        var apply = !d.locked || current.locked;
        if (apply) save(deps, d.state);
        cb({ applied: apply, decision: d });
      });
    }

    // Stores a new key with a clean state, unchecked (tests; the UI uses tryToken).
    function setToken(deps, token) {
      var s = blank(typeof token === "string" ? token.trim() : null);
      save(deps, s);
      return decide(s, deps.now(), null);
    }

    function clear(deps) { save(deps, blank(null)); }

    function peek(deps) { return decide(load(deps), deps.now(), null); }

    return {
      decide: decide, validToken: validToken, ensure: ensure, tryToken: tryToken, setToken: setToken,
      clear: clear, peek: peek,
      CHECK_URL: CHECK_URL, STORE_KEY: STORE_KEY, CACHE_MS: CACHE_MS, GRACE_MS: GRACE_MS,
      RETRY_MS: RETRY_MS, INACTIVE_MS: INACTIVE_MS, TIMEOUT_MS: TIMEOUT_MS
    };
  })();
  // ==TSA-LICENSE-END==

  var licenseDeps = {
    xhr: function (o) { return gmXhr(o); },
    store: {
      get: function (k) { return localStorage.getItem(k); },
      set: function (k, v) { localStorage.setItem(k, v); }
    },
    now: function () { return Date.now(); },
    setTimer: function (fn, ms) { return setTimeout(fn, ms); },
    clearTimer: function (t) { clearTimeout(t); }
  };

  // ============================================================
  // TSA DATA — the Dossier routes, cached, with their fallbacks
  // ============================================================
  // Pure where it can be (plan, applyTradeLog), so tests/data.test.mjs loads the
  // text between the TSA-DATA markers with vm, beside TSA-NET and TSA-LICENSE.
  //   - get(): one route; an answer younger than maxAgeMs is reused with no request;
  //     concurrent callers share one request. /me and /market are also kept in
  //     storage, so a Dossier outage still has the last holdings and market to show.
  //   - after a failed history/reference call that route waits FAIL_WAIT_MS before
  //     it is asked again (the 429 wait is dossierGet's, from Retry-After).
  //   - plan(): two answers (/me, /market) -> lock licence | lock key | render, and
  //     what to render from.
  //   - the trade log: a Quick Trade done here is laid over /me until Dossier's own
  //     poll is newer than the trade, so a refresh does not "undo" it for ~5 min.
  // ==TSA-DATA-BEGIN==
  var TSAData = (function () {
    // keep(body): whether an answer is worth reusing and storing. A cold Dossier
    // (market data [], holdings "warming") answers 200 too; storing that would
    // overwrite the last useful copy with an empty one.
    function hasRows(b) { return !!(b && Array.isArray(b.data) && b.data.length); }
    function isPolled(b) { return !!(b && b.holdings_status === "ok"); }
    function always() { return true; }
    function same(b) { return b; }
    // /benefit: only an answer is worth keeping (an "unavailable" one included —
    // that IS Dossier's answer, and TSA shows it rather than computing its own).
    function hasAnswer(b) { return !!(b && b.answer && typeof b.answer === "object" && typeof b.answer.kind === "string"); }

    // The /me body reduced to what TSA reads, every number forced to a finite
    // number. Applied to every /me answer as it arrives, so the copy kept in
    // memory and in torn.com's localStorage holds nothing more: per holding the
    // share count, each lot's shares / buy price / buy time and the benefit
    // progress; cash; the armoury balance; the poll time. A non-number never
    // reaches the arithmetic or the page (a string in `shares` would otherwise
    // concatenate into the rendered figure).
    // A plain decimal string ("500.5") counts as its number, as /market's prices do;
    // anything else that is not a finite number is 0 / null.
    function numOrNull(v) {
      if (typeof v === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(v)) v = Number(v);
      return (typeof v === "number" && isFinite(v)) ? v : null;
    }
    function num(v) { var n = numOrNull(v); return n === null ? 0 : n; }
    function bonusOf(b) {
      return (b && typeof b === "object") ? { increment: num(b.increment), progress: num(b.progress), frequency: num(b.frequency) } : null;
    }
    function trimMe(b) {
      if (!b || typeof b !== "object") return b;
      var out = { holdings_status: typeof b.holdings_status === "string" ? b.holdings_status : null,
                  stocks: {}, money_onhand: numOrNull(b.money_onhand), armory: { ok: false, money_balance: 0 },
                  meta: { source_ts: numOrNull(b.meta && b.meta.source_ts) }, trades: [] };
      if (Array.isArray(b.trades)) out.trades = b.trades.slice(0, 300).filter(function(t) {
        return !!(t && typeof t === "object" && typeof t.ts === "number" && isFinite(t.ts) && t.ts > 0 &&
          (t.side === "buy" || t.side === "sell") && typeof t.stock_id === "number" && isFinite(t.stock_id) && /^[1-9][0-9]{0,4}$/.test(String(t.stock_id)) &&
          typeof t.shares === "number" && isFinite(t.shares) && t.shares > 0 && typeof t.price === "number" && isFinite(t.price) && t.price > 0);
      }).map(function(t) { return { ts: t.ts, side: t.side, stock_id: t.stock_id, shares: t.shares, price: t.price,
        net_profit: typeof t.net_profit === "number" && isFinite(t.net_profit) ? t.net_profit : null }; });
      if (typeof b.player_id === "number") out.player_id = b.player_id;
      if (b.armory && typeof b.armory === "object") out.armory = { ok: b.armory.ok === true, money_balance: num(b.armory.money_balance) };
      var src = (b.stocks && typeof b.stocks === "object") ? b.stocks : {};
      Object.keys(src).forEach(function (id) {
        var h = src[id];
        if (!/^[1-9][0-9]{0,4}$/.test(id) || !h || typeof h !== "object") return;
        var txs = {};
        var srcTx = (h.transactions && typeof h.transactions === "object") ? h.transactions : {};
        Object.keys(srcTx).forEach(function (t, i) {
          var x = srcTx[t];
          if (!x || typeof x !== "object") return;
          // "__proto__" would replace txs's prototype instead of adding a lot
          var ok = /^[A-Za-z0-9_]{1,40}$/.test(t) && t !== "__proto__" && t !== "constructor" && t !== "prototype";
          txs[ok ? t : "tsa_bad_key_" + i] = { shares: num(x.shares), bought_price: num(x.bought_price), time_bought: num(x.time_bought) };
        });
        var c = { stock_id: Number(id), total_shares: num(h.total_shares), transactions: txs };
        var dv = bonusOf(h.dividend), bn = bonusOf(h.benefit);
        if (dv) c.dividend = dv;          // presence matters: no `dividend` = a passive perk
        if (bn) c.benefit = bn;
        out.stocks[id] = c;
      });
      return out;
    }

    var ROUTES = {
      market:    { path: "/api/tsa/market",    store: "tsa_dossier_market", keep: hasRows,  shape: same,   maxMs: 24 * 3600 * 1000 },
      me:        { path: "/api/tsa/me",        store: "tsa_dossier_me",     keep: isPolled, shape: trimMe, maxMs: 6 * 3600 * 1000 },
      history:   { path: "/api/tsa/history",   store: null, keep: always, shape: same, maxMs: 24 * 3600 * 1000 },
      reference: { path: "/api/tsa/reference", store: null, keep: always, shape: same, maxMs: 24 * 3600 * 1000 },
      // Dossier's Benefit Advisor answer (licence mode's ONLY source of the ROI
      // recommendation). Not stored: it follows the holdings, which move.
      benefit:   { path: "/api/tsa/benefit",   store: null, keep: hasAnswer, shape: same, maxMs: 30 * 60 * 1000 }
    };
    var FAIL_WAIT_MS = 5 * 60 * 1000;
    var MARKET_FALLBACK_MAX_MS = 30 * 60 * 1000;   // stored interval snapshots older than this are not scored
    // Stored data older than its route's maxMs is not shown at all, and is deleted
    // from storage when found: 24 h for the market (public prices), 6 h for /me
    // (holdings + cash: kept only long enough to show a Dossier outage through).
    var CACHE_MAX_AGE_MS = ROUTES.market.maxMs;
    var ME_CACHE_MAX_AGE_MS = ROUTES.me.maxMs;
    // Dossier polls holdings every 5 min. A /me whose poll (meta.source_ts) is older
    // than this is not today's book: shown with its time, never treated as live.
    var ME_STALE_MS = 15 * 60 * 1000;
    var TRADE_LOG_KEY = "tsa_trade_log";
    var TRADE_LOG_MAX_MS = 30 * 60 * 1000;      // Dossier polls every 5 min; 30 min is a hard cap
    var mem = {};          // name -> {body, ms}
    var inflight = {};     // name -> [callbacks]
    var failUntil = {};    // name -> ms
    var epoch = 0;         // bumped by clear(): an answer to an older request is never kept

    function readStored(deps, name) {
      var r = ROUTES[name];
      if (!r || !r.store) return null;
      try {
        var o = JSON.parse(deps.store.get(r.store) || "null");
        if (o && typeof o === "object" && typeof o.ms === "number" && o.body && typeof o.body === "object") {
          return { body: r.shape(o.body), ms: o.ms };
        }
      } catch (e) {}
      return null;
    }

    // The newest answer known for a route, from memory or storage; null if none,
    // or if it is older than the route's maxMs (then it is deleted from storage too).
    function last(deps, name) {
      var m = mem[name] || readStored(deps, name);
      if (!m) return null;
      var r = ROUTES[name];
      if (deps.now() - m.ms >= r.maxMs) {
        if (mem[name] === m) delete mem[name];
        if (r.store) { try { deps.store.set(r.store, "null"); } catch (e) {} }
        return null;
      }
      return m;
    }

    function remember(deps, name, body, ms) {
      mem[name] = { body: body, ms: ms };
      var r = ROUTES[name];
      if (r && r.store) {
        try { deps.store.set(r.store, JSON.stringify(mem[name])); } catch (e) {}   // a full store only costs the fallback
      }
    }

    // cb(res): res = {kind, body?, ms?, cached?, fallback?, outcome?}
    //   kind "ok"      body = the route's JSON, ms = when it was received; when the
    //                  body is not worth keeping (see keep), fallback = last(name)
    //   any other kind the dossierGet outcome kind; fallback = last(name) or null
    function get(deps, name, maxAgeMs, cb) {
      var r = ROUTES[name];
      if (!r) { cb({ kind: "unreachable", fallback: null, outcome: { kind: "unreachable", error: "bad_route" } }); return; }
      var now = deps.now();
      var m = mem[name];
      if (m && maxAgeMs > 0 && now - m.ms < maxAgeMs) { cb({ kind: "ok", body: m.body, ms: m.ms, cached: true }); return; }
      if (failUntil[name] && now < failUntil[name]) {
        cb({ kind: "unreachable", fallback: last(deps, name), outcome: { kind: "unreachable", error: "waiting" } });
        return;
      }
      if (inflight[name]) { inflight[name].push(cb); return; }
      var list = inflight[name] = [cb];
      var myEpoch = epoch;
      dossierGet(r.path, function (o) {
        if (inflight[name] === list) inflight[name] = null;
        var res;
        if (myEpoch !== epoch) {
          // Asked under a licence key that has since been replaced or removed: the
          // answer may be another account's, so it is neither kept nor passed on.
          res = { kind: "unreachable", fallback: null, outcome: { kind: "unreachable", error: "stale" } };
        } else if (o.kind === "ok") {
          var t = deps.now();
          var body = r.shape(o.body);
          delete failUntil[name];
          if (r.keep(body)) {
            remember(deps, name, body, t);
            res = { kind: "ok", body: body, ms: t };
          } else {
            res = { kind: "ok", body: body, ms: t, fallback: last(deps, name) };
          }
        } else {
          // A 429 waits exactly its Retry-After (the server's number), anything else FAIL_WAIT_MS.
          if (!r.store && o.kind === "throttled") failUntil[name] = deps.now() + (o.retryAfterMs || FAIL_WAIT_MS);
          else if (!r.store && o.kind === "unreachable") failUntil[name] = deps.now() + FAIL_WAIT_MS;
          res = { kind: o.kind, fallback: last(deps, name), outcome: o };
        }
        for (var i = 0; i < list.length; i++) list[i](res);
      }, deps);
    }

    // Forget everything held for a licence: memory, the stored /me and /market and
    // the trade log. Called when the licence key changes or is removed, so one
    // Dossier account's holdings are never shown under another's key.
    function clear(deps) {
      mem = {};
      failUntil = {};
      inflight = {};
      epoch++;
      Object.keys(ROUTES).forEach(function (n) {
        var st = ROUTES[n].store;
        if (st) { try { deps.store.set(st, "null"); } catch (e) {} }
      });
      try { deps.store.set(TRADE_LOG_KEY, "[]"); } catch (e) {}
    }

    function resetWaits() { failUntil = {}; }

    // Run on start. Trims ONLY the trade log (its own entries older than 30 min) and
    // touches no other key: nothing is deleted or overwritten on start or upgrade
    // (owner decision 2026-11-02). Stored /me and /market past their maxMs are
    // still never shown, and are cleared by last() when a licensed load reads them.
    function purge(deps) {
      var nowMs = deps.now(), l = readLog(deps);
      var keep = l.filter(function (e) { return e && typeof e.ts === "number" && nowMs - e.ts * 1000 < TRADE_LOG_MAX_MS; });
      if (keep.length !== l.length) { try { deps.store.set(TRADE_LOG_KEY, JSON.stringify(keep)); } catch (e) {} }
    }

    // ---- trade log ----
    function readLog(deps) {
      try {
        var l = JSON.parse(deps.store.get(TRADE_LOG_KEY) || "[]");
        return Array.isArray(l) ? l : [];
      } catch (e) { return []; }
    }

    // One executed Quick Trade: delta > 0 bought, < 0 sold. ts in unix seconds.
    function logTrade(deps, sym, delta, price) {
      var nowMs = deps.now();
      var l = readLog(deps).filter(function (e) { return e && nowMs - e.ts * 1000 < TRADE_LOG_MAX_MS; });
      l.push({ sym: String(sym).toUpperCase(), delta: Math.round(delta), price: price > 0 ? price : 0, ts: Math.floor(nowMs / 1000) });
      try { deps.store.set(TRADE_LOG_KEY, JSON.stringify(l)); } catch (e) {}
    }

    // Pure. A copy of /me's body with every logged trade NEWER than its poll
    // (meta.source_ts) applied to `stocks`, the Torn v1 shape buildOwnedMap reads,
    // and to `money_onhand`. A buy adds a transaction at its price and costs
    // shares x price; a sell takes shares from the NEWEST transactions first (the
    // swing layer TSA's own swing maths takes them from) and pays shares x price x
    // sellFee. A trade logged without a price moves shares but not cash.
    // idBySym: SYM -> Torn stock id. The input is never modified.
    function applyTradeLog(me, log, idBySym, nowMs, sellFee) {
      if (!me || typeof me !== "object") return me;
      var src = (me.meta && typeof me.meta.source_ts === "number") ? me.meta.source_ts : 0;
      var todo = (log || []).filter(function (e) {
        return e && typeof e.ts === "number" && e.ts > src && nowMs - e.ts * 1000 < TRADE_LOG_MAX_MS &&
               idBySym[e.sym] != null && typeof e.delta === "number" && e.delta !== 0;
      });
      if (!todo.length) return me;
      var fee = sellFee > 0 ? sellFee : 1;
      var cash = (typeof me.money_onhand === "number" && isFinite(me.money_onhand)) ? me.money_onhand : null;
      var out = {};
      for (var k in me) { if (Object.prototype.hasOwnProperty.call(me, k)) out[k] = me[k]; }
      var stocks = {};
      var srcStocks = me.stocks && typeof me.stocks === "object" ? me.stocks : {};
      Object.keys(srcStocks).forEach(function (id) {
        var h = srcStocks[id], txs = {};
        Object.keys((h && h.transactions) || {}).forEach(function (t) {
          var x = h.transactions[t];
          txs[t] = { shares: x.shares, bought_price: x.bought_price, time_bought: x.time_bought };
        });
        var c = {};
        for (var f in h) { if (Object.prototype.hasOwnProperty.call(h, f)) c[f] = h[f]; }
        c.transactions = txs;
        stocks[id] = c;
      });
      todo.forEach(function (e, i) {
        var id = String(idBySym[e.sym]);
        var h = stocks[id];
        if (e.delta > 0) {
          if (!h) h = stocks[id] = { stock_id: Number(id), total_shares: 0, transactions: {} };
          h.transactions["tsa_local_" + e.ts + "_" + i] = { shares: e.delta, bought_price: e.price || 0, time_bought: e.ts };
          h.total_shares = (h.total_shares || 0) + e.delta;
          if (cash != null && e.price > 0) cash -= e.delta * e.price;
          return;
        }
        if (!h) return;
        var left = -e.delta;
        var keys = Object.keys(h.transactions).sort(function (a, b) {
          return (h.transactions[b].time_bought || 0) - (h.transactions[a].time_bought || 0);
        });
        for (var j = 0; j < keys.length && left > 0; j++) {
          var tx = h.transactions[keys[j]];
          var take = Math.min(tx.shares || 0, left);
          tx.shares = (tx.shares || 0) - take;
          left -= take;
          if (tx.shares <= 0) delete h.transactions[keys[j]];
        }
        h.total_shares = Math.max(0, (h.total_shares || 0) + e.delta + left);
        if (cash != null && e.price > 0) cash += (-e.delta - left) * e.price * fee;
        if (!Object.keys(h.transactions).length) delete stocks[id];
      });
      out.stocks = stocks;
      if (cash != null) out.money_onhand = Math.max(0, Math.round(cash));
      return out;
    }

    // ---- what a load does with its two answers ----
    // Pure. meRes / marketRes are get() results, nowMs the clock. Returns
    //   {lock: "licence"|"key"|null, me, meMs, meSourceMs, holdingsLive, stale, warming,
    //    market, marketMs, marketLive, dossier: null|"throttled"|"unreachable", retryMs}
    //   holdingsLive  /me answered 200 with holdings_status "ok" just now AND its
    //                 poll is younger than ME_STALE_MS — the only case in which a
    //                 holdings DIFF (realized profit) may be booked
    //   stale         /me answered "ok", but Dossier's poll of it is older than
    //                 ME_STALE_MS (its poll has stalled): shown, not live
    //   meSourceMs    when Dossier polled the holdings shown (meta.source_ts), or null
    //   me            the /me body to show: live, or the stored one, or null
    //   market        the /market body to use: live (with rows), or the stored one if
    //                 it is younger than MARKET_FALLBACK_MAX_MS, or null (page prices)
    function plan(meRes, marketRes, nowMs) {
      var res = [meRes, marketRes];
      for (var i = 0; i < res.length; i++) {
        if (res[i] && (res[i].kind === "licence_invalid" || res[i].kind === "licence_inactive")) return { lock: "licence" };
      }
      for (var j = 0; j < res.length; j++) {
        if (res[j] && res[j].kind === "key_required") return { lock: "key" };
      }
      var p = { lock: null, me: null, meMs: null, meSourceMs: null, holdingsLive: false, stale: false, warming: false,
                market: null, marketMs: null, marketLive: false, dossier: null, retryMs: null };
      function note(r) {
        if (r.kind === "throttled") {
          p.dossier = "throttled";
          var ra = r.outcome && r.outcome.retryAfterMs;
          if (ra != null && (p.retryMs == null || ra > p.retryMs)) p.retryMs = ra;
        } else if (p.dossier !== "throttled") {
          p.dossier = "unreachable";
        }
      }
      if (meRes && meRes.kind === "ok") {
        if (meRes.body.holdings_status === "ok") {
          p.me = meRes.body; p.meMs = meRes.ms; p.holdingsLive = true;
        } else {
          // "warming": Dossier has not polled this player since it started. Show the
          // last holdings known here, if any, and say why they are not fresh.
          p.warming = true;
          var fb = meRes.fallback || null;
          if (fb) { p.me = fb.body; p.meMs = fb.ms; }
        }
      } else if (meRes) {
        note(meRes);
        if (meRes.fallback) { p.me = meRes.fallback.body; p.meMs = meRes.fallback.ms; }
      }
      var srcTs = p.me && p.me.meta && p.me.meta.source_ts;
      if (typeof srcTs === "number" && srcTs > 0) p.meSourceMs = srcTs * 1000;
      if (p.holdingsLive && p.meSourceMs != null && nowMs - p.meSourceMs > ME_STALE_MS) {
        p.holdingsLive = false;
        p.stale = true;
      }
      if (marketRes && marketRes.kind === "ok" && hasRows(marketRes.body)) {
        p.market = marketRes.body; p.marketMs = marketRes.ms; p.marketLive = true;
      } else if (marketRes) {
        if (marketRes.kind !== "ok") note(marketRes);
        var mf = marketRes.fallback;
        if (mf && hasRows(mf.body) && nowMs - mf.ms < MARKET_FALLBACK_MAX_MS) { p.market = mf.body; p.marketMs = mf.ms; }
      }
      return p;
    }

    return {
      get: get, last: last, clear: clear, resetWaits: resetWaits, plan: plan, purge: purge,
      logTrade: logTrade, readLog: readLog, applyTradeLog: applyTradeLog, trimMe: trimMe,
      FAIL_WAIT_MS: FAIL_WAIT_MS, CACHE_MAX_AGE_MS: CACHE_MAX_AGE_MS, ME_CACHE_MAX_AGE_MS: ME_CACHE_MAX_AGE_MS,
      ME_STALE_MS: ME_STALE_MS, TRADE_LOG_MAX_MS: TRADE_LOG_MAX_MS,
      MARKET_FALLBACK_MAX_MS: MARKET_FALLBACK_MAX_MS
    };
  })();
  // ==TSA-DATA-END==

  // Skip alert/signal toasts when the tab isn't actively viewed — the toast
  // TTL would expire before the user returns. Alerts/signals remain
  // un-consumed and re-fire on the next loadData() when active.
  // ON SCREEN, which is NOT the same as focused — and the difference decides whether
  // anything at all happens inside TornPDA. PDA's webview reports
  // document.hasFocus() === false even while the page is fully on screen (the on-load
  // fetch in createUIOnce has gated on visibilityState alone for exactly this reason),
  // so every hasFocus-gated timer silently never fires there: auto-refresh, price
  // alerts and the history warm-up all did nothing on the platform the owner actually
  // uses. A hidden tab still fails this test, so the "no background traffic" rule is
  // kept — a page you are looking at is not a background page.
  // Owner decision 2026-08-25: this is the gate for anything periodic.
  function isOnScreen() {
    return document.visibilityState !== "hidden";
  }

  var TORN_API_KEY = lsGet("tsa-torn-apikey", "");

  function getTornKey() {
    return lsGet("tsa-torn-apikey", "");
  }

  var KEY_BUILDER_URL = "https://www.torn.com/preferences.php#tab=api?step=addNewKey&user=basic,money,stocks&faction=donations&market=itemmarket&title=TORN%20STOCK%20ANALYZER";

  // note: optional plain-text line shown above the prompt (e.g. why a licence-mode
  // load could not use Dossier). Escaped.
  function showKeyOnboarding(contentEl, onSave, note) {
    // renders inside #tsa-overlay, so the tokens resolve and switch themselves
    var bg   = "var(--tsa-bg)";
    var bg2  = "var(--tsa-bg-raised)";
    var text = "var(--tsa-fg)";
    var muted = "var(--tsa-fg-muted)";
    var border = "var(--tsa-border)";
    contentEl.innerHTML =
      "<div style=\"padding:18px;background:" + bg + ";font-family:var(--tsa-sans)\">" +
        (note ? "<div style=\"font-size:var(--tsa-fs-micro);color:" + text + ";background:var(--tsa-warn-bg);border:1px solid var(--tsa-warn-border);border-radius:var(--tsa-r-2);padding:8px 10px;margin-bottom:12px;line-height:1.5\">" + escHtml(note) + "</div>" : "") +
        "<div style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + text + ";margin-bottom:6px\">API Key Required</div>" +
        "<div style=\"font-size:var(--tsa-fs-micro);color:" + muted + ";margin-bottom:14px;line-height:1.5\">Torn Stock Analyzer needs a Torn API key to load stock and portfolio data. Your key is stored only in your browser and sent exclusively to api.torn.com.</div>" +
        "<a href=\"" + KEY_BUILDER_URL + "\" target=\"_blank\" style=\"display:block;text-align:center;padding:10px;border-radius:var(--tsa-r-3);background:var(--tsa-accent);color:var(--tsa-on-accent);font-size:var(--tsa-fs-micro);font-weight:bold;text-decoration:none;margin-bottom:14px\">Create custom key (recommended)</a>" +
        "<div style=\"font-size:var(--tsa-fs-micro);color:" + muted + ";margin-bottom:6px;text-align:center\">— or enter an existing key below —</div>" +
        "<div style=\"font-size:var(--tsa-fs-micro);color:" + muted + ";margin-bottom:6px\">Limited Access key or custom key</div>" +
        "<input id=\"tsa-key-input\" type=\"text\" placeholder=\"Paste API key here\" style=\"width:100%;box-sizing:border-box;padding:8px 10px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:var(--tsa-fs-micro);margin-bottom:10px\">" +
        "<button id=\"tsa-key-save\" style=\"width:100%;padding:9px;border-radius:var(--tsa-r-2);border:none;background:var(--tsa-accent);color:var(--tsa-on-accent);font-size:var(--tsa-fs-body);font-weight:bold;cursor:pointer\">Save key</button>" +
      "</div>";
    document.getElementById("tsa-key-save").addEventListener("click", function() {
      var val = (document.getElementById("tsa-key-input").value || "").trim();
      if (!val) return;
      lsSet("tsa-torn-apikey", val);
      lsSet("tsa_stock_catalogue_fail_ts", "0");   // new key, fresh attempt
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
  // Nothing is deleted or overwritten on start (owner decision 2026-11-02): this
  // trims only the trade log's own entries older than 30 min.
  try { TSAData.purge(licenseDeps); } catch (e) {}
  // Where the current load reads its data: "direct" = free mode (the user's own
  // Torn key, api.torn.com + tornsy.com, as in 2.50) or "dossier" = licence mode.
  // Set by every load (loadDirect / loadDossier); this first value only steers what
  // runs before the first load. Read from the cached licence state, no request.
  var dataMode = licenceModeOn() ? "dossier" : "direct";
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
    if (mins <= 0) return;
    // Pause auto-refresh while the tab isn't actively viewed — no point
    // hitting the API for a panel nobody is looking at. Resumed by the
    // visibilitychange / focus listener below, which fires one immediate
    // loadData() that then re-enters this function with a fresh schedule.
    if (!isOnScreen()) return;
    autoRefreshEndTime = Date.now() + mins * 60000;
    autoRefreshCountdownInterval = setInterval(updateCountdownLabel, 1000);
    autoRefreshTimer = setTimeout(function() {
      autoRefreshTimer = null;
      if (autoRefreshCountdownInterval) { clearInterval(autoRefreshCountdownInterval); autoRefreshCountdownInterval = null; }
      autoRefreshEndTime = null;
      loadData();
    }, mins * 60000);
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
    // Defer consume + toast until the user is actively viewing — otherwise
    // the one-shot alert would be consumed silently while the user is away.
    if (!isOnScreen()) return;
    // Remove one-shot fired alerts; keep repeat alerts active
    var firedKeys = fired.map(function(f) { return f.sym + f.dir; });
    saveAlerts(alerts.filter(function(a) { return a.repeat || firedKeys.indexOf(a.sym + a.dir) < 0; }));
    fired.forEach(function(f) {
      var msg = f.sym + " is " + (f.dir === "above" ? "above" : "below") + " $" + f.price.toFixed(2) + " (live: $" + f.live.toFixed(2) + ")";
      showToast("Price Alert: " + msg, "warn");
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  var lastOwnedMap = null;
  var lastRaw = null;
  var lastMissingBatches = 0; // interval groups missing at last load (drives the partial-data banner on cached re-renders)
  var lastPricesFromPage = false; // last load priced from the page (no market data from Dossier)
  var lastDataBanner = ""; // Dossier status line of the last load (throttled / unreachable / warming); plain text
  var prevLoadPrices = {}; // price baseline from the PREVIOUS real load (trend arrows); cached re-renders must not touch it
  var lastLoadTs = 0; // wall-clock of the last successful fetch — footer "Updated:" stamp (render time would mislabel cached data as fresh)
  var lastBestRec = null; // Best ROI recommendation from last data load
  var lastCashBalance = 0; // money_onhand from the last loadData fetch — bridge-pill capital (same source as the ROI Planner)
  var lastArmoryFunds = 0; // faction armory balance from the last loadData fetch — bridge-pill capital
  var lastItemFetchTs = 0; // last fetchAllItemPrices run on the pill path (TTL-gated; the planner fetches on every open)
  var lastBuySymbols = []; // Symbols driving the Quick Buy pills - the Top-5 buy list, or the Buy zone when the source setting says so
  var lastBuyInvDelta = {}; // {sym: 24h investor delta} for the Quick Buy pill sub-text
  var lastBuyPriceDelta = {}; // {sym: 24h price change %} for the Quick Buy pill sub-text
  var lastBuyScores = {}; // {sym: buy score} for the Quick Buy pill sub-text
  var lastBuyZonePos = {}; // {sym: position % in its own 30-day range} for the Buy-zone pill sub-text
  var lastBuySource = "top5"; // which list actually filled lastBuySymbols on the last render - drives the pill group label
  var lastSwingPills = []; // [{sym, shares, profit}] snapshot for the Swing sell pills
  // Pending two-step Upgrade swap: set after the user clicks the Upgrade pill and the
  // worse benefit tier is sold (step 1). Holds the buy half so step 2 (the next click)
  // buys the better tier deterministically, even if a re-render recomputes the plan.
  // In-memory only (a within-session intent); cleared on the buy or via the ✕ pill.
  var qtPendingUpgrade = null; // {sells:[{sym,tier,shares}], total, buy:{sym,tier,shares}, buyPrice, expectedCash}
  var _firstLoadKicked = false; // guards the on-load first full loadData against double-fire

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

// ============================================================
// DESIGN TOKENS
// ============================================================
// One token set for the whole UI. Emitted as scoped CSS custom properties on the
// four roots below (plus .tsa-scope, which the two body-level toasts and the chart
// tooltip carry because they are appended outside the overlay). Every name is
// prefixed --tsa-* so Torn's own cascade cannot collide with it.
//
// Both themes, always: the light values are the BASE rule, so every colour token
// exists unconditionally; the dark rule only ever REDEFINES. A colour that lived in
// one branch only would break for whoever runs the other theme, and nothing here can
// do that.
//
// Sizes are px, not rem: rem would resolve against Torn's own <html> font-size,
// which this script does not control. 12/14/16/24px is the same four-step scale as
// dossier's .75/.875/1/1.5rem at a 16px root.
var TSA_TOKEN_CSS = [
  "#tsa-btn, #tsa-overlay, #qt-bar, #qt-pills, .tsa-scope {",
  // type: four steps, 12px floor. hierarchy comes from weight and colour, never size
  "  --tsa-fs-micro: 12px; --tsa-lh-micro: 1.4;",
  "  --tsa-fs-body: 14px; --tsa-lh-body: 1.55;",
  "  --tsa-fs-lead: 16px; --tsa-lh-lead: 1.4;",
  // declared for completeness, applied nowhere: the overlay has no single dominant
  // number, it has three stat tiles side by side in a 358px-wide grid, where 24px
  // would overflow the column. Same call dossier made ("intet hero-trin").
  "  --tsa-fs-stat: 24px; --tsa-lh-stat: 1.15;",
  // platform faces only. The two webfont families this script used to name (a mono and
  // a sans) were declared 34 times with no @font-face and no webfont, so both silently
  // fell back already; naming the fallback makes the real rendering explicit. No
  // external font is fetched.
  "  --tsa-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;",
  "  --tsa-sans: system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;",
  // radius: one scale, anchored on .5rem = 8px; the four steps are px for the same
  // reason the type steps are
  "  --tsa-radius: .5rem;",
  "  --tsa-r-1: 4px; --tsa-r-2: 6px; --tsa-r-3: 8px; --tsa-r-4: 12px;",
  // a circle is a shape, not a step on the scale: the only non-scale radius left,
  // and it has to stay 50% to stay round on a square box
  "  --tsa-r-circle: 50%;",
  // ---- light palette (the base) ----
  "  --tsa-bg: #ffffff;",
  "  --tsa-bg-raised: #f7f9fc;",
  "  --tsa-bg-bar: #f0f4ff;",
  "  --tsa-bg-input: #ffffff;",
  "  --tsa-bg-chart: #f7f9fc;",
  "  --tsa-border: #e5e9f0;",
  "  --tsa-border-strong: #c0d0ff;",
  "  --tsa-fg: #222222;",
  "  --tsa-fg-strong: #111827;",
  "  --tsa-fg-muted: #5a6472;",
  "  --tsa-fg-faint: #6d7684;",
  "  --tsa-accent: #4a6fa5;",
  "  --tsa-accent-hover: #3a5f95;",
  "  --tsa-accent-bg: #f0f4ff;",
  "  --tsa-accent-border: #c0d0ff;",
  "  --tsa-on-accent: #ffffff;",
  "  --tsa-on-badge: #ffffff;",
  // money polarity, CVD-safe. The two green/red pairs this script used before (one
  // per theme) were the exact hue pair dossier measured at deltaE 2.2 for deutan:
  // profit and loss
  // were practically the same colour for a red-green colour-blind reader. Green is
  // pushed toward teal, red toward rose: deltaE 7.7. That band is only legal WITH a
  // secondary encoding, so the sign character stays on every signed number.
  "  --tsa-pos: #107569;",
  // STRONG BUY sits a step deeper in the SAME hue rather than on a second hue -
  // hierarchy from value, not from a new colour. The old #FFD700 measured 1.4:1 on
  // white, so light-theme readers could barely see the strongest signal.
  "  --tsa-pos-strong: #0b5d54;",
  "  --tsa-neg: #c81e3f;",
  "  --tsa-pos-bg: rgba(16,117,105,.08);",
  "  --tsa-pos-bg-hi: rgba(16,117,105,.16);",
  "  --tsa-pos-border: rgba(16,117,105,.35);",
  "  --tsa-neg-bg: rgba(200,30,63,.08);",
  "  --tsa-neg-bg-hi: rgba(200,30,63,.16);",
  "  --tsa-neg-border: rgba(200,30,63,.35);",
  // neutral = no direction (hold rows, the hold score)
  "  --tsa-neutral: #4a6fa5;",
  "  --tsa-neutral-bg: rgba(74,111,165,.08);",
  "  --tsa-neutral-bg-hi: rgba(74,111,165,.16);",
  "  --tsa-neutral-border: rgba(74,111,165,.30);",
  "  --tsa-warn: #8a5c00;",
  "  --tsa-warn-bg: #fffbeb;",
  "  --tsa-warn-border: #fde68a;",
  // categorical pill hues: bank = ROI, bridge = bridgebuilder, swap = upgrade swap.
  // Not polarity, and never used for a signed number.
  "  --tsa-bank: #1d4ed8;",
  "  --tsa-bank-bg: rgba(29,78,216,.08);",
  "  --tsa-bank-border: rgba(29,78,216,.35);",
  "  --tsa-bridge: #155e75;",
  "  --tsa-bridge-bg: rgba(21,94,117,.08);",
  "  --tsa-bridge-border: rgba(21,94,117,.35);",
  "  --tsa-swap: #7e22ce;",
  "  --tsa-swap-bg: rgba(126,34,206,.08);",
  "  --tsa-swap-border: rgba(126,34,206,.35);",
  "  --tsa-shadow: rgba(0,0,0,.15);",
  "  --tsa-grid: rgba(74,111,165,.20);",
  // toasts are appended to document.body, outside every root, so they carry
  // class="tsa-scope tsa-dark": they are a dark scrim in both themes by design.
  "  --tsa-scrim: rgba(16,20,28,.95);",
  "  --tsa-toast-fg: #ffffff;",
  "  --tsa-scroll-thumb: #c9d2e0;",
  "}",
  // ---- dark branch: redefines, never introduces ----
  "#tsa-overlay.tsa-dark, #qt-bar.tsa-dark, #qt-pills.tsa-dark, .tsa-scope.tsa-dark {",
  "  --tsa-bg: #0f0f1a;",
  "  --tsa-bg-raised: #1a1a2e;",
  "  --tsa-bg-bar: #0c0c14;",
  "  --tsa-bg-input: #13131f;",
  "  --tsa-bg-chart: #0a0a12;",
  "  --tsa-border: #2a2a4a;",
  "  --tsa-border-strong: #3a3a6a;",
  "  --tsa-fg: #c8c8d8;",
  "  --tsa-fg-strong: #e0e0ff;",
  "  --tsa-fg-muted: #8b93a8;",
  "  --tsa-fg-faint: #7d7dab;",
  "  --tsa-accent: #7a9fd4;",
  "  --tsa-accent-hover: #a8c4e8;",
  "  --tsa-accent-bg: rgba(122,159,212,.12);",
  "  --tsa-accent-border: rgba(122,159,212,.40);",
  "  --tsa-on-accent: #0f0f1a;",
  "  --tsa-on-badge: #0c0c14;",
  "  --tsa-pos: #34d399;",
  "  --tsa-pos-strong: #6ee7b7;",
  "  --tsa-neg: #fb5c73;",
  "  --tsa-pos-bg: rgba(52,211,153,.10);",
  "  --tsa-pos-bg-hi: rgba(52,211,153,.20);",
  "  --tsa-pos-border: rgba(52,211,153,.35);",
  "  --tsa-neg-bg: rgba(251,92,115,.10);",
  "  --tsa-neg-bg-hi: rgba(251,92,115,.20);",
  "  --tsa-neg-border: rgba(251,92,115,.35);",
  "  --tsa-neutral: #a0a0ff;",
  "  --tsa-neutral-bg: rgba(160,160,255,.07);",
  "  --tsa-neutral-bg-hi: rgba(160,160,255,.16);",
  "  --tsa-neutral-border: rgba(160,160,255,.22);",
  "  --tsa-warn: #ffc107;",
  "  --tsa-warn-bg: rgba(255,193,7,.08);",
  "  --tsa-warn-border: rgba(255,193,7,.30);",
  "  --tsa-bank: #93c5fd;",
  "  --tsa-bank-bg: rgba(147,197,253,.10);",
  "  --tsa-bank-border: rgba(147,197,253,.35);",
  "  --tsa-bridge: #22d3ee;",
  "  --tsa-bridge-bg: rgba(34,211,238,.10);",
  "  --tsa-bridge-border: rgba(34,211,238,.35);",
  "  --tsa-swap: #d8b4fe;",
  "  --tsa-swap-bg: rgba(216,180,254,.10);",
  "  --tsa-swap-border: rgba(216,180,254,.35);",
  "  --tsa-shadow: rgba(0,0,0,.5);",
  "  --tsa-grid: rgba(160,160,255,.18);",
  "  --tsa-scroll-thumb: #3a3a6a;",
  "}"
].join("\n");

// Canvas cannot read var(), so the chart resolves the same tokens off a live element.
// One token set, two readers - the CSS above is the only place a value is written.
function tsaToken(name, el) {
  var host = el || document.getElementById("qt-bar") || document.getElementById("tsa-overlay");
  if (!host) return "";
  return getComputedStyle(host).getPropertyValue("--tsa-" + name).trim();
}

var STYLES = TSA_TOKEN_CSS + "\n" + [
  "#tsa-btn {",
  "  position: fixed; bottom: 80px; right: 16px; z-index: 2147483647;",
  "  background: var(--tsa-accent); color: var(--tsa-on-accent); border: none;",
  "  border-radius: var(--tsa-r-4); padding: 10px 18px;",
  "  font-size: var(--tsa-fs-body); line-height: var(--tsa-lh-lead);",
  "  font-family: var(--tsa-sans); cursor: pointer; font-weight: 700;",
  "  box-shadow: 0 2px 8px var(--tsa-shadow);",
  "  -webkit-tap-highlight-color: transparent; touch-action: none;",
  "}",
  "#tsa-btn:hover { background: var(--tsa-accent-hover); }",
  "#tsa-overlay {",
  "  position: fixed; bottom: 130px; right: 16px; z-index: 2147483646;",
  // overflow-X too, not only Y. The 12px type floor made 121 text sites 20-33%
  // wider, and a nowrap row wider than the mobile width (innerWidth-32, i.e. as
  // little as 358px) would otherwise break OUT of the panel instead of scrolling
  // inside it. Wide content scrolls in its own box; the panel never does.
  "  max-height: 75vh; overflow-y: auto; overflow-x: auto;",
  "  background: var(--tsa-bg); border: 1px solid var(--tsa-border);",
  "  border-radius: var(--tsa-r-4);",
  "  font-family: var(--tsa-sans); font-size: var(--tsa-fs-micro);",
  "  line-height: var(--tsa-lh-micro); color: var(--tsa-fg);",
  "  box-shadow: 0 4px 20px var(--tsa-shadow); display: none;",
  "}",
  "#tsa-overlay::-webkit-scrollbar { width: 4px; }",
  "#tsa-overlay::-webkit-scrollbar-thumb { background: var(--tsa-scroll-thumb); border-radius: var(--tsa-r-1); }",
  ".tsa-header {",
  "  display: flex; align-items: center; justify-content: space-between;",
  "  padding: 12px 14px; border-bottom: 1px solid var(--tsa-border);",
  "  position: sticky; top: 0; background: var(--tsa-bg); z-index: 1;",
  "}",
  ".tsa-header-left { display: flex; align-items: center; gap: 8px; }",
  ".tsa-title { font-size: var(--tsa-fs-body); font-weight: 700; color: var(--tsa-accent); letter-spacing: 0.05em; }",
  ".tsa-theme-btn {",
  "  font-size: var(--tsa-fs-body); cursor: pointer; background: none; border: none;",
  "  padding: 2px 4px; line-height: 1; opacity: 0.7;",
  "}",
  ".tsa-theme-btn:hover { opacity: 1; }",
  ".tsa-close { cursor: pointer; color: var(--tsa-fg-muted); font-size: var(--tsa-fs-lead); padding: 0 4px; line-height: 1; }",
  ".tsa-close:hover { color: var(--tsa-fg); }",
  ".tsa-stats {",
  "  display: grid; grid-template-columns: repeat(3, 1fr);",
  "  gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--tsa-border);",
  "}",
  ".tsa-stat { background: var(--tsa-bg-raised); border-radius: var(--tsa-r-3); padding: 8px; text-align: center; border: 1px solid var(--tsa-border); }",
  ".tsa-stat-label { font-size: var(--tsa-fs-micro); color: var(--tsa-fg-muted); margin-bottom: 4px; }",
  ".tsa-stat-value { font-size: var(--tsa-fs-lead); line-height: var(--tsa-lh-lead); font-weight: 700; color: var(--tsa-fg); }",
  ".tsa-stat-value.green { color: var(--tsa-pos); }",
  ".tsa-stat-value.red { color: var(--tsa-neg); }",
  ".tsa-section { padding: 10px 14px 6px; }",
  ".tsa-section-title { font-size: var(--tsa-fs-micro); letter-spacing: 0.12em; color: var(--tsa-fg-muted); text-transform: uppercase; margin-bottom: 8px; font-weight: 700; }",
  ".tsa-row {",
  "  display: flex; align-items: center; justify-content: space-between;",
  "  padding: 8px 10px; border-radius: var(--tsa-r-3); margin-bottom: 5px; cursor: pointer;",
  "}",
  ".tsa-row.buy { background: var(--tsa-pos-bg); border: 1px solid var(--tsa-pos-border); }",
  ".tsa-row.sell { background: var(--tsa-neg-bg); border: 1px solid var(--tsa-neg-border); }",
  ".tsa-row.hold { background: var(--tsa-neutral-bg); border: 1px solid var(--tsa-neutral-border); }",
  ".tsa-row.buy:active { background: var(--tsa-pos-bg-hi); }",
  ".tsa-row.sell:active { background: var(--tsa-neg-bg-hi); }",
  ".tsa-row.hold:active { background: var(--tsa-neutral-bg-hi); }",
  ".tsa-row-left { display: flex; flex-direction: column; gap: 2px; }",
  ".tsa-symbol { font-size: var(--tsa-fs-body); line-height: var(--tsa-lh-body); font-weight: 700; }",
  ".tsa-symbol.buy { color: var(--tsa-pos); }",
  ".tsa-symbol.sell { color: var(--tsa-neg); }",
  ".tsa-symbol.hold { color: var(--tsa-neutral); }",
  ".tsa-detail { font-size: var(--tsa-fs-micro); line-height: var(--tsa-lh-micro); color: var(--tsa-fg-muted); }",
  ".tsa-row-right { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }",
  ".tsa-score { font-size: var(--tsa-fs-body); line-height: var(--tsa-lh-body); font-weight: 700; }",
  ".tsa-score.buy { color: var(--tsa-pos); }",
  ".tsa-score.sell { color: var(--tsa-neg); }",
  ".tsa-score.hold { color: var(--tsa-neutral); }",
  ".tsa-badge { font-size: var(--tsa-fs-micro); padding: 2px 6px; border-radius: var(--tsa-r-2); font-weight: 700; }",
  ".tsa-badge.benefit { background: var(--tsa-warn-bg); color: var(--tsa-warn); border: 1px solid var(--tsa-warn-border); }",
  ".tsa-divider { border: none; border-top: 1px solid var(--tsa-border); margin: 6px 14px; }",
  ".tsa-footer {",
  "  padding: 10px 14px; display: flex; justify-content: space-between;",
  "  align-items: center; border-top: 1px solid var(--tsa-border); background: var(--tsa-bg-raised);",
  "  border-radius: 0 0 var(--tsa-r-4) var(--tsa-r-4);",
  "}",
  ".tsa-updated { font-size: var(--tsa-fs-micro); color: var(--tsa-fg-faint); }",
  ".tsa-refresh {",
  "  font-size: var(--tsa-fs-micro); background: var(--tsa-accent); border: none;",
  "  color: var(--tsa-on-accent); border-radius: var(--tsa-r-2); padding: 5px 12px; cursor: pointer;",
  "  font-family: var(--tsa-sans); font-weight: 700;",
  "}",
  ".tsa-refresh:hover { background: var(--tsa-accent-hover); }",
  ".tsa-loading { padding: 30px; text-align: center; color: var(--tsa-fg-faint); font-size: var(--tsa-fs-micro); }",
  "@keyframes tsa-spin { to { transform: rotate(360deg); } }",
  // 50% here is a circle, not a step on the radius scale - the only survivor of the
  // old eight radius values, and it has to be 50% to stay round.
  ".tsa-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: var(--tsa-r-circle); animation: tsa-spin 0.7s linear infinite; vertical-align: middle; margin-right: 6px; opacity: 0.6; }",
  ".tsa-error { padding: 16px; color: var(--tsa-neg); font-size: var(--tsa-fs-micro); text-align: center; }"
].join("\n");

  // ============================================================
  // ROI PLANNER
  // ============================================================

  var ROI_TABLE = [
    {sym:"SYM",tier:"T1",payout:4153424,freq:7,type:"variable",item:370},
    {sym:"FHG",tier:"T1",payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T1",payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"PRN",tier:"T1",payout:4019972,freq:7,type:"variable",item:366},
    {sym:"SYM",tier:"T2",payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T1",payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T1",payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"THS",tier:"T1",payout:272431,freq:7,type:"variable",item:365},
    {sym:"MUN",tier:"T1",payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T1",payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T1",payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T1",payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T1",payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T2",payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T2",payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"PRN",tier:"T2",payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T1",payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T1",payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T3",payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T2",payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T1",payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T2",payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T1",payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T2",payout:272431,freq:7,type:"variable",item:365},
    {sym:"MUN",tier:"T2",payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T2",payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T2",payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T2",payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T2",payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T3",payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T3",payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T1",payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T3",payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T2",payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T2",payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T4",payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T3",payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T2",payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T3",payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T2",payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T3",payout:272431,freq:7,type:"variable",item:365},
    {sym:"MUN",tier:"T3",payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T3",payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T3",payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T3",payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T3",payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T4",payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T4",payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T2",payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T4",payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T3",payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T3",payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T5",payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T4",payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T3",payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T4",payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T3",payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T4",payout:272431,freq:7,type:"variable",item:365},
    {sym:"LAG",tier:"T1",payout:203827,freq:7,type:"variable",item:368},
    {sym:"MUN",tier:"T4",payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T4",payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T4",payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T4",payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T4",payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T5",payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T5",payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T3",payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T5",payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T4",payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T4",payout:861423,freq:7,type:"variable",item:369},
    {sym:"SYM",tier:"T6",payout:4153424,freq:7,type:"variable",item:370},
    {sym:"GRN",tier:"T5",payout:4000000,freq:31,type:"fixed",item:0},
    {sym:"CNC",tier:"T4",payout:80000000,freq:31,type:"fixed",item:0},
    {sym:"IOU",tier:"T5",payout:12000000,freq:31,type:"fixed",item:0},
    {sym:"ASS",tier:"T4",payout:894596,freq:7,type:"variable",item:817},
    {sym:"THS",tier:"T5",payout:272431,freq:7,type:"variable",item:365},
    {sym:"LAG",tier:"T2",payout:203827,freq:7,type:"variable",item:368},
    {sym:"MUN",tier:"T5",payout:12705756,freq:7,type:"variable",item:818},
    {sym:"PTS",tier:"T5",payout:3000000,freq:7,type:"volatile",item:0},
    {sym:"TMI",tier:"T5",payout:25000000,freq:31,type:"fixed",item:0},
    {sym:"HRG",tier:"T5",payout:45456058,freq:31,type:"random",item:0},
    {sym:"EWM",tier:"T5",payout:1080642,freq:7,type:"variable",item:364},
    {sym:"FHG",tier:"T6",payout:12390647,freq:7,type:"variable",item:367},
    {sym:"TCT",tier:"T6",payout:1000000,freq:31,type:"fixed",item:0},
    {sym:"TCC",tier:"T4",payout:29526634,freq:31,type:"variable",item:0},
    {sym:"PRN",tier:"T6",payout:4019972,freq:7,type:"variable",item:366},
    {sym:"TSB",tier:"T5",payout:50000000,freq:31,type:"fixed",item:0},
    {sym:"LSC",tier:"T5",payout:861423,freq:7,type:"variable",item:369}
  ];

  // Lookup map for O(1) ROI_TABLE access: key = "SYM|Tn"
  var ROI_MAP = {};
  function rebuildRoiMap() {
    Object.keys(ROI_MAP).forEach(function(k) { delete ROI_MAP[k]; });
    ROI_TABLE.forEach(function(e) { ROI_MAP[e.sym + "|" + e.tier] = e; });
  }
  rebuildRoiMap();

  // BASELINE snapshot of the HARDCODED payouts, frozen at module init BEFORE
  // anything can mutate ROI_TABLE. It is the per-SYMBOL safety net for the runtime
  // derivation below: a stale payout for one symbol is a far smaller loss than
  // that symbol vanishing from the planner.
  //
  // 🪤 It MUST come from the hardcoded literal, never from a derived table — a
  // second install would otherwise snapshot its own output and the real baseline
  // would be gone for good. The IIFE runs exactly once at load, which is what
  // makes that impossible; there is no re-snapshot path to get wrong.
  //
  // VERIFIED 2026-08-25 (counted over the literal above): 88 rows, 18 symbols,
  // and every row of a symbol carries the SAME payout and the SAME item id — 0
  // exceptions. So the per-symbol view loses nothing, and it also covers the
  // tiers the hand-built table stopped short of (LAG stops at T2, the derivation
  // goes to T6).
  var BASELINE_ROI = (function() {
    var byKey = {}, bySym = {};
    ROI_TABLE.forEach(function(e) {
      byKey[e.sym + "|" + e.tier] = { payout: e.payout, item: e.item };
      if (!bySym[e.sym]) bySym[e.sym] = { payout: e.payout, item: e.item };
    });
    return { byKey: byKey, bySym: bySym, syms: Object.keys(bySym).sort() };
  })();

  // Item IDs with sellable market value
  var ITEM_IDS = [364, 365, 366, 367, 368, 369, 370, 817, 818];
  // PTS gives 100 points = $3M fixed
  var PTS_VALUE = 3000000;

  // Torn takes 0.1% on every stock sale. Stored as the MULTIPLIER you apply to a
  // gross sale (price * SELL_FEE = what actually lands), not as the rate, because
  // every net-proceeds and net-profit line below wants the multiplier directly.
  // Divide by it to go the other way (the price that nets a given profit target).
  // Where the RATE is wanted instead, write (1 - SELL_FEE) rather than restating
  // the number — one definition, so a change to Torn's fee lands everywhere.
  var SELL_FEE = 0.999;

  // Stocks with item-paying benefits that aren't hardcoded in ROI_TABLE — the
  // script discovers their item ID at runtime (one-shot) by name and synthesises
  // T1-T6 entries into ROI_TABLE.
  var DYNAMIC_BENEFIT_STOCKS = {
    "BAG": { itemName: "Ammunition Pack", freq: 7, type: "variable" }
  };

  // roiSkipped holds SYMBOL-level skip keys (e.g. "CBD"), not per-tier. Skipping
  // any tier row of a stock skips the WHOLE stock: it is hidden from the ROI
  // Planner AND excluded from the Benefit Lock (qtBenefitLockMax) so its shares
  // become fully sellable. The lock has no per-tier granularity, so symbol-level
  // is the only coherent mapping. Legacy per-tier keys ("CBDT2") written by older
  // versions are normalized to symbol-level on load (and re-persisted) so the two
  // representations can't drift apart.
  var roiSkipped = (function() {
    try {
      var arr = JSON.parse(localStorage.getItem("tsa_roi_skipped") || "[]") || [];
      var seen = {}, out = [];
      arr.forEach(function(k) {
        var sym = String(k).replace(/T\d+$/, "");
        if (sym && !seen[sym]) { seen[sym] = 1; out.push(sym); }
      });
      // Re-persist if normalization changed anything (legacy tier keys / dupes).
      if (out.length !== arr.length || out.some(function(s, i) { return s !== arr[i]; })) {
        lsSet("tsa_roi_skipped", JSON.stringify(out));
      }
      return out;
    } catch(e) { return []; }
  })();
  function roiSymSkipped(sym) {
    var up = String(sym).toUpperCase();
    return roiSkipped.some(function(k) { return k.replace(/T\d+$/, "") === up; });
  }
  // roiTierCap holds SYMBOL → max benefit tiers to KEEP (e.g. {"CBD":3}). Distinct
  // from roiSkipped: a cap keeps tiers 1..N as benefit blocks and releases every
  // share ABOVE tier N to swing (sellable + counted as planner capital); a skip
  // releases the WHOLE position. Skip takes precedence (checked first in
  // enrichOwnedMap), so a stock that is both skipped and capped is fully released.
  var roiTierCap = (function() {
    try {
      var raw = JSON.parse(localStorage.getItem("tsa_roi_tier_cap") || "{}") || {};
      var out = {};
      Object.keys(raw).forEach(function(k) {
        var sym = String(k).toUpperCase().replace(/T\d+$/, "");
        var n = parseInt(raw[k], 10);
        if (sym && n >= 0 && isFinite(n)) out[sym] = n;
      });
      return out;
    } catch(e) { return {}; }
  })();
  // Effective cap for a symbol: the stored tier limit, or Infinity (no cap).
  function roiSymTierCap(sym) {
    var up = String(sym).toUpperCase();
    return Object.prototype.hasOwnProperty.call(roiTierCap, up) ? roiTierCap[up] : Infinity;
  }
  function saveRoiTierCap() { lsSet("tsa_roi_tier_cap", JSON.stringify(roiTierCap)); }
  var itemPrices = {}; // itemId -> price: lowest item-market listing (free mode) or Torn's market_value via Dossier (licence mode)
  // itemNames are stable, persist them.
  var itemNames = (function() {
    try { return JSON.parse(lsGet("tsa_item_names", "{}")) || {}; }
    catch(e) { return {}; }
  })();
  // itemIdsByName: name → id reverse map, from Dossier's item catalogue
  // (/api/tsa/reference, daily). Used to resolve DYNAMIC_BENEFIT_STOCKS.
  var itemIdsByName = (function() {
    try { return JSON.parse(lsGet("tsa_item_ids_by_name", "{}")) || {}; }
    catch(e) { return {}; }
  })();
  // itemMarketValues: name → Torn's official market_value, from the same
  // catalogue. It is the item value everywhere (itemPrices is filled from it), and
  // gives synthesised DYNAMIC_BENEFIT_STOCKS entries their `payout`.
  var itemMarketValues = (function() {
    try { return JSON.parse(lsGet("tsa_item_market_values", "{}")) || {}; }
    catch(e) { return {}; }
  })();

  // ============================================================
  // BENEFIT DESCRIPTION PARSER
  // A DELIBERATE port of one reference implementation, not a second one written
  // from scratch: anything else that values a Torn benefit has to agree with this
  // to the cent, so keep the regexes and the branch ORDER byte-identical.
  //
  // VERIFIED 2026-08-25 against a live torn/?selections=stocks: all 35 benefit
  // descriptions classify identically in both languages (6 cash, 12 item,
  // 1 points, 16 perk; 0 unclassified). Fixture archived out of repo.
  // ============================================================

  var _CASH_RE    = /^\$([\d,]+)$/;
  var _ITEM_RE    = /^(\d+)\s*x\s+(.+?)$/;
  var _POINTS_RE  = /^(\d+)\s+points?$/i;

  // One benefit description -> {amount, kind, detail}.
  // `kind` is "cash" | "item" | "points" | "unpriceable". `amount` is whole
  // dollars per cycle, sign POSITIVE (income to the holder).
  //
  // An item is valued at the CALLER's price for it. There is deliberately no
  // baked-in fallback price: an undated snapshot of a market price is the one
  // thing this parser exists not to carry, so an item we cannot price comes back
  // "unpriceable" and the caller DROPS the row instead of ranking it off a guess.
  // "points" is the single documented exception — an owner-chosen rate, and it
  // reuses PTS_VALUE (the value of PTS's 100-point benefit) divided by 100
  // rather than declaring a second $/point constant that could drift from it.
  function parsePayout(description, itemValueByName) {
    var text = String(description == null ? "" : description).trim();
    if (!text) return { amount: 0, kind: "unpriceable", detail: "no description" };

    var m = _CASH_RE.exec(text);
    if (m) return { amount: parseFloat(m[1].replace(/,/g, "")), kind: "cash", detail: text };

    m = _ITEM_RE.exec(text);
    if (m) {
      var qty = parseInt(m[1], 10), name = m[2].trim();
      var price = itemValueByName ? itemValueByName[name] : 0;
      if (price && price > 0) return { amount: qty * price, kind: "item", detail: name };
      return { amount: 0, kind: "unpriceable", detail: "no market value for '" + name + "'" };
    }

    m = _POINTS_RE.exec(text);
    if (m) return { amount: parseInt(m[1], 10) * (PTS_VALUE / 100), kind: "points", detail: text };

    // "50 nerve", "1000 happiness", "100 energy", and every passive perk ("a 10%
    // bank interest bonus"). Real benefits with no dollar figure Torn publishes
    // and no owner-chosen rate either — pricing them would mean inventing one.
    return { amount: 0, kind: "unpriceable", detail: "non-monetary: " + text };
  }

  // {qty, name} when the benefit pays a NAMED ITEM, else {qty:null, name:null}.
  // The same regex parsePayout matches on, exposed separately because "what does
  // this block give me" and "what is it worth" are different questions with
  // different failure modes. BAG's "1x Ammunition Pack" has no catalogue entry,
  // so parsePayout correctly says unpriceable — the item NAME is still the honest
  // answer to the first question. Never guesses: no match, no name.
  function payoutItem(description) {
    var m = _ITEM_RE.exec(String(description == null ? "" : description).trim());
    if (!m) return { qty: null, name: null };
    return { qty: parseInt(m[1], 10), name: m[2].trim() };
  }

  // The ART of the income: "cash" | "item" | "points" | "perk".
  // NOT parsePayout's `kind`: that one answers "could we put a dollar figure on
  // it" and collapses two different arts into "unpriceable" — a NAMED ITEM with
  // no market value (BAG "1x Ammunition Pack", HRG "1x Random Property", TCC
  // "1x Clothing Cache") versus a genuinely non-monetary benefit ("50 nerve",
  // every passive perk). The first is item-paid income we cannot price; the
  // second is not cash income at all.
  //
  // DERIVED FROM THE BRANCH parsePayout ACTUALLY TOOK, never from whether a row
  // happens to carry an item name. For cash/item/points the branch IS the answer;
  // only the collapsed "unpriceable" case re-runs the item regex, where _CASH_RE
  // and _POINTS_RE have by definition already failed — so the three cannot
  // disagree about one description.
  //
  // NOTE the deliberate asymmetry: art "item" with a null price means "item-paid,
  // price unknown" and must NEVER be read as $0.
  function payoutKind(parseKind, description) {
    if (parseKind === "cash" || parseKind === "item" || parseKind === "points") return parseKind;
    return _ITEM_RE.test(String(description == null ? "" : description).trim()) ? "item" : "perk";
  }

  // Length of one payout cycle in DAYS, straight from Torn's benefit.frequency.
  // VERIFIED 2026-08-25: the 27 weekly stocks report 7 and all eight monthly ones
  // (CNC GRN HRG IOU TCC TCT TMI TSB) report exactly 31 — a fixed 31-day cycle,
  // never the current calendar month's length.
  function cycleDaysFromFreq(freq) {
    var f = parseInt(freq, 10);
    return (isFinite(f) && f > 0) ? f : 7;
  }

  // ============================================================
  // STOCK CATALOGUE — derive the benefit tables at runtime
  //
  // PASSIVE_STOCKS (:241), BENEFIT_REQ (:244) and ROI_TABLE.freq (:265) were
  // hand-maintained copies of data Torn publishes. VERIFIED 2026-08-25 against a
  // live torn/?selections=stocks: all three matched the API EXACTLY (13/13
  // passives set-equal, 35/35 requirements, 88/88 freq values), so nothing is
  // lost by deriving them — and a future change on Torn's side now lands by
  // itself instead of silently rotting. The hardcoded tables STAY as the
  // COLD-START FALLBACK (first load, offline, API down) and as the PER-SYMBOL
  // payout source whenever a derived row cannot be priced — including the two
  // payouts the API can never price (see UNPRICEABLE_PAYOUT_FALLBACK). The
  // degradation is per symbol, never all-or-nothing: requirements, frequencies
  // and the passive set need no item price at all, so an item-price failure must
  // not be able to take them down with it.
  //
  // 🪤 `stocks` is a DICT keyed on the stock id as a STRING ("1".."35"), not a
  // list.
  // ============================================================

  // DELIBERATELY EMPTY, owner decision 2026-08-25. It used to carry two frozen
  // figures — HRG 45,456,058 and TCC 29,526,634 — for the two benefits whose payout
  // has no entry in the item catalogue: "1x Random Property" and "1x Clothing Cache".
  // Neither is a tradeable item (a property is not an item at all, and the catalogue
  // has Gentleman/Elegant/Denim Caches but no Clothing Cache), so no market price
  // exists to check those numbers against, and nobody knows where they came from.
  // Ranking a block on an unsourced number is worse than not ranking it: BAG's
  // "1x Ammunition Pack" was already dropped for exactly this reason, so HRG and TCC
  // were getting recommendations BAG was honestly refused.
  //
  // ONE RULE NOW: a payout that cannot be priced against the market is not ranked.
  // The map stays as the hook for a payout the owner has actually MEASURED — a
  // measured figure belongs here, a guess does not.
  var UNPRICEABLE_PAYOUT_FALLBACK = {};

  // Tiers synthesised per money/item stock. T1-T6 UNIFORMLY for every priceable
  // stock (18 syms x 6 = 108 rows) — an explicit OWNER DECISION taken 2026-08-25,
  // not an accident of the port: the hand-built table truncated at 4-6 tiers per
  // symbol (88 rows) while the dynamic path already used T1-T6, and the owner
  // chose the uniform ceiling so the planner's candidate set stops depending on
  // where a hand-edit happened to stop.
  var MAX_BENEFIT_TIERS = 6;

  // torn/?selections=stocks payload -> {passive, req, roiRows, unpriceable}.
  // Pure: no globals touched, no I/O — so it is testable and the caller decides
  // whether the result is good enough to install.
  // The price map parsePayout is handed. Three sources, in this order, all folded
  // into ONE map keyed on the name the DESCRIPTION uses — parsePayout looks up the
  // raw description name, so an alias keyed any other way would never be hit, and
  // folding them in here keeps "qty x price" computed in exactly one place:
  //   1. the catalogue name verbatim — how all 9 priceable benefit items resolve
  //      today (VERIFIED 2026-08-25 against the live 1483-item catalogue: every
  //      one matches byte-for-byte, incl. "Six-Pack of Energy Drink" and
  //      "Lawyer's Business Card"), so 2 and 3 are insurance, not a live fix;
  //   2. the same name modulo surrounding whitespace and letter case;
  //   3. the market value of the item ID the hardcoded table already recorded for
  //      that symbol. Ids are stable across a rename, names are strings.
  // Nothing beyond that is guessed: no fuzzy matching, no stemming.
  function buildBenefitPriceMap(stocksDict, itemValueByName, nameToItemId) {
    var out = {}, norm = {}, valueById = {};
    Object.keys(itemValueByName || {}).forEach(function(n) {
      var v = itemValueByName[n];
      out[n] = v;
      var k = String(n).trim().toLowerCase();
      if (norm[k] === undefined) norm[k] = v;
      var id = (nameToItemId || {})[n];
      if (id && typeof v === "number" && valueById[id] === undefined) valueById[id] = v;
    });
    Object.keys(stocksDict || {}).forEach(function(id) {
      var s = stocksDict[id];
      if (!s || !s.acronym) return;
      var named = payoutItem((s.benefit || {}).description);
      if (!named.name || out[named.name] !== undefined) return;
      var v = norm[String(named.name).trim().toLowerCase()];
      if (v === undefined) {
        var base = BASELINE_ROI.bySym[s.acronym];
        if (base && base.item) v = valueById[base.item];
      }
      if (typeof v === "number" && v > 0) out[named.name] = v;
    });
    return out;
  }

  function deriveBenefitTables(stocksDict, itemValueByName, nameToItemId) {
    var passive = [], req = {}, roiRows = [], unpriceable = [], degraded = [];
    if (!stocksDict) return null;
    var priceByName = buildBenefitPriceMap(stocksDict, itemValueByName, nameToItemId);
    Object.keys(stocksDict).forEach(function(id) {
      var s = stocksDict[id];
      if (!s || !s.acronym) return;
      var sym = s.acronym, b = s.benefit || {};
      req[sym] = b.requirement || 0;
      if (b.type === "passive") { passive.push(sym); return; }

      // Active stocks only: a passive perk is a single non-monetary block, never
      // an ROI candidate (the hand-built table excluded all 13 of them too).
      var parsed = parsePayout(b.description, priceByName);
      var art = payoutKind(parsed.kind, b.description);
      if (art === "perk") return;                      // "50 nerve", "100 energy", "1000 happiness"

      var named = payoutItem(b.description);
      var baseline = BASELINE_ROI.bySym[sym];
      var itemId = (named.name && nameToItemId) ? (nameToItemId[named.name] || 0) : 0;
      // Keep the id the hardcoded table recorded when the name resolves to none:
      // getPerCycle prices a row off the LIVE market listing for row.item, so the
      // id is what keeps a degraded row tracking the market instead of sitting
      // frozen at its baseline.
      if (!itemId && baseline && baseline.item) itemId = baseline.item;
      var payout = parsed.amount;
      if (parsed.kind === "unpriceable") {
        // A benefit no price could be derived for. Degrade PER SYMBOL — an install
        // is never all-or-nothing, because requirements, frequencies and passives
        // need no price at all and must not be thrown away with one lookup:
        //   1. the owner's estimate, for the two container items (HRG, TCC);
        //   2. else the hardcoded table's own payout for this symbol — stale, but
        //      it is the exact figure the planner showed before this derivation
        //      existed, so degrading to it can never be worse than the fallback;
        //   3. only when neither exists is the row dropped (BAG, whose "1x
        //      Ammunition Pack" has no catalogue entry and no hardcoded row, and
        //      any future stock Torn adds with an unpriceable item).
        // TRANSIENT vs PERMANENT, and the item CATALOGUE is what tells them apart:
        //   * the name resolves to an item id, we just have no price for it right now
        //     -> transient (cold profile, failed price call). The baseline is the
        //        right stand-in: it is the figure the planner showed before.
        //   * the name resolves to NO id at all -> the payout is not a tradeable item,
        //     so no market price will EVER exist for it. Falling back to a stored
        //     number here means ranking a block on a figure nothing can check, which
        //     is what BAG was already refused. Drop it instead.
        // THE BASELINE'S ITEM ID IS THE DISCRIMINATOR, not whether the catalogue
        // happens to be loaded: the hand-built table recorded a real id for every
        // payout that IS an item (MUN 818, FHG 367, ...) and 0 for the three that are
        // not (HRG "1x Random Property", TCC "1x Clothing Cache", BAG "1x Ammunition
        // Pack" — a property is not an item, and the catalogue has Gentleman/Elegant/
        // Denim Caches but no Clothing Cache). So a name that resolves to no id while
        // the baseline knows one is a RENAME or a missing price — degrade. A name that
        // resolves to no id and has no baseline id either can never be priced at all.
        var notAnItem = !!named.name
          && !((nameToItemId || {})[named.name])
          && !(baseline && baseline.item);
        var est = UNPRICEABLE_PAYOUT_FALLBACK[sym];
        if (est) {
          payout = est;
        } else if (notAnItem) {
          unpriceable.push(sym);
          return;
        } else if (baseline && baseline.payout > 0) {
          payout = baseline.payout;
          degraded.push(sym);
        } else {
          unpriceable.push(sym);
          return;
        }
      }
      for (var t = 1; t <= MAX_BENEFIT_TIERS; t++) {
        roiRows.push({
          sym: sym, tier: "T" + t, payout: payout,
          freq: cycleDaysFromFreq(b.frequency),
          type: art,                 // NOTE: written for shape parity only — nothing reads ROI_TABLE.type
          item: itemId
        });
      }
    });
    passive.sort();
    return { passive: passive, req: req, roiRows: roiRows,
             unpriceable: unpriceable, degraded: degraded };
  }

  var benefitTablesDerived = false;
  // WHY the planner is showing the numbers it is showing. Rendered in the ROI
  // Planner footer: without it, "the table looks unchanged" is indistinguishable
  // from "the derivation was refused", and the only way to tell them apart is to
  // read the source. One short string, set at every exit the install can take.
  var benefitTableStatus = "hardcoded (no catalogue yet)";
  // The running @version, read from the manager's own metadata rather than kept in a
  // second constant that could disagree with the header. Falls back to "?" where the
  // manager exposes no GM_info (TornPDA).
  var TSA_VERSION = (function() {
    try { return (GM_info && GM_info.script && GM_info.script.version) || "?"; }
    catch (e) { return "?"; }
  })();
  // The status string is rendered with insertAdjacentHTML and carries symbols that
  // came from Torn's payload, so it is sanitised at the source rather than trusted
  // for being "just acronyms": A-Z, 0-9 and comma, capped at 40 chars. Nothing that
  // reaches the DOM through this string can be markup.
  function safeSyms(list) {
    return String((list || []).join(",")).replace(/[^A-Za-z0-9,]/g, "").slice(0, 40);
  }

  // Install a derived set over the hardcoded fallback. Returns true if it landed.
  //
  // 🪤 The three tables are MUTATED IN PLACE, never reassigned: closures all over
  // the file captured the original objects, so a reassignment would leave half
  // the script reading the old arrays. (The out-of-repo logic guards also grab
  // them as `var` literals, which is why the fallback path is what they test.)
  //
  // 🪤 The gate measures the ONE invariant that matters: a derived table may never
  // LOSE a symbol the hardcoded table had. Row COUNT was the wrong measure — the
  // old `>= 60` refused the whole install (requirements and frequencies included)
  // on any profile whose item prices were not cached yet, because 9 priceable
  // symbols x 6 tiers = 54 legitimate rows. That is the defect the owner saw as
  // "still 88 rows". With per-symbol degradation a derivation that keeps every old
  // symbol and adds Torn's own requirements is strictly better than the fallback,
  // even with not one item price available.
  function installDerivedBenefitTables(stocksDict) {
    var d = deriveBenefitTables(stocksDict, itemMarketValues, itemIdsByName);
    if (!d) { benefitTableStatus = "hardcoded (empty payload)"; return false; }
    // A symbol the derivation deliberately refused to price is NOT a loss — it is the
    // rule working. Counting it as one would make removing the two unsourced estimates
    // refuse the entire install and drag every other symbol back to the hardcoded table.
    var lost = BASELINE_ROI.syms.filter(function(sym) {
      if (d.unpriceable.indexOf(sym) >= 0) return false;
      return !d.roiRows.some(function(r) { return r.sym === sym; });
    });
    if (Object.keys(d.req).length < 30) {
      benefitTableStatus = "hardcoded (only " + Object.keys(d.req).length + " reqs)"; return false;
    }
    if (d.passive.length < 1) { benefitTableStatus = "hardcoded (no passives)"; return false; }
    if (lost.length) {
      benefitTableStatus = "hardcoded (would lose " + safeSyms(lost) + ")"; return false;
    }

    PASSIVE_STOCKS.length = 0;
    d.passive.forEach(function(sym) { PASSIVE_STOCKS.push(sym); });

    Object.keys(BENEFIT_REQ).forEach(function(k) { delete BENEFIT_REQ[k]; });
    Object.keys(d.req).forEach(function(k) { BENEFIT_REQ[k] = d.req[k]; });

    ROI_TABLE.length = 0;
    d.roiRows.forEach(function(row) { ROI_TABLE.push(row); });
    rebuildRoiMap();

    // Any item id the derivation discovered must be price-fetched like the rest.
    ROI_TABLE.forEach(function(row) {
      if (row.item && ITEM_IDS.indexOf(row.item) < 0) ITEM_IDS.push(row.item);
    });

    benefitTablesDerived = true;
    benefitTableStatus = "derived " + ROI_TABLE.length + " rows"
      + (d.degraded.length ? " (" + d.degraded.length + " on baseline price)" : "")
      + (d.unpriceable.length ? " (dropped " + safeSyms(d.unpriceable) + ")" : "");
    return true;
  }

  // The stock catalogue: Torn's torn/?selections=stocks, fetched with the user's
  // own key (free mode) or, in licence mode, as Dossier caches it together with the
  // item catalogue (names + Torn's market_value) on /api/tsa/reference. Benefit
  // requirements are game mechanics and change ~never, so one call per user per DAY
  // is plenty.
  var STOCK_CATALOGUE_TTL_MS = 24 * 60 * 60 * 1000;
  // NEGATIVE CACHE. A FAILED catalogue call leaves stockCatalogue null, and the TTL
  // guard below only short-circuits when it is non-null — so without this a key that
  // cannot read the catalogue would spend one wasted API call on EVERY page load,
  // for as long as the script is installed. One hour, not 24: the usual cause is a
  // key missing the `stocks` selection under Torn (error 16, distinct from the
  // `stocks` selection under User that the holdings call uses), and someone who
  // ticks that box should not have to wait a day to see it work.
  var STOCK_CATALOGUE_FAIL_TTL_MS = 60 * 60 * 1000;
  function catalogueFailedRecently() {
    var t = parseInt(lsGet("tsa_stock_catalogue_fail_ts", "0"), 10) || 0;
    return t > 0 && (Date.now() - t) < STOCK_CATALOGUE_FAIL_TTL_MS;
  }
  function noteCatalogueFailure() {
    lsSet("tsa_stock_catalogue_fail_ts", String(Date.now()));
  }
  // Dossier answered, but without the stock or the item half (its cache was empty,
  // e.g. right after a restart): ask again sooner than a day, not on every load.
  var REFERENCE_PARTIAL_RETRY_MS = 15 * 60 * 1000;
  var REFERENCE_TS_KEY = "tsa_reference_ts";
  // A cached payload past its TTL is still USED (it triggers a refresh, it does
  // not stop being true) — expiring it into nothing would drop the whole install
  // back to the hardcoded fallback for one load every 24h.
  var stockCatalogue = (function() {
    try { return safeStockCatalogue(JSON.parse(lsGet("tsa_stock_catalogue", "null"))); }
    catch(e) { return null; }
  })();

  function applyStockCatalogue() {
    if (!stockCatalogue) return false;
    try { return installDerivedBenefitTables(stockCatalogue); }
    catch(e) { return false; }
  }

  // Item names and values for every id the ROI table prices. Item income is valued
  // at Torn's market_value (a rolling average), not the lowest listing: owner
  // decision 2026-11-01, so pricing an item costs no call at all.
  var itemPricesFromDossier = false;   // itemPrices currently holds Dossier market_values
  function fillItemValuesFromCatalogue() {
    itemPricesFromDossier = true;
    var nameById = {};
    Object.keys(itemIdsByName).forEach(function(n) { nameById[itemIdsByName[n]] = n; });
    ITEM_IDS.forEach(function(id) {
      var n = nameById[id];
      if (!n) return;
      itemNames[id] = n;
      if (typeof itemMarketValues[n] === "number") itemPrices[id] = itemMarketValues[n];
    });
    lsSet("tsa_item_names", JSON.stringify(itemNames));
  }

  // Store one /api/tsa/reference body. Either half may be null (Dossier's cache is
  // empty, e.g. right after a restart); a null half leaves what is held here alone.
  function applyReference(body) {
    var items = body && body.items;
    if (items && typeof items === "object") {
      var byName = {}, values = {};
      Object.keys(items).forEach(function(id) {
        var it = items[id];
        var n = parseInt(id, 10);
        var name = it ? safeItemName(it.name) : null;
        if (!name || !(n > 0)) return;
        byName[name] = n;
        if (typeof it.market_value === "number" && isFinite(it.market_value)) values[name] = it.market_value;
      });
      if (Object.keys(byName).length) {
        // In place, never reassigned: the maps are read by name all over the file.
        Object.keys(itemIdsByName).forEach(function(k) { delete itemIdsByName[k]; });
        Object.keys(itemMarketValues).forEach(function(k) { delete itemMarketValues[k]; });
        Object.keys(byName).forEach(function(k) { itemIdsByName[k] = byName[k]; });
        Object.keys(values).forEach(function(k) { itemMarketValues[k] = values[k]; });
        lsSet("tsa_item_ids_by_name", JSON.stringify(itemIdsByName));
        lsSet("tsa_item_market_values", JSON.stringify(itemMarketValues));
      }
    }
    var stocks = safeStockCatalogue(body && body.stocks);
    if (stocks) {
      stockCatalogue = stocks;
      lsSet("tsa_stock_catalogue", JSON.stringify(stocks));
      lsSet("tsa_stock_catalogue_ts", String(Date.now()));
    }
  }

  // Fetch the catalogue at most once per TTL and install what it yields.
  // Never rejects: a failed call resolves false and the current tables stand.
  function refreshStockCatalogueDirect() {
    var ts = parseInt(lsGet("tsa_stock_catalogue_ts", "0"), 10) || 0;
    if (stockCatalogue && (Date.now() - ts) < STOCK_CATALOGUE_TTL_MS) {
      return Promise.resolve(false);
    }
    if (!stockCatalogue && catalogueFailedRecently()) {
      benefitTableStatus = "hardcoded (catalogue not readable by this key)";
      return Promise.resolve(false);
    }
    var key = getTornKey();
    if (!key) { benefitTableStatus = "hardcoded (no API key)"; return Promise.resolve(false); }
    return fetchJSON("https://api.torn.com/torn/?selections=stocks&key=" + key)
      .then(function(d) {
        if (!d || d.error || !d.stocks) {
          var code = (d && d.error) ? (parseInt(d.error.code, 10) || 0) : 0;
          noteCatalogueFailure();
          // 16 is the one worth naming: the key is valid but lacks the `stocks`
          // selection under Torn. Ticking it is a one-click fix the user can make,
          // so say so instead of printing a bare number.
          benefitTableStatus = (code === 16)
            ? "hardcoded (key lacks Torn>stocks)"
            : ("hardcoded (catalogue call: " + (code ? ("error " + code) : "no stocks in body") + ")");
          return false;
        }
        stockCatalogue = d.stocks;
        lsSet("tsa_stock_catalogue_fail_ts", "0");
        lsSet("tsa_stock_catalogue", JSON.stringify(d.stocks));
        lsSet("tsa_stock_catalogue_ts", String(Date.now()));
        return applyStockCatalogue();
      })
      .catch(function(e) {
        noteCatalogueFailure();
        benefitTableStatus = "hardcoded (catalogue call threw)";
        return false;
      });
  }

  // Licence mode: the stock and item catalogue from Dossier's /api/tsa/reference,
  // at most once per TTL. Never rejects: a failed call resolves false and the
  // current tables stand.
  function refreshStockCatalogueDossier() {
    var ts = parseInt(lsGet(REFERENCE_TS_KEY, "0"), 10) || 0;
    var complete = !!stockCatalogue && Object.keys(itemIdsByName).length > 0;
    var ttl = complete ? STOCK_CATALOGUE_TTL_MS : REFERENCE_PARTIAL_RETRY_MS;
    if ((Date.now() - ts) < ttl) {
      if (!stockCatalogue) benefitTableStatus = "hardcoded (Dossier has no catalogue yet)";
      return Promise.resolve(false);
    }
    return new Promise(function(resolve) {
      TSAData.get(licenseDeps, "reference", 0, function(res) {
        if (res.kind !== "ok") {
          if (!stockCatalogue) benefitTableStatus = "hardcoded (Dossier catalogue unavailable)";
          resolve(false);
          return;
        }
        // Stamped whatever the body held: an empty answer is still an answer, and the
        // TTL above decides how soon an incomplete one is asked for again.
        lsSet(REFERENCE_TS_KEY, String(Date.now()));
        try { applyReference(res.body); } catch (e) {}
        if (!stockCatalogue) {
          benefitTableStatus = "hardcoded (Dossier has no catalogue yet)";
          resolve(false);
          return;
        }
        resolve(applyStockCatalogue());
      });
    });
  }

  // The source the current load uses decides who is asked (see dataMode).
  function refreshStockCatalogue() {
    return dataMode === "dossier" ? refreshStockCatalogueDossier() : refreshStockCatalogueDirect();
  }

  // Warm-cache install, before anything reads the tables. On a cold profile both
  // the catalogue and the item market values are missing, so this is a no-op and
  // the hardcoded tables serve the first load.
  applyStockCatalogue();

  // ============================================================
  // PER-SYMBOL HISTORY — tornsy warm-up (free mode) or /api/tsa/history (licence)
  // ============================================================
  // Free mode (the default): TSA fetches tornsy's per-symbol series itself, one
  // call per 3 s on a paced round-robin warm-up (histStart, below), exactly as
  // in 2.50. Licence mode: the same summaries, computed by Dossier.
  //
  // Two summaries per symbol, both computed by Dossier from tornsy's per-symbol
  // series (signals.py long_term_context / band_streak — the functions TSA's own
  // warm-up used to port) and served as they are:
  //   lt  the long-term summary: days, first_ts, all_time_high/low,
  //       position_all_time, vs_year_ago, month/quarter/year {high, low, position},
  //       band_days, and price (the basis every position was measured against)
  //   h1  the last 200 hourly closes with their stamps
  // TSA used to fetch these itself, 70 calls per warm-up on a paced timer. It now
  // asks Dossier at most every HIST_REFRESH_MS, inside a load — so there is no timer,
  // and nothing here can outlive a licence.
  //
  // Nothing here feeds calcScore. Its outputs are the stores below, the readiness
  // flags (the buy zone reads d1_ok) and one status string.

  // The band, defined HERE because this is where it is measured. DIP_MAX_POS below
  // reads this value instead of repeating the number — the streak and the position
  // must always judge the same band, and two literals would eventually disagree.
  var HIST_BAND_PCT = 10;
  var HIST_D1_MAX_AGE_MS = 86400 * 1000;   // daily candles move once a day
  var HIST_H1_MAX_AGE_MS = 21600 * 1000;   // six-hourly, same gates as dossier
  var HIST_TICK_MS       = 3000;           // warm-up cadence: one call per 3 s
  var HIST_MIN_GAP_MS    = 2000;           // HARD FLOOR between calls
  var HIST_MAX_IN_FLIGHT = 1;              // tornsy's own client is one-at-a-time
  var HIST_ERR_BACKOFF_MS     = 3000;      // ordinary error: exponential from here
  var HIST_ERR_BACKOFF_MAX_MS = 300000;
  // Stand-down rungs in SECONDS, one probe call per rung. Copied from dossier's
  // TornsyClient. We NEVER ramp faster than HIST_TICK_MS on a success streak:
  // additive increase is the direction that trips a throttle, and tornsy
  // publishes no limit, so there is no safe number to increase towards.
  var HIST_THROTTLE_LADDER = [120, 300, 900, 1800];
  var HIST_D1_LIMIT = 2000, HIST_H1_LIMIT = 200;
  var HIST_REFRESH_MS    = 30 * 60 * 1000;   // licence mode: /api/tsa/history at most this often
  var HIST_WAIT_MS       = 2000;             // licence mode: a load waits for it this long, no longer
  var HIST_H1_MIN_CLOSES = 35;             // MACD/RSI need this many points
  var HIST_D1_MIN_ROWS   = 30;             // 30-day window
  var HIST_D1_YEAR_ROWS  = 365;            // vs_year_ago + the year window
  // The 17 intervals calcScore actually reads (h5/h10/d6 ride along in the
  // batches but are never scored, so their absence is not a readiness failure).
  var HIST_SCORE_INTERVALS = ["m30","h1","h2","h3","h4","h6","h8","h12","h16",
                              "h20","d1","d2","d3","d4","d5","d7","w1"];

  var HIST_LT_KEY    = "tsa_lt_context";
  var HIST_LT_TS_KEY = "tsa_lt_context_ts";
  var HIST_H1_KEY    = "tsa_h1_closes";
  var HIST_H1_TS_KEY = "tsa_h1_closes_ts";
  var HIST_BLOCK_KEY = "tsa_tornsy_blocked_until";
  var HIST_STEP_KEY  = "tsa_tornsy_throttle_step";
  var HIST_FETCH_KEY = "tsa_hist_fetch_ts";

  function histLoadMap(key) {
    try { return JSON.parse(lsGet(key, "{}")) || {}; } catch (e) { return {}; }
  }
  function histSaveMap(key, obj) { lsSet(key, JSON.stringify(obj)); }

  var histLtStore = histLoadMap(HIST_LT_KEY);   // SYM -> long-term summary
  var histLtTs    = histLoadMap(HIST_LT_TS_KEY); // SYM -> ms of the last d1 fetch (TSA's own, or Dossier's)
  var histH1Store = histLoadMap(HIST_H1_KEY);   // SYM -> {closes, stamps}
  var histH1Ts    = histLoadMap(HIST_H1_TS_KEY); // SYM -> ms of the last h1 fetch (TSA's own, or Dossier's)

  function histNum(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // Rows exactly as long_term_context receives them in dossier (_fetch_daily):
  // length-filtered only. The >0 filters live INSIDE the derivations, as they do
  // there, so `days` counts the same rows on both sides of the port.
  function histRawRows(data) {
    if (!data || !Array.isArray(data.data)) return null;
    return data.data.filter(function(r) { return Array.isArray(r) && r.length >= 5; });
  }

  function histNewestClose(rows) {
    for (var i = rows.length - 1; i >= 0; i--) {
      var c = histNum(rows[i][4]);
      if (c > 0) return c;
    }
    return 0;
  }

  // Close from `days` CALENDAR days before the newest row, located by ts. Port of
  // signals.py `_close_days_back`, including why it cannot be `closes[-days]`:
  // the last element is today, so day N back is index -(N+1), AND tornsy's daily
  // series has real holes, so N rows back is not N days back. Returns null when
  // nothing sits within tolDays of the target rather than quietly substituting a
  // row from another month.
  function histCloseDaysBack(rows, days, tolDays) {
    if (tolDays === undefined) tolDays = 7;
    if (!rows || !rows.length) return null;
    var usable = rows.filter(function(r) {
      return r.length >= 5 && histNum(r[4]) > 0 && typeof r[0] === "number";
    });
    if (!usable.length) return null;
    var target = usable[usable.length - 1][0] - days * 86400;
    var best = usable[0], bestD = Math.abs(usable[0][0] - target);
    for (var i = 1; i < usable.length; i++) {
      var d = Math.abs(usable[i][0] - target);
      if (d < bestD) { best = usable[i]; bestD = d; }
    }
    if (bestD > tolDays * 86400) return null;
    return histNum(best[4]);
  }

  function histPctVs(price, ref) {
    if (!ref || ref <= 0 || !price || price <= 0) return null;
    return (price / ref - 1) * 100;
  }

  // Position in the last N ROWS' range. The window size is in ROWS, matching
  // long_term_context.window(30) — the side that must not move, because the
  // dossier zone result is backtested on it. Too short a series returns null.
  function histWindow(rows, price, days) {
    if (!rows || rows.length < days) return null;
    var hi = 0, lo = 0, seenHi = false, seenLo = false;
    for (var i = rows.length - days; i < rows.length; i++) {
      var r = rows[i];
      if (r.length < 5) continue;
      var h = histNum(r[2]), l = histNum(r[3]);
      if (h > 0 && (!seenHi || h > hi)) { hi = h; seenHi = true; }
      if (l > 0 && (!seenLo || l < lo)) { lo = l; seenLo = true; }
    }
    if (!seenHi || !seenLo) return null;
    var rng = hi - lo;
    return { high: hi, low: lo,
             position: rng > 0 ? ((price - lo) / rng * 100) : null };
  }


  // Port of signals.py `long_term_context` — same field names, same maths. The
  // mirror shares the original's computation instead of re-deriving the numbers
  // a second way. Deliberately NOT folded into calcScore: that function is a
  // faithful port whose only purpose is to agree with dossier number for number,
  // and feeding it inputs it never had would make the cross-check meaningless.
  // CONSECUTIVE DAYS CLOSED IN THE BOTTOM `threshold`% OF THE OWN TRAILING RANGE —
  // "how long has this been cheap". Port of the reference implementation's
  // band_streak, and the reason it can exist here at all is that `rows` is in hand
  // at derive time: only the STORAGE of the series is given up, not the access.
  // The result is one integer in the ~200 B summary, so it costs no space and no
  // extra call.
  //
  // 🪤 The window is 30 ROWS, not 31 — `rows.slice(i - 29, i + 1)` — so it measures
  // the same interval as the 30-day window in the summary. When the two disagreed,
  // a stock could sit in the zone while its streak read 0, showing WAIT where BUY
  // belonged (136 of 68,198 day-symbols in the reference measurement).
  //
  // 🪤 Judged on the CLOSE, never on the live price. A past day only ever had a
  // close to be judged on; mixing the two makes the streak mean different things at
  // its two ends. 0 when the newest close sits outside the band, which the UI reads
  // as "new" — the honest gap between a price that moved today and a finished day.
  function histBandStreak(rows, threshold, lookback) {
    var th = (threshold === undefined) ? HIST_BAND_PCT : threshold;
    var lb = (lookback === undefined) ? 30 : lookback;
    var back = lb - 1;
    if (!rows || rows.length < lb) return 0;
    var streak = 0;
    for (var i = rows.length - 1; i >= back; i--) {
      var row = rows[i];
      // A short row must break, not throw: a raise here would drop the whole stock.
      if (!row || row.length < 5) break;
      var close = histNum(row[4]);
      // Highs and lows are tracked with SEPARATE seen-flags, exactly as the Python
      // builds `his` and `los` as two independently >0-filtered lists. One shared
      // flag is a silent defect: a row with a high but a zero low would set the
      // flag with `lo` still 0, and every later min() against 0 keeps it there —
      // the position then measures against a low of zero. `histRawRows` filters on
      // length only, so a zero low is reachable, not hypothetical.
      var hi = 0, lo = 0, seenHi = false, seenLo = false;
      for (var j = i - back; j <= i; j++) {
        var w = rows[j];
        if (!w || w.length < 5) continue;
        var h = histNum(w[2]), l = histNum(w[3]);
        if (h > 0 && (!seenHi || h > hi)) { hi = h; seenHi = true; }
        if (l > 0 && (!seenLo || l < lo)) { lo = l; seenLo = true; }
      }
      // Python: `if not close or not his or not los: break`, then `if hi <= lo`.
      if (!(close > 0) || !seenHi || !seenLo || !(hi > lo)) break;
      if ((close - lo) / (hi - lo) * 100 > th) break;
      streak++;
    }
    return streak;
  }

  function histLongTermContext(price, rows) {
    if (!rows || !rows.length || !(price > 0)) return null;
    var ath = 0, atl = 0, seenHi = false, seenLo = false, seenClose = false;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.length < 5) continue;
      var h = histNum(r[2]), l = histNum(r[3]), c = histNum(r[4]);
      if (h > 0 && (!seenHi || h > ath)) { ath = h; seenHi = true; }
      if (l > 0 && (!seenLo || l < atl)) { atl = l; seenLo = true; }
      if (c > 0) seenClose = true;
    }
    if (!seenHi || !seenLo || !seenClose) return null;
    var span = ath - atl;
    return {
      days: rows.length,
      first_ts: rows[0][0],
      all_time_high: ath,
      all_time_low: atl,
      position_all_time: span > 0 ? ((price - atl) / span * 100) : null,
      vs_year_ago: histPctVs(price, histCloseDaysBack(rows, 365)),
      month:   histWindow(rows, price, 30),
      // The buy zone's second gate, measured on the same band and the same 30-row
      // window as `month` above — HIST_BAND_PCT and HIST_D1_MIN_ROWS are passed
      // explicitly so the two halves of one signal cannot drift apart.
      band_days: histBandStreak(rows, HIST_BAND_PCT, HIST_D1_MIN_ROWS),
      quarter: histWindow(rows, price, 90),
      year:    histWindow(rows, price, 365),
      // The price every position above was measured against. Kept so a consumer
      // can re-derive a position from high/low with a fresher price instead of
      // reading a stale one as current — the basis has to be visible for that.
      price: price
    };
  }

  // h1: only the closes and their stamps survive — 200 floats, ~2 KB per symbol.
  // Mirrors _fetch_candles' close>0 filter so closes and stamps line up index
  // for index. total_shares is dropped: it is shares outstanding, not volume,
  // and nothing here reads it.
  function histH1Closes(rows) {
    if (!rows) return null;
    var closes = [], stamps = [];
    for (var i = 0; i < rows.length; i++) {
      var c = histNum(rows[i][4]);
      if (c <= 0) continue;
      closes.push(c);
      stamps.push(rows[i][0]);
    }
    return closes.length ? { closes: closes, stamps: stamps } : null;
  }

  // -- rate discipline -------------------------------------------------------
  // blocked_until is PERSISTED, unlike dossier's in-memory equivalent: dossier's
  // process outlives a stand-down, a browser tab does not. Without this, a
  // reload resets the stand-down and goes straight back to hammering an IP that
  // was just blocked.
  function histBlockedUntil() { return parseInt(lsGet(HIST_BLOCK_KEY, "0"), 10) || 0; }
  function histThrottleStep() { return parseInt(lsGet(HIST_STEP_KEY, "0"), 10) || 0; }

  var histInFlight = 0;
  var histLastCallTs = 0;
  var histBackoffUntil = 0;   // ordinary-error backoff; in memory on purpose
  var histBackoffMs = 0;
  var histD1Cursor = 0, histH1Cursor = 0;
  var histTimer = null;

  function histNoteThrottle(now) {
    var step = histThrottleStep();
    var rung = HIST_THROTTLE_LADDER[Math.min(step, HIST_THROTTLE_LADDER.length - 1)];
    lsSet(HIST_BLOCK_KEY, String(now + rung * 1000));
    lsSet(HIST_STEP_KEY, String(step + 1));
    histRecomputeStatus(now);
  }

  function histNoteSuccess() {
    lsSet(HIST_BLOCK_KEY, "0");
    lsSet(HIST_STEP_KEY, "0");
    histBackoffUntil = 0;
    histBackoffMs = 0;
  }

  function histNoteError(now) {
    histBackoffMs = histBackoffMs
      ? Math.min(histBackoffMs * 2, HIST_ERR_BACKOFF_MAX_MS)
      : HIST_ERR_BACKOFF_MS;
    histBackoffUntil = now + histBackoffMs;
  }

  // A LiteSpeed throttle answers with an HTML page and can carry HTTP 200, so a
  // 200 is not proof of data. 403/429, a content type that is not JSON, or a
  // body opening with "<" all mean BLOCKED — never "empty series". Reading a
  // block as empty data is what turns one stand-down into a retry storm.
  function histIsThrottled(status, contentType, body) {
    if (status === 403 || status === 429) return true;
    var ct = String(contentType || "").toLowerCase();
    if (ct && ct.indexOf("json") === -1) return true;
    var b = String(body || "").replace(/^[\s\uFEFF]+/, "");
    if (b.charAt(0) === "<") return true;
    return false;
  }

  function histContentType(r) {
    var h = (r && r.responseHeaders) || "";
    var m = /^[ \t]*content-type[ \t]*:[ \t]*([^\r\n]+)/im.exec(h);
    return m ? m[1] : "";
  }

  // The whole rate model in one predicate: one call in flight, never faster than
  // the hard floor, nothing at all while a stand-down or a backoff is live, and
  // nothing while the tab is not being looked at.
  //
  // Gated on isOnScreen(), not on focus: a page the user is looking at is not a
  // background page, and PDA's webview never reports focus (see isOnScreen).
  function histMayCall(now) {
    // Licence mode reads history from Dossier: no call to tornsy at all.
    if (dataMode !== "direct") return false;
    if (histInFlight >= HIST_MAX_IN_FLIGHT) return false;
    if (now < histBlockedUntil()) return false;
    if (now < histBackoffUntil) return false;
    if (now - histLastCallTs < HIST_MIN_GAP_MS) return false;
    if (!isOnScreen()) return false;
    return true;
  }

  // Next symbol whose cached entry is missing or past maxAge, round-robining
  // from a per-store cursor so ordering can never starve a symbol. Port of
  // signals.py `_next_stale`; returns the advanced cursor because JS has no
  // setattr. The cursor advances at PICK time, so a symbol that keeps failing
  // does not block the other 34.
  function histNextStale(syms, tsStore, maxAge, now, cursor) {
    if (!syms || !syms.length) return null;
    for (var i = 0; i < syms.length; i++) {
      var idx = (cursor + i) % syms.length;
      var sym = syms[idx];
      var t = tsStore[sym] || 0;
      if (!t || (now - t) >= maxAge) {
        return { sym: sym, cursor: (idx + 1) % syms.length, age: now - t };
      }
    }
    return null;
  }

  // GET one series. Deliberately NOT fetchJSON: that retries three times on any
  // 4xx, which against a throttle is three extra hits on an IP that just said
  // stop, and it cannot see the status or content type a block is detected from.
  function histFetch(sym, interval, limit, cb) {
    var url = "https://tornsy.com/api/" + String(sym).toUpperCase() +
              "?interval=" + interval + "&limit=" + limit;
    var settled = false;
    histInFlight++;
    histLastCallTs = Date.now();
    function finish(data, err) {
      if (settled) return;
      settled = true;
      histInFlight--;
      cb(data, err);
    }
    try {
      gmXhr({
        method: "GET", url: url,
        // Identifies the traffic to tornsy instead of leaving it anonymous. Only
        // GM_xmlhttpRequest honours a custom UA; PDA_httpGet and native fetch
        // send the browser's own. Known limitation, not a blocker.
        headers: { "User-Agent": "TornStockAnalyzer/" + TSA_VERSION + " (userscript)" },
        onload: function(r) {
          var body = (r && r.responseText) || "";
          if (histIsThrottled(r && r.status, histContentType(r), body)) {
            histNoteThrottle(Date.now());
            finish(null, "throttled");
            return;
          }
          // Declared WITHOUT an initialiser so the catch's assignment is the thing
          // that defines it: `var data = null` first would make `data = null` in the
          // catch a no-op, which is exactly what ESLint's no-useless-assignment flags.
          var data;
          try { data = JSON.parse(body); } catch (e) { data = null; }
          if (!data) { histNoteError(Date.now()); finish(null, "parse"); return; }
          histNoteSuccess();
          finish(data, null);
        },
        onerror: function() {
          histNoteError(Date.now());
          finish(null, "network");
        }
      });
    } catch (e) {
      histNoteError(Date.now());
      finish(null, "throw");
    }
  }

  function histFetchD1(sym) {
    var s = String(sym).toUpperCase();
    histFetch(s, "d1", HIST_D1_LIMIT, function(data) {
      if (!data) { histRecomputeStatus(Date.now()); return; }
      var rows = histRawRows(data);
      // No rows: leave the timestamp alone so the round-robin comes back to it,
      // instead of recording an empty summary as if it were a good fetch.
      if (!rows || !rows.length) return;
      var live = histNum(lastLoadPrices[s]);
      var price = live > 0 ? live : histNewestClose(rows);
      var lt = histLongTermContext(price, rows);
      if (!lt) return;
      histLtStore[s] = lt;
      histLtTs[s] = Date.now();
      histSaveMap(HIST_LT_KEY, histLtStore);
      histSaveMap(HIST_LT_TS_KEY, histLtTs);
      histRecomputeStatus(Date.now());
      // `rows` dies here. The 125 KB series is never written to localStorage.
    });
  }

  function histFetchH1(sym) {
    var s = String(sym).toUpperCase();
    histFetch(s, "h1", HIST_H1_LIMIT, function(data) {
      if (!data) { histRecomputeStatus(Date.now()); return; }
      var parsed = histH1Closes(histRawRows(data));
      if (!parsed) return;
      histH1Store[s] = parsed;
      histH1Ts[s] = Date.now();
      histSaveMap(HIST_H1_KEY, histH1Store);
      histSaveMap(HIST_H1_TS_KEY, histH1Ts);
      histRecomputeStatus(Date.now());
    });
  }

  // Store one /api/tsa/history body. A symbol missing from a NON-EMPTY answer is
  // dropped here too (Dossier no longer has a basis for it); an empty answer —
  // Dossier cold after a restart — leaves everything held here alone.
  //
  // The *_ts stores take Dossier's own fetch time, not the time this answer
  // arrived: dipNotePrice records one price point per distinct d1 stamp, so the
  // stamp must move on the daily-candle cadence, never on how often TSA asks.
  // A null stamp (Dossier's design mode) keeps the stamp held here.
  function histApply(body) {
    var syms = body && body.symbols;
    if (!syms || typeof syms !== "object") return 0;
    var known = STOCKS_LIST.map(function(x) { return String(x).toUpperCase(); });
    var keys = Object.keys(syms);
    if (!keys.length) return 0;
    var seen = {}, n = 0;
    keys.forEach(function(k) {
      var s = String(k).toUpperCase();
      var e = syms[k];
      if (known.indexOf(s) < 0 || !e || typeof e !== "object") return;
      seen[s] = true;
      if (e.lt && typeof e.lt === "object") {
        histLtStore[s] = e.lt;
        if (typeof e.lt_ts === "number" && e.lt_ts > 0) histLtTs[s] = e.lt_ts * 1000;
      } else {
        delete histLtStore[s];
        delete histLtTs[s];
      }
      var h = e.h1;
      if (h && Array.isArray(h.closes) && Array.isArray(h.stamps)) {
        var closes = [], stamps = [];
        for (var i = 0; i < h.closes.length && i < h.stamps.length; i++) {
          var c = histNum(h.closes[i]);
          if (c > 0) { closes.push(c); stamps.push(h.stamps[i]); }
        }
        histH1Store[s] = { closes: closes.slice(-HIST_H1_LIMIT), stamps: stamps.slice(-HIST_H1_LIMIT) };
        if (typeof e.h1_ts === "number" && e.h1_ts > 0) histH1Ts[s] = e.h1_ts * 1000;
      } else {
        delete histH1Store[s];
        delete histH1Ts[s];
      }
      n++;
    });
    [histLtStore, histLtTs, histH1Store, histH1Ts].forEach(function(m) {
      Object.keys(m).forEach(function(k) { if (!seen[k]) delete m[k]; });
    });
    histSaveMap(HIST_LT_KEY, histLtStore);
    histSaveMap(HIST_LT_TS_KEY, histLtTs);
    histSaveMap(HIST_H1_KEY, histH1Store);
    histSaveMap(HIST_H1_TS_KEY, histH1Ts);
    return n;
  }

  // Licence mode. Resolves once /history is applied, skipped (fresh enough) or has
  // failed — never rejects, so a load can wait for it without being able to fail
  // on it. Runs only inside a licensed load: there is no other caller and no timer.
  function histMaybeRefresh() {
    var last = parseInt(lsGet(HIST_FETCH_KEY, "0"), 10) || 0;
    if (Date.now() - last < HIST_REFRESH_MS) return Promise.resolve(false);
    return new Promise(function(resolve) {
      TSAData.get(licenseDeps, "history", 0, function(res) {
        if (res.kind === "ok") {
          try {
            histApply(res.body);
            // A cold Dossier answers with no symbols: ask again on the next load.
            if (res.body && res.body.symbols && Object.keys(res.body.symbols).length) {
              lsSet(HIST_FETCH_KEY, String(Date.now()));
            }
          } catch (e) {}
          histLastFailed = false;
        } else {
          histLastFailed = true;
        }
        histRecomputeStatus();
        resolve(res.kind === "ok");
      });
    });
  }

  // -- readiness -------------------------------------------------------------
  // Every flag is PER SYMBOL. A symbol with a full basis is ready the moment it
  // has one; it never waits for the other 34.
  function histRowOk(row) {
    if (!row || !row.interval) return false;
    for (var i = 0; i < HIST_SCORE_INTERVALS.length; i++) {
      var iv = row.interval[HIST_SCORE_INTERVALS[i]];
      if (!iv || !(histNum(iv.price) > 0)) return false;
    }
    return true;
  }

  function histReadiness(sym, row) {
    var s = String(sym || "").toUpperCase();
    var h1 = histH1Store[s];
    var lt = histLtStore[s];
    return {
      row_ok: histRowOk(row),
      h1_ok: !!(h1 && h1.closes && h1.closes.length >= HIST_H1_MIN_CLOSES),
      d1_ok: !!(lt && lt.days >= HIST_D1_MIN_ROWS),
      // The year window and vs_year_ago need a full year of rows; d1_ok at 30 is
      // enough for the month window. Two thresholds, so a two-month-old symbol
      // is not silently shown a year figure it does not have.
      year_ok: !!(lt && lt.days >= HIST_D1_YEAR_ROWS)
    };
  }

  // One string, in the shape of benefitTableStatus: it says why the panel shows
  // what it shows, and nothing more.
  var historyStatus = "history 0/" + STOCKS_LIST.length;
  var histLastFailed = false;
  function histRecomputeStatus(now) {
    if (now === undefined) now = Date.now();
    var blocked = dataMode === "direct" ? histBlockedUntil() : 0;
    if (blocked > now) {
      var mins = Math.ceil((blocked - now) / 60000);
      historyStatus = "tornsy throttled, retry in " + mins + "m";
      return historyStatus;
    }
    var ready = 0;
    for (var i = 0; i < STOCKS_LIST.length; i++) {
      var f = histReadiness(STOCKS_LIST[i], null);
      if (f.d1_ok && f.h1_ok) ready++;
    }
    historyStatus = "history " + ready + "/" + STOCKS_LIST.length +
                    (ready >= STOCKS_LIST.length ? "" : " warming") +
                    (dataMode === "dossier" && histLastFailed ? " (Dossier unreachable)" : "");
    return historyStatus;
  }
  histRecomputeStatus();
  // One symbol per tick, oldest first across BOTH stores, so d1 and h1 interleave
  // instead of 35 d1 calls having to land before the first h1 does.
  function histTick(now) {
    if (!histMayCall(now)) return null;
    var syms = STOCKS_LIST.map(function(s) { return s.toUpperCase(); });
    var d1 = histNextStale(syms, histLtTs, HIST_D1_MAX_AGE_MS, now, histD1Cursor);
    var h1 = histNextStale(syms, histH1Ts, HIST_H1_MAX_AGE_MS, now, histH1Cursor);
    if (!d1 && !h1) return null;
    // Ties go to d1: the long-term summary is the half nothing else substitutes.
    if (d1 && (!h1 || d1.age >= h1.age)) {
      histD1Cursor = d1.cursor;
      histFetchD1(d1.sym);
      return { sym: d1.sym, interval: "d1" };
    }
    histH1Cursor = h1.cursor;
    histFetchH1(h1.sym);
    return { sym: h1.sym, interval: "h1" };
  }

  function histStart() {
    if (histTimer) return;
    histRecomputeStatus(Date.now());
    histTimer = setInterval(function() { histTick(Date.now()); }, HIST_TICK_MS);
  }


  // ============================================================
  // BUY ZONE — ITS OWN SECTION, WITH ITS OWN FORWARD MEASUREMENT
  // ============================================================
  // The rule: buy when the price sits in the bottom DIP_MAX_POS% of the stock's
  // own 30-day high/low range, hold DIP_HOLD_DAYS days, exit at +DIP_SELL_TARGET%.
  //
  // The constants are COPIED, not invented — VERIFIED 2026-08-25 against the
  // dossier's frontend/src/tabs/Signals.tsx:80, 81, 93, 104. Everything they
  // claim rests on ONE backtest that has never been validated FORWARD. So this
  // is deliberately not a primary recommendation: it sits BESIDE the Top-5
  // score, never inside it, and it never touches calcScore or its indicators.
  //
  // What is new here is the honest half. TSA logs every time the zone fires and
  // scores those calls on this owner's own book, so the hit rate on display is
  // measured here rather than imported from a study.
  //
  // DIP_RIPE_DAYS IS applied. The streak is band_streak's, computed by Dossier on
  // the full daily series and served as one integer, lt.band_days. Deriving the
  // streak from the 8-day h1 window would have been a different measurement wearing
  // the same name — that is the version that was rejected, not this one. Only BUY
  // calls are logged for scoring, because BUY is what the section recommends.
  var DIP_MAX_POS     = HIST_BAND_PCT;  // same band band_days is measured on
  var DIP_HOLD_DAYS   = 7;     // hold horizon, and the horizon calls are scored on
  var DIP_RIPE_DAYS   = 3;     // days settled in the band before BUY, not just WAIT
  var DIP_SELL_TARGET = 1.0;   // +1.0% net is what a call has to reach to count

  var DIP_MIN_N        = 20;                          // below this: never a percentage
  var DIP_HOLD_MS      = DIP_HOLD_DAYS * 86400000;
  var DIP_PX_TOL_MS    = 2 * 86400000;                // daily cadence => +/-2d slack
  var DIP_CALLS_MAX    = 200;                         // rolling cap, both directions
  var DIP_CALLS_MAX_MS = 180 * 86400000;
  var DIP_PX_PER_SYM   = 10;                          // ~10 daily points per symbol
  var DIP_PX_MAX_MS    = (DIP_HOLD_DAYS + 7) * 86400000;

  var DIP_CALLS_KEY = "tsa_dip_calls";
  var DIP_PX_KEY    = "tsa_dip_px";

  var dipCalls = (function () {
    try {
      var a = JSON.parse(lsGet(DIP_CALLS_KEY, "[]"));
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  })();
  // SYM -> { t: stamp of the d1 fetch last recorded, s: [[ts, price], ...] }
  var dipPx = histLoadMap(DIP_PX_KEY);

  function dipSaveCalls() { lsSet(DIP_CALLS_KEY, JSON.stringify(dipCalls)); }
  function dipSavePx()    { histSaveMap(DIP_PX_KEY, dipPx); }
  function dipRound(n, dp) { var f = Math.pow(10, dp); return Math.round(n * f) / f; }

  // The position, RE-DERIVED against the live price instead of read off the
  // stored summary. long_term_context keeps `price` precisely so a consumer can
  // do this: the summary refreshes at most once a day, so its own `position` can
  // be 24 h stale, and a stale position presented as current is the defect this
  // avoids. high/low move once a day; the price does not.
  //
  // Gated PER SYMBOL on d1_ok, never globally. A symbol without 30 daily rows
  // returns null and is reported as waiting — never as a half number.
  function dipZone(sym) {
    var s = String(sym || "").toUpperCase();
    if (!histReadiness(s, null).d1_ok) return null;
    var lt = histLtStore[s];
    var m = lt && lt.month;
    // A flat 30 days has no range to be at the bottom of; long_term_context already
    // returns position null there, and so must this.
    if (!m || !(m.high > 0) || !(m.low > 0) || !(m.high > m.low)) return null;
    var px = histNum(lastLoadPrices[s]) || histNum(lt.price);
    if (!(px > 0)) return null;
    return { pos: (px - m.low) / (m.high - m.low) * 100,
             price: px, high: m.high, low: m.low,
             // 0 on a summary derived before band_days existed, which reads as
             // "not settled yet" — the cautious direction.
             bandDays: histNum(lt.band_days) || 0 };
  }

  // TOP-5 RANGE GATE — a DISPLAY filter over the buy list. It does NOT touch
  // calcScore: the score, weekPeak, the four indicators and their weights are
  // untouched by this block, and nothing here writes back onto a scored row.
  //
  // Why the list needed a gate at all. Measured on the live archive over 43,960
  // points, the score's BUY+ calls hit 45.7% (n=35) and were beaten by the buy
  // zone's dip rule on all five horizons. The score is not weak, it is UNFOCUSED:
  // 44% of its BUY+ calls sat ABOVE the middle of the symbol's own 30-day range,
  // because `reversal` (40p) and `macd` (25p) both reward a price that has ALREADY
  // risen. The same list bought low hits 89.2% (position 0-10%). So the half that
  // loses is removed from view and the half that works is left exactly as it was.
  //
  // The position is dipZone's, not a second derivation of the same idea — one
  // formula, one high/low pair, one answer on screen.
  var TOP5_MAX_POS = 50;

  // A symbol without 30 daily rows has NO position, and hiding it would be a
  // guess dressed as a filter. It stays in the list and is marked unknown.
  //
  // The gate runs over the WHOLE candidate pool, before the top-5 slice, so the
  // list still fills to five out of the qualifying half instead of showing two
  // rows and three gaps. `hidden` is therefore every candidate the gate removed,
  // not only those that would have made the visible five — the panel prints it,
  // because a filter that hides in silence is worse than no filter.
  function top5RangeGate(list) {
    var rows = [], pos = {}, hidden = 0;
    for (var i = 0; i < (list || []).length; i++) {
      var s = list[i];
      var z = dipZone(s.symbol);
      if (z && z.pos > TOP5_MAX_POS) { hidden++; continue; }
      pos[s.symbol] = z ? z.pos : null;
      rows.push(s);
    }
    return { rows: rows, pos: pos, hidden: hidden };
  }

  // The two lines the gate puts on screen. Both take the theme object, so the
  // light and the dark palette are covered by the same call — no colour is
  // defined for one theme only.
  //
  // Shown for every row: the position that let it through, or an explicit
  // "unknown" for a symbol with no 30-day basis. Same detail style as the
  // score's own "Drop -0.3% · Low pos 15%", and deliberately labelled 30d so it
  // cannot be read as calcScore's short-term "Low pos".
  function top5PosHtml(d, pos) {
    if (pos === null || pos === undefined) {
      return " · <span style=\"color:" + d.yellow + "\">30d pos unknown</span>";
    }
    return " · 30d pos " + pos.toFixed(0) + "%";
  }

  function top5HiddenHtml(d, hidden) {
    if (!(hidden > 0)) return "";
    return " <span style=\"font-weight:normal;letter-spacing:0;text-transform:none;color:" +
           d.muted + "\">· " + hidden + " above mid-range hidden</span>";
  }

  // One price point per D1 REFRESH, keyed on step 4a's own fetch stamp. This is
  // what makes the measurement's second leg honest: the series advances on the
  // daily-candle cadence, NOT on how often the browser happened to be open. The
  // price archive TSA already keeps is exactly the biased sample this replaces —
  // it only holds the moments a tab was in front of someone.
  //
  // The value is lt.price: the basis the stored positions were measured against,
  // i.e. the live price at the moment the d1 series was parsed, falling back to
  // the newest d1 close when no live price had been loaded.
  //
  // Appends only. Trimming is dipTrimPx's job and runs after dipSettle.
  function dipNotePrice(sym, now) {
    var s = String(sym || "").toUpperCase();
    var stamp = histLtTs[s] || 0;
    var lt = histLtStore[s];
    var px = lt ? histNum(lt.price) : 0;
    if (!stamp || !(px > 0)) return false;
    var e = dipPx[s];
    if (!e || !Array.isArray(e.s)) { e = { t: 0, s: [] }; dipPx[s] = e; }
    if (e.t === stamp) return false;   // same d1 fetch, already recorded
    e.t = stamp;
    e.s.push([stamp, dipRound(px, 2)]);
    dipSavePx();
    return true;
  }

  // COLLAPSE: one call per symbol per horizon, and it is the FIRST one. A zone
  // that simply persists for three days is one signal, not three — counting it
  // three times is precisely what makes a small sample look stronger than it is.
  // Returns the record when a call was opened, null when it collapsed into a call
  // that is still inside its horizon.
  function dipNoteCall(sym, pos, price, now) {
    var s = String(sym || "").toUpperCase();
    if (!(price > 0)) return null;
    for (var i = dipCalls.length - 1; i >= 0; i--) {
      var c = dipCalls[i];
      if (c.sym !== s) continue;
      // dipCalls is append-ordered, so the first match walking backwards is this
      // symbol's newest call. No older one can be inside the horizon if it is not.
      if (now - c.ts < DIP_HOLD_MS) return null;
      break;
    }
    return dipPushCall(s, pos, price, now);
  }

  function dipPushCall(sym, pos, price, now) {
    var rec = { sym: sym, ts: now, price: dipRound(price, 2), pos: dipRound(pos, 1) };
    dipCalls.push(rec);
    dipCalls = dipCalls.filter(function (c) { return now - c.ts <= DIP_CALLS_MAX_MS; });
    if (dipCalls.length > DIP_CALLS_MAX) {
      dipCalls = dipCalls.slice(dipCalls.length - DIP_CALLS_MAX);
    }
    dipSaveCalls();
    return rec;
  }

  // Nearest journal point to targetTs, within tolerance. Nearest rather than
  // first-after: the journal is daily, so an exact horizon match is rare, and
  // substituting a point from another week would be far worse than the +/-2 d
  // slack. The lag actually used is frozen onto the call so it stays auditable.
  function dipPriceAt(sym, targetTs, tolMs) {
    var e = dipPx[String(sym || "").toUpperCase()];
    if (!e || !Array.isArray(e.s) || !e.s.length) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < e.s.length; i++) {
      var d = Math.abs(e.s[i][0] - targetTs);
      if (d < bestD) { bestD = d; best = e.s[i]; }
    }
    if (!best || bestD > tolMs) return null;
    return { px: best[1], ts: best[0] };
  }

  // A call is SCORED ONCE and the result frozen onto the record. The journal is a
  // rolling 14-day window, so a call left unscored would silently become
  // unscoreable — freezing is what lets a 180-day sample survive without keeping
  // 180 days of prices.
  function dipSettle(now) {
    var changed = false;
    for (var i = 0; i < dipCalls.length; i++) {
      var c = dipCalls[i];
      if (c.px !== undefined) continue;
      var due = c.ts + DIP_HOLD_MS;
      if (now < due) continue;                       // horizon not FULLY expired yet
      var hit = dipPriceAt(c.sym, due, DIP_PX_TOL_MS);
      if (!hit) continue;                            // no daily price to score it on
      c.px = hit.px;
      c.pd = dipRound((hit.ts - c.ts) / 86400000, 1);
      changed = true;
    }
    if (changed) dipSaveCalls();
    return changed;
  }

  // Runs AFTER dipSettle, never before: the trim is what turns an unscored call
  // into an unscoreable one, so settling has to get first look at the points the
  // trim is about to drop.
  function dipTrimPx(now) {
    var changed = false;
    Object.keys(dipPx).forEach(function (s) {
      var e = dipPx[s];
      if (!e || !Array.isArray(e.s)) return;
      var keep = e.s.filter(function (r) { return now - r[0] <= DIP_PX_MAX_MS; });
      if (keep.length > DIP_PX_PER_SYM) keep = keep.slice(keep.length - DIP_PX_PER_SYM);
      if (keep.length !== e.s.length) { e.s = keep; changed = true; }
    });
    if (changed) dipSavePx();
    return changed;
  }

  // The measurement. Three rules keep it honest rather than flattering:
  //   a call counts only once its horizon is FULLY expired — until then it is
  //   `pending`, so an empty table reads as "not yet" and not as "nothing worked";
  //   a call whose horizon expired with no daily price to score it against is
  //   `nodata`, shown, never quietly dropped;
  //   and NO percentage exists below DIP_MIN_N. 100% on n=2 is worse than no
  //   number at all, so under the floor only the n is reported.
  function dipMeasure(now) {
    var nets = [], pending = 0, nodata = 0, wins = 0;
    for (var i = 0; i < dipCalls.length; i++) {
      var c = dipCalls[i];
      var due = c.ts + DIP_HOLD_MS;
      if (c.px === undefined) {
        if (now > due + DIP_PX_TOL_MS) nodata++; else pending++;
        continue;
      }
      var net = (c.px / c.price - 1) * 100;
      nets.push(net);
      if (net >= DIP_SELL_TARGET) wins++;
    }
    var n = nets.length;
    var ready = n >= DIP_MIN_N;
    nets.sort(function (a, b) { return a - b; });
    var median = n ? (n % 2 ? nets[(n - 1) / 2] : (nets[n / 2 - 1] + nets[n / 2]) / 2) : null;
    return {
      n: n, wins: wins, pending: pending, nodata: nodata, ready: ready,
      hitRate: ready ? (wins / n * 100) : null,
      medianPct: ready ? median : null
    };
  }

  // One pass over every symbol: journal the daily price, decide the zone, log the
  // call. `log` is false on a cached re-render — the same discipline recordSignals
  // already applies, because a cached render's price can be minutes stale and a
  // measurement built on stale entry prices is not a measurement.
  // The SELL side of the same rule. Every holding with a tradeable SWING gets a
  // verdict; pure benefit blocks are excluded, because they are held for the perk
  // and a price target is meaningless there — the same reason calcScore's own
  // PROFIT badge skips them.
  //
  // The number is calcSwingNetPct's, i.e. the SAME one calcScore's badge uses. The
  // section does not recompute it: a displayed target must come from the formula
  // that makes the decision, or the two disagree on screen and one of them is
  // lying. It is the swing avg, never the blended one — a benefit block underneath
  // can make a whole-position figure read +9% on a swing that is down 56%.
  //
  // The threshold is DIP_SELL_TARGET (+1.0%), this rule's own exit, NOT the user's
  // Sell setting that drives the PROFIT badge. Two different thresholds can be on
  // screen at once, so the row says which one it is.
  function dipSells(ownedMap) {
    var out = [];
    if (!ownedMap) return out;
    Object.keys(ownedMap).forEach(function (sym) {
      var s = String(sym).toUpperCase();
      var o = ownedMap[sym];
      if (!o || !(o.swing_shares > 0)) return;
      var net = calcSwingNetPct(o, histNum(lastLoadPrices[s]));
      if (net === null) return;
      out.push({ sym: s, net: net, shares: o.swing_shares,
                 verdict: net >= DIP_SELL_TARGET ? "SELL" : "HOLD" });
    });
    out.sort(function (a, b) { return b.net - a.net; });
    return out;
  }

  function dipScan(now, log, ownedMap) {
    var rows = [], waiting = 0;
    for (var i = 0; i < STOCKS_LIST.length; i++) {
      var sym = String(STOCKS_LIST[i]).toUpperCase();
      var z = dipZone(sym);
      if (!z) { waiting++; continue; }
      if (log) dipNotePrice(sym, now);
      if (z.pos <= DIP_MAX_POS) {
        // BUY needs BOTH gates: in the band AND settled there. In the band but only
        // just fallen in is WAIT — the same trade measured better a few days later
        // (73.9% from day 3 against 66.2% from day 1 in the reference data), so
        // printing BUY on day 1 would recommend the worse half of the rule.
        var ripe = z.bandDays >= DIP_RIPE_DAYS;
        rows.push({ sym: sym, pos: z.pos, price: z.price, high: z.high, low: z.low,
                    bandDays: z.bandDays, verdict: ripe ? "BUY" : "WAIT",
                    fresh: (log && ripe) ? !!dipNoteCall(sym, z.pos, z.price, now) : false });
      }
    }
    if (log) { dipSettle(now); dipTrimPx(now); }
    // ACTION order first, price position second. Sorting by position alone puts the
    // one row you are meant to act on at the BOTTOM, underneath rows that say WAIT,
    // and the order then looks arbitrary to a reader who cannot see the sort key.
    rows.sort(function (a, b) {
      var ra = a.verdict === "BUY" ? 0 : 1, rb = b.verdict === "BUY" ? 0 : 1;
      return ra !== rb ? ra - rb : a.pos - b.pos;
    });
    return { rows: rows, waiting: waiting, sells: dipSells(ownedMap),
             stats: dipMeasure(now) };
  }

  function fmRoi(n) {
    if (n >= 1e9) return "$" + (n/1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n/1e6).toFixed(2) + "M";
    if (n >= 1e3) return "$" + (n/1e3).toFixed(0) + "K";
    return "$" + n.toFixed(0);
  }

  // ---- free mode: item prices and names straight from Torn's API (as in 2.50) ----
  function fetchItemPrice(itemId, cb) {
    if (itemPrices[itemId] !== undefined) { cb(itemPrices[itemId]); return; }
    var url = "https://api.torn.com/market/" + itemId + "?selections=itemmarket&key=" + getTornKey();
    gmXhr({
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
    gmXhr({
      method: "GET", url: url,
      onload: function(r) {
        try {
          var d = JSON.parse(r.responseText);
          var entry = d.items && d.items[itemId];
          var nm = entry ? safeItemName(entry.name) : null;
          if (nm) {
            itemNames[itemId] = nm;
            lsSet("tsa_item_names", JSON.stringify(itemNames));
            cb(nm);
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
    gmXhr({
      method: "GET", url: url,
      onload: function(r) {
        try {
          var d = JSON.parse(r.responseText);
          if (d.items) {
            Object.keys(d.items).forEach(function(id) {
              var item = d.items[id];
              var nm = item ? safeItemName(item.name) : null;
              if (nm) {
                itemIdsByName[nm] = parseInt(id, 10);
                if (typeof item.market_value === "number") {
                  itemMarketValues[nm] = item.market_value;
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
  // into ROI_TABLE (and its lookup map) and register their item ID so it is
  // valued from the catalogue. Idempotent.
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
          payout: baseline, freq: def.freq, type: def.type, item: itemId
        });
      }
      if (ITEM_IDS.indexOf(itemId) < 0) ITEM_IDS.push(itemId);
    });
    rebuildRoiMap();
  }

  function fetchAllItemPricesDirect(cb) {
    // After a licence-mode load, itemPrices holds market_values: drop them (memory
    // only) so free mode prices from the item market as in 2.50.
    if (itemPricesFromDossier) {
      Object.keys(itemPrices).forEach(function(k) { delete itemPrices[k]; });
      itemPricesFromDossier = false;
    }
    // Resolve any pending dynamic item IDs first, then add their entries to
    // ROI_TABLE, then fetch market price + display name for the (possibly
    // expanded) ITEM_IDS list.
    ensureDynamicItemIds(function() {
      // The item fetch is what makes item-paying benefits priceable, so retry the
      // catalogue install here: on a cold profile the module-init attempt ran with
      // an empty itemMarketValues and was (correctly) rejected as implausible.
      applyStockCatalogue();
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

  // Licence mode.
  function fetchAllItemPricesDossier(cb) {
    // The reference (at most daily) carries item ids, names and market values, so
    // nothing here is fetched per item. Then: re-install the catalogue (on a cold
    // profile the module-init attempt ran with an empty itemMarketValues and was,
    // correctly, rejected as implausible), add the dynamic stocks' rows, and value
    // every item id the (possibly expanded) ROI table needs.
    refreshStockCatalogue().then(function() {
      applyStockCatalogue();
      augmentRoiTableWithDynamicStocks();
      fillItemValuesFromCatalogue();
      cb();
    });
  }

  function fetchAllItemPrices(cb) {
    if (dataMode === "dossier") fetchAllItemPricesDossier(cb);
    else fetchAllItemPricesDirect(cb);
  }

  function getItemValue(entry) {
    if (entry.sym === "PTS") return PTS_VALUE;
    if (entry.item && itemPrices[entry.item]) return itemPrices[entry.item];
    return 0;
  }

  function getItemName(itemId) {
    return (itemId && itemNames[itemId]) ? itemNames[itemId] : "";
  }

  // Per-cycle payout of ONE benefit tier, in dollars. Item-paying stocks are valued
  // at the item's current market_value (Torn's, via Dossier); ROI_TABLE.payout is
  // only the baseline used until that value has loaded (and is the real figure for cash stocks, where item is 0).
  // Every income / ROI / payback figure in the planner - buy side AND sell side -
  // goes through this one function, so the two sides cannot drift onto different
  // price bases again. ONE DOCUMENTED EXCEPTION, display only: the tier table's second
  // line prints the raw ROI_TABLE.payout baseline next to "live <value>" so both
  // numbers are visible side by side. No ROI, payback or income figure is derived from
  // that print.
  function getPerCycle(entry) {
    if (!entry) return 0;
    var iv = getItemValue(entry);
    return (entry.item && iv > 0) ? iv : (entry.payout || 0);
  }

  // Length of one payout cycle, in DAYS. Torn reports it per stock as
  // dividend.frequency / benefit.frequency and buildOwnedMap stores it as
  // dividend_frequency, so that value wins whenever it exists. ROI_TABLE.freq is
  // only the FALLBACK for stocks the user does not hold yet (the API reports a
  // frequency for held positions).
  // Both fallback values are VERIFIED against the live API (2026-08-24, raw response
  // archived out of repo): the 27
  // weekly stocks return frequency 7, and all eight monthly stocks (TSB, IOU, GRN,
  // TCT, CNC, TMI, HRG, TCC) return exactly 31 — Torn uses a fixed 31-day cycle,
  // never the current calendar month's length. Reading the API value anyway means a
  // future change on Torn's side lands here on its own instead of silently.
  function getCycleDays(entry, ownedMap) {
    var o = (entry && ownedMap) ? ownedMap[entry.sym] : null;
    var apiFreq = o ? (o.dividend_frequency || 0) : 0;
    if (apiFreq > 0) return apiFreq;
    return (entry && entry.freq) ? entry.freq : 7;
  }

  // Calculate Bollinger Bands using all stored price history
  // Returns { upper, middle, lower, pctB } or null if insufficient data
  // pctB = position within bands: 0 = at lower, 1 = at upper, <0 = below lower
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

    // Historical sample: one BB width every 4 prices.
    // bbWidthFromSlice only ever looks at the trailing 20 elements, so slice
    // exactly that window instead of copying the whole prefix (O(n) vs O(n²)).
    var historicalWidths = [];
    for (var i = 20; i <= prices.length; i += 4) {
      var w = bbWidthFromSlice(prices.slice(i - 20, i));
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
        weeklyTotal += (getPerCycle(entry) / getCycleDays(entry, ownedMap)) * 7;
      });
    });
    // Add extra entry (bridgebuilder)
    if (extraEntry) {
      weeklyTotal += (getPerCycle(extraEntry) / getCycleDays(extraEntry, ownedMap)) * 7;
    }
    return weeklyTotal;
  }

  // A CALENDAR MONTH, NOT A PAYOUT CYCLE. 365/12 = 30.4167 days, the same 365-day
  // year TSA already annualises ROI with, so "per month" and "per year" describe one
  // calendar. Deliberately NOT 31: 31 is Torn's CYCLE length for the monthly benefit
  // stocks (getCycleDays), a property of the payout, and using it as a month length
  // would silently mix the two. Deliberately not 30 either - that would disagree with
  // the ROI denominator.
  var DAYS_PER_MONTH = 365 / 12;

  // Calculate days until target is affordable with given weekly income + capital
  function daysToAfford(target, capital, weeklyIncome) {
    if (capital >= target) return 0;
    if (weeklyIncome <= 0) return Infinity;
    var needed = target - capital;
    var dailyIncome = weeklyIncome / 7;
    return Math.ceil(needed / dailyIncome);
  }

  // Full snowball roadmap: every real benefit tier across all payout stocks,
  // ranked by payback (days for the block to earn back its own price). Cost is
  // priced the same way the buy side prices it (calcNextTier): the shares STILL
  // MISSING to reach the tier, at live share price - so one tier carries one ROI
  // number everywhere. Income uses the live item value when available. Owned tiers
  // are flagged (kept as income, not re-bought).
  function computeRoadmap(ownedMap, raw) {
    var rows = [];
    ROI_TABLE.forEach(function(entry) {
      var req = BENEFIT_REQ[entry.sym];
      if (!req) return;
      // THE USER'S OPT-OUTS BIND HERE TOO. computeBridgePlan (the buy side) filters on
      // roiSymSkipped and roiSymTierCap; this table did not, so a symbol switched off
      // with the planner's X, or a tier above that symbol's cap, could still be ranked
      // - and since the roadmap now leads with "Goal X T5 ... via Y T2", it could
      // become the HEADLINE recommendation, contradicting an explicit choice. An
      // explicit opt-out applies to every view, so it is filtered at the source of the
      // table: no row, therefore no step, therefore no goal.
      if (roiSymSkipped(entry.sym)) return;
      var liveEntry = raw ? raw.find(function(x) { return x.stock === entry.sym; }) : null;
      var livePrice = liveEntry ? (parseFloat(liveEntry.price) || 0) : 0;
      if (livePrice <= 0) return;
      var tierNum = parseInt(entry.tier.replace("T", ""), 10);
      if (!tierNum) return;
      if (tierNum > roiSymTierCap(entry.sym)) return;   // above the user's tier cap
      var o = ownedMap[entry.sym];
      var held = o ? (o.shares || 0) : 0;
      var curInc = o ? (o.dividend_increment || 0) : 0;
      var owned = tierNum <= curInc;
      // Tiers are cumulative: reaching tier n needs (2^n - 1) * req shares in total,
      // and shares already held count toward it. marginalShares is the tier's OWN
      // parcel - used only for the secured rows below (the cumulative column in the
      // renderer is built from `cost`, not from this).
      var marginalShares = Math.pow(2, tierNum - 1) * req;
      var sharesNeeded = Math.max(0, (Math.pow(2, tierNum) - 1) * req - held);
      // PENDING TIER - BOUGHT BUT NOT YET CREDITED. Torn only bumps
      // dividend_increment on the payout day, so between the buy and the next payout
      // held is already at or above (2^n - 1) * req while curInc is still below n.
      // sharesNeeded === 0 && !owned IS exactly that state and nothing else, because
      // sharesNeeded === 0 <=> held >= (2^n - 1) * req. Same condition as
      // enrichOwnedMap's effectiveIncrement loop, which exists for this case but only
      // reclassifies benefit_shares/swing_shares and never reaches this table.
      // A pending tier is NOT a step: pricing it as an unpaid buy invented money the
      // user has already spent, which (a) put a phantom row into computeFastestPath's
      // `open` where it could even be picked as the GOAL, displacing a real target,
      // and (b) added that phantom price to the renderer's running `cum`, shifting the
      // capital figure of every row below it.
      var pending = !owned && sharesNeeded === 0;
      var perCycle = getPerCycle(entry);
      if (!perCycle) return;
      var freq = getCycleDays(entry, ownedMap);
      var cost, dailyInc;
      if (sharesNeeded > 0) {
        cost = sharesNeeded * livePrice;
        // COST AND INCOME MUST DESCRIBE THE SAME PURCHASE. `cost` is every share still
        // missing to REACH tier n, which for n > increment+1 pays for the intermediate
        // tiers too - and Torn pays out EVERY tier up to your increment (calcWeeklyIncome
        // sums them). So the income side has to be the sum of every tier this one buy
        // switches on, from increment+1 to n. Pairing that cost with tier n's payout
        // alone understated ROI and payback for every multi-step row and pushed the far
        // tiers down the ranking; the buy side (calcNextTier) never had the bug because
        // it only ever looks one increment ahead.
        // PAID-FOR TIERS ARE NOT PART OF THIS PURCHASE. `cost` above credits every
        // share already held against sharesNeeded, so a tier whose shares are ALREADY
        // BOUGHT - but whose increment Torn has not bumped yet, because the payout day
        // has not come - costs nothing here. Crediting its income to this buy invents
        // income the buy does not switch on, and always in the OPTIMISTIC direction,
        // which is the dangerous one: real money is spent against these numbers.
        // So the base is the number of tiers the SHARES have paid for, which is what
        // `cost` is measured against, not the increment Torn has got around to
        // reporting. Derived here from `held` and `req` rather than read off ownedMap,
        // so this holds even on a map enrichOwnedMap has not touched. The error was
        // worth up to a FACTOR OF TWO on payback for an affected row.
        var paidTiers = 0;
        while (held >= (Math.pow(2, paidTiers + 1) - 1) * req) paidTiers++;
        var incomeBase = Math.max(curInc, paidTiers);
        dailyInc = 0;
        for (var t = incomeBase + 1; t <= tierNum; t++) {
          var e2 = ROI_MAP[entry.sym + "|T" + t];
          if (!e2) continue;
          var pc2 = getPerCycle(e2);
          if (pc2 > 0) dailyInc += pc2 / getCycleDays(e2, ownedMap);
        }
        // Increment claims the tier is reached while the shares say otherwise (a sale
        // the API has not caught up with): the loop is empty, so price the tier's own
        // payout rather than dropping the row.
        if (dailyInc <= 0) dailyInc = perCycle / freq;
      } else {
        // Already secured - either owned, or pending the next payout. Zero further
        // shares, which priced at zero would rank the row ahead of every real buy, so
        // it falls back to the tier's own parcel at live price: the liquidation value
        // of the block being held, i.e. the same basis the sell side uses, so a
        // secured row's ROI stays comparable to a sell unit's, and the income is that
        // one tier's payout for the same reason. DISPLAY ONLY - `owned` and `pending`
        // both keep the row out of `open` and out of the renderer's `cum`, so this
        // price is never charged to anybody.
        cost = marginalShares * livePrice;
        dailyInc = perCycle / freq;
      }
      if (cost <= 0 || dailyInc <= 0) return;
      // sharesNeeded/marginalShares/perCycle/freq have no reader in the UI - they are
      // the deliberate TEST SURFACE of this function: an out-of-repo logic guard
      // extracts these functions from the file and asserts on them. Do not trim them
      // without updating that guard.
      rows.push({
        sym: entry.sym, tier: entry.tier, tierNum: tierNum,
        cost: cost, sharesNeeded: sharesNeeded, marginalShares: marginalShares,
        perCycle: perCycle, dailyInc: dailyInc, freq: freq,
        // ONE definition of "income per month", so the goal rule and the line that
        // displays the goal cannot drift apart: dailyInc (= sum of perCycle/cycleDays
        // over every tier this buy switches on) times a calendar month.
        monthlyInc: dailyInc * DAYS_PER_MONTH,
        roi: dailyInc * 365 / cost * 100,
        payback: Math.round(cost / dailyInc),
        owned: owned, pending: pending
      });
    });
    // Payback ascending, then symbol alphabetically, then tier - a deterministic
    // tie-break instead of ROI_TABLE insertion order.
    rows.sort(function(a, b) {
      return (a.payback - b.payback) || a.sym.localeCompare(b.sym) || (a.tierNum - b.tierNum);
    });
    return rows;
  }

  // Live swing value of one symbol's tradable shares, net of Torn's 0.1% sell fee.
  // One definition, so every "this capital cannot fund THAT block" rule agrees.
  // KNOWN 0.1% ASYMMETRY: this side is net of the sell fee, while computeRoadmap
  // credits shares already held against sharesNeeded at FULL price (they are not
  // being sold, so no fee applies to them). The two sides therefore differ by up to
  // 0.1% of the held parcel - intentional, and far below any ranking threshold here.
  function symSwingValue(sym, ownedMap, raw) {
    var o = ownedMap ? ownedMap[sym] : null;
    if (!o || !(o.swing_shares > 0)) return 0;
    var le = raw ? raw.find(function(x) { return x.stock === sym; }) : null;
    var lp = le ? (parseFloat(le.price) || 0) : 0;
    if (lp <= 0) return 0;
    return lp * o.swing_shares * SELL_FEE;
  }

  // FASTEST PATH TO THE BIGGEST BLOCK — the roadmap's ranking.
  //
  // Ranking a benefit tier by its own payback or raw ROI answers the wrong
  // question: what the owner wants is the largest income this book can eventually
  // reach, and what matters is how soon it can be reached. So rank by TIME TO THE
  // GOAL instead:
  //
  //   goal = the tier with the HIGHEST ABSOLUTE INCOME that is neither owned nor
  //          pending, using the corrected inputs (live per-cycle payout, live cost
  //          of only the shares still missing, Torn's own cycle length).
  //
  //   WHY INCOME AND NOT ROI. Within one symbol, ROI is STRICTLY DECREASING in tier:
  //   roi(n) is proportional to (n - curInc) / ((2^n - 1) * req - held), so
  //   roi(k+2) > roi(k+1) would require -req - held > 0, impossible for req > 0 and
  //   held >= 0. The highest-ROI open row is therefore ALWAYS the next increment of
  //   the best symbol - exactly the tier computeBridgePlan already offers as its
  //   target. A goal that is one buy away by construction can have no path to it, so
  //   the whole stepping-stone mechanism was dead code under the old rule (it
  //   reported 0 qualifying steps on any book, which was not a property of the book).
  //   Absolute income rises with tier, so an expensive high tier can now be the goal
  //   and the steps have something to shorten.
  //
  //   Income is compared as monthlyInc (dailyInc * 365/12). Per month and per week
  //   RANK IDENTICALLY - both are the same positive constant times dailyInc, and
  //   multiplying every row by one constant cannot reorder them - so the unit is a
  //   display choice (the owner's horizon is a month), never a ranking choice.
  //   D0   = daysToAfford(goal.cost, capital, weeklyIncome)          — just wait.
  //
  //   step s = any unowned tier buyable RIGHT NOW (s.cost <= Cs). Buying it
  //   spends its cost but raises weekly income, which pulls the goal closer:
  //       Ws = weeklyIncome + s.dailyInc * 7   — EVERY tier the buy switches on
  //       Cs = capital - swing(s.sym) - s.cost — s's own swing shares are already
  //            counted inside s.cost as progress made, so they are not also cash
  //       Gs = goal.cost, less s.cost whenever s is ANY other tier of the goal's OWN
  //            stock — tiers are cumulative, so those shares are part of the goal's
  //            remaining requirement and the step pre-pays that part of it. A HIGHER
  //            tier of the goal's stock costs at least what the goal costs, so it
  //            pre-pays the goal in full and Gs clamps to 0. DEFENCE IN DEPTH, not a
  //            live case: income is cumulative, so the goal is always the TOP open
  //            tier of its own symbol and no higher tier of it exists to be a step -
  //            and even if one were injected, st.cost >= goal.cost while a qualifying
  //            step needs goalCapital < goal.cost, so it could never be affordable.
  //            The branch is nevertheless written correctly rather than left wrong.
  //       Ds = daysToAfford(Gs, Cs, Ws)
  //
  //   A step is recommended ONLY when Ds < D0. Its own ROI is irrelevant: a
  //   high-ROI block that does not shorten the time to the goal is not a step.
  //   Winner = smallest Ds; ties break on symbol, then tier.
  //
  // capital: the goal's own swing value is excluded, because selling those shares
  // shrinks the very block being completed — the same rule computeBridgePlan uses
  // for its target, via the shared symSwingValue.
  //
  // Pure function: no DOM, no fetch. Give it an ownedMap, live prices, capital and
  // weekly income and it is fully testable on its own.
  function computeFastestPath(ownedMap, raw, capital, weeklyIncome, roadmapRows) {
    ownedMap = ownedMap || {};
    var rows = roadmapRows || computeRoadmap(ownedMap, raw);
    // Pending rows are excluded with the owned ones: the shares are already bought,
    // so the row is not a purchase and its display price is not money to be spent.
    var open = rows.filter(function(r) { return !r.owned && !r.pending && r.cost > 0 && r.roi > 0; });
    if (open.length === 0) return null;

    // HIGHEST ABSOLUTE INCOME, not highest ROI — see the header. monthlyInc is the
    // roadmap row's own field, so the goal is chosen with the very number the goal
    // line displays.
    var goal = open.slice().sort(function(a, b) {
      return (b.monthlyInc - a.monthlyInc) || a.sym.localeCompare(b.sym) || (a.tierNum - b.tierNum);
    })[0];

    var goalCapital = Math.max(0, capital - symSwingValue(goal.sym, ownedMap, raw));
    var baselineDays = daysToAfford(goal.cost, goalCapital, weeklyIncome);

    var steps = [];
    open.forEach(function(st) {
      if (st.sym === goal.sym && st.tierNum === goal.tierNum) return;
      // ANY other tier of the goal's own stock is nested, above the goal as well as
      // below it. Restricting this to lower tiers left a higher tier of the goal's
      // stock on the non-nested branch, where stepCapital would subtract that symbol's
      // swing a SECOND time (goalCapital already did) and goalCost would stay at the
      // full goal.cost even though the step buys every share the goal is missing.
      // No live fixture reaches it (see Gs above), so this is correctness of the
      // branch, not a bug fix - do not build a guard on it: with rows computeRoadmap
      // can actually produce, such a guard passes either way and can never fail.
      var nested = (st.sym === goal.sym);
      // NO SHARE COUNTS TWICE. st.cost is only the shares still MISSING, i.e. the ones
      // already held are counted as progress made - while `capital` separately counts
      // those same shares at their liquidation value. Judging the step against the full
      // capital would spend them twice, and a stock held mostly as swing would look
      // nearly free. So a step is judged against capital minus its OWN swing, exactly
      // as the goal already is. A nested step is the goal's own stock, whose swing
      // symSwingValue has removed from goalCapital already.
      var stepCapital = nested ? goalCapital
        : Math.max(0, goalCapital - symSwingValue(st.sym, ownedMap, raw));
      if (st.cost > stepCapital) return; // not buyable right now — not a step
      var goalCost = nested ? Math.max(0, goal.cost - st.cost) : goal.cost;
      // Every tier the step switches on, not just its own - see computeRoadmap.
      var stepWeekly = (st.dailyInc || 0) * 7;
      var days = daysToAfford(goalCost, stepCapital - st.cost, weeklyIncome + stepWeekly);
      var saved = (baselineDays === Infinity)
        ? (days === Infinity ? 0 : Infinity)
        : (baselineDays - days);
      if (!(saved > 0)) return; // buys no time — not a step, whatever its own ROI
      // extraWeekly/nested and (on the return value) capital/weeklyIncome have no UI
      // reader either - same test surface as the roadmap row fields above.
      steps.push({
        sym: st.sym, tier: st.tier, tierNum: st.tierNum, cost: st.cost, roi: st.roi,
        extraWeekly: stepWeekly, nested: nested, days: days, daysSaved: saved
      });
    });

    steps.sort(function(a, b) {
      return (a.days - b.days) || a.sym.localeCompare(b.sym) || (a.tierNum - b.tierNum);
    });

    return {
      goal: goal,
      capital: goalCapital,
      weeklyIncome: weeklyIncome,
      baselineDays: baselineDays,
      steps: steps,
      best: steps[0] || null
    };
  }

  // Every OWNED marginal benefit tier that could be sold, worst ROI first — the
  // sell side of the upgrade swap and of the next-block rule's "via sale" step.
  function computeSellUnits(ownedMap, raw) {
    ownedMap = ownedMap || {};
    // Sell units: EVERY owned benefit marginal tier (each stock, tier 1..effTopTier).
    // A stock's tiers must be sold top-down (shares are fungible — to drop a lower tier
    // you must sell everything above it). Because a higher tier has lower ROI, sorting
    // all units by ROI ascending lays out each stock's tiers in top-down order, so
    // accumulating a prefix of the sorted list never violates the top-down rule.
    // effTopTier honours the planner tier cap (shares above the cap are already swing).
    var sellUnits = [];
    Object.keys(ownedMap).forEach(function(sym) {
      var o = ownedMap[sym];
      if (!o || !o.has_dividend || o.benefit_shares <= 0) return;
      if (roiSymSkipped(sym)) return; // released to swing — not a benefit block
      var inc = o.dividend_increment || 0;
      var cap = roiSymTierCap(sym);
      var effTopTier = Math.min(inc, cap === Infinity ? inc : cap);
      if (effTopTier < 1) return;
      var req = BENEFIT_REQ[sym] || 0;
      if (req <= 0) return;
      var liveEntry = raw ? raw.find(function(x) { return x.stock === sym; }) : null;
      var livePrice = liveEntry ? (parseFloat(liveEntry.price) || 0) : 0;
      if (livePrice <= 0) return;
      var isPassive = PASSIVE_STOCKS.indexOf(sym) >= 0;
      var topT = isPassive ? 1 : effTopTier; // passive stocks are single-tier
      for (var t = 1; t <= topT; t++) {
        var marginalShares = isPassive ? req : Math.pow(2, t - 1) * req;
        var saleValue = marginalShares * livePrice * SELL_FEE; // net of Torn's 0.1% sell fee
        if (saleValue <= 0) continue;
        var entry = ROI_MAP[sym + "|T" + t];
        if (!entry) continue;
        var perCycle = getPerCycle(entry);
        var cycleDays = getCycleDays(entry, ownedMap);
        var weekly = perCycle ? perCycle / cycleDays * 7 : 0;
        var tierCost = marginalShares * livePrice;
        // ROI on the LIVE per-cycle payout the buy side uses (getPerCycle), so the two
        // sides are genuinely comparable for the 9 item-paying stocks. The cost basis
        // stays this tier's own parcel at live price: that is what selling the block
        // actually returns, which is the right denominator for a sell decision.
        var roi = (tierCost > 0 && perCycle) ? (perCycle / tierCost * (365 / cycleDays) * 100) : 0;
        sellUnits.push({ sym: sym, tier: "T" + t, tierNum: t, roi: roi, shares: marginalShares, saleValue: saleValue, weekly: weekly });
      }
    });
    // Lowest ROI first, then symbol alphabetically (deterministic instead of
    // Object.keys order), then tier DESCENDING. The tier key is defence in depth
    // only: within one symbol ROI is strictly decreasing in tier (the parcel doubles
    // while the payout does not), so the ROI key already orders one stock's tiers
    // top-down and the tier key cannot currently be reached. It stays as the explicit
    // statement of the ordering the accumulate-a-prefix loop below depends on - it
    // must never drop a lower tier while a higher one is still held.
    sellUnits.sort(function(a, b) {
      return (a.roi - b.roi) || a.sym.localeCompare(b.sym) || (b.tierNum - a.tierNum);
    });
    return sellUnits;
  }

  // ---- NEXT BLOCK: the same rule as Dossier's Benefit Advisor (2.56.0) ----
  // Owner decision 2026-11-05: TSA names the same next benefit block Dossier does.
  // Licence mode shows Dossier's own answer (/api/tsa/benefit) and runs none of
  // this; free mode runs this port of dossier app/benefit_advisor.py pick_answer(),
  // own_days_to_afford() and fund_by_sale(). Over the open roadmap rows, in the
  // roadmap's own order (payback ascending, as Dossier's ranking):
  //   buy      the first row affordable now: cost <= capital
  //   viaSale  else the first row that selling worse blocks pays for
  //   closest  else the row with the FEWEST days to afford, each judged against
  //            capital minus that stock's OWN swing (its own shares cannot pay for
  //            its own block) at the current weekly income; a tie keeps the
  //            earlier row
  //   save     else (no income, nothing reachable) the highest-income goal
  //   none     nothing open at all
  // ``capital`` is the planner's whole capital (cash + swing + armoury).

  // fund_by_sale(): sell the worst blocks (units, ROI ascending) until the funds
  // cover the cost. Skips the buy's own stock, stops at a block as good as the buy,
  // and refuses a sale that loses more weekly income than the buy brings in.
  function fundBySale(buySym, buyRoi, buyWeekly, cost, units, funds) {
    var proceeds = 0, lost = 0, sells = [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.sym === buySym) continue;
      if (buyRoi <= u.roi) break;
      sells.push(u);
      proceeds += u.saleValue;
      lost += u.weekly;
      if (funds + proceeds >= cost) {
        var net = buyWeekly - lost;
        if (net <= 0) return null;   // a downgrade, never a plan
        return { sells: sells, proceeds: proceeds, netWeekly: net, leftoverCash: funds + proceeds - cost };
      }
    }
    return null;
  }

  // -> {kind, row, days, viaSale}. row is a computeRoadmap row (null for none/empty),
  // days the whole days until it is affordable (0 for buy/viaSale, null = never).
  function pickNextBlock(ownedMap, raw, capital, weeklyIncome, roadmapRows) {
    ownedMap = ownedMap || {};
    capital = capital || 0;
    var all = roadmapRows || computeRoadmap(ownedMap, raw);
    var rows = all.filter(function(r) { return !r.owned && !r.pending && r.cost > 0; });
    var out = { kind: "none", row: null, days: null, viaSale: null };
    if (rows.length === 0) { out.kind = all.length ? "none" : "empty"; return out; }
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].cost <= capital) { out.kind = "buy"; out.row = rows[i]; out.days = 0; return out; }
    }
    function capFor(sym) { return Math.max(0, capital - symSwingValue(sym, ownedMap, raw)); }
    var units = computeSellUnits(ownedMap, raw);
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var sale = fundBySale(r.sym, r.roi, (r.perCycle / r.freq) * 7, r.cost, units, capFor(r.sym));
      if (sale && sale.sells.length > 0) { out.kind = "viaSale"; out.row = r; out.days = 0; out.viaSale = sale; return out; }
    }
    var best = -1, bestDays = null;
    for (i = 0; i < rows.length; i++) {
      var d = daysToAfford(rows[i].cost, capFor(rows[i].sym), weeklyIncome);
      if (!isFinite(d)) continue;
      if (best < 0 || d < bestDays) { best = i; bestDays = d; }
    }
    if (best >= 0) { out.kind = "closest"; out.row = rows[best]; out.days = bestDays; return out; }
    var fp = computeFastestPath(ownedMap, raw, capital, weeklyIncome, all);
    if (fp && fp.goal) {
      out.kind = "save"; out.row = fp.goal;
      out.days = isFinite(fp.baselineDays) ? fp.baselineDays : null;
    }
    return out;
  }

  // A roadmap row as the recommendation the rec widget, the bank pill and the
  // planner's "Next move" read. sharesNeeded is the shares still missing to REACH
  // the tier (a buy of exactly that many can never overshoot it).
  function blockTarget(row, ownedMap, raw) {
    if (!row) return null;
    var req = BENEFIT_REQ[row.sym] || 0;
    var le = raw ? raw.find(function(x) { return x.stock === row.sym; }) : null;
    var lp = le ? (parseFloat(le.price) || 0) : 0;
    return {
      sym: row.sym, tier: row.tier, cost: row.cost, roi: row.roi || 0,
      monthlyInc: row.monthlyInc || 0,
      tierInfo: {
        nextIncrement: row.tierNum,
        sharesNeeded: row.sharesNeeded,
        totalSharesNeeded: (Math.pow(2, row.tierNum) - 1) * req,
        livePrice: lp
      }
    };
  }

  // One line on why the next block is the next block. Plain text; every symbol in
  // it is one of the 35 known ones (blockTarget / dossierBlock), so it is HTML-safe.
  function nextBlockWhy(ans) {
    var d = ans && typeof ans.days === "number" && isFinite(ans.days) ? "~" + Math.round(ans.days).toLocaleString("en-US") + "d" : null;
    switch (ans && ans.kind) {
      case "buy": return "✓ Affordable now";
      case "viaSale":
        var sells = (ans.viaSale && ans.viaSale.sells) ? ans.viaSale.sells.map(function(u) { return u.sym + " " + u.tier; }) : [];
        return sells.length ? "Sell " + sells.join(" + ") + " to afford it" : "Affordable by selling worse blocks";
      case "closest": return "Closest to afford" + (d ? ": " + d : "");
      case "save": return "Biggest income goal" + (d ? ": " + d : ": not reachable at current income");
      default: return "—";
    }
  }

  // ---- LICENCE MODE: Dossier's answer, adapted to the shapes TSA renders ----
  // Nothing here decides anything: it reads /api/tsa/benefit's answer, bridge,
  // fastest_path and swap, keeps only the 35 known symbols (so no Dossier string
  // reaches the page) and forces every number through Number(). The block is
  // Dossier's; the only local figure is how many shares are still missing, from
  // the holdings TSA shows (Dossier's poll plus any Quick Trade since), so a click
  // made before Dossier's next poll can never buy the same block twice.
  function dNum(v) { var n = Number(v); return (typeof v === "number" || typeof v === "string") && isFinite(n) ? n : null; }
  function dDays(v) { var n = dNum(v); return n === null ? Infinity : n; }
  function dTier(v) { var n = dNum(v); return (n !== null && n >= 1 && n <= 20 && Math.floor(n) === n) ? n : null; }

  function dossierBlock(row, ownedMap, raw) {
    if (!row || typeof row !== "object") return null;
    var sym = typeof row.sym === "string" ? row.sym : "";
    if (!Object.prototype.hasOwnProperty.call(BENEFIT_REQ, sym)) return null;
    var n = dTier(row.tier);
    if (n === null) return null;
    var req = BENEFIT_REQ[sym];
    var total = (Math.pow(2, n) - 1) * req;
    var o = ownedMap ? ownedMap[sym] : null;
    var held = o ? (o.shares || 0) : 0;
    var le = raw ? raw.find(function(x) { return x.stock === sym; }) : null;
    var lp = le ? (parseFloat(le.price) || 0) : 0;
    var dShares = dNum(row.shares_needed);
    var dCost = dNum(row.cost);
    var missing = Math.max(0, total - held);
    if (!(lp > 0) && dShares > 0 && dCost > 0) lp = dCost / dShares;
    var cost = (dShares === missing && dCost !== null) ? dCost : missing * lp;
    return {
      sym: sym, tier: "T" + n, cost: cost, roi: dNum(row.roi) || 0,
      monthlyInc: dNum(row.monthly_inc) || 0, dailyInc: dNum(row.daily_inc) || 0,
      tierInfo: { nextIncrement: n, sharesNeeded: missing, totalSharesNeeded: total, livePrice: lp }
    };
  }

  // The status line licence mode shows when Dossier gave no block to name.
  function dossierBenefitStatus(res) {
    if (!res) return "Waiting for Dossier's Benefit Advisor.";
    if (res.kind === "throttled") return "Dossier throttled: the recommendation comes back on the next refresh.";
    if (res.kind === "key_required") return "Dossier has no working Torn API key for your account.";
    if (res.kind === "licence_invalid" || res.kind === "licence_inactive") return "Dossier did not accept the TSA licence.";
    if (res.kind !== "ok") return "Dossier unreachable: no recommendation until it answers.";
    var k = res.body && res.body.answer ? res.body.answer.kind : null;
    if (k === "unavailable") return "Dossier's Benefit Advisor is not available right now (its market data is still loading).";
    if (k === "empty") return "Dossier's Benefit Advisor has no benefit blocks to rank yet.";
    return "Dossier's Benefit Advisor has nothing to recommend right now.";
  }

  // The computeBridgePlan shape, from Dossier. target null + status text when
  // Dossier named no block: licence mode then shows that status, never a local pick.
  function dossierBenefitPlan(res, ownedMap, raw) {
    var plan = {
      fromDossier: true, status: null, answer: null, dynamicNextTiers: [], target: null,
      fundCapital: 0, bridgeChain: [], daysBaseline: Infinity, bridgeGoal: null,
      bridgeHorizonDays: 90, bridgeBaselineDays: 0, bridgeDaysWith: 0, swap: null, fastest: null
    };
    var body = (res && res.kind === "ok" && res.body && typeof res.body === "object") ? res.body : null;
    var a = body && body.answer && typeof body.answer === "object" ? body.answer : null;
    var pl = body && body.payload && typeof body.payload === "object" ? body.payload : {};
    plan.fundCapital = dNum(pl.capital && pl.capital.total) || 0;
    var kind = a && typeof a.kind === "string" ? a.kind : null;
    var target = (kind === "buy" || kind === "viaSale" || kind === "closest" || kind === "save")
      ? dossierBlock(a.row, ownedMap, raw) : null;
    if (!target) { plan.status = dossierBenefitStatus(res); return plan; }
    plan.target = target;
    plan.answer = { kind: kind, days: dNum(a.days), viaSale: null };
    if (kind === "viaSale" && a.row.affordable_via_sale && Array.isArray(a.row.affordable_via_sale.sells)) {
      plan.answer.viaSale = { sells: a.row.affordable_via_sale.sells.map(function(u) {
        var b = dossierBlock({ sym: u && u.sym, tier: u && u.tier }, null, null);
        return b ? { sym: b.sym, tier: b.tier } : null;
      }).filter(Boolean) };
    }
    plan.daysBaseline = plan.answer.days === null ? Infinity : plan.answer.days;
    var ranking = Array.isArray(pl.ranking) ? pl.ranking : [];
    function rankRow(sym, tier) {
      for (var i = 0; i < ranking.length; i++) {
        var r = ranking[i];
        if (r && r.sym === sym && dTier(r.tier) === tier) return r;
      }
      return null;
    }
    var br = pl.bridge && typeof pl.bridge === "object" ? pl.bridge : null;
    if (br) {
      var g = dossierBlock(br.goal, ownedMap, raw);
      plan.bridgeGoal = g;
      plan.bridgeHorizonDays = dNum(br.horizon_days) || 90;
      plan.bridgeBaselineDays = dDays(br.baseline_days);
      plan.bridgeDaysWith = br.days_with_bridges == null ? plan.bridgeBaselineDays : dDays(br.days_with_bridges);
      (Array.isArray(br.chain) ? br.chain : []).forEach(function(c) {
        if (!c || typeof c !== "object") return;
        var n = dTier(c.tier);
        var rr = rankRow(c.sym, n) || { sym: c.sym, tier: n, cost: c.cost };
        var b = dossierBlock(rr, ownedMap, raw);
        if (!b) return;
        plan.bridgeChain.push({
          sym: b.sym, tier: b.tier, cost: dNum(c.cost) || b.cost, roi: dNum(c.roi) || 0,
          extraIncome: dNum(c.extra_weekly) || 0, status: c.status === "now" ? "now" : "later",
          daysUntil: dDays(c.days_until), daysSaved: dDays(c.days_saved), tierInfo: b.tierInfo
        });
      });
    }
    var fp = pl.fastest_path && typeof pl.fastest_path === "object" ? pl.fastest_path : null;
    var fg = fp ? dossierBlock(fp.goal, ownedMap, raw) : null;
    if (fg) {
      var steps = [];
      (Array.isArray(fp.steps) ? fp.steps : []).forEach(function(st) {
        var b = dossierBlock({ sym: st && st.sym, tier: st && st.tier }, null, null);
        if (!b) return;
        steps.push({ sym: b.sym, tier: b.tier, tierNum: b.tierInfo.nextIncrement, cost: dNum(st.cost) || 0,
                     days: dDays(st.days), daysSaved: dDays(st.days_saved) });
      });
      plan.fastest = {
        goal: { sym: fg.sym, tier: fg.tier, cost: dNum(fp.goal.cost) || fg.cost, roi: fg.roi, monthlyInc: fg.monthlyInc },
        baselineDays: dDays(fp.baseline_days), steps: steps, best: steps[0] || null
      };
    }
    var sw = pl.swap && pl.swap.best && typeof pl.swap.best === "object" ? pl.swap.best : null;
    var buy = sw ? dossierBlock(sw.buy, ownedMap, raw) : null;
    if (buy && Array.isArray(sw.sells) && sw.sells.length > 0) {
      var sells = [];
      var ok = sw.sells.every(function(u) {
        var b = dossierBlock({ sym: u && u.sym, tier: u && u.tier }, null, null);
        if (!b) return false;
        // The share count a sale trades is never taken from the server: one tier's own
        // parcel, as computeSellUnits sells it. A Dossier figure that disagrees drops
        // the swap rather than sell a different amount than "Sell SYM Tn" says.
        var tn = b.tierInfo.nextIncrement, rq = BENEFIT_REQ[b.sym];
        var sh = PASSIVE_STOCKS.indexOf(b.sym) >= 0 ? rq : Math.pow(2, tn - 1) * rq;
        if (dNum(u && u.shares) !== sh) return false;
        sells.push({ sym: b.sym, tier: b.tier, roi: dNum(u.roi) || 0, shares: sh,
                     saleValue: dNum(u.sale_value) || 0, weekly: dNum(u.weekly_lost) || 0 });
        return true;
      });
      if (ok && buy.tierInfo.sharesNeeded > 0) {
        plan.swap = {
          sells: sells,
          buy: { sym: buy.sym, tier: buy.tier, roi: buy.roi, cost: buy.cost, shares: buy.tierInfo.sharesNeeded, tierInfo: buy.tierInfo },
          netWeekly: dNum(sw.net_weekly) || 0, leftoverCash: dNum(sw.leftover_cash) || 0
        };
      }
    }
    return plan;
  }

  // ONE entry point for the ROI recommendation, so the planner, the rec widget and
  // the Quick Trade pills cannot disagree: Dossier's answer in licence mode, TSA's
  // own (same rule) in free mode.
  function benefitPlan(ownedMap, raw, totalCapital, weeklyIncome, roadmapRows) {
    if (dataMode === "dossier") return dossierBenefitPlan(lastDossierBenefit, ownedMap, raw);
    return computeBridgePlan(ownedMap, raw, totalCapital, weeklyIncome, roadmapRows);
  }
  function benefitSwap(ownedMap, raw, liquidCash, plan) {
    if (plan && plan.fromDossier) return plan.swap;
    return computeUpgradeSwap(ownedMap, raw, liquidCash, plan);
  }

  // The planner's capital: cash + every swing position net of the sell fee + the
  // faction armoury — the figure the next-block rule measures "affordable" against.
  function planCapital(ownedMap, raw) {
    var sw = 0;
    Object.keys(ownedMap || {}).forEach(function(sym) {
      var o = ownedMap[sym];
      if (!o || !(o.swing_shares > 0)) return;
      var le = raw ? raw.find(function(x) { return x.stock === sym; }) : null;
      if (le) sw += (parseFloat(le.price) || 0) * o.swing_shares * SELL_FEE;
    });
    return (lastCashBalance || 0) + sw + (lastArmoryFunds || 0);
  }

  // Target + bridgebuilder chain — shared by the ROI Planner and the Quick
  // Trade bridge pill so both always agree on the target and on bridgeChain.
  // Logic extracted 1:1 from renderROIPlanner; chain entries additionally
  // carry tierInfo (sharesNeeded/livePrice) for the pill's click handler.
  function computeBridgePlan(ownedMap, raw, totalCapital, weeklyIncome, roadmapRows) {
    // Build dynamic next tier list for all 35 stocks with benefit data
    var benefitSyms = Object.keys(BENEFIT_REQ);
    var dynamicNextTiers = [];
    benefitSyms.forEach(function(sym) {
      var tierInfo = calcNextTier(sym, ownedMap, raw);
      if (!tierInfo || tierInfo.cost <= 0) return;
      // Find payout data from ROI_MAP for this next increment
      var payoutEntry = ROI_MAP[sym + "|T" + tierInfo.nextIncrement] || null;
      // If no ROI_MAP entry — passive stock, skip (no sellable payout)
      // ROI uses the LIVE per-cycle payout (getPerCycle) and Torn's own cycle length
      // (getCycleDays) - the same two inputs computeRoadmap, the upgrade swap and the
      // planner's sell candidates now use, so every view ranks a tier identically.
      var npCycle = getPerCycle(payoutEntry);
      dynamicNextTiers.push({
        sym: sym,
        tierInfo: tierInfo,
        payoutEntry: payoutEntry,
        cost: tierInfo.cost,
        roi: payoutEntry ? (npCycle / tierInfo.cost * (365 / getCycleDays(payoutEntry, ownedMap)) * 100) : 0
      });
    });

    // Sort by ROI descending, filter out skipped (symbol-level) and any next tier
    // that sits ABOVE the user's tier cap (don't recommend a buy that would
    // immediately fall to swing).
    dynamicNextTiers = dynamicNextTiers.filter(function(e) {
      if (roiSymSkipped(e.sym)) return false;
      return e.tierInfo.nextIncrement <= roiSymTierCap(e.sym);
    });
    // ROI descending, then symbol alphabetically - one candidate per symbol, so the
    // symbol key makes the order fully deterministic instead of ownedMap key order.
    dynamicNextTiers.sort(function(a, b) {
      return (b.roi - a.roi) || a.sym.localeCompare(b.sym);
    });

    // Target = the next-block rule (2.56.0, Dossier's rule): buy now → via a sale →
    // the closest block → the biggest-income goal. dynamicNextTiers (best ROI per
    // symbol) stays the upgrade swap's buy list.
    var rmRows = roadmapRows || computeRoadmap(ownedMap, raw);
    var answer = pickNextBlock(ownedMap, raw, totalCapital, weeklyIncome, rmRows);
    var target = blockTarget(answer.row, ownedMap, raw);

    // Capital actually deployable toward the target. A stock's own swing value
    // can't fund building THAT stock's benefit block — selling those shares
    // shrinks the very block being completed — so the target's own swing is
    // excluded from every affordability/days calculation below (and from the
    // renderer's verdict, which reads plan.fundCapital). Mirrors the swing
    // valuation in renderROIPlanner (livePrice × swing_shares net of 0.1% fee).
    var ownTargetSwing = target ? symSwingValue(target.sym, ownedMap, raw) : 0;
    // A "buy now" answer is measured against the whole capital, as Dossier's is.
    var fundCapital = answer.kind === "buy" ? totalCapital : Math.max(0, totalCapital - ownTargetSwing);

    // Bridgebuilder chain (sell-later model): a bridge is a benefit tier you buy
    // (or drip into via the pills), hold to collect dividends, then SELL again to
    // help fund the goal. The capital is recovered on sale, so it does NOT
    // permanently reduce your capital — only Torn's 0.1% sell fee is lost (at live
    // price, which already reflects any profit/loss on the position). The days saved
    // therefore come purely from the extra dividend income while held.
    //
    // ITS GOAL IS *NOT* `target`, AND THAT IS THE WHOLE FIX (2026-08-25).
    // `target` was then the best-ROI next increment (since 2.56.0 it is the next-block
    // rule's pick, see pickNextBlock; the chain's own goal is unchanged). ROI falls strictly with tier
    // inside one symbol, so the best-ROI open row is ALWAYS the next increment of the
    // best symbol — a goal one buy away. daysToAfford then returned 0, every
    // candidate scored saved <= 0, and this chain came back EMPTY every single time.
    // The owner reported exactly that on 2026-08-25 and it was not a data problem.
    //
    // So the chain now aims at its own goal: the highest-INCOME open row he can
    // actually be inside within BRIDGE_HORIZON_DAYS. Two rules, both needed —
    // highest income alone picks a block years away and makes the whole roadmap read
    // as "you cannot get there", while affordability alone picks something trivial.
    // Mirrors app/signals.py's sibling engine in the dashboard, which is the ground
    // truth for this maths; the departures from the OLD TSA behaviour are deliberate:
    //   * a step is judged against capital minus its OWN swing (no share counts
    //     twice — the rule computeFastestPath already applies);
    //   * the goal's whole SYMBOL is excluded, not just its tier: in a sell-later
    //     model those shares are the very ones the goal is missing;
    //   * the best bridge is the one that SAVES THE MOST DAYS, not the first in ROI
    //     order — saving days is the entire purpose of the feature.
    var BRIDGE_HORIZON_DAYS = 90;
    var bridgeChain = [];
    var daysBaseline = target ? (answer.days === null ? Infinity : answer.days) : 0;
    var openRows = rmRows.filter(function(r) {
      return !r.owned && !r.pending && r.cost > 0 && r.roi > 0;
    });
    // Capital a given row can actually be funded from: its own swing cannot pay for
    // its own block, because selling those shares shrinks the block being built.
    function capFor(sym) {
      return Math.max(0, totalCapital - symSwingValue(sym, ownedMap, raw));
    }
    var reachable = openRows.filter(function(r) {
      return daysToAfford(r.cost, capFor(r.sym), weeklyIncome) <= BRIDGE_HORIZON_DAYS;
    });
    // HIGHEST ABSOLUTE INCOME among those, same key computeFastestPath ranks on:
    // monthlyInc is built from dailyInc, which already sums every tier the buy
    // switches on, so goal and cost are priced off the same purchase.
    var bridgeGoal = reachable.slice().sort(function(a, b) {
      return (b.monthlyInc - a.monthlyInc) || a.sym.localeCompare(b.sym) || (a.tierNum - b.tierNum);
    })[0] || null;
    var bridgeBaselineDays = bridgeGoal
      ? daysToAfford(bridgeGoal.cost, capFor(bridgeGoal.sym), weeklyIncome) : 0;
    var bridgeDaysWith = bridgeBaselineDays;

    if (bridgeGoal) {
      var goalCap = capFor(bridgeGoal.sym);
      // Days to the goal if capital detours through `st` and is sold later to fund
      // it: only the fee is lost, the rest of the cost is recovered. null when the
      // step can never be reached at all — an infinite wait would poison the
      // arithmetic below (income/7 x Infinity is NaN, which compares false against
      // everything and would travel silently).
      function bridgeDays(st) {
        var stepCap = Math.max(0, goalCap - symSwingValue(st.sym, ownedMap, raw));
        var fee = st.cost * (1 - SELL_FEE);
        var boosted = weeklyIncome + st.dailyInc * 7;
        if (st.cost <= stepCap) {
          return { daysUntil: 0, days: daysToAfford(bridgeGoal.cost, stepCap - fee, boosted) };
        }
        var daysUntil = daysToAfford(st.cost, stepCap, weeklyIncome);
        if (daysUntil === Infinity) return null;
        var capAtBuy = stepCap + (weeklyIncome / 7 * daysUntil) - fee;
        return { daysUntil: daysUntil, days: daysUntil + daysToAfford(bridgeGoal.cost, capAtBuy, boosted) };
      }

      var candidates = [];
      openRows.forEach(function(st) {
        if (st.sym === bridgeGoal.sym) return;   // its own shares cannot bridge it
        var info = bridgeDays(st);
        if (!info) return;
        var saved = bridgeBaselineDays - info.days;
        if (!(saved > 0)) return;                // buys no time — not a bridge
        var le = raw ? raw.find(function(x) { return x.stock === st.sym; }) : null;
        candidates.push({
          sym: st.sym, tier: st.tier, cost: st.cost,
          extraIncome: st.dailyInc * 7, roi: st.roi,
          status: info.daysUntil === 0 ? "now" : "later",
          daysUntil: info.daysUntil, daysSaved: saved,
          // Shape the pill's click handler reads. sharesNeeded is the roadmap row's
          // own "still missing" count, so a click can never overshoot the tier.
          tierInfo: {
            nextIncrement: st.tierNum,
            sharesNeeded: st.sharesNeeded,
            livePrice: le ? (parseFloat(le.price) || 0) : 0
          }
        });
      });
      // Most days saved wins in each slot; ROI, symbol and tier break ties so the
      // order is fully determined rather than dependent on row order.
      candidates.sort(function(a, b) {
        return (b.daysSaved - a.daysSaved) || (b.roi - a.roi)
            || a.sym.localeCompare(b.sym) || a.tier.localeCompare(b.tier);
      });
      var nowBridge = null, nextBridge = null;
      candidates.forEach(function(b) {
        if (b.status === "now") { if (!nowBridge) nowBridge = b; }
        else if (!nextBridge) nextBridge = b;
      });
      // The affordable-now bridge is listed first even when the later one saves more:
      // its capital can start working today, and the drip target is what to aim at
      // afterwards.
      if (nowBridge) bridgeChain.push(nowBridge);
      if (nextBridge) bridgeChain.push(nextBridge);

      if (nowBridge) {
        bridgeDaysWith = daysToAfford(bridgeGoal.cost,
          goalCap - nowBridge.cost * (1 - SELL_FEE),
          weeklyIncome + nowBridge.extraIncome);
      }
    }

    return {
      dynamicNextTiers: dynamicNextTiers,
      target: target,
      answer: { kind: answer.kind, days: answer.days, viaSale: answer.viaSale },
      fundCapital: fundCapital,
      bridgeChain: bridgeChain,
      // `daysBaseline` belongs to `target` — it is the "Goal in ~Nd" line on the
      // Next-move block and nothing else. The chain no longer touches it, and the
      // old `daysWithBridges` companion is gone: it described a chain aimed at
      // `target`, which is exactly the arrangement that kept the panel empty.
      daysBaseline: daysBaseline,
      // The chain's OWN goal and its own day counts, kept separate for that reason.
      bridgeGoal: bridgeGoal,
      bridgeHorizonDays: BRIDGE_HORIZON_DAYS,
      bridgeBaselineDays: bridgeBaselineDays,
      bridgeDaysWith: bridgeDaysWith
    };
  }

  // Upgrade swap — shared by the ROI Planner line and the Quick Trade pill so both
  // always agree. Finds the best "sell one or more worse-ROI owned benefit tiers → buy
  // a strictly-better-ROI next tier" plan: it sells the LOWEST-ROI tiers first and only
  // as many as needed to afford the buy, requiring total weekly income to still rise.
  // Buy candidates are reused from plan.dynamicNextTiers (skip/cap-filtered, ROI-ranked).
  // Returns { sells:[...], buy, netWeekly, leftoverCash } or null. NOTE: the sells are
  // deliberate, user-initiated benefit-share sales — the Quick Trade pill bypasses
  // Benefit Lock for them (labelled explicitly) and fires one POST per click only.
  // `liquidCash` must be ON-HAND cash only (NOT swing/armory paper value): the pill funds
  // the buy from on-hand cash + the sale proceeds, so swing/armory aren't deployable.
  function computeUpgradeSwap(ownedMap, raw, liquidCash, plan) {
    if (!plan || !plan.dynamicNextTiers || plan.dynamicNextTiers.length === 0) return null;
    ownedMap = ownedMap || {};

    var sellUnits = computeSellUnits(ownedMap, raw);
    if (sellUnits.length === 0) return null;

    var best = null;
    plan.dynamicNextTiers.forEach(function(b) {
      if (!b.payoutEntry || b.cost <= 0 || !b.tierInfo) return;
      var bPerCycle = getPerCycle(b.payoutEntry);
      var buyWeekly = bPerCycle ? bPerCycle / getCycleDays(b.payoutEntry, ownedMap) * 7 : 0;
      if (buyWeekly <= 0) return;
      if (liquidCash >= b.cost) return; // affordable with cash alone — no sell needed, not an upgrade swap
      // Accumulate lowest-ROI sell units until on-hand cash + proceeds cover the buy.
      // Skip the buy's own symbol; stop the moment a unit's ROI reaches the buy's — we
      // never give up a block as good as the one we're buying, and (list is ascending)
      // every later unit is worse-ROI too. Record only when income still rises.
      var cumProceeds = 0, cumWeekly = 0, sells = [];
      for (var i = 0; i < sellUnits.length; i++) {
        var u = sellUnits[i];
        if (u.sym === b.sym) continue;
        if (b.roi <= u.roi) break;
        sells.push(u); cumProceeds += u.saleValue; cumWeekly += u.weekly;
        if (liquidCash + cumProceeds >= b.cost) {
          var netWeekly = buyWeekly - cumWeekly;
          if (netWeekly > 0 && (!best || netWeekly > best.netWeekly)) {
            best = {
              sells: sells.map(function(s){ return { sym: s.sym, tier: s.tier, roi: s.roi, shares: s.shares, saleValue: s.saleValue, weekly: s.weekly }; }),
              buy: { sym: b.sym, tier: "T" + b.tierInfo.nextIncrement, roi: b.roi, cost: b.cost, shares: b.tierInfo.sharesNeeded, tierInfo: b.tierInfo },
              netWeekly: netWeekly,
              leftoverCash: liquidCash + cumProceeds - b.cost
            };
          }
          break; // affordable — never sell more than needed
        }
      }
    });
    return best;
  }

  function renderROIPlanner(ownedMap, raw, cashBalance, armoryFunds) {
    // From-zero support: planner works with no owned benefit blocks — capital
    // comes from cash + armory, income starts at 0 and bootstraps via buys.
    ownedMap = ownedMap || {};
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
      // Net of Torn's 0.1% sell fee — this is the cash actually deployable if
      // the swing position is liquidated to fund a benefit purchase. Live price
      // already reflects current profit/loss vs the original investment.
      var val = livePrice * o.swing_shares * SELL_FEE;
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

    // Target + bridgebuilder chain via the shared computation (also used by
    // the Quick Trade bridge pill, so both views always agree). Licence mode:
    // Dossier's answer, never a local one.
    var plan = benefitPlan(ownedMap, raw, totalCapital, weeklyIncome);
    var dynamicNextTiers = plan.dynamicNextTiers;
    var target = plan.target;
    var nextEntries = target ? [target] : [];
    var bridgeChain = plan.bridgeChain;
    var fundCapital = plan.fundCapital; // deployable toward target (excl. its own swing)
    var daysWait = plan.daysBaseline;

    if (target && !plan.fromDossier) {
      // Sell candidates: owned benefit blocks with lower ROI than target
      // ROI of target
      var targetRoi = target.roi || 0;
      var sellCandidates = [];
      ownedEntries.forEach(function(e) {
        var sPerCycle = getPerCycle(e);
        var sCycleDays = getCycleDays(e, ownedMap);
        var weekly = sPerCycle ? sPerCycle / sCycleDays * 7 : 0;
        var liveEntry = raw ? raw.find(function(x) { return x.stock === e.sym; }) : null;
        var livePrice = liveEntry ? (parseFloat(liveEntry.price) || 0) : 0;
        var req = BENEFIT_REQ[e.sym] || 0;
        // Use this entry's specific tier number, not the overall increment
        var entryTierNum = parseInt(e.tier.replace("T",""), 10) || 0;
        // Shares belonging to THIS tier only: (2^n - 2^(n-1)) * BENEFIT_REQ
        var tierShares = entryTierNum > 0 ? (Math.pow(2, entryTierNum) - Math.pow(2, entryTierNum - 1)) * req : 0;
        var saleValue = tierShares * livePrice * SELL_FEE;
        // Live cost of this tier's shares
        var liveTierCost = tierShares * livePrice;
        // Same LIVE per-cycle payout as the buy side (getPerCycle) over this tier's own
        // parcel at live price - the cash a sale of this block actually returns.
        var entryRoi = (liveTierCost > 0 && sPerCycle) ? (sPerCycle / liveTierCost * (365 / sCycleDays) * 100) : 0;
        if (entryRoi > 0 && entryRoi < targetRoi && saleValue > 0) {
          sellCandidates.push({
            sym: e.sym,
            tier: e.tier,
            tierNum: entryTierNum,
            roi: entryRoi,
            saleValue: saleValue,
            weekly: weekly
          });
        }
      });
      // Lowest ROI first, then symbol alphabetically, then tier - deterministic
      // instead of ROI_TABLE insertion order.
      sellCandidates.sort(function(a, b) {
        return (a.roi - b.roi) || a.sym.localeCompare(b.sym) || (a.tierNum - b.tierNum);
      });
    }

    // Build HTML
    // Every value is a --tsa-* token, so the theme branch that used to live here is
    // gone: the tokens themselves switch on #tsa-overlay.tsa-dark. This markup is
    // rendered inside the overlay, so var() always resolves.
    var c = {
      bg:"var(--tsa-bg)", border:"var(--tsa-border)", bg2:"var(--tsa-bg-raised)", bg3:"var(--tsa-bg-bar)",
      text:"var(--tsa-fg)", muted:"var(--tsa-fg-faint)", mono:"var(--tsa-mono)",
      blue:"var(--tsa-accent)", green:"var(--tsa-pos)", red:"var(--tsa-neg)", yellow:"var(--tsa-warn)",
      owned_bg:"var(--tsa-pos-bg)", owned_border:"var(--tsa-pos-border)",
      next_bg:"var(--tsa-accent-bg)", next_border:"var(--tsa-accent-border)",
      skip_bg:"var(--tsa-neg-bg)", skip_border:"var(--tsa-neg-border)",
      neutral:"var(--tsa-fg-faint)", row_border:"var(--tsa-border)", divider:"var(--tsa-border)",
      tag_bg:"var(--tsa-accent-bg)", tag_border:"var(--tsa-accent-border)", tag_text:"var(--tsa-accent)",
      bridge_bg:"var(--tsa-bridge-bg)", bridge_border:"var(--tsa-bridge-border)", bridge:"var(--tsa-bridge)"
    };

    var s = 'font-family:' + c.mono + ';';

    // Capital bar — show EVERY position that is counted in totalCapital
    // (incl. ROI-skipped stocks, whose whole position counts as swing), so
    // the tag breakdown always reconciles with the Available capital sum.
    swingDetails.sort(function(a, b) { return b.val - a.val; });
    var swingTagsHtml = swingDetails.map(function(d){
      return '<span style="font-size:var(--tsa-fs-micro);padding:2px 6px;border-radius:var(--tsa-r-3);background:' + c.tag_bg + ';border:1px solid ' + c.tag_border + ';color:' + c.tag_text + ';' + s + 'margin-right:4px">' + d.sym + ' ' + fmRoi(d.val) + '</span>';
    }).join('');
    if (armoryFunds > 0) {
      swingTagsHtml = '<span style="font-size:var(--tsa-fs-micro);padding:2px 6px;border-radius:var(--tsa-r-3);background:' + c.tag_bg + ';border:1px solid ' + c.tag_border + ';color:' + c.tag_text + ';' + s + 'margin-right:4px">Armory ' + fmRoi(armoryFunds) + '</span>' + swingTagsHtml;
    }
    if (cashBalance > 0) {
      swingTagsHtml = '<span style="font-size:var(--tsa-fs-micro);padding:2px 6px;border-radius:var(--tsa-r-3);background:' + c.tag_bg + ';border:1px solid ' + c.tag_border + ';color:' + c.tag_text + ';' + s + 'margin-right:4px">Cash ' + fmRoi(cashBalance) + '</span>' + swingTagsHtml;
    }

    var html = '<div style="padding:8px 14px;border-bottom:1px solid ' + c.divider + ';background:' + c.bg2 + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
        '<span style="font-size:var(--tsa-fs-micro);letter-spacing:0.1em;color:' + c.muted + ';text-transform:uppercase">Available capital</span>' +
        '<span style="font-size:var(--tsa-fs-micro);' + s + 'color:' + (benefitTablesDerived ? c.green : c.yellow) + '">v' + TSA_VERSION + ' · ' + benefitTableStatus + '</span>' +
      '</div>' +
      '<div style="' + s + 'font-size:var(--tsa-fs-body);font-weight:700;color:' + c.text + '">' + fmRoi(totalCapital) + '</div>' +
      '<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px">' + swingTagsHtml + '</div>' +
      '</div>';

    // Next move section
    if (target) {
      var nmRow = function(label, val, color) {
        return '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">' +
          '<span style="font-size:var(--tsa-fs-micro);color:' + c.muted + ';text-transform:uppercase;letter-spacing:0.08em;' + s + '">' + label + '</span>' +
          '<span style="font-size:var(--tsa-fs-micro);color:' + (color||c.text) + ';' + s + ';text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%">' + val + '</span>' +
          '</div>';
      };

      html += '<div style="padding:10px 14px;border-bottom:2px solid ' + c.divider + ';background:' + c.bg3 + '">';
      html += '<div style="font-size:var(--tsa-fs-micro);letter-spacing:0.12em;text-transform:uppercase;color:' + c.blue + ';' + s + ';font-weight:700;margin-bottom:8px">💡 Next move</div>';

      // Target — affordability is judged against plan.fundCapital (totalCapital
      // minus the target stock's own swing value), since selling the target stock
      // to fund its own benefit block shrinks the very block being completed.
      var shortBy = Math.max(0, target.cost - fundCapital);
      var targetTier = target.tier || ("T" + target.tierInfo.nextIncrement);
      var ans = plan.answer || {};
      if (ans.kind === "buy" || ans.kind === "viaSale") shortBy = 0;
      html += nmRow("Target", target.sym + " " + targetTier + " · " + (target.roi || 0).toFixed(2) + "% ROI", c.blue);
      html += nmRow("Why", nextBlockWhy(ans), ans.kind === "buy" || ans.kind === "viaSale" ? c.green : c.text);
      if (plan.fromDossier) html += nmRow("Source", "Dossier Benefit Advisor", c.muted);
      html += nmRow("Payback", target.roi > 0 ? Math.round(36500 / target.roi).toLocaleString("en-US") + " days" : "—");
      html += nmRow("Cost", fmRoi(target.cost) + (shortBy > 0 ? " · short " + fmRoi(shortBy) : " ✓"), shortBy > 0 ? c.red : c.green);
      html += nmRow("Available", fmRoi(fundCapital), c.text);

      // Bridgebuilder chain — buy (or drip into) a tier, collect dividends, then
      // sell it again to help fund the BRIDGE GOAL. Each row saves days vs. waiting.
      //
      // THE GOAL NAMED HERE IS NOT "Next move" ABOVE, and the line below says so
      // rather than leaving two different day counts on one panel to read as a
      // contradiction. "Next move" is the next-block rule's pick; this chain aims at
      // the biggest income reachable inside the horizon — see computeBridgePlan.
      html += '<div style="border-top:1px solid ' + c.divider + ';margin:6px 0"></div>';
      html += '<div style="font-size:var(--tsa-fs-micro);color:var(--tsa-bridge);letter-spacing:0.08em;' + s + ';margin-bottom:5px">🔗 Bridgebuilder · sell later for goal</div>';

      var hasSell = sellCandidates && sellCandidates.length > 0;
      var bGoal = plan.bridgeGoal;

      if (bGoal) {
        html += nmRow(
          "Goal · " + bGoal.sym + " " + bGoal.tier,
          fmRoi(bGoal.cost) + " · +" + fmRoi(bGoal.dailyInc * 7) + "/7d · ~" + plan.bridgeBaselineDays + "d",
          c.text
        );
      }

      if (bridgeChain.length > 0) {
        bridgeChain.forEach(function(b) {
          var statusColor = b.status === "now" ? c.green : c.muted;
          var statusLabel = b.status === "now"
            ? "✓ Buy now · saves " + b.daysSaved + "d"
            : "drip ~" + b.daysUntil + "d · saves " + b.daysSaved + "d";
          var roiStr = b.roi > 0 ? " · " + b.roi.toFixed(1) + "%" : "";
          html += nmRow(
            "🔗 " + b.sym + " " + b.tier + roiStr,
            fmRoi(b.cost) + " · +" + fmRoi(b.extraIncome) + "/7d · " + statusLabel,
            statusColor
          );
        });
        var savedDays = plan.bridgeBaselineDays - plan.bridgeDaysWith;
        if (savedDays > 0) {
          html += nmRow(
            "Goal with bridges",
            "~" + plan.bridgeDaysWith + "d (saves " + savedDays + "d)",
            c.green
          );
        }
      } else if (!bGoal) {
        // Distinguish "nothing to aim at" from "nothing shortens the wait" — they are
        // different facts and the fix for each is different.
        html += nmRow("", "No block is reachable within " + plan.bridgeHorizonDays + "d", c.muted);
      } else {
        html += nmRow("", "No bridgebuilder options", c.muted);
      }

      if (hasSell) {
        html += '<div style="margin:4px 0;border-top:1px dashed ' + c.divider + '"></div>';
        html += '<div style="font-size:var(--tsa-fs-micro);color:var(--tsa-fg-muted);letter-spacing:0.08em;' + s + ';margin-bottom:5px">💸 Alt: Sell lower ROI blocks</div>';
        var cumulativeSale = 0;
        var cumulativeLostIncome = 0;
        sellCandidates.slice(0, 4).forEach(function(sc) {
          cumulativeSale += sc.saleValue;
          cumulativeLostIncome += sc.weekly;
          var daysIfSold = daysToAfford(target.cost - cumulativeSale, fundCapital, weeklyIncome - cumulativeLostIncome);
          html += nmRow("Sell " + sc.sym + " " + sc.tier + " · " + sc.roi.toFixed(1) + "%", fmRoi(sc.saleValue) + " → ~" + daysIfSold + "d", c.muted);
        });
      }

      // ⤴ Upgrade — best plan to sell one or more worse-ROI owned tiers (lowest ROI
      // first, only as many as needed) and buy a strictly-better tier, for the largest
      // net weekly income gain. Shares the computeUpgradeSwap plan with the Quick Trade
      // pill so the two always agree. On-hand cash only (not totalCapital) — the swap is
      // executed via the pill from cash + sale proceeds, so swing/armory aren't usable.
      var upSwap = benefitSwap(ownedMap, raw, cashBalance, plan);
      if (upSwap) {
        var upSellLabel = upSwap.sells.map(function(sc){ return sc.sym + " " + sc.tier; }).join(" + ");
        html += '<div style="border-top:1px solid ' + c.divider + ';margin:6px 0"></div>';
        html += '<div style="font-size:var(--tsa-fs-micro);color:var(--tsa-swap);letter-spacing:0.08em;' + s + ';margin-bottom:5px">⤴ Upgrade · swap to better ROI'
          + (upSwap.sells.length > 1 ? " (" + upSwap.sells.length + " blocks)" : "") + '</div>';
        html += nmRow(
          "Sell " + upSellLabel + " → " + upSwap.buy.sym + " " + upSwap.buy.tier + " (" + upSwap.buy.roi.toFixed(1) + "%)",
          "+" + fmRoi(upSwap.netWeekly) + "/7d",
          c.green
        );
        html += nmRow("Net cash after swap", fmRoi(upSwap.leftoverCash), c.muted);
      }

      // Alt: Wait
      html += '<div style="border-top:1px solid ' + c.divider + ';margin:6px 0"></div>';
      html += '<div style="font-size:var(--tsa-fs-micro);color:var(--tsa-fg-muted);letter-spacing:0.08em;' + s + ';margin-bottom:5px">⏱ Alt: Wait</div>';
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
          stockWeekly += getPerCycle(entry) / getCycleDays(entry, ownedMap) * 7;
          if (entry.item) itemName = getItemName(entry.item) || itemName;
        });
        if (stockWeekly > 0) {
          incomeBreakdown.push(incomeBreakdownHtml(sym, itemName, fmRoi(stockWeekly)));
        }
      });
      if (incomeBreakdown.length > 0) {
        html += nmRow("Breakdown", incomeBreakdown.slice(0,3).join(" · "));
        if (incomeBreakdown.length > 3) html += nmRow("", incomeBreakdown.slice(3,6).join(" · "));
      }
      html += nmRow("Goal in", daysWait === 0 ? "Now!" : daysWait === Infinity ? "N/A" : "~" + daysWait + " days", c.text);
      html += '</div>';
    } else if (plan.fromDossier && plan.status) {
      // Licence mode and Dossier named no block: say why. No local pick instead.
      html += '<div style="padding:10px 14px;border-bottom:2px solid ' + c.divider + ';background:' + c.bg3 + '">' +
        '<div style="font-size:var(--tsa-fs-micro);letter-spacing:0.12em;text-transform:uppercase;color:' + c.blue + ';' + s + ';font-weight:700;margin-bottom:6px">💡 Next move</div>' +
        '<div style="font-size:var(--tsa-fs-micro);color:' + c.muted + ';line-height:1.5">' + escHtml(plan.status) +
        ' With a TSA licence, the recommendation comes from Dossier only.</div></div>';
    }

    // Hidden stocks dropdown
    if (roiSkipped.length > 0) {
      html += '<div id="tsa-hidden-stocks-bar" style="border-bottom:1px solid ' + c.divider + ';background:' + c.bg2 + '">' +
        '<button id="tsa-hidden-stocks-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:7px 14px;background:none;border:none;cursor:pointer;font-family:' + c.mono + '">' +
          '<span style="font-size:var(--tsa-fs-micro);color:' + c.red + ';font-weight:600;letter-spacing:0.06em;text-transform:uppercase">Hidden &amp; unlocked (' + roiSkipped.length + ')</span>' +
          '<span id="tsa-hidden-stocks-caret" style="font-size:var(--tsa-fs-micro);color:' + c.muted + '">▶</span>' +
        '</button>' +
        '<div id="tsa-hidden-stocks-list" style="display:none">' +
          roiSkipped.map(function(sym) {
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 14px;border-top:1px solid ' + c.divider + '">' +
              '<span style="' + s + ';font-size:var(--tsa-fs-micro);font-weight:700;color:' + c.red + '">' + sym + '</span>' +
              '<button class="tsa-roi-skip" data-key="' + sym + '" data-owned="0" title="Restore — show in planner &amp; re-lock benefit shares" style="width:28px;height:28px;border-radius:var(--tsa-r-circle);border:1px solid ' + c.divider + ';background:none;cursor:pointer;font-size:var(--tsa-fs-micro);color:' + c.muted + ';display:flex;align-items:center;justify-content:center">↩</button>' +
            '</div>';
          }).join("") +
        '</div>' +
      '</div>';
    }

    // Tier-cap controls — dropdown of all 35 stocks + cap input, then a
    // collapsible list of stocks that currently have a cap. A cap keeps tiers
    // 1..N as benefit blocks and releases every share above tier N to swing.
    var capSyms = Object.keys(roiTierCap).filter(function(k) { return roiSymTierCap(k) !== Infinity; }).sort();
    var stockOpts = STOCKS_LIST.map(function(sl) {
      var sym = sl.toUpperCase();
      return '<option value="' + sym + '">' + sym + '</option>';
    }).join("");
    html += '<div style="padding:8px 14px;border-bottom:1px solid ' + c.divider + ';background:' + c.bg2 + '">' +
      '<div style="font-size:var(--tsa-fs-micro);letter-spacing:0.1em;color:' + c.muted + ';text-transform:uppercase;margin-bottom:5px">Tier cap · shares above tier N → swing</div>' +
      '<div style="display:flex;gap:6px;align-items:center">' +
        '<select id="tsa-tiercap-sym" style="flex:1;min-width:0;font-size:var(--tsa-fs-micro);padding:5px 6px;border-radius:var(--tsa-r-2);border:1px solid ' + c.border + ';background:' + c.bg + ';color:' + c.text + ';' + s + '">' + stockOpts + '</select>' +
        '<input id="tsa-tiercap-n" type="number" min="0" step="1" placeholder="N" style="width:52px;font-size:var(--tsa-fs-micro);padding:5px 6px;border-radius:var(--tsa-r-2);border:1px solid ' + c.border + ';background:' + c.bg + ';color:' + c.text + ';' + s + '">' +
        '<button id="tsa-tiercap-set" style="font-size:var(--tsa-fs-micro);font-weight:700;padding:5px 12px;border-radius:var(--tsa-r-2);border:none;background:' + c.blue + ';color:var(--tsa-on-accent);cursor:pointer;' + s + '">Set</button>' +
      '</div>';
    if (capSyms.length > 0) {
      html += '<div style="margin-top:6px;border:1px solid ' + c.divider + ';border-radius:var(--tsa-r-2);overflow:hidden">' +
        '<button id="tsa-tiercap-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:none;border:none;cursor:pointer;font-family:' + c.mono + '">' +
          '<span style="font-size:var(--tsa-fs-micro);color:' + c.blue + ';font-weight:600;letter-spacing:0.06em;text-transform:uppercase">Tier-capped (' + capSyms.length + ')</span>' +
          '<span id="tsa-tiercap-caret" style="font-size:var(--tsa-fs-micro);color:' + c.muted + '">▶</span>' +
        '</button>' +
        '<div id="tsa-tiercap-list" style="display:none">' +
          capSyms.map(function(sym) {
            return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-top:1px solid ' + c.divider + '">' +
              '<span style="' + s + ';font-size:var(--tsa-fs-micro);font-weight:700;color:' + c.text + '">' + sym + ' <span style="font-size:var(--tsa-fs-micro);color:' + c.muted + ';font-weight:400">· cap T' + roiTierCap[sym] + '</span></span>' +
              '<button class="tsa-tiercap-del" data-sym="' + sym + '" title="Remove cap — restore full benefit-block treatment" style="width:26px;height:26px;border-radius:var(--tsa-r-circle);border:1px solid ' + c.divider + ';background:none;cursor:pointer;font-size:var(--tsa-fs-micro);color:' + c.muted + ';display:flex;align-items:center;justify-content:center">✕</button>' +
            '</div>';
          }).join("") +
        '</div>' +
      '</div>';
    }
    html += '</div>';

    // Table header
    html += '<div style="display:grid;grid-template-columns:50px 34px 1fr 54px 32px;overflow:hidden;gap:4px;padding:5px 14px;font-size:var(--tsa-fs-micro);letter-spacing:0.1em;color:' + c.muted + ';text-transform:uppercase;border-bottom:1px solid ' + c.divider + ';' + s + ';position:sticky;top:0;background:' + c.bg + ';z-index:2;">' +
      '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">Stock</span><span style="min-width:0;overflow:hidden">Tier</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">Needed / Cost</span><span style="text-align:right">ROI</span><span></span></div>';


    // Show all benefit stocks: owned tiers first (green), then next tiers sorted by ROI
    var tableRows = [];
    // Add owned entries
    ownedEntries.forEach(function(e) {
      var o = ownedMap[e.sym];
      // Days remaining = frequency - progress (both already stored from API)
      var freq = getCycleDays(e, ownedMap);
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
        freq: e.payoutEntry ? getCycleDays(e.payoutEntry, ownedMap) : 7,
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
      var paybackDays = (!row.isOwned && row.roi > 0) ? Math.round(36500 / row.roi) : 0;
      var costLine = row.isOwned ? "Owned" :
        row.sharesNeeded.toLocaleString("en-US") + " shares · " + fmRoi(row.cost) +
        (paybackDays > 0 ? " · pb " + paybackDays.toLocaleString("en-US") + "d" : "");
      var skipBtnStyle = 'width:28px;height:28px;border-radius:var(--tsa-r-circle);border:1px solid ' + c.divider + ';background:none;cursor:pointer;font-size:var(--tsa-fs-micro);color:' + c.muted + ';display:flex;align-items:center;justify-content:center;justify-self:center;' + (row.isOwned ? 'opacity:0.2;pointer-events:none;' : '');
      var skipLabel = row.isSkipped ? "↩" : "✕";
      var skipTitle = row.isSkipped
        ? "Restore — show in planner &amp; re-lock benefit shares"
        : "Skip — hide from planner &amp; unlock shares for selling (Benefit Lock off for this stock)";
      var key = row.key || (row.sym + row.tier);

      var buyAttrs = (!row.isOwned && row.sharesNeeded > 0)
        ? ' class="tsa-roi-buyrow" data-buy-sym="' + row.sym + '" data-buy-shares="' + row.sharesNeeded + '" data-buy-tier="' + row.tier + '" data-buy-state="0"'
        : '';
      html += '<div data-roi-key="' + key + '"' + buyAttrs + ' style="display:grid;grid-template-columns:50px 34px 1fr 54px 32px;overflow:hidden;gap:4px;align-items:center;padding:7px 14px;border-bottom:1px solid ' + c.row_border + ';background:' + rowBg + ';border-left:2px solid ' + borderLeft + ';cursor:' + (buyAttrs ? 'pointer' : 'default') + ';transition:background 0.15s">' +
        '<span style="' + s + ';font-weight:700;font-size:var(--tsa-fs-micro);color:' + symColor + '">' + row.sym + '</span>' +
        '<span style="' + s + ';font-size:var(--tsa-fs-micro);color:' + c.muted + '">' + row.tier + '</span>' +
        '<div style="display:flex;flex-direction:column;gap:1px;overflow:hidden;min-width:0">' +
          '<span style="' + s + ';font-size:var(--tsa-fs-micro);color:' + c.muted + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + costLine + (nextPayoutStr ? '<span style="color:' + nextPayoutColor + '">' + nextPayoutStr + '</span>' : '') + '</span>' +
          '<span style="font-size:var(--tsa-fs-micro);color:' + c.muted + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + fmRoi(row.payout) + " / " + row.freq + "d" + (itemVal > 0 ? " · live " + fmRoi(itemVal) : "") + "</span>" +
        '</div>' +
        '<span style="' + s + ';font-size:var(--tsa-fs-micro);font-weight:700;text-align:right;color:' + symColor + '">' + roiPct + '</span>' +
        '<button class="tsa-roi-skip" data-key="' + key + '" data-owned="' + (row.isOwned?1:0) + '" title="' + skipTitle + '" style="' + skipBtnStyle + '">' + skipLabel + '</button>' +
        '</div>';
    });

    // Full snowball roadmap (collapsible). Ranked by TIME TO THE BIGGEST BLOCK — the
    // goal is the highest absolute income still open, not the best ROI and not the
    // shortest payback — see computeFastestPath. Buys that shorten the
    // time to the goal lead, in the order they shorten it most; every other tier
    // follows in payback order. Owned tiers flagged ✓; for unowned tiers a running
    // "cum" shows the capital needed to reach that rung buying in this order.
    var roadmap = computeRoadmap(ownedMap, raw);
    var fastest = plan.fromDossier ? plan.fastest : computeFastestPath(ownedMap, raw, totalCapital, weeklyIncome, roadmap);
    var rmStepMap = {};
    if (fastest) {
      fastest.steps.forEach(function(st, i) { rmStepMap[st.sym + "|" + st.tier] = { step: st, rank: i }; });
      // Array#sort is stable, so non-steps keep computeRoadmap's payback order.
      roadmap = roadmap.slice().sort(function(a, b) {
        var ra = rmStepMap[a.sym + "|" + a.tier], rb = rmStepMap[b.sym + "|" + b.tier];
        if (ra && rb) return ra.rank - rb.rank;
        if (ra) return -1;
        if (rb) return 1;
        return 0;
      });
    }
    var fmDays = function(v) { return (v === Infinity || v == null) ? "—" : Math.round(v).toLocaleString("en-US") + "d"; };
    // daysSaved is Infinity when the goal is unreachable by waiting but reachable via
    // this step - the strongest possible recommendation. fmDays would print "—" for it,
    // which reads as "saves nothing", so say what actually happened instead.
    // "−123d" read as a penalty next to a day count. Days saved are a GAIN, so
    // both call sites say it in words.
    var fmSaved = function(v) {
      if (v === Infinity) return "now reachable";
      return fmDays(v) + " sooner";
    };
    if (roadmap.length > 0) {
      var rmCum = 0;
      var rmSymSpent = {}; // highest per-symbol cost already counted into rmCum
      var rmRows = roadmap.map(function(r) {
        // payback is always finite: computeRoadmap drops any row with dailyInc <= 0,
        // so the old Infinity branch here could not be reached.
        var pbStr = r.payback.toLocaleString("en-US") + "d";
        // A pending tier is already paid for, so it is shown (the user should see it
        // is on its way) but it is NOT a step and contributes nothing to `cum`.
        var secured = r.owned || r.pending;
        var detail;
        if (secured) {
          detail = r.pending ? "⏳ pending — shares held, tier lands on next payout" : "✓ owned";
        } else {
          // r.cost is the shares still missing to REACH this tier, so consecutive
          // tiers of one stock overlap - adding them raw would double-count. Only the
          // increment over the highest tier of that stock already counted goes in.
          var spent = rmSymSpent[r.sym] || 0;
          rmCum += Math.max(0, r.cost - spent);
          rmSymSpent[r.sym] = Math.max(spent, r.cost);
          detail = fmRoi(r.cost) + " · cum " + fmRoi(rmCum);
        }
        var secColor = secured ? c.green : c.text;
        return '<div style="display:grid;grid-template-columns:50px 34px 1fr 60px;overflow:hidden;gap:4px;align-items:center;padding:6px 14px;border-bottom:1px solid ' + c.row_border + ';' + (secured ? 'background:' + c.owned_bg + ';' : '') + '">' +
          '<span style="' + s + ';font-weight:700;font-size:var(--tsa-fs-micro);color:' + secColor + '">' + r.sym + '</span>' +
          '<span style="' + s + ';font-size:var(--tsa-fs-micro);color:' + c.muted + '">' + r.tier + '</span>' +
          '<div style="display:flex;flex-direction:column;gap:1px;overflow:hidden;min-width:0">' +
            '<span style="' + s + ';font-size:var(--tsa-fs-micro);color:' + c.muted + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + detail + '</span>' +
            '<span style="font-size:var(--tsa-fs-micro);color:' + c.muted + '">ROI ' + r.roi.toFixed(2) + '%' +
              (rmStepMap[r.sym + "|" + r.tier] ? ' · goal in ' + fmDays(rmStepMap[r.sym + "|" + r.tier].step.days) + ' (' + fmSaved(rmStepMap[r.sym + "|" + r.tier].step.daysSaved) + ')' : '') + '</span>' +
          '</div>' +
          '<span style="' + s + ';font-size:var(--tsa-fs-micro);font-weight:700;text-align:right;color:' + (secured ? c.green : c.blue) + '">' + pbStr + '</span>' +
          '</div>';
      }).join("");
      html += '<div style="border-bottom:1px solid ' + c.divider + ';background:' + c.bg2 + '">' +
        '<button id="tsa-roadmap-toggle" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:none;border:none;cursor:pointer;font-family:' + c.mono + '">' +
          '<span style="font-size:var(--tsa-fs-micro);color:' + c.blue + ';font-weight:700;letter-spacing:0.08em;text-transform:uppercase">📋 Full snowball roadmap (' + roadmap.length + ')</span>' +
          '<span id="tsa-roadmap-caret" style="font-size:var(--tsa-fs-micro);color:' + c.muted + '">▶</span>' +
        '</button>' +
        '<div id="tsa-roadmap-list" style="display:none">' +
          (fastest ? '<div style="padding:6px 14px;border-bottom:1px solid ' + c.divider + ';font-size:var(--tsa-fs-micro);color:' + c.muted + ';' + s + ';line-height:1.5">' +
            'Goal ' + fastest.goal.sym + ' ' + fastest.goal.tier + ' · ' + fmRoi(fastest.goal.monthlyInc) + '/mo · ' + fmRoi(fastest.goal.cost) + ' · ROI ' + fastest.goal.roi.toFixed(2) + '%<br>' +
            'Wait only: ' + fmDays(fastest.baselineDays) +
            (fastest.best
              ? ' · via ' + fastest.best.sym + ' ' + fastest.best.tier + ': ' + fmDays(fastest.best.days) + ' (' + fmSaved(fastest.best.daysSaved) + ')'
              : ' · no affordable buy shortens it') +
            '</div>' : '') +
          '<div style="display:grid;grid-template-columns:50px 34px 1fr 60px;overflow:hidden;gap:4px;padding:5px 14px;font-size:var(--tsa-fs-micro);letter-spacing:0.1em;color:' + c.muted + ';text-transform:uppercase;border-bottom:1px solid ' + c.divider + ';' + s + '"><span>Stock</span><span>Tier</span><span>Cost / cumulative</span><span style="text-align:right">Payback</span></div>' +
          ((fastest && fastest.steps.length > 0)
            ? '<div style="padding:2px 14px 5px;font-size:var(--tsa-fs-micro);color:' + c.muted + ';' + s + '">Order: goal-shortening steps first, then payback</div>'
            : '') +
          rmRows +
        '</div>' +
      '</div>';
    }

    return html;
  }

  function showROIPlanner(ownedMap, raw, cacheOnly) {
    var content = document.getElementById("tsa-content");
    if (!content) return;
    content.style.background = "var(--tsa-bg)";
    content.style.color = "var(--tsa-fg)";
    content.innerHTML = '<div style="padding:20px;text-align:center;color:' + 'var(--tsa-fg-faint)' + ';font-size:var(--tsa-fs-micro)"><span class="tsa-spinner"></span>Loading...</div>';

    // Shared listener setup — used by both success and catch paths
    function attachListeners() {
      content.querySelectorAll(".tsa-roi-skip").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          if (btn.dataset.owned === "1") return;
          // Skip is symbol-level: strip any trailing tier so toggling one CBD
          // row skips/restores the whole stock. Idempotent on already-stripped
          // keys (Hidden-list restore buttons carry the bare symbol).
          var k = (btn.dataset.key || "").replace(/T\d+$/, "");
          if (!k) return;
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

      var roadmapBtn = content.querySelector("#tsa-roadmap-toggle");
      if (roadmapBtn) {
        roadmapBtn.addEventListener("click", function() {
          var list = content.querySelector("#tsa-roadmap-list");
          var caret = content.querySelector("#tsa-roadmap-caret");
          if (!list) return;
          var open = list.style.display !== "none";
          list.style.display = open ? "none" : "block";
          if (caret) caret.textContent = open ? "▶" : "▼";
        });
      }

      // Tier-cap controls
      var capSel = content.querySelector("#tsa-tiercap-sym");
      var capInput = content.querySelector("#tsa-tiercap-n");
      var capSetBtn = content.querySelector("#tsa-tiercap-set");
      if (capSel && capInput) {
        // Pre-fill the input with the selected stock's existing cap (if any).
        var syncCapInput = function() {
          var cur = roiTierCap[capSel.value];
          capInput.value = (cur === 0 || cur > 0) ? cur : "";
        };
        capSel.addEventListener("change", syncCapInput);
        syncCapInput();
      }
      if (capSetBtn) {
        capSetBtn.addEventListener("click", function() {
          if (!capSel) return;
          var sym = String(capSel.value || "").toUpperCase();
          var n = parseInt(capInput ? capInput.value : "", 10);
          if (!sym) return;
          if (isNaN(n) || n < 0) { showToast("Enter a tier cap of 0 or more", "warn"); return; }
          roiTierCap[sym] = n;
          saveRoiTierCap();
          // Recompute the benefit/swing split so the new cap takes effect
          // immediately (swing capital, benefit rows, QT lock) — not just at the
          // next full refresh. enrichOwnedMap ignores its raw arg.
          enrichOwnedMap(ownedMap, null);
          showToast(sym + " capped at T" + n + " — shares above go to swing", "success");
          showROIPlanner(ownedMap, raw);
        });
      }
      var capToggle = content.querySelector("#tsa-tiercap-toggle");
      if (capToggle) {
        capToggle.addEventListener("click", function() {
          var list = content.querySelector("#tsa-tiercap-list");
          var caret = content.querySelector("#tsa-tiercap-caret");
          if (!list) return;
          var open = list.style.display !== "none";
          list.style.display = open ? "none" : "block";
          if (caret) caret.textContent = open ? "▶" : "▼";
        });
      }
      content.querySelectorAll(".tsa-tiercap-del").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          var sym = String(btn.dataset.sym || "").toUpperCase();
          if (!sym || !Object.prototype.hasOwnProperty.call(roiTierCap, sym)) return;
          delete roiTierCap[sym];
          saveRoiTierCap();
          // Recompute so the restored stock re-enters the benefit-block split now.
          enrichOwnedMap(ownedMap, null);
          showROIPlanner(ownedMap, raw);
        });
      });

      content.querySelectorAll(".tsa-roi-buyrow").forEach(function(row) {
        row.addEventListener("click", function(e) {
          if (e.target.closest(".tsa-roi-skip")) return;
          var sym    = row.dataset.buySym;
          var shares = parseInt(row.dataset.buyShares, 10);
          var tier   = row.dataset.buyTier;
          qtBuildMaps();
          var price  = qtGetPrice(sym);
          var cash   = qtGetMoneyFast();
          // Never fire a full-tier buy blind: refuse when price or cash is
          // unreadable (matches the 💡 rec button / bank pill / qtVault).
          if (price <= 0) { showToast("Could not read price for " + sym, "error"); return; }
          if (cash <= 0) { showToast("No money found", "warn"); return; }
          // Tier buys must hit the exact share count to unlock the benefit
          // block — refuse rather than partial-buy wasted shares.
          if (shares * price > cash) {
            showToast("Need $" + (shares * price - cash).toLocaleString("en-US") + " more for " + sym + " " + tier, "warn");
            return;
          }
          qtUiTrade(sym, shares, "buyShares", "Bought " + shares.toLocaleString("en-US") + " " + sym + " (" + tier + ")");
        });
      });
    }

    function renderAndAttach(cashBalance, armoryFunds) {
      function paint() {
        content.innerHTML = renderROIPlanner(ownedMap, raw, cashBalance, armoryFunds);
        attachListeners();
        var footerDivider = "var(--tsa-border)";
        var footerBg      = "var(--tsa-bg)";
        content.insertAdjacentHTML("beforeend",
          '<div style="padding:7px 14px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid ' + footerDivider + ';background:' + footerBg + '">' +
            '<span style="font-size:var(--tsa-fs-micro);color:var(--tsa-fg-faint)">✕ skip + unlock &nbsp;·&nbsp; ↩ restore</span>' +
            '<span style="font-size:var(--tsa-fs-micro);color:var(--tsa-fg-faint);font-family:var(--tsa-mono)">' + benefitTableStatus + ' &nbsp;·&nbsp; ' + new Date().toLocaleTimeString("en-GB") + '</span>' +
          '</div>'
        );
      }
      if (cacheOnly) paint();
      else fetchAllItemPrices(paint);
    }

    if (cacheOnly) { renderAndAttach(lastCashBalance, lastArmoryFunds); return; }

    // Free mode (as in 2.50): cash and the armoury balance straight from Torn.
    if (dataMode !== "dossier") {
      if (!hasTornKey()) { renderAndAttach(0, 0); return; }
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
      return;
    }
    // Licence mode: cash and the armoury balance from /api/tsa/me — reused when the
    // load just fetched it (<60 s), so opening the planner right after a refresh is
    // free. Anything but a usable answer renders with 0 / 0, as a failed call always did.
    TSAData.get(licenseDeps, "me", ME_PLANNER_MAX_AGE_MS, function(res) {
      var me = (res.kind === "ok" && res.body && res.body.holdings_status === "ok") ? res.body
             : (res.fallback ? res.fallback.body : null);
      // Trades done here since Dossier's poll are paid for already: cash follows them.
      if (me) me = meWithTrades(me);
      var cashBalance = (me && typeof me.money_onhand === "number") ? me.money_onhand : 0;
      var armoryFunds = (me && me.armory && me.armory.ok) ? (me.armory.money_balance || 0) : 0;
      renderAndAttach(cashBalance, armoryFunds);
    });
  }

  function injectStyles() {
    var el = document.createElement("style");
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  function fetchJSON(url, retries) {
    if (retries === undefined) retries = 3;
    if (tsaSelfFetchBlocked(url)) return Promise.reject(new Error("Licence mode reads from Dossier only"));
    return new Promise(function(resolve, reject) {
      var attempt = function(n) {
        gmXhr({
          method: "GET", url: url,
          onload: function(r) {
            // HTTP-level errors (4xx/5xx) take the same retry path as
            // network/parse errors, so transient hiccups are retried instead
            // of an error body being accepted as data. Exception: a parseable
            // Torn-style {error: ...} body resolves, so the caller can map it
            // to a friendly message. (All gmXhr adapter paths supply r.status;
            // if it's ever missing, the check is false and we parse as before.)
            if (r.status >= 400) {
              var errBody = null;
              try { errBody = JSON.parse(r.responseText); } catch (_) { /* not JSON */ }
              if (errBody && errBody.error) { resolve(errBody); return; }
              if (n > 1) { setTimeout(function() { attempt(n - 1); }, 2000); }
              else reject(new Error("HTTP " + r.status + " after 3 attempts: " + url));
              return;
            }
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

      // Active (money/item) stocks expose the active increment under `dividend`;
      // passive perk stocks (WSU, IST, etc.) expose it under `benefit`. Read
      // whichever is present so passive benefit blocks are detected too.
      var bonus = s.dividend || s.benefit;
      var apiIncrement = (bonus && bonus.increment) || 0;
      // A holding is a PASSIVE perk when the API gives it no `dividend` object at
      // all (verified 2026-08-24: `dividend` exists only where the benefit type is
      // "active"). Passive perks are permanent — WSU's 10% education-time cut is
      // simply on — so their `benefit.frequency` is a static market attribute, NOT a
      // countdown. Flag them here so no view invents a "next payout in Xd" for a
      // benefit that never pays out. PASSIVE_STOCKS is the belt-and-braces check.
      var isPassivePerk = !s.dividend || PASSIVE_STOCKS.indexOf(acronym) >= 0;

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
        dividend_progress: (bonus && bonus.progress) || 0,
        dividend_frequency: (bonus && bonus.frequency) || 0,
        is_passive_perk: isPassivePerk,
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

      // ROI-skipped stocks are released from benefit-block treatment entirely:
      // the user opted them out via the planner's ✕ skip, so the WHOLE position
      // counts as swing (sellable) and no shares are held back as a benefit
      // block. benefit_shares/swing_shares here fold in the skip preference (not
      // just the Torn game mechanic) — this is what makes the sell pill show the
      // full position, drops the stock out of the benefit section, and keeps the
      // capital / scoring / Benefit Lock all consistent. Restore (un-skip)
      // recomputes the normal split on the next enrich run.
      if (roiSymSkipped(sym)) {
        o.benefit_shares = 0;
        o.swing_shares = totalShares;
        o.has_dividend = false;
        o.has_swing = totalShares > 0;
        return;
      }

      // FAIL-SAFE for a fulfilled passive perk block with NO increment reported.
      //
      // Torn omits the `dividend` object entirely for a passive perk but still reports
      // the increment under `benefit` (VERIFIED against the live API 2026-08-24, raw
      // response archived out of repo: WSU
      // returns `benefit:{ready:0,increment:1,progress:1,frequency:7}` on a fulfilled
      // holding). buildOwnedMap reads `s.dividend || s.benefit`, so the normal path
      // below already holds the block back — this guard only catches the day that
      // increment goes missing (Torn changes the field, or a proxy/PDA strips it),
      // which would otherwise dump a live perk block into sellable swing capital.
      // A fulfilled perk block can be worth many millions, and the planner would
      // happily spend it.
      //
      // FULFILMENT IS SHARES, NOTHING ELSE: `shares >= requirement`. Never `ready` or
      // `progress` — WSU reports ready:0/progress:1 while the perk is fully on (that
      // is day 1 of the 7-day cycle), so gating on either locks the wrong blocks.
      // Below the requirement there is no perk yet, so those shares stay ordinary
      // swing and keep their price signals. `roiSymSkipped` above and a tier cap of 0
      // still release the block — an explicit user opt-out wins over the fail-safe.
      if (increment <= 0 && PASSIVE_STOCKS.indexOf(sym) >= 0) {
        var passReq = BENEFIT_REQ[sym] || 0;
        if (passReq > 0 && totalShares >= passReq && roiSymTierCap(sym) >= 1) {
          o.benefit_shares = passReq;
          o.swing_shares = totalShares - passReq;
          o.has_dividend = true;
          o.has_swing = (totalShares - passReq) > 0;
          return;
        }
      }

      if (increment <= 0) {
        o.benefit_shares = 0;
        o.swing_shares = totalShares;
        o.has_dividend = false;
        o.has_swing = totalShares > 0;
        return;
      }

      var req = BENEFIT_REQ[sym] || 0;
      // Per-stock tier cap (ROI planner): keep at most `cap` benefit tiers, release
      // everything above to swing. Infinity = no cap. cap 0 = whole position swing
      // (same end state as a skip, but tracked in the separate cap list).
      var cap = roiSymTierCap(sym);
      var benefitShares;
      if (PASSIVE_STOCKS.indexOf(sym) >= 0) {
        // Passive perk stocks (WSU, IST, etc.) are single-tier — one block of
        // `req` shares, they never stack. Cap at req so any extra shares stay
        // swing/sellable instead of being locked by the 2^n tier formula.
        // A tier cap of 0 releases that single block too.
        benefitShares = (req > 0 && cap >= 1) ? Math.min(req, totalShares) : 0;
      } else {
        // Active (money/item) stocks stack. If the user has bought enough shares
        // for a higher tier (pending next dividend day), treat those extra shares
        // as BB rather than swing.
        var effectiveIncrement = increment;
        if (req > 0) {
          while (totalShares >= (Math.pow(2, effectiveIncrement + 1) - 1) * req) {
            effectiveIncrement++;
          }
        }
        // Clamp to the user's tier cap so shares above tier `cap` fall to swing.
        if (cap < effectiveIncrement) effectiveIncrement = cap;
        benefitShares = (req > 0 && effectiveIncrement > 0) ? (Math.pow(2, effectiveIncrement) - 1) * req : 0;
        benefitShares = Math.min(benefitShares, totalShares);
      }
      var swingShares = Math.max(0, totalShares - benefitShares);

      o.benefit_shares = benefitShares;
      o.swing_shares = swingShares;
      o.has_dividend = benefitShares > 0;
      o.has_swing = swingShares > 0;
    });
    return ownedMap;
  }

  // Live prices read straight off the stocks page — the fallback when tornsy is
  // unreachable. Same shape mergeIntervals produces, minus the `interval` history
  // (only tornsy has that), so everything that needs a PRICE keeps working:
  // holdings value, benefit blocks, swing P/L, the ROI planner and the whole
  // Quick Trade bar. Only the signal scores drop out, and calcScore refuses to
  // invent those from empty intervals.
  // No network call: the page is already loaded and being viewed by the user.
  function buildRawFromDom() {
    qtBuildMaps();
    var out = [];
    QT_STOCKS.forEach(function(sym) {
      var price = qtGetPrice(sym);
      if (price > 0) out.push({ stock: sym, price: price, interval: {}, investors: null });
    });
    return out;
  }

  function mergeIntervals(calls) {
    var merged = {};
    calls.forEach(function(call) {
      if (!call) return; // failed tornsy batch (fetch .catch'ed to null)
      var stocks = call.data || call;
      if (!Array.isArray(stocks)) return;
      stocks.forEach(function(s) {
        if (!merged[s.stock]) {
          merged[s.stock] = Object.assign({}, s, {interval: {}, ohlc: {}});
        }
        Object.assign(merged[s.stock].interval, s.interval || {});
        // ohlc rides along inside the same four responses (one `ohlc=` param per
        // batch, no extra call), so it merges exactly like `interval`: per symbol,
        // a later batch overwrites the same bucket key. Rows are
        // {open, high, low} as STRINGS — every reader must parseFloat.
        Object.assign(merged[s.stock].ohlc, s.ohlc || {});
        if (s.price) merged[s.stock].price = s.price;
        if (s.investors) merged[s.stock].investors = s.investors;
      });
    });
    return Object.values(merged);
  }

  // Average buy price of the SWING portion of a mixed (benefit block + swing)
  // position. Transactions are sorted newest-first and swing shares are the
  // newest blocks on top of the benefit block, so walk from the top until
  // swing_shares are consumed. Returns null when there is no mixed position
  // or no usable prices — callers fall back to the blended avg_price.
  function calcSwingAvgPrice(owned, transactions, fallbackAvg) {
    if (!owned || !(owned.benefit_shares > 0) || !(owned.swing_shares > 0)) return null;
    if (!transactions || transactions.length === 0) return null;
    var swRem = owned.swing_shares, swCost = 0, swCount = 0;
    transactions.forEach(function(t) {
      if (swRem <= 0) return;
      var take = Math.min(t.shares || 0, swRem);
      var price = (t.bought_price && t.bought_price > 0) ? t.bought_price : (fallbackAvg || 0);
      if (price > 0) { swCost += take * price; swCount += take; }
      swRem -= (t.shares || 0);
    });
    return swCount > 0 ? swCost / swCount : null;
  }

  // Net % on the SWING portion only, after Torn's 0.1% sale fee.
  //
  // Extracted from calcScore so the buy zone's SELL verdict and calcScore's
  // PROFIT / STOP LOSS badge are the SAME number, not two formulas that happen to
  // agree today. It must be the SWING avg and never the blended one: a benefit
  // block underneath can make a whole-position figure read +9% on a swing that is
  // actually down 56%, which is exactly the defect the dossier hit and fixed.
  //
  // Returns null when there is no swing to talk about — a pure benefit block is
  // held for the perk, so a price target is meaningless there.
  function calcSwingNetPct(owned, p_live) {
    if (!owned || !(owned.swing_shares > 0) || !(p_live > 0)) return null;
    var swingAvg = calcSwingAvgPrice(owned, owned.transactions, owned.avg_price);
    var base = (swingAvg !== null) ? swingAvg : owned.avg_price;
    if (!(base > 0)) return null;
    return (p_live * SELL_FEE - base) / base * 100;
  }

  function calcScore(stock, raw, ownedMap, priceHistory) {
    var s = stock.toUpperCase();
    var r = raw ? raw.find(function(x) { return x.stock === s; }) : null;
    if (!r) return null;

    var owned = ownedMap[s];
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

    // ── SELL LOGIC (owner-side; computed before any buy-filter early return
    // so PROFIT/STOP LOSS badges survive the above-weekly-peak state) ──
    // Signals apply ONLY to the swing portion of a position: the threshold is
    // evaluated against the swing-specific avg (FIFO newest transactions) so a
    // benefit block underneath never triggers or masks one. Pure benefit
    // blocks (swing_shares = 0) never get signals.
    var sellSignal = null, netProfitPct = null, hoursHeld = null;

    // Profit % for ALL owned stocks — include 0.1% sell fee for accurate P/L
    if (owned && owned.avg_price > 0) {
      netProfitPct = ((p_live * SELL_FEE - owned.avg_price) / owned.avg_price * 100);
      hoursHeld = owned.time_bought
        ? ((Date.now() / 1000 - owned.time_bought) / 3600).toFixed(0)
        : null;
    }

    var swingNetPct = calcSwingNetPct(owned, p_live);
    if (swingNetPct !== null) {
      var stopLoss = getStopLoss();
      if (swingNetPct >= getProfitTarget())                        sellSignal = "PROFIT";
      else if (stopLoss > 0 && swingNetPct <= -stopLoss)           sellSignal = "STOP LOSS";
    }

    // Pre-compute weekly peak (used by both the hard filter and indicator 1).
    // weekPrices are seven POINT samples — the d1..d5/d7/w1 CLOSES. The max of a
    // sample is not the week's HIGH, and the gap is not academic: measured on live
    // tornsy data for all 35 stocks, 19 were off by more than 10 percentage points,
    // 12 of those read a flat 0% drop because live sat below every sample, and TMI
    // showed 18.8% where the true drop from the weekly high was 46.6%.
    // So the w1 CANDLE high wins when tornsy sent one, and the sampled max stays as
    // the fallback for when it did not (a failed tornsy batch, or prices read off
    // the page by buildRawFromDom, which has no history at all).
    var weekPrices = [p_d1,p_d2,p_d3,p_d4,p_d5,p_d7,p_w1].filter(function(x){ return x > 0; });
    var sampledPeak = weekPrices.length > 0 ? Math.max.apply(null, weekPrices) : 0;
    var w1Candle = (r.ohlc && r.ohlc.w1) || null;
    var w1High = w1Candle ? parseFloat(w1Candle.high) : NaN;
    var w1Low  = w1Candle ? parseFloat(w1Candle.low)  : NaN;
    // A candle whose high is not above its low is not a range: reject it whole
    // rather than half-trusting one side of it.
    var haveW1Candle = isFinite(w1High) && isFinite(w1Low) && w1Low > 0 && w1High > w1Low;
    var weekPeak = haveW1Candle ? w1High : sampledPeak;

    // ── NO INTERVAL HISTORY (tornsy unreachable; price came off the page) ──
    // Every indicator below reads interval prices, and with them all defaulting to 0 the
    // score would be noise wearing a signal's clothes. Return the owner-side view only:
    // score -1 keeps it out of Top-5 (min score is never negative) and out of the 45-75
    // watch band, while shares/avg_price/P-L still populate the holdings sections. Dropping
    // the result entirely would have emptied those too — the panel would show a "trading
    // still works" banner over nothing at all.
    if (!r.interval || Object.keys(r.interval).length === 0) {
      return {
        symbol: s, score: -1, signal: "NO DATA", sellSignal: sellSignal, noHistory: true,
        scoreBreakdown: { drop: 0, position: 0, reversal: 0 },
        owned: !!owned, alreadyRallied: false, priceAboveWeek: false,
        has_swing: (owned && owned.has_swing) || false,
        has_benefit: (owned && owned.has_dividend) || false,
        hasDividend: (owned && owned.has_dividend) || false,
        dividendProgress: (owned && owned.dividend_progress) || 0,
        dividendFrequency: (owned && owned.dividend_frequency) || 0,
        isPassivePerk: (owned && owned.is_passive_perk) || false,
        p_live, reasons: "tornsy unavailable — no signal data",
        netProfitPct: netProfitPct,
        hoursHeld: hoursHeld,
        shares: (owned && owned.shares) || 0,
        avg_price: (owned && owned.avg_price) || 0,
        transactions: (owned && owned.transactions) || []
      };
    }

    // ── HARD FILTER: must be below the weekly high ────────────────────
    // Live must be below the recent weekly peak — blocks scoring once the
    // opportunity has passed. Uses the actual highest price seen this week
    // (max of d1-d7/w1), NOT just w1, so mid-week peaks are captured correctly.
    // Only short-circuits BUY scoring — sellSignal/netProfitPct above are
    // included so owner-side P/L display and badges stay correct.
    if (weekPeak > 0 && p_live >= weekPeak) {
      return {
        symbol: s, score: 0, signal: "WAIT", sellSignal: sellSignal,
        scoreBreakdown: { drop: 0, position: 0, reversal: 0 },
        owned: !!owned, alreadyRallied: false, priceAboveWeek: true,
        has_swing: (owned && owned.has_swing) || false,
        has_benefit: (owned && owned.has_dividend) || false,
        hasDividend: (owned && owned.has_dividend) || false,
        dividendProgress: (owned && owned.dividend_progress) || 0,
        dividendFrequency: (owned && owned.dividend_frequency) || 0,
        isPassivePerk: (owned && owned.is_passive_perk) || false,
        p_live, reasons: "Above weekly peak",
        netProfitPct: netProfitPct,
        hoursHeld: hoursHeld,
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

    if (weekPeak > 0) {
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
      let r_m30_h1 = p_m30 > p_h1;
      let r_h1_h2  = p_h1  > p_h2;
      let r_h2_h4  = p_h2  > p_h4;
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
      let r_m30_h1 = p_m30 > p_h1;
      let r_h1_h2  = p_h1  > p_h2;
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

    // (sellSignal / netProfitPct / hoursHeld computed at the top of the
    // function, before the weekly-peak early return.)
    return {
      symbol: s, score, signal, sellSignal,
      scoreBreakdown: scoreBreakdown,
      sustainedDowntrend: sustainedDowntrend,
      owned: !!owned,
      alreadyRallied: alreadyRallied,
      rsiOverbought: rsiOverbought,
      priceAboveWeek: p_w1 > 0 && p_live > p_w1,
      // The week the drop/position points were scored against. low is 0 when no
      // candle arrived — the sampled fallback knows a max, not a range.
      weekRange: { high: weekPeak, low: haveW1Candle ? w1Low : 0, fromCandle: haveW1Candle },
      has_swing: (owned && owned.has_swing) || false,
      has_benefit: (owned && owned.has_dividend) || false,
      hasDividend: (owned && owned.has_dividend) || false,
      dividendProgress: (owned && owned.dividend_progress) || 0,
      dividendFrequency: (owned && owned.dividend_frequency) || 0,
      isPassivePerk: (owned && owned.is_passive_perk) || false,
      p_live, reasons: reasons.join(" | "), netProfitPct, hoursHeld,
      shares: (owned && owned.shares) || 0,
      avg_price: (owned && owned.avg_price) || 0,
      transactions: (owned && owned.transactions) || []
    };
  }

  // Defaults changed in v2.39.0, from +0.3%/-1.0%. Measured on 5 years of daily
  // candles (35 stocks, 2021-2026, net of Torn's 0.1% sell fee):
  //   - The old pair risked 1% to make 0.3%, needing a 76.9% hit rate to break
  //     even and getting 66.3%. Simulated on ordinary entries it lost money in
  //     four of five years (-3.7 / -9.0 / -2.2 / +0.1 / -3.7), while never
  //     selling at all was positive in all five.
  //   - The tight stop is the expensive half: loosening it alone helped more
  //     than raising the target alone.
  // The 1.0% figure itself was measured on zone entries (price in the bottom of
  // its own 30-day range), where it was the peak of return per day of tied-up
  // capital. This script applies the target to every swing position regardless
  // of entry, so treat 1.0 as a sane default rather than a proven optimum for
  // your own entries. Existing users keep whatever they saved — these are
  // defaults, not a migration.
  function getProfitTarget() {
    return parseFloat(lsGet("tsa_profit_target", "1.0"));
  }

  // 0 disables the stop loss entirely (see the SELL LOGIC guard).
  function getStopLoss() {
    return parseFloat(lsGet("tsa_stop_loss", "0"));
  }

  // ==TSA-SAFE-BEGIN==
  // Text from Dossier that can reach the page. TSA runs on www.torn.com, where a
  // script tag in an item name would run with the user's Torn session (Quick Trade
  // can POST trades), so nothing Dossier sends is trusted to be plain text: a
  // string is escaped where it meets HTML, and the names and symbols the rest of
  // the script builds HTML from are checked once, where they arrive.
  // The TSA-SAFE markers let the node tests load these unchanged.
  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  // An item name from /api/tsa/reference: kept only when it is plain text of a
  // sane length. Torn's own item names use letters, digits, spaces and . , ' & - ( ) :
  // — none of them is refused here. null = drop the item.
  function safeItemName(n) {
    if (typeof n !== "string" || !n || n.length > 80) return null;
    return /[<>"`\\\u0000-\u001f\u007f]/.test(n) ? null : n;
  }

  // The stock catalogue (id -> Torn stock object), with every entry whose acronym is
  // not 2-5 capital letters dropped: the acronym becomes a symbol that the planner,
  // the tables and the Quick Trade bar all build HTML from. null when none is left.
  function safeStockCatalogue(stocks) {
    if (!stocks || typeof stocks !== "object") return null;
    var out = {};
    Object.keys(stocks).forEach(function(id) {
      var s = stocks[id];
      if (s && typeof s === "object" && typeof s.acronym === "string" && /^[A-Z]{2,5}$/.test(s.acronym)) out[id] = s;
    });
    return Object.keys(out).length ? out : null;
  }

  // A /api/tsa/market body with only the rows of a known symbol (known: SYM -> id).
  // A row's `stock` is the symbol rendered everywhere; an unknown one is dropped.
  function safeMarketBody(body, known) {
    if (!body || !Array.isArray(body.data)) return body;
    var out = {};
    for (var k in body) { if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k]; }
    out.data = body.data.filter(function(r) {
      return !!r && typeof r === "object" && typeof r.stock === "string" && Object.prototype.hasOwnProperty.call(known, r.stock);
    });
    return out;
  }

  // One entry of the ROI planner's income "Breakdown" line, as HTML.
  function incomeBreakdownHtml(sym, itemName, amountText) {
    return escHtml(sym) + (itemName ? " (" + escHtml(itemName) + ")" : "") + " " + escHtml(amountText);
  }
  // ==TSA-SAFE-END==

  // Dedup identical toasts within 3 seconds. Stops Benefit-Lock-cap and similar
  // warnings from spamming the screen on rapid clicks.
  var lastToastMsg = "";
  var lastToastTs = 0;
  function showToast(msg, type) {
    var now = Date.now();
    if (msg === lastToastMsg && (now - lastToastTs) < 3000) return;
    lastToastMsg = msg;
    lastToastTs = now;
    // One scrim, four semantic borders. Four different solid backgrounds carried no
    // information that the 3px border and the glyph did not already carry.
    var colors = {
      success: { bg:"var(--tsa-scrim)", border:"var(--tsa-pos)",    icon:"✓" },
      error:   { bg:"var(--tsa-scrim)", border:"var(--tsa-neg)",    icon:"✕" },
      warn:    { bg:"var(--tsa-scrim)", border:"var(--tsa-warn)",   icon:"!" },
      info:    { bg:"var(--tsa-scrim)", border:"var(--tsa-accent)", icon:"i" }
    };
    var c = colors[type] || colors.info;
    var toast = document.createElement("div");
    toast.className = "tsa-scope tsa-dark";
    toast.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:2147483648;" +
      "max-width:280px;padding:10px 14px;border-radius:var(--tsa-r-3);border-left:3px solid " + c.border + ";" +
      "background:" + c.bg + ";color:var(--tsa-toast-fg);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);" +
      "font-weight:600;box-shadow:0 4px 16px var(--tsa-shadow);display:flex;align-items:center;" +
      "gap:8px;animation:tsaToastIn 0.2s ease";
    toast.innerHTML = "<span style='font-size:var(--tsa-fs-body);flex-shrink:0'>" + c.icon + "</span><span>" + escHtml(msg) + "</span>";
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

  // Undo toast for the realized-profit reset: shows for 10s with an Undo
  // button that restores tsa_realized_events from the backup written by the
  // reset handler. Separate from showToast so the button can carry a handler.
  function showRealizedUndoToast() {
    var t = document.createElement("div");
    t.className = "tsa-scope tsa-dark";
    t.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:2147483648;display:flex;align-items:center;gap:10px;" +
      "padding:10px 14px;border-radius:var(--tsa-r-3);border-left:3px solid var(--tsa-warn);background:var(--tsa-scrim);" +
      "color:var(--tsa-toast-fg);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);";
    var span = document.createElement("span");
    span.textContent = "Realized profit reset";
    t.appendChild(span);
    var btn = document.createElement("button");
    btn.textContent = "Undo";
    btn.style.cssText = "padding:4px 10px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-toast-fg);background:transparent;color:var(--tsa-toast-fg);font-weight:700;cursor:pointer;font-size:var(--tsa-fs-micro);";
    btn.onclick = function() {
      lsSet("tsa_realized_events", localStorage.getItem("tsa_realized_events_backup") || "[]");
      if (t.parentNode) t.parentNode.removeChild(t);
      showToast("Realized profit restored", "success");
      renderCached();
    };
    t.appendChild(btn);
    document.body.appendChild(t);
    setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 10000);
  }

  var API_ERRORS = {
    "Incorrect key":  "Invalid API key — update it in Settings → Account.",
    "Access level":   "API key is missing required permissions — create a new key and save it in Settings → Account.",
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
  function getShowQtBar() {
    return lsGet("tsa_show_qt_bar", "true") !== "false";
  }
  function getPillsAlways() {
    return lsGet("tsa_pills_always", "false") === "true";
  }
  // Which list fills the Quick Buy pills. "buyzone" is the default: the Buy zone's
  // rule is evidence-based on price history and is the preferred buy signal. An
  // explicitly stored "top5" is still honoured; any other stored value falls back to
  // "buyzone" rather than leaving the pills empty on a typo.
  function getQtBuySource() {
    return lsGet("tsa_qt_buy_source", "buyzone") === "top5" ? "top5" : "buyzone";
  }
  // Whether the Top 5 buy section (or its "Buy signals" empty state) is drawn. Off by
  // default since the Buy zone is the preferred signal. Display only: the Top 5
  // ranking is still computed every render either way, because Watch, the Top 5
  // pill source and the signal log all read it.
  function getShowTop5() {
    return lsGet("tsa_show_top5", "false") === "true";
  }
  // The Top 5 section is drawn when the toggle is on OR when the Quick Buy pills
  // come from Top 5: pills must never trade from a list the user cannot see, and
  // the pin buttons that reorder that list live only in this section.
  function top5SectionVisible() {
    return getShowTop5() || getQtBuySource() === "top5";
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

  // Anchor the overlay panel to whichever screen quadrant the button sits in,
  // clamped on-screen. Used for the free-drag ("custom") mode where the button
  // can be anywhere; the preset modes use the fixed map in applyOverlayPosition.
  function positionOverlayNearButton() {
    var btn = document.getElementById("tsa-btn");
    var ov  = document.getElementById("tsa-overlay");
    if (!btn || !ov) return;
    var r = btn.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    ov.style.transform = "none";
    // Horizontal: anchor to the side the button is nearer to.
    if (r.left + r.width / 2 < vw / 2) {
      ov.style.left = Math.round(r.left) + "px"; ov.style.right = "auto";
    } else {
      ov.style.right = Math.round(vw - r.right) + "px"; ov.style.left = "auto";
    }
    // Vertical: open above the button when it's in the lower half, else below.
    if (r.top + r.height / 2 > vh / 2) {
      ov.style.bottom = Math.round(vh - r.top + 8) + "px"; ov.style.top = "auto";
    } else {
      ov.style.top = Math.round(r.bottom + 8) + "px"; ov.style.bottom = "auto";
    }
  }

  function applyOverlayPosition(pos) {
    var btn = document.getElementById("tsa-btn");
    var ov  = document.getElementById("tsa-overlay");
    // Free-drag mode: restore the saved button coords (clamped to the current
    // viewport) and anchor the overlay next to it.
    if (pos === "custom") {
      var c;
      try { c = JSON.parse(lsGet("tsa_btn_custom", "null")); } catch(e) { c = null; }
      if (btn && c && typeof c.left === "number" && typeof c.top === "number") {
        var left = Math.max(0, Math.min(c.left, window.innerWidth - btn.offsetWidth));
        var top  = Math.max(0, Math.min(c.top,  window.innerHeight - btn.offsetHeight));
        btn.style.left = left + "px"; btn.style.top = top + "px";
        btn.style.right = "auto"; btn.style.bottom = "auto"; btn.style.transform = "none";
        positionOverlayNearButton();
        return;
      }
      // No saved coords yet — fall through to the default preset.
      pos = "bottom-right";
    }
    var p = {
      "bottom-right": { btn: { bottom:"80px",  top:"auto", right:"16px", left:"auto", transform:"none" }, overlay: { bottom:"130px", top:"auto", right:"16px", left:"auto", transform:"none" } },
      "bottom-left":  { btn: { bottom:"80px",  top:"auto", right:"auto", left:"16px", transform:"none" }, overlay: { bottom:"130px", top:"auto", right:"auto", left:"16px", transform:"none" } },
      "top-right":    { btn: { bottom:"auto",  top:"16px", right:"16px", left:"auto", transform:"none" }, overlay: { bottom:"auto",  top:"60px", right:"16px", left:"auto", transform:"none" } },
      "top-left":     { btn: { bottom:"auto",  top:"16px", right:"auto", left:"16px", transform:"none" }, overlay: { bottom:"auto",  top:"60px", right:"auto", left:"16px", transform:"none" } },
      "middle-right": { btn: { bottom:"auto",  top:"50%", right:"16px", left:"auto", transform:"translateY(-50%)" }, overlay: { bottom:"auto", top:"50%", right:"16px", left:"auto", transform:"translateY(-50%)" } },
      "middle-left":  { btn: { bottom:"auto",  top:"50%", right:"auto", left:"16px", transform:"translateY(-50%)" }, overlay: { bottom:"auto", top:"50%", right:"auto", left:"16px", transform:"translateY(-50%)" } }
    }[pos] || { btn: { bottom:"80px", top:"auto", right:"16px", left:"auto", transform:"none" }, overlay: { bottom:"130px", top:"auto", right:"16px", left:"auto", transform:"none" } };
    if (btn) { btn.style.bottom = p.btn.bottom; btn.style.top = p.btn.top; btn.style.right = p.btn.right; btn.style.left = p.btn.left; btn.style.transform = p.btn.transform; }
    if (ov)  { ov.style.bottom  = p.overlay.bottom; ov.style.top = p.overlay.top; ov.style.right = p.overlay.right; ov.style.left = p.overlay.left; ov.style.transform = p.overlay.transform; }
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
      // Orphaned since the PROFIT/STOP LOSS toasts were removed (v2.26.0)
      localStorage.removeItem("tsa_notified_signals");
      Object.keys(localStorage).forEach(function(key) {
        if (key.indexOf("qt_intent_") !== 0) return;
        var v = JSON.parse(localStorage.getItem(key) || "null");
        if (!v || v.ts < cutoff) localStorage.removeItem(key);
      });
    } catch(e) {}
  }

  // Render the overlay from already-fetched data. Extracted from loadData so
  // panel exits (settings Cancel, alerts Back, ROI planner close) can redraw
  // instantly from lastOwnedMap/lastRaw without refetching. Side-effect
  // tracking (realized P/L, alerts, price recording, holdings snapshot)
  // stays in loadData — this only computes scores and renders. recordSignals
  // (inside) dedupes per symbol+minute, so re-rendering is safe.
  function renderFromData(ownedMap, raw, missingBatches, fromCache, localTrade) {
    var content = document.getElementById("tsa-content");
    if (!content) return;
    var ownedSymbols = Object.keys(ownedMap);
      // If ROI planner is active, show it instead
      if (roiPlannerActive && !localTrade) { showROIPlanner(ownedMap, raw); return; }
      var cachedPriceHistory = loadHistory();
      var stockResults = STOCKS_LIST
        .map(function(s) { return calcScore(s, raw, ownedMap, cachedPriceHistory); })
        .filter(Boolean)
        .sort(function(a, b) { return b.score - a.score; });

      // Log buy signals to history — only on real loads. The sym+minute
      // dedupe doesn't protect a cached re-render >1 min after the fetch,
      // which would append a duplicate entry with a stale price.
      if (!fromCache) recordSignals(stockResults);

      // Trend-arrow baseline from the previous real load (maintained in
      // loadData; cached re-renders reuse it unchanged)
      var prevPrices = prevLoadPrices;

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
      // RANGE GATE, applied to the ranked candidates before the slice. Display
      // only — see top5RangeGate: no score, weight or indicator is changed here.
      var top5Gate = top5RangeGate(top5BuyAll);
      var top5Pos = top5Gate.pos;          // SYM -> position %, or null = unknown
      var top5Hidden = top5Gate.hidden;    // candidates above mid-range, printed below
      var top5Buy = top5Gate.rows.slice(0, 5);
      // Buy pills are ordered by 24h investor growth (most new investors first),
      // stocks without enough history last. Doesn't affect the buy-section order.
      lastBuySymbols = top5Buy.slice().sort(function(a, b) {
        var da = (a.invDelta == null) ? -Infinity : a.invDelta;
        var db = (b.invDelta == null) ? -Infinity : b.invDelta;
        return db - da;
      }).map(function(s) { return s.symbol; });
      // 24h investor delta per buy stock, shown as the pill sub-text.
      // s.invDelta was computed above; null means not enough history yet.
      lastBuyInvDelta = {};
      top5Buy.forEach(function(s) {
        if (s.invDelta != null) lastBuyInvDelta[s.symbol] = s.invDelta;
      });

      // Buy score per stock, shown as the leading pill sub-text (mirrors the
      // bold score in the buy-section rows).
      lastBuyScores = {};
      top5Buy.forEach(function(s) {
        lastBuyScores[s.symbol] = s.score;
      });

      // 24h price change % per buy stock — derived from tornsy d1 interval vs live price.
      lastBuyPriceDelta = {};
      top5Buy.forEach(function(s) {
        var rEntry = raw ? raw.find(function(r) { return r.stock === s.symbol; }) : null;
        if (!rEntry) return;
        var pLive = parseFloat(rEntry.price) || 0;
        var p24h = parseFloat((rEntry.interval && rEntry.interval.d1 && rEntry.interval.d1.price)) || 0;
        if (pLive > 0 && p24h > 0) lastBuyPriceDelta[s.symbol] = ((pLive - p24h) / p24h) * 100;
      });

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
          // Price the swing portion at its own FIFO avg (same as the swing
          // rows and sell pills) so the header total reconciles with the
          // per-row $ values shown below it.
          var swingCost = calcSwingAvgPrice(ownedEntry, ownedEntry.transactions, ownedEntry.avg_price);
          if (swingCost === null) swingCost = ownedEntry.avg_price || 0;
          if (swingCost > 0) {
            totalProfit += (livePrice * SELL_FEE - swingCost) * ownedEntry.swing_shares;
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
              txProfit += (livePrice * SELL_FEE - costPrice) * shares;
              txCounted = true;
            });
          }
          if (txCounted) totalProfit += txProfit;
        }
      }

      // All --tsa-* tokens, so the theme branch is gone; the tokens switch on
      // #tsa-overlay.tsa-dark. Mono in both themes: this table is number columns,
      // and the light branch used to switch to a proportional face mid-table.
      var d = {
        bg:"var(--tsa-bg)", bg2:"var(--tsa-bg-raised)", bg3:"var(--tsa-bg-bar)", border:"var(--tsa-border)",
        text:"var(--tsa-fg)", muted:"var(--tsa-fg-faint)", blue:"var(--tsa-accent)",
        green:"var(--tsa-pos)", red:"var(--tsa-neg)", yellow:"var(--tsa-warn)",
        rowBuy:"var(--tsa-pos-bg)", rowBuyBorder:"var(--tsa-pos-border)",
        rowSell:"var(--tsa-neg-bg)", rowSellBorder:"var(--tsa-neg-border)",
        rowBenefit:"var(--tsa-neutral-bg)", rowBenefitBorder:"var(--tsa-neutral-border)",
        divider:"var(--tsa-border)", txBg:"var(--tsa-bg-raised)", txBorder:"var(--tsa-border)",
        moveBg:"var(--tsa-warn-bg)", moveBorder:"var(--tsa-warn-border)", moveColor:"var(--tsa-warn)",
        moveBg2:"var(--tsa-accent-bg)", moveBorder2:"var(--tsa-accent-border)", moveColor2:"var(--tsa-accent)",
        mono:"var(--tsa-mono)"
      };
      var ms = "font-family:" + d.mono + ";";

      var html = "<div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 14px;border-bottom:1px solid " + d.border + ";background:" + d.bg + "\">" +
        "<div style=\"background:" + d.bg2 + ";border-radius:var(--tsa-r-3);padding:8px;text-align:center;border:1px solid " + d.border + "\">" +
          "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";margin-bottom:4px\">Analyzed</div>" +
          "<div style=\"font-size:var(--tsa-fs-lead);font-weight:bold;color:" + d.text + ";" + ms + "\">" + stockResults.filter(function(sr) { return sr.score >= 0; }).length + "</div></div>" +
        "<div style=\"background:" + d.bg2 + ";border-radius:var(--tsa-r-3);padding:8px;text-align:center;border:1px solid " + d.border + "\">" +
          "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";margin-bottom:4px\">You own</div>" +
          "<div style=\"font-size:var(--tsa-fs-lead);font-weight:bold;color:" + d.text + ";" + ms + "\">" + ownedSymbols.length + "</div></div>" +
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
                "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" + sym + "</span>" +
                "<span style=\"font-size:var(--tsa-fs-micro);font-weight:bold;color:" + (p >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(p) + "</span>" +
              "</div>";
            }).join("");
            return "<div style=\"background:" + d.bg2 + ";border-radius:var(--tsa-r-3);padding:8px;border:1px solid " + d.border + "\">" +
              "<div style=\"display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px\">" +
                "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Open P/L</div>" +
                "<div style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + (totalProfit >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(totalProfit) + "</div>" +
              "</div>" +
              "<div id=\"tsa-realized-row\" style=\"display:flex;justify-content:space-between;align-items:baseline;cursor:pointer;\">" +
                "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Real. " + realDays + "d " + (realExpanded ? "&#9660;" : "&#9658;") + "</div>" +
                "<div style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + (realizedTotal >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(realizedTotal) + "</div>" +
              "</div>" +
              (realExpanded && stockKeys.length > 0 ? "<div style=\"margin-top:4px;border-top:1px solid " + d.border + ";padding-top:4px\">" + detailHtml + "</div>" : "") +
            "</div>";
          } else {
            return "<div style=\"background:" + d.bg2 + ";border-radius:var(--tsa-r-3);padding:8px;text-align:center;border:1px solid " + d.border + "\">" +
              "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";margin-bottom:4px\">Trading profit</div>" +
              "<div style=\"font-size:var(--tsa-fs-lead);font-weight:bold;color:" + (totalProfit >= 0 ? d.green : d.red) + ";" + ms + "\">" + fm(totalProfit) + "</div></div>";
          }
        })() +
        "</div>";

      function buildBreakdownHtml(bd, st) {
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
          var maxBadge = row.pts === row.max ? " <span style=\"color:" + d.green + ";font-size:var(--tsa-fs-micro)\">★ MAX</span>" : "";
          return "<div style=\"margin-bottom:6px\">" +
            "<div style=\"display:flex;justify-content:space-between;font-size:var(--tsa-fs-micro);margin-bottom:2px\">" +
            "<span style=\"color:" + d.muted + "\">" + row.label + "</span>" +
            "<span style=\"color:" + d.text + ";font-weight:bold;" + ms + "\">" + row.pts + " / " + row.max + "p" + maxBadge + "</span>" +
            "</div>" +
            "<div style=\"height:4px;background:" + d.border + ";border-radius:var(--tsa-r-1)\">" +
            "<div style=\"height:4px;width:" + barW + "%;background:" + barColor + ";border-radius:var(--tsa-r-1)\"></div>" +
            "</div></div>";
        }).join("") + buildWeekRangeHtml(st);
      }

      // One line under the bars: the week that the drop and position points were
      // actually scored against, so the honest high/low sits next to them.
      // "sampled" marks the fallback — no w1 candle, so the high is the max of the
      // daily closes and can sit below the real weekly high.
      function buildWeekRangeHtml(st) {
        var wr = st && st.weekRange;
        if (!wr || !(wr.high > 0)) return "";
        var txt = "Week " + (wr.low > 0 ? "$" + wr.low.toFixed(2) + "–" : "high ") + "$" + wr.high.toFixed(2);
        if (st.p_live > 0) {
          txt += " · live $" + st.p_live.toFixed(2);
          if (wr.low > 0 && wr.high > wr.low) {
            txt += " (" + Math.round((st.p_live - wr.low) / (wr.high - wr.low) * 100) + "% of range)";
          }
        }
        if (!wr.fromCandle) txt += " · sampled";
        return "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";margin:-2px 0 6px\">" + txt + "</div>";
      }

      function buildBbHtml(bbCtx) {
        if (!bbCtx || bbCtx.percentile === null) return "";
        var bbBarW = Math.round(bbCtx.percentile);
        var bbColor = bbCtx.percentile <= 15 ? d.yellow :
                      bbCtx.percentile <= 65 ? d.muted :
                      bbCtx.percentile <= 85 ? d.green : d.red;
        return "<div style=\"margin-bottom:6px;border-top:1px solid " + d.divider + ";padding-top:6px\">" +
          "<div style=\"display:flex;justify-content:space-between;font-size:var(--tsa-fs-micro);margin-bottom:2px\">" +
          "<span style=\"color:" + d.muted + "\">Volatility</span>" +
          "<span style=\"color:" + bbColor + ";font-weight:bold;" + ms + "\">" + bbCtx.label + " · " + bbBarW + "%</span>" +
          "</div>" +
          "<div style=\"height:4px;background:" + d.border + ";border-radius:var(--tsa-r-1)\">" +
          "<div style=\"height:4px;width:" + bbBarW + "%;background:" + bbColor + ";border-radius:var(--tsa-r-1)\"></div>" +
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
        return "<div style=\"margin-bottom:4px;padding:5px 8px;border-radius:var(--tsa-r-2);" +
          "background:var(--tsa-accent-bg);" +
          "border:1px solid var(--tsa-accent-border)\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">To " + nextLabel + ": </span>" +
          "<span style=\"font-size:var(--tsa-fs-micro);font-weight:bold;color:" + gapColor + ";" + ms + "\">" + gapText + "</span>" +
          (reversalNote ? "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.yellow + "\">" + reversalNote + "</span>" : "") +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" + needsStr + "</span>" +
          "</div>";
      }

      if (!top5SectionVisible()) {
        // Top 5 section hidden by setting: draw nothing. top5Buy above is still
        // computed and used elsewhere; only this panel is skipped.
      } else if (top5Buy.length > 0) {
        html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
          "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">" +
          "Top " + top5Buy.length + " buy" + top5HiddenHtml(d, top5Hidden) + "</div>";
        top5Buy.forEach(function(s) {
          var breakdownId = "tsa-breakdown-" + s.symbol;
          var bd = s.scoreBreakdown || {};
          var invDelta = s.invDelta;
          var invHtml = "";
          if (invDelta !== null) {
            var invColor = invDelta > 0 ? d.green : invDelta < 0 ? d.red : d.muted;
            var invSign = invDelta > 0 ? "+" : "";
            invHtml = " <span style=\"font-size:var(--tsa-fs-micro);color:" + invColor + ";font-weight:bold\">" + invSign + invDelta.toLocaleString("en-US") + " inv 24h</span>";
          }
          var bdHtml = buildBreakdownHtml(bd, s);
          var signalColor = s.signal === "STRONG BUY" ? "var(--tsa-pos-strong)" : s.signal === "BUY" ? d.green : s.signal === "CONSIDER" ? "var(--tsa-warn)" : d.muted;
          // Color based on ownership: unowned=green, owned swing=amber, owned benefit=blue
          var symColor = !s.owned ? d.green : s.has_benefit ? d.blue : d.yellow;
          var rowBg = !s.owned ? d.rowBuy : s.has_benefit ? d.rowBenefit : "var(--tsa-warn-bg)";
          var rowBorder = !s.owned ? d.rowBuyBorder : s.has_benefit ? d.rowBenefitBorder : "var(--tsa-warn-border)";

          // Trend arrow vs previous load
          var prevP = prevPrices[s.symbol];
          var trendHtml = "";
          if (prevP && prevP > 0 && s.p_live > 0) {
            var diff = ((s.p_live - prevP) / prevP * 100);
            if (Math.abs(diff) >= 0.01) {
              var trendCol = diff > 0 ? d.green : d.red;
              var trendArr = diff > 0 ? "↑" : "↓";
              trendHtml = "<span style=\"font-size:var(--tsa-fs-micro);color:" + trendCol + ";font-weight:bold;margin-left:4px\">" + trendArr + Math.abs(diff).toFixed(2) + "%</span>";
            }
          }
          var isPinned = tsaPinned.indexOf(s.symbol) >= 0;
          var pinBtnHtml = "<button class=\"tsa-pin-btn" + (isPinned ? " pinned" : "") + "\" data-sym=\"" + s.symbol + "\" title=\"" + (isPinned ? "Unpin" : "Pin to top") + "\">📌</button>";

          var bbHtml = buildBbHtml(bbWidthCache[s.symbol]);

          html += "<div style=\"margin-bottom:5px\">" +
            "<div class=\"tsa-buy-row\" data-symbol=\"" + s.symbol + "\" data-breakdown=\"" + breakdownId + "\" style=\"display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:var(--tsa-r-3);cursor:pointer;background:" + rowBg + ";border:1px solid " + rowBorder + "\">" +
            "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
            "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + symColor + ";" + ms + "\">" + s.symbol + trendHtml + " " + pinBtnHtml + "</span>" +
            "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" + s.reasons.split(" | ").slice(0,2).join(" · ") + top5PosHtml(d, top5Pos[s.symbol]) + invHtml + "</span>" +
            "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
            "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + symColor + ";" + ms + "\">" + s.score + "</span>" +
            "<span style=\"font-size:var(--tsa-fs-micro);color:" + signalColor + ";font-weight:bold\">" + s.signal + "</span>" +
            "<span id=\"" + breakdownId + "-caret\" style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">▶</span>" +
            "</div></div>" +
            "<div id=\"" + breakdownId + "\" style=\"display:none;background:" + d.txBg + ";border:1px solid " + d.txBorder + ";border-top:none;border-radius:0 0 var(--tsa-r-3) var(--tsa-r-3);padding:10px 12px 8px;margin-top:-4px\">" +
            bdHtml +
            bbHtml +
            buildGapHtml(bd, s.score, s.signal, s.sustainedDowntrend) +
            "<div style=\"border-top:1px solid " + d.divider + ";margin-top:4px;padding-top:6px;display:flex;justify-content:space-between;align-items:center\">" +
            "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Total</span>" +
            "<span style=\"font-size:var(--tsa-fs-micro);font-weight:bold;color:" + symColor + ";" + ms + "\">" + s.score + "p · " + s.signal + "</span>" +
            "<button class=\"tsa-goto-chart\" data-symbol=\"" + s.symbol + "\" style=\"padding:5px 10px;border-radius:var(--tsa-r-2);border:1px solid " + d.border + ";background:" + d.bg2 + ";color:" + d.muted + ";font-size:var(--tsa-fs-micro);cursor:pointer;font-weight:bold;\">📈 Chart</button>" +
            "</div></div>" +
            "</div>";
        });
        html += "</div>";
      } else {
        html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
          "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">Buy signals" + top5HiddenHtml(d, top5Hidden) + "</div>" +
          "<div style=\"color:" + d.muted + ";font-size:var(--tsa-fs-micro);padding:8px 0\">No signals right now</div></div>";
      }

      var dipRowsThisRender = null; // filled by the Buy zone section below; read by the pill-source block after it

      // BUY ZONE — its own section, BESIDE the score and never folded into it.
      // See the constants block for why: the rule's numbers come from a backtest
      // that was never validated forward, so it gets its own frame and its own
      // measured track record instead of a seat in the ranking.
      //
      // `!fromCache` is the logging gate, matching recordSignals above: a cached
      // re-render reuses a price that may be minutes old, and a call logged at a
      // stale entry price would poison the very measurement this section exists
      // for. The collapse rule would dedupe it anyway; this is the honest reason.
      (function () {
        var dipNow = Date.now();
        var dip = dipScan(dipNow, !fromCache, ownedMap);
        // Captured for the Quick Buy pill source below. dipScan runs EXACTLY once per
        // render because it journals prices and logs calls; calling it a second time
        // just to read the same rows would double-log and corrupt the very measurement
        // this section exists for.
        dipRowsThisRender = dip.rows;
        var dst = dip.stats;
        var rateHtml;
        if (dst.ready) {
          var rateCol = dst.hitRate >= 50 ? d.green : d.red;
          rateHtml = "<span style=\"color:" + rateCol + ";font-weight:bold\">" +
            dst.hitRate.toFixed(0) + "%</span> reached +" + DIP_SELL_TARGET.toFixed(1) +
            "% within " + DIP_HOLD_DAYS + "d · median " +
            (dst.medianPct >= 0 ? "+" : "") + dst.medianPct.toFixed(2) +
            "% · n=" + dst.n;
        } else {
          // Under the floor there is no percentage to show. Printing one would be
          // the single most misleading thing this section could do.
          rateHtml = "n=" + dst.n + ", too early (needs " + DIP_MIN_N + ")";
        }

        html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
          "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted +
          ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">Buy zone" +
          (dip.rows.length ? " (" + dip.rows.length + ")" : "") + "</div>";

        if (dip.rows.length) {
          dip.rows.forEach(function (r) {
            html += "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:var(--tsa-r-3);margin-bottom:5px;background:" + d.rowBuy + ";border:1px solid " + d.rowBuyBorder + "\">" +
              "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
              // The ACTION leads. A measurement is not an instruction: the dossier
              // shipped "3 days · ready" and a user reported not knowing what it
              // meant, so the verb comes first and the evidence sits under it.
              "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" +
              (r.verdict === "BUY" ? d.green : d.muted) + ";" + ms + "\">" +
              r.verdict + " <span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted +
              "\">" + r.sym + "</span></span>" +
              "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" +
              (r.verdict === "BUY"
                ? r.bandDays + "d settled in the band · "
                : "only " + r.bandDays + "d in the band, " + DIP_RIPE_DAYS + " wanted · ") +
              "30d range $" +
              r.low.toFixed(2) + " – $" + r.high.toFixed(2) + " · now $" + r.price.toFixed(2) + "</span>" +
              "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
              "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + d.green + ";" + ms + "\">" + r.pos.toFixed(1) + "%</span>" +
              "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">into its range</span>" +
              "</div></div>";
          });
        } else {
          html += "<div style=\"color:" + d.muted + ";font-size:var(--tsa-fs-micro);padding:8px 0\">" +
            "Nothing in the bottom " + DIP_MAX_POS + "% of its own 30-day range</div>";
        }

        // SELL / HOLD — the owner side of the same rule. Only rendered when there
        // is a swing to talk about, so a user who holds nothing tradeable never
        // sees an empty frame.
        if (dip.sells.length) {
          html += "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted +
            ";text-transform:uppercase;margin:8px 0 6px;font-weight:bold\">" +
            "Your swings · +" + DIP_SELL_TARGET.toFixed(1) + "% target</div>";
          dip.sells.forEach(function (r) {
            var isSell = r.verdict === "SELL";
            html += "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:var(--tsa-r-3);margin-bottom:5px;background:" +
              "var(--tsa-warn-bg)" + ";border:1px solid " +
              "var(--tsa-warn-border)" + "\">" +
              "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
              "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" +
              (isSell ? d.yellow : d.muted) + ";" + ms + "\">" + r.verdict +
              " <span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" + r.sym +
              "</span></span>" +
              "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" +
              r.shares.toLocaleString("en-US") + " swing shares · this rule's +" +
              DIP_SELL_TARGET.toFixed(1) + "% target, not your Sell setting</span>" +
              "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
              "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" +
              (r.net >= 0 ? d.green : d.red) + ";" + ms + "\">" +
              (r.net >= 0 ? "+" : "") + r.net.toFixed(2) + "%</span>" +
              "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">net, after the 0.1% fee</span>" +
              "</div></div>";
          });
        }

        // The disclosure, and it is not decoration: the track record, what is not
        // counted yet, and which symbols have no basis at all.
        html += "<div style=\"border-top:1px solid " + d.divider + ";margin-top:6px;padding-top:6px;font-size:var(--tsa-fs-micro);color:" + d.muted + ";line-height:1.6\">" +
          "<div>Measured on your own calls: " + rateHtml + "</div>" +
          "<div>" + dst.pending + " still inside the " + DIP_HOLD_DAYS + "d horizon · " +
          dst.nodata + " expired unpriced" +
          (dip.waiting ? " · ⏳ " + dip.waiting + "/" + STOCKS_LIST.length +
            " waiting for history" : "") + "</div>" +
          "<div>BUY = in the band and settled there ≥" + DIP_RIPE_DAYS +
          " days. In the band but newer than that is WAIT — the same trade measured " +
          "better a few days later. SELL = a swing that has reached +" +
          DIP_SELL_TARGET.toFixed(1) + "%; HOLD = one that has not. Only BUY calls " +
          "are scored above, because BUY is the only one of the four this section " +
          "recommends.</div>" +
          "</div></div>";
      })();

      // QUICK BUY PILL SOURCE. The Top-5 assignment far above always runs, because
      // the Top-5 section itself needs it; this only re-points the PILLS. It sits
      // here rather than at that assignment because dipScan runs inside the Buy zone
      // section above and must not be called twice.
      //
      // Only verdict BUY rows qualify. WAIT rows are inside the band but have not
      // settled there, and the disclosure printed by that section states BUY is the
      // only one of the four calls it recommends — so a WAIT pill would offer a
      // trade the rule does not make.
      //
      // An empty zone means NO buy pills. There is deliberately no silent fallback to
      // Top 5: seeing Top-5 symbols while the setting reads Buy zone would be read as
      // the zone agreeing with the ranking, which is the one thing the Buy zone is
      // built to keep separate.
      if (getQtBuySource() === "buyzone") {
        lastBuySource = "buyzone";
        var zoneBuys = (dipRowsThisRender || []).filter(function (r) { return r.verdict === "BUY"; });
        lastBuySymbols = zoneBuys.map(function (r) { return r.sym; });
        lastBuyZonePos = {};
        zoneBuys.forEach(function (r) { lastBuyZonePos[r.sym] = r.pos; });
      } else {
        lastBuySource = "top5";
        lastBuyZonePos = {};
      }

      // WATCH section — owned stocks with CONSIDER score
      if (getShowWatch() && watchList.length > 0) {
        html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
          "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">Watch (" + watchList.length + ")</div>";
        watchList.forEach(function(s) {
          var watchBreakdownId = "tsa-watch-breakdown-" + s.symbol;
          var bd = s.scoreBreakdown || {};
          var bdHtml = buildBreakdownHtml(bd, s);
          var watchSymColor = s.has_benefit ? d.blue : d.yellow;
          var watchRowBg = s.has_benefit ? d.rowBenefit : "var(--tsa-warn-bg)";
          var watchRowBorder = s.has_benefit ? d.rowBenefitBorder : "var(--tsa-warn-border)";
          var watchBbHtml = buildBbHtml(bbWidthCache[s.symbol]);

          html += "<div style=\"margin-bottom:5px\">" +
            "<div class=\"tsa-watch-row\" data-symbol=\"" + s.symbol + "\" data-breakdown=\"" + watchBreakdownId + "\" style=\"display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:var(--tsa-r-3);cursor:pointer;background:" + watchRowBg + ";border:1px solid " + watchRowBorder + "\">" +
            "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
            "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + watchSymColor + ";" + ms + "\">" + s.symbol + "</span>" +
            "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" + s.reasons.split(" | ").slice(0,2).join(" · ") + "</span>" +
            "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
            "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + watchSymColor + ";" + ms + "\">" + s.score + "</span>" +
            "<span style=\"font-size:var(--tsa-fs-micro);color:" + watchSymColor + ";font-weight:bold\">CONSIDER</span>" +
            "<span id=\"" + watchBreakdownId + "-caret\" style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">▶</span>" +
            "</div></div>" +
            "<div id=\"" + watchBreakdownId + "\" style=\"display:none;background:" + d.txBg + ";border:1px solid " + d.txBorder + ";border-top:none;border-radius:0 0 var(--tsa-r-3) var(--tsa-r-3);padding:10px 12px 8px;margin-top:-4px\">" +
            bdHtml +
            watchBbHtml +
            buildGapHtml(bd, s.score, s.signal, s.sustainedDowntrend) +
            "<div style=\"border-top:1px solid " + d.divider + ";margin-top:4px;padding-top:6px;display:flex;justify-content:space-between;align-items:center\">" +
            "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Total</span>" +
            "<span style=\"font-size:var(--tsa-fs-micro);font-weight:bold;color:" + watchSymColor + ";" + ms + "\">" + s.score + "p · CONSIDER</span>" +
            "<button class=\"tsa-goto-chart\" data-symbol=\"" + s.symbol + "\" style=\"padding:5px 10px;border-radius:var(--tsa-r-2);border:1px solid " + d.border + ";background:" + d.bg2 + ";color:" + d.muted + ";font-size:var(--tsa-fs-micro);cursor:pointer;font-weight:bold;\">📈 Chart</button>" +
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
        var swShares = (owned && owned.swing_shares > 0) ? owned.swing_shares : s.shares;
        var swAvg = s.avg_price;
        if (s.p_live > 0) {
          var fifoAvg = calcSwingAvgPrice(owned, s.transactions, s.avg_price);
          if (fifoAvg !== null) { swAvg = fifoAvg; swingPct = (s.p_live * SELL_FEE - swAvg) / swAvg * 100; }
        }
        s._swingDisplayPct = swingPct;
        s._swingShares = swShares;
        // Profit if sold now, net of Torn's 0.1% sales fee
        s._swingProfit = (s.p_live > 0 && swAvg > 0) ? swShares * (s.p_live * SELL_FEE - swAvg) : null;
        // Total position value (gross market value: shares × live price)
        s._swingValue = (s.p_live > 0 && swShares > 0) ? swShares * s.p_live : null;
      });
      swingTrades.sort(function(a, b) { return (b._swingDisplayPct || -Infinity) - (a._swingDisplayPct || -Infinity); });
      // Sell pills are ordered by net profit % (closest to profit first),
      // so the position nearest break-even/profit surfaces at the top.
      lastSwingPills = swingTrades.map(function(s) {
        return { sym: s.symbol, shares: s._swingShares, profit: s._swingProfit, value: s._swingValue, pct: s._swingDisplayPct };
      }).sort(function(a, b) {
        var pa = (a.pct == null) ? -Infinity : a.pct;
        var pb = (b.pct == null) ? -Infinity : b.pct;
        return pb - pa;
      });

      // PROFIT / STOP LOSS is shown in the row badge and the 🎯 pill marker
      // only — no toast notifications (toasts are reserved for trade
      // confirmations and errors).

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
        if (!isBenefit && s.p_live > 0) {
          swingAvgPrice = calcSwingAvgPrice(owned, s.transactions, s.avg_price);
          if (swingAvgPrice !== null) {
            swingNetProfitPct = (s.p_live * SELL_FEE - swingAvgPrice) / swingAvgPrice * 100;
          }
        }
        var displayNetProfitPct = swingNetProfitPct !== null ? swingNetProfitPct : s.netProfitPct;
        var displayValue = displayShares > 0 && s.p_live ? "$" + Math.round(displayShares * s.p_live).toLocaleString("en-US") : "";
        var sharesStr = displayShares > 0 ? displayShares.toLocaleString("en-US") + " shares" + (displayValue ? " · " + displayValue : "") : "?";
        var targetLine = "";
        if (!isBenefit && s.avg_price > 0) {
          var profitPct = getProfitTarget();
          var avgForTarget = swingAvgPrice !== null ? swingAvgPrice : s.avg_price;
          // Price at which NET profit (after Torn's 0.1% sell fee) hits the
          // target — matches the PROFIT signal / 🎯 threshold exactly:
          // (p * SELL_FEE - avg) / avg = target%  ⇒  p = avg * (1 + t%) / SELL_FEE
          var targetPrice = avgForTarget * (1 + profitPct / 100) / SELL_FEE;
          var currentPctStr = displayNetProfitPct !== null ? (displayNetProfitPct >= 0 ? "+" : "") + displayNetProfitPct.toFixed(2) + "%" : "";
          var currentPctColor = (displayNetProfitPct || 0) >= 0 ? d.green : d.red;
          targetLine = "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Avg $" + avgForTarget.toFixed(2) + " → Target <strong style=\"color:" + d.green + "\">$" + targetPrice.toFixed(2) + "</strong> (+" + profitPct.toFixed(1) + "%)" +
            (currentPctStr ? " · <strong style=\"color:" + currentPctColor + "\">" + currentPctStr + "</strong>" : "") +
            "</span><br>";
        }
        var pct = displayNetProfitPct !== null
          ? (displayNetProfitPct >= 0 ? "+" : "") + displayNetProfitPct.toFixed(2) + "%"
          : (s.avg_price > 0 && s.p_live > 0
            ? (((s.p_live * SELL_FEE - s.avg_price) / s.avg_price * 100) >= 0 ? "+" : "") + ((s.p_live * SELL_FEE - s.avg_price) / s.avg_price * 100).toFixed(2) + "%"
            : "");
        var effectiveProfitPct = displayNetProfitPct !== null ? displayNetProfitPct
          : (s.avg_price > 0 && s.p_live > 0 ? (s.p_live * SELL_FEE - s.avg_price) / s.avg_price * 100 : null);
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
            var txProfit = txCurrentVal * SELL_FEE - txInvested;
            var txPct = txInvested > 0 ? ((txProfit / txInvested) * 100).toFixed(2) : "?";
            var txSign = txProfit >= 0 ? "+" : "";
            var txColD = txProfit >= 0 ? d.green : d.red;
            // In swing section: transactions beyond swing_shares are benefit blocks
            var isBenefitTx = !isBenefit && owned && owned.benefit_shares > 0 && txSwingLeft <= 0;
            txSwingLeft -= (t.shares || 0);
            var txLabel = isBenefitTx ? "Benefit block" : "Block " + (idx + 1);
            var txLabelColor = isBenefitTx ? d.blue : d.muted;
            txHtml += "<div " + (!isBenefitTx ? "id=\"tsa-swing-tx-" + s.symbol + "-" + idx + "\" class=\"tsa-swing-tx-row\" data-sym=\"" + s.symbol + "\" data-shares=\"" + (t.shares || 0) + "\" data-label=\"Block " + (idx + 1) + "\" data-state=\"0\" " : "") + "style=\"display:flex;justify-content:space-between;align-items:center;padding:6px 4px;border-bottom:1px solid " + d.divider + ";font-size:var(--tsa-fs-micro);" + (!isBenefitTx ? "cursor:pointer;border-radius:var(--tsa-r-1);" : "") + "\">" +
              "<div><span style=\"color:" + txLabelColor + ";" + ms + "\">" + txLabel + "</span><span style=\"color:" + d.muted + ";margin-left:6px\">" + txDate + "</span><br>" +
              "<span style=\"color:" + d.text + ";" + ms + "\">" + txShares + " @ " + txPrice + "</span></div>" +
              "<div style=\"text-align:right\">" +
              "<span style=\"font-weight:bold;color:" + txColD + ";font-size:var(--tsa-fs-micro);\">" + txSign + "$" + Math.abs(Math.round(txProfit)).toLocaleString("en-US") + "</span><br>" +
              "<span style=\"font-weight:bold;color:" + txColD + ";font-size:var(--tsa-fs-micro);\">" + txSign + txPct + "%</span></div></div>";
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
        var totalProfit = totalCurrentVal * SELL_FEE - totalInvested;
        var totalPct = totalInvested > 0 ? ((totalProfit / totalInvested) * 100).toFixed(2) : null;
        var totalCol = (totalPct === null) ? d.muted : (totalProfit >= 0 ? d.green : d.red);
        var totalSign = totalProfit >= 0 ? "+" : "";

        return "<div style=\"margin-bottom:5px;\">" +
          "<div style=\"display:flex;align-items:center;gap:6px;\">" +
          "<div style=\"" + rowBgStr + ";flex:1;margin-bottom:0;cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:var(--tsa-r-3);\" data-detail=\"" + detailId + "\" data-symbol=\"" + s.symbol + "\">" +
          "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
          "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + col + ";" + ms + "\">" + s.symbol + "</span>" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" + sharesStr + "</span><br>" +
          targetLine +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Score " + s.score + (s.hasDividend ? " · DIV" : "") + (s.reasons ? " · " + s.reasons.split(" | ").slice(0,2).join(" · ") : "") + "</span>" +
          "</div><div style=\"display:flex;flex-direction:column;align-items:flex-end;gap:2px\">" +
          "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + col + ";" + ms + "\">" + pct + "</span>" +
          // A passive perk has no payout cycle, so it gets a plain PERK badge:
          // showing progress/frequency there would be a countdown to nothing.
          (s.hasDividend ? "<span style=\"font-size:var(--tsa-fs-micro);padding:2px 6px;border-radius:var(--tsa-r-3);font-weight:bold;background:var(--tsa-warn-bg);color:" + d.yellow + ";border:1px solid var(--tsa-warn-border)\">" + (s.isPassivePerk ? "PERK" : "DIV " + s.dividendProgress + "/" + s.dividendFrequency + "d") + "</span>" : "") +
          (s.sellSignal ? "<span style=\"font-size:var(--tsa-fs-micro);font-weight:bold;color:" + d.red + "\">" + s.sellSignal + "</span>" : "") +
          "</div></div>" +
          "</div>" +
          "<div id=\"" + detailId + "\" style=\"display:none;background:" + d.txBg + ";border:1px solid " + d.txBorder + ";border-radius:0 0 var(--tsa-r-3) var(--tsa-r-3);padding:8px 10px;margin-top:-4px;\">" +
          // Total P/L summary
          "<div style=\"display:flex;justify-content:space-between;align-items:center;background:" + d.bg + ";border-radius:var(--tsa-r-2);padding:8px 10px;margin-bottom:8px;border:1px solid " + d.border + "\">" +
          "<div><div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px\">Total P/L</div>" +
          "<div style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + totalCol + "\">" + (totalPct !== null ? totalSign + "$" + Math.abs(Math.round(totalProfit)).toLocaleString("en-US") : "N/A") + "</div></div>" +
          "<div style=\"text-align:right\"><div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px\">Return</div>" +
          "<div style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + totalCol + "\">" + (totalPct !== null ? totalSign + totalPct + "%" : "N/A") + "</div></div>" +
          "<button class=\"tsa-goto-chart\" data-symbol=\"" + s.symbol + "\" style=\"padding:6px 10px;border-radius:var(--tsa-r-2);border:1px solid " + d.border + ";background:" + d.bg2 + ";color:" + d.muted + ";font-size:var(--tsa-fs-micro);cursor:pointer;font-weight:bold;\">📈 Chart</button>" +
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
                    return "<div style=\"display:flex;align-items:center;gap:6px;padding:5px 8px;margin-bottom:6px;border-radius:var(--tsa-r-2);background:" + (slipPct > 0 ? "var(--tsa-neg-bg)" : "var(--tsa-pos-bg)") + ";border:1px solid " + (slipPct > 0 ? "var(--tsa-neg-border)" : "var(--tsa-pos-border)") + "\">" +
                      "<span style=\"font-size:var(--tsa-fs-micro)\">" + (slipPct > 0 ? "⚠" : "✓") + "</span>" +
                      "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Entry slippage: intended <strong style=\"color:" + d.text + "\">$" + intent.price.toFixed(2) + "</strong> · paid <strong style=\"color:" + slipColor + "\">$" + s.avg_price.toFixed(2) + "</strong> <strong style=\"color:" + slipColor + "\">(" + slipSign + slipPct.toFixed(1) + "%)</strong></span>" +
                      "</div>";
                  }
                }
              }
            } catch(e) {}
            return "";
          })() +
          "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";margin-bottom:4px;font-weight:bold;text-transform:uppercase;letter-spacing:0.08em;" + ms + "\">Transactions</div>" +
          "<div style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + ";margin-bottom:6px;" + ms + "\">Avg: <strong style=\"color:" + d.text + "\">" + (s.avg_price > 0 ? "$" + s.avg_price.toFixed(2) : "N/A") + "</strong> · Live: <strong style=\"color:" + d.text + "\">$" + s.p_live.toFixed(2) + "</strong>" + (s.hoursHeld ? " · <span style=\"color:" + d.muted + "\">held " + s.hoursHeld + "h</span>" : "") + "</div>" +
          txHtml + "</div></div>";
      };

      if (allOwned.length > 0) {
        html += "<hr style=\"border:none;border-top:1px solid " + d.divider + ";margin:6px 14px\">";

        if (swingTrades.length > 0) {
          var swingCollapsed = lsGet("tsa_swing_collapsed", "false") === "true";
          html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
            "<div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;cursor:pointer;\" id=\"tsa-swing-header\">" +
            "<span style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;font-weight:bold;" + ms + "\">Swing trades (" + swingTrades.length + ")</span>" +
            "<span style=\"font-size:var(--tsa-fs-body);color:" + d.muted + ";\">" + (swingCollapsed ? "&#9658;" : "&#9660;") + "</span></div>" +
            "<div id=\"tsa-swing-body\" style=\"display:" + (swingCollapsed ? "none" : "block") + "\">";
          swingTrades.forEach(function(s) { html += renderStockRow(s, "swing"); });
          html += "</div></div>";
        }

        if (benefitBlocks.length > 0) {
          if (swingTrades.length > 0) html += "<hr style=\"border:none;border-top:1px solid " + d.divider + ";margin:6px 14px\">";
          var benefitCollapsed = lsGet("tsa_benefit_collapsed", "false") === "true";
          html += "<div style=\"padding:10px 14px 6px;background:" + d.bg + "\">" +
            "<div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;cursor:pointer;\" id=\"tsa-benefit-header\">" +
            "<span style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;font-weight:bold;" + ms + "\">Benefit blocks (" + benefitBlocks.length + ")</span>" +
            "<span style=\"font-size:var(--tsa-fs-body);color:" + d.muted + ";\">" + (benefitCollapsed ? "&#9658;" : "&#9660;") + "</span></div>" +
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
        "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Updated: " + new Date(lastLoadTs || Date.now()).toLocaleTimeString("en-GB") + autoRefreshLabel + "<span id='tsa-countdown'></span></span>" +
        "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Storage: " + getTsaStorageSize() + histLabel + " \u00b7 " + historyStatus + "</span>" +
        "</div>" +
        "<button id='tsa-scroll-top' title='Scroll to top'>↑</button>";
      // (scheduleAutoRefresh deliberately NOT called here: a cached re-render
      // must not reset the pending fetch timer. loadData re-arms it after
      // calling this function — which also covers the roiPlannerActive
      // early-return above, where this point is never reached.)

      // Partial-data banner: scores/signals below are computed from
      // incomplete interval data — say so instead of rendering as if full.
      if (lastPricesFromPage) {
        // No market data: prices are the page's own, so there is no history to score
        // with. Be explicit that trading is unaffected — the whole point of not blanking out.
        html = "<div style=\"padding:8px 14px;font-size:var(--tsa-fs-micro);font-weight:700;color:" + "var(--tsa-neg)" + ";background:var(--tsa-neg-bg);border-bottom:1px solid var(--tsa-neg-border)\">" +
          (dataMode === "dossier" ? "\u26d4 No market data from Dossier \u2014 no signals or charts. Prices are read from this page, "
                                  : "\u26d4 tornsy is down \u2014 no signals or charts. Prices are read from this page, ") +
          "so holdings, the ROI planner and buying/selling all still work.</div>" + html;
      } else if (missingBatches > 0) {
        html = "<div style=\"padding:8px 14px;font-size:var(--tsa-fs-micro);font-weight:700;color:" + "var(--tsa-warn)" + ";background:var(--tsa-warn-bg);border-bottom:1px solid var(--tsa-warn-border)\">" +
          (dataMode === "dossier" ? "\u26a0 Market data partial \u2014 " + missingBatches + "/4 interval groups missing or stale, signals degraded"
                                  : "\u26a0 tornsy partial \u2014 " + missingBatches + "/4 interval batches missing, signals degraded") + "</div>" + html;
      }
      // The data source's own state (Dossier throttled / unreachable / still loading
      // holdings, or that a lapsed licence put TSA back on the user's own key), on top.
      if (lastDataBanner) {
        html = "<div style=\"padding:8px 14px;font-size:var(--tsa-fs-micro);font-weight:700;color:var(--tsa-warn);background:var(--tsa-warn-bg);border-bottom:1px solid var(--tsa-warn-border)\">" +
          "\u26a0 " + escHtml(lastDataBanner) + "</div>" + html;
      }

      content.innerHTML = html;

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
      // Only the user's single click is propagated to Torn's UI (priceTab.click).
      // We do NOT auto-switch to weekly view — that was a second script-initiated
      // request not directly triggered by the user, which violates Torn's
      // scripting policy. User can manually pick a timeframe in Torn's UI.
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

      // Per-row in-flight feedback: a sell fires on a single click (one click =
      // one POST). The instant the user taps a Block row we show a red highlight
      // + "SELLING…" badge on the row, before awaiting the async POST — so the
      // user sees the action registered even if the corner toast is hidden
      // behind the panel. Cleared after the async outcome:
      //   - POST succeeds → row removed (success path),
      //   - POST fails     → highlight cleared (no stale in-flight state).
      var activeSwingRow = null;
      function clearSwingRowHighlight() {
        if (!activeSwingRow) return;
        activeSwingRow.style.background = "";
        activeSwingRow.style.boxShadow = "";
        var oldBadge = activeSwingRow.querySelector(".tsa-swing-selling-badge");
        if (oldBadge && oldBadge.parentNode) oldBadge.parentNode.removeChild(oldBadge);
        activeSwingRow = null;
      }
      function markSwingRowSelling(row) {
        clearSwingRowHighlight();
        row.style.background = "var(--tsa-neg-bg-hi)";
        row.style.boxShadow = "inset 0 0 0 2px var(--tsa-neg)";
        var sellingBadge = document.createElement("span");
        sellingBadge.className = "tsa-swing-selling-badge";
        sellingBadge.textContent = "↻ SELLING…";
        sellingBadge.style.cssText = "margin-left:8px;font-size:var(--tsa-fs-micro);font-weight:800;color:var(--tsa-neg);text-transform:uppercase;letter-spacing:0.06em";
        row.appendChild(sellingBadge);
        activeSwingRow = row;
      }
      content.querySelectorAll(".tsa-swing-tx-row").forEach(function(row) {
        row.addEventListener("click", async function(e) {
          e.stopPropagation();
          var sym    = row.dataset.sym;
          var shares = parseInt(row.dataset.shares, 10);
          var label  = row.dataset.label;
          qtBuildMaps();
          var owned = qtGetOwnedShares(sym);
          if (owned <= 0) { showToast("You have no shares of " + sym, "warn"); return; }
          if (shares > owned) shares = owned;
          shares = qtApplyBenefitLock(sym, shares);
          if (shares === null) return;

          // Show the in-flight visual immediately, then await the single POST.
          markSwingRowSelling(row);

          var fired = await qtUiTrade(sym, shares, "sellShares", "Sold " + shares.toLocaleString("en-US") + " " + sym + " (" + label + ")", { blockMaxShares: shares });

          if (fired) {
            // Trade succeeded — drop the row.
            clearSwingRowHighlight();
            var parent = row.parentNode;
            if (parent) parent.removeChild(row);
            return;
          }
          // Trade failed — clear the in-flight visual.
          clearSwingRowHighlight();
        });
      });

      var benefitHeader = document.getElementById("tsa-benefit-header");
      if (benefitHeader) benefitHeader.addEventListener("click", function() {
        lsSet("tsa_benefit_collapsed", String(lsGet("tsa_benefit_collapsed", "false") !== "true"));
        loadData();
      });

      // Refresh the torn-stock-pocket-style Quick Buy / Swing pills under the QT bar
      renderQtPills();
      if (roiPlannerActive && localTrade) showROIPlanner(ownedMap, raw, true);

  }

  // Re-render from the last load's cached data; falls back to a full
  // loadData when no cache exists yet (e.g. the light owned-only prefetch
  // sets lastOwnedMap but not lastRaw).
  function renderCached() {
    if (lastOwnedMap && lastRaw) renderFromData(lastOwnedMap, lastRaw, lastMissingBatches, true);
    else loadData();
  }

  // Instant holdings view, painted the moment Dossier's /me lands, before the
  // larger /market answer arrives. Shows ONLY price-independent
  // data (shares + cost basis) from buildOwnedMap; renderFromData overwrites it
  // with the full panel once live prices are in. The caller guards against the
  // ROI planner being open.
  function renderHoldingsSkeleton(ownedMap) {
    var content = document.getElementById("tsa-content");
    if (!content) return;
    var isDark = document.getElementById("tsa-overlay").classList.contains("tsa-dark");
    var d = isDark
      // theme-invariant: every value is a token that switches itself
      ? { bg:"var(--tsa-bg)", bg2:"var(--tsa-bg-raised)", border:"var(--tsa-border)", text:"var(--tsa-fg)", muted:"var(--tsa-fg-faint)", blue:"var(--tsa-accent)" }
      : { bg:"var(--tsa-bg)", bg2:"var(--tsa-bg-raised)", border:"var(--tsa-border)", text:"var(--tsa-fg)", muted:"var(--tsa-fg-faint)", blue:"var(--tsa-accent)" };
    var syms = Object.keys(ownedMap).sort(function(a, b) {
      var ia = (ownedMap[a].shares || 0) * (ownedMap[a].avg_price || 0);
      var ib = (ownedMap[b].shares || 0) * (ownedMap[b].avg_price || 0);
      return ib - ia;
    });
    var rows = syms.map(function(sym) {
      var o = ownedMap[sym];
      var shares = o.shares || 0;
      var avg = o.avg_price || 0;
      var invested = shares * avg;
      var sub = shares.toLocaleString("en-US") + " sh" +
        (avg > 0 ? " @ $" + Math.round(avg).toLocaleString("en-US") : "");
      var investedStr = invested > 0 ? "$" + Math.round(invested).toLocaleString("en-US") : "—";
      return "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:var(--tsa-r-3);margin-bottom:5px;background:" + d.bg2 + ";border:1px solid " + d.border + "\">" +
        "<div style=\"display:flex;flex-direction:column;gap:2px\">" +
          "<span style=\"font-size:var(--tsa-fs-body);font-weight:bold;color:" + d.blue + "\">" + escHtml(sym) + "</span>" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">" + sub + "</span>" +
        "</div>" +
        "<span style=\"font-size:var(--tsa-fs-micro);font-weight:bold;color:" + d.text + "\">" + investedStr + "</span>" +
      "</div>";
    }).join("");
    if (!rows) rows = "<div style=\"padding:20px;text-align:center;color:" + d.muted + ";font-size:var(--tsa-fs-micro)\">No holdings yet</div>";
    content.style.background = d.bg;
    content.innerHTML =
      "<div style=\"padding:10px 14px;display:flex;align-items:center;gap:8px;border-bottom:1px solid " + d.border + ";background:" + d.bg + "\">" +
        "<span class=\"tsa-spinner\" style=\"color:" + d.blue + "\"></span>" +
        "<span style=\"font-size:var(--tsa-fs-micro);color:" + d.muted + "\">Loading live prices…</span>" +
      "</div>" +
      "<div style=\"padding:10px 14px\">" +
        "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + d.muted + ";text-transform:uppercase;margin-bottom:8px;font-weight:bold\">Your holdings</div>" +
        rows +
      "</div>";
  }

  // Free mode is the default: the user's own Torn key, api.torn.com + tornsy.com,
  // exactly as in 2.50. Only a stored, well-formed licence key makes a load ask the
  // licence module; an ACTIVE licence then reads from Dossier (licence mode). An
  // invalid, expired or unconfirmable licence never locks anything: that load simply
  // runs in free mode. With a fresh cached answer the check is synchronous and
  // costs nothing; when one is due, one request goes to dossier-api.aec3.org first.
  function loadData() {
    var token = null;
    try { token = TSALicense.peek(licenseDeps).state.token; } catch (e) { token = null; }
    if (!TSALicense.validToken(token)) { loadDirect(""); return; }
    var settled = false;
    licenseEnsure(false, function (d) {
      settled = true;
      // Licence off (expired, rejected, unconfirmable): free mode, and the status
      // line (or, without a Torn key, the key prompt) says so.
      if (d.locked) loadDirect(licenceOffNote(d, ""));
      else loadDossier();
    });
    if (!settled) {
      var c = document.getElementById("tsa-content");
      if (c) {
        c.textContent = "";
        var l = document.createElement("div");
        l.className = "tsa-loading";
        l.textContent = "Checking TSA licence…";
        c.appendChild(l);
      }
    }
  }

  // Whether a stored licence currently puts TSA in licence mode, from the cached
  // state only (no request). Used where no load is running (the background prefetch).
  function licenceModeOn() {
    try {
      var d = TSALicense.peek(licenseDeps);
      return TSALicense.validToken(d.state.token) && !d.locked;
    } catch (e) { return false; }
  }

  // True for a request to Torn's API or to tornsy while licence mode is on. Licence
  // mode is Dossier ONLY (owner decision 2026-11-05): gmXhr and fetchJSON refuse
  // such a request, so no code path can fetch for itself while a licence is active.
  // Once the licence lapses (licenceModeOn() false) free mode fetches as before.
  function tsaSelfFetchBlocked(url) {
    if (typeof url !== "string" || !/^https?:\/\/(api\.torn\.com|(www\.)?tornsy\.com)([\/?#:]|$)/i.test(url)) return false;
    return licenceModeOn();
  }

  // A well-formed licence key is stored (active or not), from the cached state only.
  function licenceKeyStored() {
    try { return TSALicense.validToken(TSALicense.peek(licenseDeps).state.token); } catch (e) { return false; }
  }

  function hasTornKey() {
    var k = getTornKey();
    return !!k && k !== "###PDA-APIKEY###";
  }

  // How long a /me or /market answer is reused before it is asked for again. Dossier
  // itself moves on a 1-min (price) / 5-min (holdings) cadence, so a refresh inside
  // 30 s would only fetch the same bytes again.
  var ME_MAX_AGE_MS         = 30 * 1000;
  var MARKET_MAX_AGE_MS     = 30 * 1000;
  var ME_PLANNER_MAX_AGE_MS = 60 * 1000;
  var BENEFIT_MAX_AGE_MS    = 30 * 1000;
  var BENEFIT_WAIT_MS       = 3000;
  // The last /api/tsa/benefit result of a licence-mode load (a TSAData.get result),
  // or null. Licence mode's ROI recommendation is read from here and nowhere else.
  var lastDossierBenefit = null;
  var lastDossierTrades = [];

  // /me with every Quick Trade done here since Dossier's last poll laid over it.
  function meWithTrades(me) {
    return TSAData.applyTradeLog(me, TSAData.readLog(licenseDeps), STOCK_SYM_MAP, Date.now(), SELL_FEE);
  }

  function dataFmtTime(ms) {
    try { return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return new Date(ms).toISOString().slice(11, 16); }
  }

  // The one status line a load shows about Dossier, as plain text (rendered with
  // escHtml). "" when everything came fresh.
  // Holdings times are Dossier's poll time (meta.source_ts) when it is known — the
  // age of the book itself — else the time this browser received them.
  function dataBannerText(p) {
    var parts = [];
    var meAt = p.me ? dataFmtTime(p.meSourceMs != null ? p.meSourceMs : p.meMs) : null;
    if (p.dossier === "throttled") {
      var secs = p.retryMs != null ? Math.max(1, Math.ceil(p.retryMs / 1000)) : null;
      parts.push("Dossier throttled — showing the last data" + (secs ? ", next try in " + secs + "s" : "") +
        (meAt ? ", holdings from " + meAt : ""));
    } else if (p.dossier === "unreachable") {
      parts.push("Dossier unreachable — " + (p.market ? "market from " + dataFmtTime(p.marketMs) + ", prices from page" : "prices from page") +
        ", " + (meAt ? "holdings from " + meAt : "no holdings available"));
    }
    if (p.warming) {
      parts.push("Dossier is still loading your holdings (it polls every 5 min)" +
        (meAt ? " — showing holdings from " + meAt : " — try again in a few minutes"));
    }
    if (p.stale) {
      parts.push("Holdings from " + meAt + " — Dossier has not polled them since (it normally does every 5 min); not treated as live");
    }
    return parts.join(" · ");
  }

  // One delayed reload, for a licence-mode load that had nothing to show (holdings
  // still warming, no Torn key in TSA to fall back on). Only while the page is on
  // screen and no auto-refresh is due anyway.
  var DATA_RETRY_MS = 90 * 1000;
  var dataRetryTimer = null;
  function dataRetrySoon() {
    if (dataRetryTimer) { clearTimeout(dataRetryTimer); dataRetryTimer = null; }
    if (autoRefreshTimer || !isOnScreen()) return;
    dataRetryTimer = setTimeout(function() {
      dataRetryTimer = null;
      if (isOnScreen()) loadData();
    }, DATA_RETRY_MS);
  }

  // The licence key changed or was removed. Everything held for the previous
  // Dossier account goes: Dossier answers (stored and in flight), the trade log, and
  // any load still running under the old key. When a key replaces another, also the
  // holdings snapshot the realized-profit diff compares against (diffing account B
  // against account A's snapshot would book every A stock as sold).
  // resetSnapshot: only when one licence key REPLACES another (possibly another
  // account). Adding a first key or removing one keeps the realized-profit snapshot,
  // which belongs to the user's own book (free mode reads the same account).
  function dataForgetAccount(resetSnapshot) {
    TSAData.clear(licenseDeps);
    if (resetSnapshot) lsSet("tsa_prev_holdings", "{}");
    lastOwnedMap = null;
    lastRaw = null;
    lastDossierBenefit = null;
    lastBestRec = null;
    licenseGen++;
  }

  // The status text for a load that runs in free mode although a licence key is
  // stored: the licence is not active (expired, rejected, unconfirmable for 72 h).
  // prefix: what the load saw first ("" when the licence check alone decided).
  function licenceOffNote(d, prefix) {
    var why = d ? licenseReasonText(d) : "";
    return (prefix ? prefix + ". " : "") + (hasTornKey()
      ? "Your TSA licence is not active, so TSA is back on your own Torn API key."
      : "Your TSA licence is not active, so TSA runs free on your own Torn API key.") + (why ? " " + why : "");
  }

  // Appended to a licence-mode error: licence mode never falls back to the user's
  // own key, and this says how to get free mode back on purpose.
  function licenceOnlyHint() {
    return hasTornKey()
      ? " While a TSA licence is set, TSA reads from Dossier only and does not use your own Torn API key. Remove the licence in Settings → Account to run free on your key."
      : " Or use TSA free with your own Torn API key: Settings → Account.";
  }

  // The error panel with a Retry button. Re-arms auto-refresh (a failed load must
  // not end the loop) and, with auto-refresh off and noRetry unset (licence mode),
  // schedules one retry. Free mode passes noRetry, as 2.50 had no such retry.
  function dataShowError(msg, noRetry) {
    var content = document.getElementById("tsa-content");
    if (!content) return;
    content.innerHTML = "<div class=\"tsa-error\">" + escHtml(msg) + "</div>" +
      "<div class=\"tsa-footer\"><span id=\"tsa-error-next\" style=\"font-size:var(--tsa-fs-micro)\"><span id='tsa-countdown'></span></span><button class=\"tsa-refresh\" id=\"tsa-refresh-btn\">Retry</button></div>";
    var retryBtn = document.getElementById("tsa-refresh-btn");
    if (retryBtn) retryBtn.addEventListener("click", loadData);
    scheduleAutoRefresh();
    if (autoRefreshEndTime) {
      var nextEl = document.getElementById("tsa-error-next");
      if (nextEl) nextEl.insertAdjacentText("afterbegin", "Auto-retry");
    } else if (!noRetry) {
      dataRetrySoon();
    }
  }

  // Licence mode: one load from Dossier.
  function loadDossier() {
    // Every load (and a licence key change) bumps licenseGen; every continuation of
    // this load checks it, so a load overtaken by a newer one, or still in flight
    // under an old key, renders, alerts and schedules nothing.
    var gen = ++licenseGen;
    dataMode = "dossier";
    cleanOldIntents();
    var content = document.getElementById("tsa-content");
    content.style.background = "var(--tsa-bg)";
    content.innerHTML = "<div class=\"tsa-loading\">Fetching data...</div>";

    // Everything from Dossier, authenticated by the licence alone: holdings + cash +
    // armoury (/me), prices + interval snapshots (/market), the stock/item catalogue
    // (/reference, daily) and the long-term history (/history, every 30 min). None of
    // these promises rejects; plan() below decides what the answers add up to.
    var meP = new Promise(function(resolve) { TSAData.get(licenseDeps, "me", ME_MAX_AGE_MS, resolve); });
    var marketP = new Promise(function(resolve) { TSAData.get(licenseDeps, "market", MARKET_MAX_AGE_MS, resolve); });
    // Dossier's Benefit Advisor answer: the ONLY source of licence mode's ROI
    // recommendation. Never rejects; a failure is shown as Dossier's status. Like
    // history, the render waits for it at most BENEFIT_WAIT_MS: a slow answer must
    // not hold back the holdings. A late one replaces the recommendation as it lands.
    var benefitLate = false;
    var benefitRaw = new Promise(function(resolve) { TSAData.get(licenseDeps, "benefit", BENEFIT_MAX_AGE_MS, resolve); });
    var benefitP = Promise.race([benefitRaw, new Promise(function(r) { setTimeout(function() { benefitLate = true; r(null); }, BENEFIT_WAIT_MS); })]);
    benefitRaw.then(function(res) {
      if (!benefitLate || gen !== licenseGen || !lastOwnedMap || !lastRaw) return;
      lastDossierBenefit = res;
      lastBestRec = benefitPlan(lastOwnedMap, lastRaw, 0, 0).target;
      renderQtPills();
      updateQtRecommendation(null);
    });
    // Awaited purely for ORDER: the tables must be installed before anything is
    // computed from them. Never rejects — a failure leaves the fallback standing.
    var cataloguePromise = refreshStockCatalogue();
    // History (the largest answer, every 30 min) feeds only the buy zone and its
    // status line: the render waits for it at most HIST_WAIT_MS, then goes ahead
    // with what is stored. A late answer is applied for the next render.
    var historyPromise = Promise.race([histMaybeRefresh(), new Promise(function(r) { setTimeout(r, HIST_WAIT_MS); })]);

    // Instant holdings: paint a price-independent holdings list the moment /me
    // lands, instead of waiting for the market. The full render below overwrites it.
    var fullRendered = false;
    meP.then(function(res) {
      if (gen !== licenseGen) return;
      if (fullRendered) return;              // prices already landed — skip the flash
      if (roiPlannerActive) return;          // don't clobber an open ROI planner
      if (res.kind !== "ok" || !res.body || res.body.holdings_status !== "ok") return;
      renderHoldingsSkeleton(buildOwnedMap(meWithTrades(res.body)));
    });

    Promise.all([meP, marketP, cataloguePromise, historyPromise, benefitP]).then(function(results) {
      if (gen !== licenseGen) return;
      lastDossierBenefit = results[4] || null;   // null: still on its way (see benefitRaw)
      var p = TSAData.plan(results[0], results[1], Date.now());
      lastDossierTrades = p.me && Array.isArray(p.me.trades) ? p.me.trades : [];
      fullRendered = true;
      // LICENCE MODE IS DOSSIER ONLY (owner decision 2026-11-05): nothing below
      // falls back to the user's own Torn key while the licence is active.
      if (p.lock === "licence") {
        // Let the licence module apply its rules (401 = rejected, active:false =
        // expired). Lapsed: free mode on the user's own key, and the status line
        // says so. Still active by the licence check: Dossier's error, retried.
        licenseEnsure(true, function(d) {
          if (gen !== licenseGen) return;
          if (d.locked) loadDirect(licenceOffNote(d, "Dossier did not accept the TSA licence"));
          else dataShowError("Dossier did not accept the TSA licence for data. TSA tries again shortly." + licenceOnlyHint());
        });
        return;
      }
      if (p.lock === "key") {
        dataShowError("Dossier has no working Torn API key for your account: add it on dossier.aec3.org. TSA tries again shortly." + licenceOnlyHint());
        return;
      }
      if (p.lock) return;
      // Dossier unreachable, throttled or still warming: carry on with what Dossier
      // gave before (stored holdings, page prices) under a status line, or show
      // Dossier's error below. Never the user's own key.

      // No holdings known at all (Dossier still warming for this player, or down,
      // with nothing stored here): do NOT render an empty book as if it were real —
      // the planner and the Quick Trade recommendations would then advise buying
      // blocks the user already owns. Say why, and try again.
      if (!p.me) {
        throw new Error(p.warming
          ? "Dossier is still loading your holdings (it polls every 5 min). TSA tries again shortly."
          : (p.dossier === "throttled" ? "Dossier throttled and no holdings stored yet. TSA tries again shortly."
                                       : "Dossier unreachable and no holdings stored yet. TSA tries again shortly."));
      }
      var me = meWithTrades(p.me);
      var tornData = me;
      lastCashBalance = (me && typeof me.money_onhand === "number") ? me.money_onhand : 0;
      lastArmoryFunds = (me && me.armory && me.armory.ok) ? (me.armory.money_balance || 0) : 0;

      // Market: Dossier's merged rows (one "batch" — mergeIntervals reads
      // call.data). Dossier down or cold: the page's own prices, laid over the last
      // stored market when that is recent (plan() gives it only under 30 min), so
      // holdings, the ROI planner and the Quick Trade bar never blank out.
      var missingBatches, raw, fromPage = false;
      if (p.market) p.market = safeMarketBody(p.market, STOCK_SYM_MAP);
      if (p.market && p.marketLive) {
        raw = mergeIntervals([p.market]);
        missingBatches = Math.max(0, Math.min(4, parseInt(p.market.missing_batches, 10) || 0));
      } else {
        var dom = buildRawFromDom();
        if (p.market) {
          raw = mergeIntervals([p.market]);
          var domPx = {};
          dom.forEach(function(r) { domPx[r.stock] = r.price; });
          raw.forEach(function(r) { if (domPx[r.stock] > 0) r.price = domPx[r.stock]; });
          missingBatches = Math.max(0, Math.min(4, parseInt(p.market.missing_batches, 10) || 0));
        } else {
          raw = dom;
          fromPage = true;
          missingBatches = 4;
        }
      }
      if (!raw.length) {
        throw new Error(p.dossier ? "Dossier unreachable and no prices on the page" : "No market data from Dossier and no prices on the page");
      }
      lastPricesFromPage = fromPage;
      lastDataBanner = dataBannerText(p);

      // Track realized profit from sold positions — only from holdings Dossier
      // polled just now, and from the poll ITSELF, never with the local trade log
      // laid over it. A stored or "warming" copy is not today's book, and the
      // overlay is a guess that stops applying on its own clock: diffing either
      // against the last snapshot would invent sales, or book one twice.
      var polledMap = p.holdingsLive ? buildOwnedMap(p.me) : null;
      loadFinish(gen, tornData, polledMap, raw, missingBatches, p.meSourceMs != null ? p.meSourceMs : p.meMs);

    }).catch(function(e) {
      if (gen !== licenseGen) return;
      // A failed load must NOT kill the auto-refresh loop — dataShowError re-arms it,
      // so a transient error only skips one cycle. Without a Torn key in TSA there
      // was nothing to fall back to: say that free mode is one key away.
      dataShowError("Error: " + e.message + licenceOnlyHint());
    });
  }

  // The shared tail of a load, free or licence mode. tornData: the Torn v1 user
  // shape (stocks, money_onhand) to show. polledMap: the owned map of holdings that
  // are TODAY's book (free mode: Torn's own answer; licence mode: a live Dossier
  // poll), or null - only then is a realized-profit diff booked and the snapshot
  // saved.
  // sourceMs: when the holdings in polledMap were read from Torn (free mode: now;
  // licence mode: Dossier's poll time). The two modes can alternate (a licence added,
  // a Dossier fallback), and a Dossier poll may predate a direct read: a book older
  // than the snapshot's own source would undo a sale in the snapshot and then book
  // it a second time. Such a book is neither diffed nor saved.
  function loadFinish(gen, tornData, polledMap, raw, missingBatches, sourceMs) {
    var snapSrc = parseInt(lsGet("tsa_prev_holdings_src_ms", "0"), 10) || 0;
    if (polledMap && !(sourceMs > snapSrc)) polledMap = null;
    var ownedMap = buildOwnedMap(tornData);
    // Enrich ownedMap with correct benefit_shares/swing_shares using live prices
    enrichOwnedMap(ownedMap, raw);

    if (polledMap && getShowRealized()) {
      try {
        var prevHoldings = JSON.parse(localStorage.getItem("tsa_prev_holdings") || "{}");
        var realizedEvents = getRealizedEvents();
        var nowTs = Math.floor(Date.now() / 1000);
        var prevSyms = Object.keys(prevHoldings);
        for (var rpi = 0; rpi < prevSyms.length; rpi++) {
          var rpSym = prevSyms[rpi];
          var prevEntry = prevHoldings[rpSym];
          if (!prevEntry) continue;
          var curEntry = polledMap[rpSym];
          var prevShares = prevEntry.shares || 0;
          var curShares = curEntry ? (curEntry.shares || 0) : 0;
          var soldShares = prevShares - curShares;
          if (soldShares <= 0) continue;
          var rpRaw = raw ? raw.find(function(x) { return x.stock === rpSym; }) : null;
          var liveP = rpRaw ? (parseFloat(rpRaw.price) || 0) : 0;
          var costP = prevEntry.avg_price || 0;
          if (liveP <= 0 || costP <= 0) continue;
          var realizedProfit = (liveP * SELL_FEE - costP) * soldShares;
          realizedEvents.push({ ts: nowTs, profit: realizedProfit, sym: rpSym, sell_price: liveP });
        }
        // Trim events older than 90 days. Keep entries that are missing `ts`
        // (legacy data from older TSA versions that didn't record a timestamp)
        // — discarding them silently would lose the user's realized-P/L history.
        var trim90 = nowTs - 90 * 86400;
        realizedEvents = realizedEvents.filter(function(e) { return !e.ts || e.ts >= trim90; });
        localStorage.setItem("tsa_realized_events", JSON.stringify(realizedEvents));
      } catch(e) {}
    }
    // Save the holdings snapshot on EVERY load with live holdings, regardless of
    // the show-realized toggle. If it only updated while the toggle was on,
    // re-enabling it later would diff against a stale snapshot and book
    // every interim sale as realized profit at TODAY'S price instead of
    // the actual sale price. Sales made while the toggle was off are
    // simply not recorded (their sale price is unknowable).
    if (polledMap) {
      var holdingsSnap = {};
      Object.keys(polledMap).forEach(function(s) {
        holdingsSnap[s] = { shares: polledMap[s].shares || 0, avg_price: polledMap[s].avg_price || 0 };
      });
      lsSet("tsa_prev_holdings", JSON.stringify(holdingsSnap));
      lsSet("tsa_prev_holdings_src_ms", String(sourceMs));
    }

    // Store for ROI planner
    lastOwnedMap = ownedMap;
    lastRaw = raw;
    lastMissingBatches = missingBatches;
    lastLoadTs = Date.now();
    // Trend-arrow baseline: snapshot the previous load's prices, then
    // update lastLoadPrices from this load. Maintained here (per FETCH,
    // not per render) so cached re-renders reuse the same baseline
    // instead of wiping the arrows.
    prevLoadPrices = {};
    Object.keys(lastLoadPrices).forEach(function(k) { prevLoadPrices[k] = lastLoadPrices[k]; });
    raw.forEach(function(r) {
      var px = parseFloat(r.price) || 0;
      if (r.stock && px > 0) lastLoadPrices[r.stock] = px;
    });

    // The next-block recommendation for the Quick Trade bar = the planner's
    // target from the shared computation, so the bank pill, rec widget,
    // bridge pill and planner "Next move" always agree. Licence mode: Dossier's
    // answer. Free mode: the same rule, which needs the real capital and income.
    lastBestRec = benefitPlan(ownedMap, raw, planCapital(ownedMap, raw), calcWeeklyIncome(ownedMap, raw, null)).target;
    updateQtRecommendation(null);

    // Check price alerts
    checkAlerts(raw);

    // Record live prices to history (also refreshes the in-memory history cache)
    recordPrices(raw);

    // Update chart with selected stock
    var currentStock = lsGet("qt_last_stock", "");
    if (currentStock) qtDrawChart(currentStock);

    renderFromData(ownedMap, raw, missingBatches);

    // Item values feed the bridge pill's income math (planner parity). Free mode:
    // live item-market prices from Torn, TTL-gated to 30 min so auto-refresh does
    // not re-fetch ~18 item endpoints every cycle. Licence mode: they come with the
    // daily reference. Pills re-render once values land.
    if (Date.now() - lastItemFetchTs > 30 * 60 * 1000) {
      lastItemFetchTs = Date.now();
      fetchAllItemPrices(function() { if (gen === licenseGen) renderQtPills(); });
    }

    // Re-arm the auto-refresh AFTER rendering, from the fetch path only —
    // cached re-renders never reset the timer, and the ROI-planner branch
    // inside renderFromData can't skip it.
    scheduleAutoRefresh();
  }

  // Free mode (the default), as in 2.50: the user's own Torn key, api.torn.com for
  // holdings / cash / faction armoury, tornsy.com for prices. note: one status line
  // for this load ("" = none), e.g. why a licence-mode load fell back to this.
  function loadDirect(note) {
    var gen = ++licenseGen;
    dataMode = "direct";
    cleanOldIntents();
    var content = document.getElementById("tsa-content");
    content.style.background = "var(--tsa-bg)";

    // Check for API key
    if (!hasTornKey()) {
      showKeyOnboarding(content, function() { loadData(); }, note);
      return;
    }

    content.innerHTML = "<div class=\"tsa-loading\">Fetching data...</div>";

    // A failed tornsy batch resolves to null instead of rejecting the whole
    // Promise.all — the panel renders from whatever arrived (every batch
    // carries the live price) with a visible "partial data" banner. Only a
    // failed Torn call, or ALL four tornsy batches failing, shows the error UI.
    var tornsyFetch = function(url) {
      return fetchJSON(url).catch(function() { return null; });
    };

    // money,basic piggyback on the stocks call: money_onhand + player_id feed
    // the bridge-pill capital (same numbers the ROI Planner fetches on open).
    var userPromise = fetchJSON("https://api.torn.com/user/?selections=stocks,money,basic&key=" + getTornKey());
    // Faction armory balance — counted as capital by the planner's bridgebuilder.
    // Non-faction users get an API error body → armory stays 0.
    var factionPromise = fetchJSON("https://api.torn.com/faction/?selections=donations&key=" + getTornKey()).catch(function() { return null; });
    // Benefit requirements / frequencies / payout descriptions, straight from Torn
    // instead of a hand-maintained table. Cached 24h, so this is at most one extra
    // call per user per day and usually zero. It is awaited in the Promise.all
    // below purely for ORDER: the tables must be installed before anything is
    // computed from them. Never rejects — a failure leaves the fallback standing.
    var cataloguePromise = refreshStockCatalogue();
    var t1p = tornsyFetch("https://tornsy.com/api/stocks?interval=m30,h1,h2,h3,h4");
    var t2p = tornsyFetch("https://tornsy.com/api/stocks?interval=h6,h8,h10,h12,h16");
    // `ohlc=` rides along in a request that is already being made — same response,
    // no extra call, no extra rate cost. It gives the week's real high/low instead
    // of the max of seven daily closes (see the weekPeak comment in calcScore).
    // TRAP: ohlc accepts a SMALLER key set than interval — h1/h6/h12/d1/w1/n1/y1
    // are 200, but an OFFSET like d7 (or d2/d3/h20) is a 400 that kills the whole
    // batch. d7 stays in `interval`, never in `ohlc`. Verified 2026-08-25.
    // w1 is asked for on two batches on purpose: either one landing keeps the
    // candle path alive if the other fails.
    var t3p = tornsyFetch("https://tornsy.com/api/stocks?interval=h20,d1,d2,d3,d4&ohlc=w1");
    var t4p = tornsyFetch("https://tornsy.com/api/stocks?interval=d5,d6,d7,w1,h5&ohlc=w1");

    // Instant holdings: the Torn user call is fast, the tornsy price batches are
    // the slow part. Paint a price-independent holdings list the moment the user
    // call lands, instead of blocking the whole panel on tornsy. The full render
    // below overwrites this once prices are in.
    var fullRendered = false;
    userPromise.then(function(tornData) {
      if (gen !== licenseGen) return;
      if (fullRendered) return;              // prices already landed — skip the flash
      if (roiPlannerActive) return;          // don't clobber an open ROI planner
      if (!tornData || tornData.error) return; // real error surfaced by Promise.all below
      renderHoldingsSkeleton(buildOwnedMap(tornData));
    }).catch(function() {});                 // Promise.all owns the error UI

    Promise.all([
      userPromise, t1p, t2p, t3p, t4p, factionPromise, cataloguePromise
    ]).then(function(results) {
      if (gen !== licenseGen) return;
      fullRendered = true;
      var tornData = results[0];
      var t1 = results[1];
      var t2 = results[2];
      var t3 = results[3];
      var t4 = results[4];
      var factionData = results[5];

      if (tornData.error) { throw new Error(friendlyApiError(tornData.error.error)); }

      lastCashBalance = tornData.money_onhand || 0;
      lastArmoryFunds = 0;
      var bpPlayerId = tornData.player_id;
      if (bpPlayerId && factionData && !factionData.error && factionData.donations && factionData.donations[bpPlayerId]) {
        lastArmoryFunds = factionData.donations[bpPlayerId].money_balance || 0;
      }

      // Count unusable batches (failed fetch, or a JSON error body that
      // carries no stock array) so the banner reflects what's really missing.
      var missingBatches = [t1, t2, t3, t4].filter(function(t) {
        return !t || !Array.isArray(t.data || t);
      }).length;
      // tornsy fully down: fall back to the page's own prices instead of throwing.
      // Throwing blanked the whole panel — holdings, ROI planner and the Quick Trade
      // bar's pills with it — even though none of those need tornsy. Only give up if
      // the page has no prices either (not the stocks page / markup changed).
      var raw = (missingBatches === 4) ? buildRawFromDom() : mergeIntervals([t1, t2, t3, t4]);
      if (missingBatches === 4 && raw.length === 0) {
        throw new Error("tornsy.com unreachable and no prices on the page");
      }
      lastPricesFromPage = (missingBatches === 4);
      lastDataBanner = note || "";
      // Torn's own answer is today's book: it is both what is shown and what the
      // realized-profit diff compares (as in 2.50).
      loadFinish(gen, tornData, buildOwnedMap(tornData), raw, missingBatches, Date.now());

    }).catch(function(e) {
      if (gen !== licenseGen) return;
      // A failed load must NOT kill the auto-refresh loop — dataShowError re-arms
      // it, so a transient API/tornsy error only skips one cycle.
      dataShowError("Error: " + e.message, true);
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

  function getHistoryMaxAge() {
    var days = parseInt(lsGet("tsa_history_days", "30"), 10);
    if (isNaN(days) || days < 1) days = 1;
    if (days > 30) days = 30;
    return days * 24 * 60 * 60 * 1000;
  }

  // In-memory cache of the parsed price history. The JSON string is multi-MB,
  // so re-parsing it for every chart draw / row tap is expensive on mobile.
  // recordPrices mutates the cached object in place and saveHistory re-points
  // the cache, so reads and writes stay coherent within this tab. (Cross-tab
  // writes were already last-write-wins before the cache existed.)
  var historyMemCache = null;

  function loadHistory() {
    if (historyMemCache) return historyMemCache;
    try { historyMemCache = JSON.parse(localStorage.getItem(HISTORY_KEY)) || {}; } catch(e) { historyMemCache = {}; }
    return historyMemCache;
  }

  function saveHistory(history) {
    historyMemCache = history;
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
        } catch {}
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
    if (!lastBestRec || !lastBestRec.tierInfo || !(lastBestRec.tierInfo.sharesNeeded > 0)) { recDiv.style.display = "none"; return; }

    var rec = lastBestRec;
    var cash = typeof qtGetMoneyFast === "function" ? qtGetMoneyFast() : 0;
    var canAfford = cash >= rec.cost;
    var color = canAfford ? "var(--tsa-pos)" : "var(--tsa-neg)";
    var border = canAfford ? "var(--tsa-pos-border)" : "var(--tsa-neg-border)";
    var bg = canAfford ? "var(--tsa-pos-bg)" : "var(--tsa-neg-bg)";
    var recSym = rec.sym;
    var recTier = "T" + rec.tierInfo.nextIncrement;
    var recShares = rec.tierInfo.sharesNeeded;
    var recCost = rec.cost;

    var label = "💡 " + recSym + " " + recTier + " · " + recShares.toLocaleString("en-US") + " shares · " + fmRoi(recCost);

    recDiv.style.display = "block";
    recDiv.innerHTML = "<button id='qt-rec-btn' style='width:100%;padding:6px 10px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:" + bg + ";color:" + color + ";font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;cursor:pointer;text-align:left;'>" + label + "</button>";

    document.getElementById("qt-rec-btn").addEventListener("click", function() {
      var liveCash = qtGetMoneyFast();
      // Unreadable money element (liveCash 0) must REFUSE, matching the bank
      // pill and qtVault — never fire a full-cost buy blind.
      if (liveCash <= 0) { showToast("No money found", "warn"); return; }
      // Tier rec buys must hit the exact share count to unlock the benefit
      // block — refuse rather than partial-buy wasted shares.
      if (recCost > liveCash) {
        showToast("Need $" + (recCost - liveCash).toLocaleString("en-US") + " more for " + recSym + " " + recTier, "warn");
        return;
      }
      qtUiTrade(recSym, recShares, "buyShares", "Bought " + recShares.toLocaleString("en-US") + " " + recSym + " (" + recTier + ")");
      updateQtRecommendation(null);
    });
  }
  var QT_DEFAULT_AMOUNTS = [1000000, 3000000, 5000000, 10000000, 25000000, 50000000, 100000000];
  var qtAmounts = (function() {
    try {
      var stored = localStorage.getItem("qt_amounts");
      var parsed = stored ? JSON.parse(stored) : null;
      return (Array.isArray(parsed) && parsed.length > 0) ? parsed : QT_DEFAULT_AMOUNTS.slice();
    } catch(e) { return QT_DEFAULT_AMOUNTS.slice(); }
  })();
  var qtEditMode = false;
  // Quick Trade direction. One row of amount buttons serves both sides, so the bar
  // has to show which way it points — the buttons themselves no longer say.
  //
  // NOT persisted, on purpose. Remembering it would mean a bar left in SELL reopens
  // armed to sell in the exact position muscle memory uses to buy, on a one-click
  // irreversible trade. It resets to BUY on every load; within a session the choice
  // sticks, which is where the convenience actually matters.
  var qtDir = "buy";
  function setQtDir(d) {
    qtDir = (d === "sell") ? "sell" : "buy";
    renderQtRows();   // repaints the row and resets the consequence line
  }

  var QT_STOCKS = ["ASS","BAG","CBD","CNC","ELT","EVL","EWM","FHG","GRN","HRG",
    "IIL","IOU","IST","LAG","LOS","LSC","MCS","MSG","MUN","PRN",
    "PTS","SYM","SYS","TCC","TCI","TCM","TCP","TCT","TGP","THS",
    "TMI","TSB","WLT","WSU","YAZ"];

  var qt_stocks = {}, qt_stockRows = {}, qt_stockId = {}, qt_localShareCache = {};
  var qtMapsBuiltAt = 0;   // throttles the preview's map rebuild — see qtRenderConsequence

  function qtBuildMaps() {
    qt_stocks = {}; qt_stockRows = {}; qt_stockId = {};
    $("ul[class^='stock_']").each(function() {
      // Guard the logo parse: a card missing its <img> or a src without
      // "logos/" must skip (return = continue the .each) rather than throw,
      // which would abort the loop and leave the trade maps half-built.
      var src = $("img", $(this)).attr("src") || "";
      if (src.indexOf("logos/") < 0) return;
      var sym = src.split("logos/")[1].split(".svg")[0];
      qt_stocks[sym] = $("div[class^='price_']", $(this));
      qt_stockRows[sym] = $(this);
      qt_stockId[sym] = $(this).attr("id"); // used by qtPostTrade
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

  // Returns the DOM-reported owned count, or null when the count can't be read
  // (row not registered yet, or neither the mobile nor the desktop markup is
  // present — e.g. mid-render). null is deliberately distinct from a genuine 0:
  // callers must not treat "unreadable" as "owns zero", otherwise a transient
  // re-render would look like an authoritative change and wipe the local cache.
  function qtReadOwnedFromDom(id) {
    var row = qt_stockRows[id];
    if (!row) return null;
    var mobileEl = row.find("p[class^='count']");
    if (mobileEl.length > 0) return parseFloat(mobileEl.text().replace(/,/g, "")) || 0;
    var cols = row.children("div");
    if (cols.length >= 5) return parseFloat($(cols[4]).text().replace(/,/g, "")) || 0;
    return null;
  }

  function qtGetOwnedShares(id, bypassCache) {
    var domVal = qtReadOwnedFromDom(id);
    if (!bypassCache && qt_localShareCache[id] !== undefined) {
      // The cache holds the true post-trade count while Torn's DOM still shows the
      // pre-trade value (a direct-POST trade doesn't re-render the share count). If
      // the DOM is momentarily unreadable (null, e.g. mid-render) keep trusting the
      // cache — a transient blank must not be mistaken for a real change. Otherwise
      // trust the cache only while the DOM is unchanged from when we cached; once the
      // DOM actually moves — our trade finally reflected, OR the user traded this
      // stock via Torn's native UI — the cached value is stale, so drop it and trust
      // the DOM again. Without this the cache would never yield back within a session.
      if (domVal === null) return qt_localShareCache[id].val;
      if (qt_localShareCache[id].domAtWrite === domVal) return qt_localShareCache[id].val;
      delete qt_localShareCache[id];
    }
    return domVal === null ? 0 : domVal;
  }

  function qtUpdateLocalCache(sym, amt) {
    var domNow = qtReadOwnedFromDom(sym);
    var cached = qt_localShareCache[sym];
    // Re-validate before building on the cache: reuse the cached count only when the
    // DOM is unchanged from when it was written (still valid) or currently unreadable
    // (can't tell — keep our known truth). If the DOM has actually moved since, the
    // cached base is stale (a native-UI trade happened), so re-anchor to the DOM. With
    // no cache and an unreadable DOM we have no basis, so fall back to 0 as before.
    var base;
    if (cached !== undefined && (domNow === null || cached.domAtWrite === domNow)) {
      base = cached.val;
    } else if (domNow !== null) {
      base = domNow;
    } else {
      base = 0;
    }
    qt_localShareCache[sym] = { val: Math.max(0, base + amt), domAtWrite: domNow };
  }

  // Reconcile a trade against the last loaded position, never against the API.
  // DOM echoes of a Quick Trade have no delta and cannot apply the buy twice.
  function applyLocalTrade(sym, deferRender) {
    if (!lastOwnedMap) return false;
    var old = lastOwnedMap[sym];
    var oldShares = old ? old.shares : 0;
    var shares = qtGetOwnedShares(sym);
    if (shares === oldShares) return false;
    var price = qtGetPrice(sym);
    var delta = shares - oldShares;
    if (shares <= 0) {
      delete lastOwnedMap[sym];
    } else {
      var o = old;
      if (!o) {
        var id = Object.keys(STOCK_ID_MAP).find(function(k) { return STOCK_ID_MAP[k] === sym; });
        var stocks = {};
        stocks[id] = { dividend: PASSIVE_STOCKS.indexOf(sym) < 0 ? {} : undefined,
          transactions: { local: { shares: shares, bought_price: price,
            time_bought: Math.floor(Date.now() / 1000) } } };
        o = buildOwnedMap({ stocks: stocks })[sym];
        if (!o) return false;
        lastOwnedMap[sym] = o;
      } else {
        if (delta > 0) {
          o.avg_price = ((o.avg_price || 0) * oldShares + price * delta) / shares;
          o.transactions.unshift({ shares: delta, bought_price: price, time_bought: Math.floor(Date.now() / 1000) });
        } else {
          // Swing cost basis uses the newest lots first, just like the trade log.
          var remaining = -delta;
          o.transactions = o.transactions.map(function(t) {
            var take = Math.min(t.shares || 0, remaining);
            remaining -= take;
            return Object.assign({}, t, { shares: (t.shares || 0) - take });
          }).filter(function(t) { return t.shares > 0; });
        }
        o.shares = shares;
      }
      // Only Torn's payout can credit a higher tier; sells can lower it locally.
      o.dividend_increment = Math.min(o.dividend_increment || 0, qtGetBenefitTier(sym, shares).tier);
      o.has_dividend = o.dividend_increment > 0;
    }
    enrichOwnedMap(lastOwnedMap, lastRaw);
    if (lastRaw && price > 0) {
      var live = lastRaw.find(function(r) { return r.stock === sym; });
      if (live) live.price = String(price);
      else lastRaw.push({ stock: sym, price: String(price), interval: {} });
    }
    if (!deferRender) qtRenderLocalTrade();
    return true;
  }

  function qtRenderLocalTrade() {
    if (!lastOwnedMap || !lastRaw) return;
    renderFromData(lastOwnedMap, lastRaw, lastMissingBatches, true, true);
    qtRenderConsequence(null);
  }

  var qtOwnedObserver = null;
  var qtOwnedCounts = {};
  var qtOwnedFrame = null;

  function qtObserveOwnedList() {
    if (qtOwnedObserver) return;
    var attached = false;
    function attach() {
      if (!document.querySelector("ul[class^='stock_']")) return false;
      qtOwnedObserver.disconnect();
      qtBuildMaps();
      Object.keys(qt_stockRows).forEach(function(sym) {
        var value = qtReadOwnedFromDom(sym);
        if (value !== null) qtOwnedCounts[sym] = value;
      });
      // The body survives React replacing individual rows or the whole list.
      qtOwnedObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
      attached = true;
      return true;
    }
    qtOwnedObserver = new MutationObserver(function() {
      if (!attached) { attach(); return; }
      if (qtOwnedFrame !== null) return;
      qtOwnedFrame = requestAnimationFrame(function() {
        qtOwnedFrame = null;
        qtBuildMaps();
        var changed = false;
        Object.keys(qt_stockRows).forEach(function(sym) {
          var value = qtReadOwnedFromDom(sym);
          if (value === null || value === qtOwnedCounts[sym]) return;
          qtOwnedCounts[sym] = value;
          if (applyLocalTrade(sym, true)) changed = true;
        });
        if (changed) qtRenderLocalTrade();
      });
    });
    if (!attach()) {
      // Wait once for Torn's initial list, without polling or observing each row.
      qtOwnedObserver.observe(document, { childList: true, subtree: true });
    }
  }

  function qtGetMoneyFast() {
    // Guard against a non-numeric data-money attribute: NaN slips past every
    // caller's <= 0 / cost-comparison guard (NaN compares false to anything),
    // so an unreadable value must collapse to the text fallback / 0 instead.
    var n = parseFloat($("#user-money").attr("data-money"));
    if (isFinite(n) && n > 0) return n;
    var textMoney = $("#user-money").text();
    return textMoney ? qtParseTornNumber(textMoney) : 0;
  }

  // Returns the user's current benefit tier number for `sym` (T1, T2, T3...
  // → 1, 2, 3...) given their owned share count, plus the cumulative shares
  // needed to reach the NEXT tier. Torn benefit blocks stack at thresholds
  // (2^n - 1) × BENEFIT_REQ[sym]: T1 = 1×req, T2 = 3×req, T3 = 7×req, T4 = 15×req, etc.
  function qtGetBenefitTier(sym, shares) {
    var data = BENEFIT_REQ[sym];
    if (!data) return { tier: 0, next: 0 };
    if (PASSIVE_STOCKS.indexOf(sym) >= 0) {
      return (shares >= data) ? { tier: 1, next: data } : { tier: 0, next: data };
    }
    if (shares < data) return { tier: 0, next: data };
    // Largest n such that shares >= (2^n - 1) * data.
    var tier = 1;
    while (shares >= (Math.pow(2, tier + 1) - 1) * data) tier++;
    return { tier: tier, next: (Math.pow(2, tier + 1) - 1) * data };
  }

  // Trades are submitted directly via POST to Torn's stock-market endpoint.
  // One user click fires one POST — $.ajax runs same-origin so the browser
  // attaches session cookies automatically.
  //
  // Endpoint (verified against three independent public scripts):
  //   POST https://www.torn.com/page.php?sid=StockMarket
  //        &step=buyShares|sellShares
  //        &rfcv=<token from rfc_v cookie>
  //   Body:    stockId=<DOM id from <ul class="stock_*">>&amount=<shares>
  //   Response: JSON { success: true } / { success: false, message|text }

  function qtGetRfc() {
    var m = document.cookie.match(/(?:^|;\s*)rfc_v=([^;]+)/);
    return m ? m[1] : "";
  }

  function qtPostTrade(stockId, shares, action) {
    return new Promise(function(resolve) {
      var rfc = qtGetRfc();
      if (!rfc) { resolve({ success: false, message: "Missing rfc_v cookie — reload the page and try again" }); return; }
      if (!stockId) { resolve({ success: false, message: "Missing stockId — DOM not yet built" }); return; }
      var url = "https://www.torn.com/page.php?sid=StockMarket" +
                "&step=" + encodeURIComponent(action) +
                "&rfcv=" + encodeURIComponent(rfc);
      var body = "stockId=" + encodeURIComponent(stockId) +
                 "&amount=" + encodeURIComponent(shares);
      // Use jQuery $.ajax (same-origin XHR from the page) rather than
      // GM_xmlhttpRequest. The extension context doesn't carry session cookies
      // reliably for torn.com, causing Torn to return the full HTML page.
      // $.ajax matches how all reference scripts (Stock Manager & Advisor v7.6,
      // Smart Stock Vault) make this call.
      $.ajax({
        type: "POST",
        url: url,
        data: body,
        timeout: 15000,
        success: function(data) {
          if (typeof data === "string") {
            try { data = JSON.parse(data); }
            catch(e) {
              try { data = JSON.parse(JSON.parse(data)); }
              catch(_) { resolve({ success: false, message: "Unparseable response: " + data.slice(0, 200) }); return; }
            }
          }
          resolve(data);
        },
        error: function(jqXHR, textStatus) {
          resolve({ success: false, message: textStatus === "timeout" ? "Request timed out" : "Network error: " + jqXHR.status });
        }
      });
    });
  }

  // Public entry. One user click → one POST. Matches the pattern used by all
  // three reference scripts (Stock Manager & Advisor, Smart Stock Vault,
  // Smart Stock Vault Panic Navbar). Torn's rule requires that non-API
  // requests be directly user-initiated, which a button-triggered POST is.
  async function qtUiTrade(symb, shares, action, label, options) {
    if (!shares || !isFinite(shares) || shares < 1) {
      showToast("Invalid share count for " + symb, "error");
      return false;
    }
    return await qtFireTrade({
      symb: symb,
      shareCount: shares,
      action: action,
      label: label,
      blockMaxShares: options && options.blockMaxShares
    });
  }

  // Fires exactly one POST to Torn's stock endpoint per user click.
  async function qtFireTrade(pending) {
    var symb = pending.symb;
    var shares = pending.shareCount;
    var action = pending.action;
    var label = pending.label;
    var blockMaxShares = pending.blockMaxShares;

    // Defense-in-depth: refresh DOM maps so qt_stockId is populated even if
    // qtBuildMaps hasn't run since the page loaded.
    qtBuildMaps();
    var stockId = qt_stockId[symb];
    if (!stockId) { showToast("Stock card not found for " + symb + " — reload the page", "error"); return false; }

    // Block-sell guard: cheap pre-flight. The share count we send IS what
    // gets traded — no DOM mirror to drift against, so a single comparison
    // is sufficient. (Replaces the multi-stage mirror-verification dance
    // the old DOM-clicking path needed.)
    if (blockMaxShares != null && shares > blockMaxShares) {
      showToast("Block sell aborted: requested " + shares.toLocaleString("en-US") +
                " > block max " + blockMaxShares.toLocaleString("en-US"), "error");
      return false;
    }

    // Capture the live price BEFORE the POST — Torn may have shifted by the
    // time the response comes back, so we snapshot the price the user
    // actually clicked at. Persisted only on success (see below) to avoid
    // leaving a stale intent for a failed buy, which would spuriously
    // trigger the slippage detector against the user's existing position.
    var intentPrice = null;
    if (action === "buyShares") {
      var p = qtGetPrice(symb);
      if (p > 0) intentPrice = p;
    }

    var resp = await qtPostTrade(stockId, shares, action);

    // First 3 responses go to console.log so a fresh install can verify the
    // response shape matches what we coded against. Self-disables after 3.
    // (Remove localStorage key `tsa_post_logged_count` to re-arm.)
    var logged = parseInt(lsGet("tsa_post_logged_count", "0"), 10) || 0;
    if (logged < 3) {
      try { console.log("[TSA] POST response #" + (logged + 1), resp); } catch(e) {}
      lsSet("tsa_post_logged_count", String(logged + 1));
    }

    if (!resp || !resp.success) {
      var rawMsg = (resp && (resp.message || resp.text)) || "unknown error";
      showToast("Trade failed: " + rawMsg, "error");
      return false;
    }

    if (intentPrice !== null) {
      lsSet("qt_intent_" + symb, JSON.stringify({ price: intentPrice, ts: Math.floor(Date.now() / 1000) }));
    }
    qtUpdateLocalCache(symb, action === "buyShares" ? shares : -shares);
    applyLocalTrade(symb);
    // Laid over Dossier's /me until its next poll has the trade (up to ~5 min).
    // Logged whenever a licence key is stored, not only while this load came from
    // Dossier: a trade made on a fallback (free-mode) load is still missing from
    // Dossier's /me when the next load is a licence load, and without the log that
    // load would show the old holdings. applyTradeLog skips a trade the poll
    // already has (ts <= source_ts). Free mode itself reads Torn, which has it.
    if (licenceKeyStored()) TSAData.logTrade(licenseDeps, symb, action === "buyShares" ? shares : -shares, intentPrice || qtGetPrice(symb));
    showToast(label, "success");
    // The preview line described a trade that has now happened. The pointer is still
    // resting on the button, so no mouseenter or blur will fire to clear it — without
    // this the line keeps asserting "25M buys 1,234 shares" about a completed trade,
    // and a second click would be judged against pre-trade cash and holdings. Reset to
    // the idle state, which re-reads price and holding from the updated cache.
    qtRenderConsequence(null);
    return true;
  }

  // ── TheALFA's exact vault() ──
  function qtVault(symb) {
    var money = qtGetMoneyFast();
    if (money === 0) { showToast("No money found", "warn"); return; }
    var price = qtGetPrice(symb);
    if (price <= 0) { showToast("Could not read price for " + symb, "error"); return; }
    var amt = Math.floor(money / price);
    if (amt <= 0) { showToast("Amount too small", "warn"); return; }
    qtUiTrade(symb, amt, "buyShares", "Vaulted $" + (amt*price).toLocaleString("en-US") + " (" + amt + " shares)");
  }

  // ── TheALFA's exact withdraw() ──
  // ── Shared benefit lock check — used by all three sell paths ──
  // Returns max shares that can be safely sold (Infinity = no restriction).
  // Blocks by returning 0 when all shares are locked or count is unverifiable.
  function qtBenefitLockMax(symb) {
    // ROI-skipped stocks are excluded from the Benefit Lock entirely — the user
    // explicitly opted them out via the planner's ✕ skip, so treat them as
    // having no benefit restriction (fully sellable). Must sit ABOVE both the
    // precise benefit_shares path and the BENEFIT_REQ fallback.
    if (roiSymSkipped(symb)) return Infinity;
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
      // Honour the ROI-planner tier cap: only the tiers up to the cap are held
      // back; shares above it are swing/sellable. (The precise path above already
      // reflects the cap via enriched benefit_shares — this fallback runs only
      // before the TSA panel has loaded.)
      var effTier = Math.min(curTier.tier, roiSymTierCap(symb));
      if (effTier <= 0) return Infinity; // cap 0 → no shares held back
      // Max sellable = current owned minus shares needed to stay at the capped tier.
      // Active benefit blocks need the cumulative threshold (2^tier - 1) × req
      // to maintain that tier, NOT just `tier × req` — selling down to tier × req
      // would drop the user to a lower tier. Passive stocks are single-tier so
      // they only need `req` shares total.
      var keepShares = PASSIVE_STOCKS.indexOf(symb) >= 0
        ? BENEFIT_REQ[symb]
        : (Math.pow(2, effTier) - 1) * BENEFIT_REQ[symb];
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
      showToast("Benefit Lock: Capped to " + maxSell.toLocaleString("en-US") + " swing shares", "warn");
      return maxSell;
    }
    return shares;
  }

  function qtWithdrawAll(symb) {
    var owned = qtGetOwnedShares(symb);
    if (owned <= 0) { showToast("You have no shares of " + symb, "warn"); return; }
    var sellAmt = qtApplyBenefitLock(symb, owned);
    if (sellAmt === null) return;
    qtUiTrade(symb, sellAmt, "sellShares", "Sold all " + sellAmt.toLocaleString("en-US") + " shares", { blockMaxShares: sellAmt });
  }

  function fmtQtAmt(n) {
    n = Math.abs(n || 0);
    if (n >= 1e9) return (n/1e9 % 1 === 0 ? n/1e9 : (n/1e9).toFixed(1)) + "B";
    if (n >= 1e6) return (n/1e6 % 1 === 0 ? n/1e6 : (n/1e6).toFixed(1)) + "M";
    if (n >= 1e3) return Math.round(n/1e3) + "K";
    return "$" + n;
  }

  function saveQtAmounts() { lsSet("qt_amounts", JSON.stringify(qtAmounts)); }

  // Quick Buy pill budget: a single optional $ amount applied to every Quick Buy
  // pill click. 0 / unset = buy with all available cash (qtVault), preserving the
  // original behaviour. Set via the ⚙ in the Quick Buy pill header.
  function getQtBuyPillAmt() {
    var n = parseInt(lsGet("qt_buy_pill_amount", "0"), 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }
  // Swing sell pill budget: a single optional $ amount applied to every Swing
  // pill click. 0 / unset = sell the whole swing position (original behaviour).
  // Set via the ⚙ in the Swing pill header.
  function getQtSellPillAmt() {
    var n = parseInt(lsGet("qt_sell_pill_amount", "0"), 10);
    return (isFinite(n) && n > 0) ? n : 0;
  }
  // Parse a money string like "25m", "1.5b", "500k", "25000000", "$25,000,000".
  // Returns 0 for blank/invalid (→ all-cash fallback).
  function parseQtMoney(str) {
    if (str == null) return 0;
    str = String(str).trim().toLowerCase().replace(/[$,\s]/g, "");
    if (!str) return 0;
    var mult = 1, last = str.charAt(str.length - 1);
    if (last === "k") { mult = 1e3; str = str.slice(0, -1); }
    else if (last === "m") { mult = 1e6; str = str.slice(0, -1); }
    else if (last === "b") { mult = 1e9; str = str.slice(0, -1); }
    var n = parseFloat(str);
    return (isFinite(n) && n > 0) ? Math.floor(n * mult) : 0;
  }

  function qtUpdateExec() {
    var stock = document.getElementById("qt-stock") ? document.getElementById("qt-stock").value : "";
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
    qtUiTrade(sym, amt, "buyShares", "Bought " + amt.toLocaleString("en-US") + " " + sym);
  }

  function qtExecuteSell(sym, dollarAmt) {
    qtBuildMaps();
    if (!sym) { showToast("Select a stock first.", "warn"); return; }
    var price = qtGetPrice(sym);
    if (price <= 0) { showToast("Could not read price for " + sym, "error"); return; }
    var owned = qtGetOwnedShares(sym);
    if (owned <= 0) { showToast("You have no shares of " + sym, "warn"); return; }
    var shares = Math.ceil((dollarAmt / SELL_FEE) / price);
    if (shares > owned) shares = owned;
    shares = qtApplyBenefitLock(sym, shares);
    if (shares === null) return;
    qtUiTrade(sym, shares, "sellShares", "Sold " + shares.toLocaleString("en-US") + " " + sym, { blockMaxShares: shares });
  }

  function createAmountBtn(label, amt, mode, idx) {
    var btn = document.createElement("button");
    var isBuy = mode === "buy";
    // One row now serves both directions, so the amount buttons carry the colour of
    // whichever way the bar points. Colour alone never decides what a click does —
    // the direction toggle above states it in words, and the line below spells out
    // the consequence — but the buttons still have to LOOK like what they will do.
    var buyBorder  = "var(--tsa-pos-border)";
    var buyBg      = "var(--tsa-pos-bg)";
    var buyColor   = "var(--tsa-pos)";
    var sellBorder = "var(--tsa-neg-border)";
    var sellBg     = "var(--tsa-neg-bg)";
    var sellColor  = "var(--tsa-neg)";
    btn.style.cssText = "position:relative;padding:6px 9px;border-radius:var(--tsa-r-2);border:1px solid " +
      (isBuy ? buyBorder : sellBorder) +
      ";background:" + (isBuy ? buyBg : sellBg) +
      ";color:" + (isBuy ? buyColor : sellColor) +
      ";font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;";
    btn.textContent = label;

    if (qtEditMode) {
      // Del button
      var del = document.createElement("span");
      del.textContent = "✕";
      del.style.cssText = "position:absolute;top:-6px;right:-6px;width:16px;height:16px;border-radius:var(--tsa-r-circle);background:var(--tsa-neg);color:var(--tsa-on-badge);font-size:var(--tsa-fs-micro);line-height:16px;text-align:center;cursor:pointer;";
      del.onclick = function(e) {
        e.stopPropagation();
        qtAmounts.splice(idx, 1);
        saveQtAmounts(); renderQtRows();
      };
      btn.appendChild(del);
      // Click to edit value
      btn.onclick = function() {
        // parseQtMoney accepts the same 25m/1.5b/500k shorthand the pill
        // budget prompts teach; prompt is pre-filled in the same format.
        var newVal = parseQtMoney(prompt("Edit amount (e.g. 25m):", fmtQtAmt(amt)));
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
      // Focus as well as hover: the row is keyboard-reachable, and a keyboard user
      // needs the same answer a mouse user gets.
      var show = function() { qtRenderConsequence({ amt: amt, all: false }); };
      btn.addEventListener("mouseenter", show);
      btn.addEventListener("focus", show);
      var clear = function() { qtRenderConsequence(null); };
      btn.addEventListener("mouseleave", clear);
      btn.addEventListener("blur", clear);
    }
    return btn;
  }

  // What the next click will actually do, in shares — the bar asks for money but a
  // benefit tier is counted in shares, so "25M" alone never answered the question
  // the user was really asking. Empty until a button is hovered or focused.
  // Every number here is computed with the EXECUTOR's own formula, not a plausible
  // approximation of it — qtExecuteSell grosses up for the 0.1% fee and rounds UP,
  // qtExecuteBuy clamps to cash on hand and rounds DOWN. A preview that disagrees
  // with the trade by even one share is worse than no preview, because the whole
  // point of the line is that it is exact.
  //
  // The idle state shows price and holding rather than "hover an amount": on touch
  // (TornPDA) mouseenter fires as part of the tap that also trades, so a hover-only
  // line would arrive at or after the trade it was meant to explain.
  //
  // ⚠️ KNOWN LIMIT: the PER-AMOUNT preview is therefore desktop-only in practice. On
  // touch the idle line still gives price, holding and the armed direction before any
  // tap, but the exact share count for a specific amount cannot be read before the
  // trade fires. A tap-to-preview / tap-again-to-trade path would fix it and is the
  // obvious next step if mis-taps happen on the phone.
  function qtRenderConsequence(btnInfo) {
    var el = document.getElementById("qt-consequence");
    if (!el) return;
    var dim = "var(--tsa-fg-muted)";
    var live = "var(--tsa-fg-strong)";
    var accent = qtDir === "buy" ? "var(--tsa-pos)" : "var(--tsa-neg)";
    var quiet = function(msg) {
      el.textContent = msg;
      el.style.color = dim;
      el.style.borderLeftColor = "transparent";
    };

    var sym = document.getElementById("qt-stock") ? document.getElementById("qt-stock").value : "";
    if (!sym) { quiet("Select a stock to see what a trade would do."); return; }
    // The maps must be fresh — a Torn re-render leaves the cached jQuery nodes
    // detached, which would make the preview quietly disagree with the trade. But
    // rebuilding on every mouseenter re-walks all 35 cards once per button as the
    // pointer slides along the row, so throttle it: the DOM cannot go stale faster
    // than Torn re-renders.
    if (!qt_stocks[sym] || (btnInfo && Date.now() - qtMapsBuiltAt > 1000)) {
      qtBuildMaps();
      qtMapsBuiltAt = Date.now();
    }

    // qt_stocks is keyed by SYMBOL — qtGetPrice's parameter is named `id` but all its
    // other call sites pass the symbol. qt_stockId holds Torn's DOM id, for the POST.
    var price = qtGetPrice(sym);
    var owned = qtGetOwnedShares(sym);
    if (!price) { quiet("Price not readable on this page yet."); return; }

    if (!btnInfo) {
      quiet(sym + " $" + price.toLocaleString("en-US") +
            (owned > 0 ? "  ·  you hold " + owned.toLocaleString("en-US") : "  ·  none held"));
      return;
    }

    var txt;
    if (qtDir === "buy") {
      // Mirrors qtExecuteBuy: clamp to cash, then floor.
      var money = qtGetMoneyFast();
      var wanted = btnInfo.all ? (money > 0 ? money : 0) : btnInfo.amt;
      var spend = (money > 0 && wanted > money) ? money : wanted;
      var sh = Math.floor(spend / price);
      if (sh <= 0) {
        txt = "Not enough cash for a single share at $" + price.toLocaleString("en-US");
      } else {
        var now = qtGetBenefitTier(sym, owned);
        var after = qtGetBenefitTier(sym, owned + sh);
        txt = (spend < wanted ? "$" + spend.toLocaleString("en-US") : fmtQtAmt(spend)) +
              " buys " + sh.toLocaleString("en-US") + " shares at $" +
              price.toLocaleString("en-US") +
              (spend < wanted ? "  ·  capped by cash on hand" : "") +
              // Only claim a tier when the share count is trustworthy: qtGetOwnedShares
              // collapses an unreadable count to 0, which would promise a tier the user
              // may already be past.
              (qtReadOwnedFromDom(sym) !== null && after.tier > now.tier
                ? "  ·  reaches T" + after.tier : "");
      }
    } else {
      if (owned <= 0) {
        txt = "You hold no " + sym + " to sell.";
      } else {
        // Mirrors qtExecuteSell: gross up for the fee, round UP, clamp to owned,
        // then apply the lock. qtBenefitLockMax is the lock's single source of truth.
        var want = btnInfo.all ? owned : Math.ceil((btnInfo.amt / SELL_FEE) / price);
        if (want > owned) want = owned;
        var maxSell = $("#qt-lock-benefit").is(":checked") ? qtBenefitLockMax(sym) : Infinity;
        if (maxSell === -1) {
          // Defence-in-depth only: qtBenefitLockMax returns -1 when it reads zero
          // shares, which the `owned <= 0` branch above has already caught. Kept so a
          // future change to either function cannot silently produce a wrong promise.
          txt = "Share count not readable — the lock will block this for safety.";
        } else if (maxSell === 0) {
          txt = "Every share is in a benefit block — the lock will refuse this.";
        } else {
          // Two different caps can bind: your holding (already applied to `want`
          // above, and self-evident from "N of your N") and the lock. Only the lock
          // gets named, because only the lock is a setting the reader can change.
          var capped = (maxSell !== Infinity && maxSell < want);
          var actual = capped ? maxSell : want;
          txt = "Sells " + actual.toLocaleString("en-US") + " of your " +
                owned.toLocaleString("en-US") + " shares" +
                (capped ? "  ·  capped by Benefit Lock" : "");
        }
      }
    }
    el.textContent = txt;
    el.style.color = live;
    el.style.borderLeftColor = accent;
  }

  function renderQtRows() {
    var row = document.getElementById("qt-amount-row");
    if (!row) return;
    row.innerHTML = "";
    var isBuy = qtDir === "buy";

    qtAmounts.forEach(function(amt, idx) {
      row.appendChild(createAmountBtn(fmtQtAmt(amt), amt, qtDir, idx));
    });

    // ALL means two different things depending on direction — vault everything in,
    // or withdraw everything out. Same button, because the direction toggle has
    // already said which one you are asking for.
    var allBtn = document.createElement("button");
    allBtn.title = isBuy
      ? "Vault — buy max shares with all available cash"
      : "Withdraw all — sell every share of this stock (respects Benefit Lock)";
    var bd = isBuy ? "var(--tsa-pos-border)" : "var(--tsa-neg-border)";
    var bg = isBuy ? "var(--tsa-pos-bg-hi)"  : "var(--tsa-neg-bg-hi)";
    var fg = isBuy ? "var(--tsa-pos)"        : "var(--tsa-neg)";
    allBtn.style.cssText = "padding:6px 9px;border-radius:var(--tsa-r-2);border:1px solid " + bd +
      ";background:" + bg + ";color:" + fg +
      ";font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;";
    allBtn.textContent = "ALL";
    allBtn.onclick = function() {
      var s = $("#qt-stock").val();
      if (!s) { showToast("Select a stock first.", "warn"); return; }
      qtBuildMaps();
      if (isBuy) qtVault(s); else qtWithdrawAll(s);
    };
    var showAll = function() { qtRenderConsequence({ amt: 0, all: true }); };
    allBtn.addEventListener("mouseenter", showAll);
    allBtn.addEventListener("focus", showAll);
    var clearAll = function() { qtRenderConsequence(null); };
    allBtn.addEventListener("mouseleave", clearAll);
    allBtn.addEventListener("blur", clearAll);
    row.appendChild(allBtn);

    if (qtEditMode) {
      var addBtn = document.createElement("button");
      addBtn.style.cssText = "padding:6px 10px;border-radius:var(--tsa-r-2);border:1px dashed var(--tsa-border);background:transparent;color:var(--tsa-accent);font-family:var(--tsa-mono);font-size:var(--tsa-fs-body);cursor:pointer;flex-shrink:0;";
      addBtn.textContent = "+";
      addBtn.onclick = function() {
        var val = parseQtMoney(prompt("Enter amount in $ (e.g. 25m or 25000000):"));
        if (val > 0) { qtAmounts.push(val); qtAmounts.sort(function(a,b){return a-b;}); saveQtAmounts(); renderQtRows(); }
      };
      row.appendChild(addBtn);
    }

    // Repaint the direction toggle so the active side is unmistakable.
    var bBuy = document.getElementById("qt-dir-buy");
    var bSell = document.getElementById("qt-dir-sell");
    if (bBuy && bSell) {
      bBuy.style.opacity = isBuy ? "1" : "0.4";
      bSell.style.opacity = isBuy ? "0.4" : "1";
      bBuy.style.background = isBuy ? "var(--tsa-pos-bg-hi)" : "transparent";
      bBuy.style.color = isBuy ? "var(--tsa-pos)" : "var(--tsa-fg-muted)";
      bSell.style.background = isBuy ? "transparent" : "var(--tsa-neg-bg-hi)";
      bSell.style.color = isBuy ? "var(--tsa-fg-muted)" : "var(--tsa-neg)";
      bBuy.setAttribute("aria-pressed", isBuy ? "true" : "false");
      bSell.setAttribute("aria-pressed", isBuy ? "false" : "true");
    }
    // Reset the idle line on every re-render, not just on a direction click: this
    // function also runs at load, on theme change and when edit mode toggles, and a
    // line left over from before the re-render would describe the wrong state.
    qtRenderConsequence(null);
  }

  // ── torn-stock-pocket-style Quick pills ──────────────────────────────────
  // Buy pills (one per Top-5 buy stock, vault all cash) and Swing sell pills
  // (one per swing holding, showing profit-if-sold-now net of the 0.1% fee).
  // Same one-click POST flow as the rest of the QT bar — no new mechanism.
  var qtPillCssInjected = false;
  function injectQtPillCss() {
    if (qtPillCssInjected) return;
    qtPillCssInjected = true;
    var st = document.createElement("style");
    st.textContent =
      ".qt-pill{display:inline-flex;align-items:center;gap:6px;border-radius:var(--tsa-r-2);border:1px solid;padding:5px 8px;" +
        "font-family:var(--tsa-sans);font-size:var(--tsa-fs-micro);font-weight:600;line-height:1;cursor:pointer;" +
        "user-select:none;transition:filter .12s,transform .05s;white-space:nowrap;}" +
      ".qt-pill:active{transform:scale(0.96);}" +
      ".qt-pills-light .qt-pill:hover{filter:brightness(0.95);}" +
      ".qt-pills-dark .qt-pill:hover{filter:brightness(1.12);}" +
      ".qt-pill img{width:18px;height:18px;display:block;margin:-2px 0;flex-shrink:0;}" +
      ".qt-pill .qt-pill-badge{color:var(--tsa-on-badge);border-radius:var(--tsa-r-1);padding:2px 5px;font-size:var(--tsa-fs-micro);font-weight:800;" +
        "text-transform:uppercase;letter-spacing:.03em;}" +
      ".qt-pill-group-label{font-size:var(--tsa-fs-micro);font-weight:700;letter-spacing:.06em;text-transform:uppercase;" +
        "font-family:var(--tsa-mono);margin:0 0 5px 2px;display:block;}" +
      ".qt-pill .qt-pill-sub{font-size:var(--tsa-fs-micro);opacity:0.65;}" +
      // Sell pill + its mini "buy more" pill stay glued together as one unit when the row wraps.
      ".qt-pill-pair{display:inline-flex;gap:4px;align-items:stretch;}" +
      // Compact green buy-more pill: no logo/badge, just a bold ＋.
      ".qt-pill-mini{padding:5px 9px;font-size:var(--tsa-fs-body);font-weight:800;gap:0;}" +
      ".qt-pill-row{display:flex;flex-wrap:wrap;gap:6px;}";
    document.head.appendChild(st);
  }

  // Centralizes #qt-bar / row1 / body / pills visibility. Rules:
  //  - bar shown:                full bar (body respects minimize) + pills
  //  - bar shown, minimized:     row1 + pills, body hidden (pills survive minimize)
  //  - bar hidden + pills-always + has pills: slim chrome-less strip with only pills
  //  - otherwise:                bar fully hidden
  function applyQtBarVisibility() {
    var bar = document.getElementById("qt-bar");
    if (!bar) return;
    var row1 = document.getElementById("qt-row1");
    var body = document.getElementById("qt-body");
    var pills = document.getElementById("qt-pills");
    var showBar = getShowQtBar();
    var hasPills = (lastBuySymbols && lastBuySymbols.length > 0) || (lastSwingPills && lastSwingPills.length > 0) || !!lastBestRec;
    var pillsVisible = hasPills && (showBar || getPillsAlways());
    var minimized = lsGet("qt_minimized", "false") === "true";
    bar.classList.toggle("qt-minimized", minimized);

    if (pills) pills.style.display = pillsVisible ? "block" : "none";

    if (showBar) {
      bar.style.display = "";
      // "flex", not "" — an empty string CLEARS the inline display and the div falls
      // back to block, which stacked the stock picker, ✎ and Benefit Lock on four
      // separate lines. There is no #qt-row1 rule in STYLES to fall back to.
      if (row1) row1.style.display = "flex";
      if (body) body.style.display = minimized ? "none" : "block";
    } else {
      bar.style.display = "none";
    }
  }

  function qtFmtNum(n) {
    var a = Math.abs(n || 0), s;
    if (a >= 1e9) s = (a / 1e9).toFixed(2) + "B";
    else if (a >= 1e6) s = (a / 1e6).toFixed(2) + "M";
    else if (a >= 1e3) s = (a / 1e3).toFixed(1) + "K";
    else s = String(Math.round(a));
    return s;
  }
  function qtFmtDollar(n) {
    return "$" + qtFmtNum(n);
  }
  function qtFmtSignedDollar(n) {
    return (n < 0 ? "-" : "+") + qtFmtDollar(n);
  }

  // Money polarity, from the shared token set. isDark is kept in the signature so no
  // call site changes; the tokens switch themselves on the root's tsa-dark class.
  function qtPillPalette(positive, isDark) {
    if (positive) {
      return { border: "var(--tsa-pos-border)", bg: "var(--tsa-pos-bg)", text: "var(--tsa-pos)", badge: "var(--tsa-pos)" };
    }
    return { border: "var(--tsa-neg-border)", bg: "var(--tsa-neg-bg)", text: "var(--tsa-neg)", badge: "var(--tsa-neg)" };
  }

  // Blue palette for the ROI "bank" pill (distinct from green buy / red sell)
  function qtPillPaletteBank(isDark) {
    return { border: "var(--tsa-bank-border)", bg: "var(--tsa-bank-bg)", text: "var(--tsa-bank)", badge: "var(--tsa-bank)" };
  }

  // Bridgebuilder pill palettes: teal when affordable now (distinct from
  // buy-green and bank-blue), amber while still saving up.
  function qtPillPaletteBridge(affordable, isDark) {
    if (affordable) {
      return { border: "var(--tsa-bridge-border)", bg: "var(--tsa-bridge-bg)", text: "var(--tsa-bridge)", badge: "var(--tsa-bridge)" };
    }
    // still saving up: the one amber in the set, shared with the benefit-lock label
    return { border: "var(--tsa-warn-border)", bg: "var(--tsa-warn-bg)", text: "var(--tsa-warn)", badge: "var(--tsa-warn)" };
  }

  // Purple palette for the Upgrade swap pill — visually distinct from buy-green,
  // sell-red, bank-blue and bridge-teal/amber so the swap action stands apart.
  function qtPillPaletteUpgrade(isDark) {
    return { border: "var(--tsa-swap-border)", bg: "var(--tsa-swap-bg)", text: "var(--tsa-swap)", badge: "var(--tsa-swap)" };
  }

  function makeQtPill(sym, positive, labelText, isDark, onClick, subText, palOverride) {
    var pal = palOverride || qtPillPalette(positive, isDark);
    var btn = document.createElement("button");
    btn.className = "qt-pill";
    btn.style.border = "1px solid " + pal.border;
    btn.style.background = pal.bg;
    btn.style.color = pal.text;
    var img = document.createElement("img");
    img.src = "https://www.torn.com/images/v2/stock-market/dark-mode/logos/" + sym + ".svg";
    img.alt = sym;
    img.onerror = function() { this.style.display = "none"; };
    btn.appendChild(img);
    var badge = document.createElement("span");
    badge.className = "qt-pill-badge";
    badge.style.background = pal.badge;
    badge.textContent = sym;
    btn.appendChild(badge);
    var lbl = document.createElement("span");
    lbl.textContent = labelText;
    btn.appendChild(lbl);
    if (subText) {
      var sub = document.createElement("span");
      sub.className = "qt-pill-sub";
      sub.textContent = subText;
      btn.appendChild(sub);
    }
    btn.onclick = onClick;
    return btn;
  }

  // Live-price re-check for an Upgrade swap. computeUpgradeSwap plans against the last
  // API snapshot, which can be stale; before we ever sell a benefit block we re-price
  // the WHOLE remaining plan against CURRENT stock prices (qtGetPrice), so a price drop
  // since the snapshot — a real loss on the sale — shrinks the proceeds we count.
  // `remainingSells` = the sell units not yet executed; `buy` = the target tier.
  // Returns null if any remaining sell's price/shares are unreadable (never sell blind);
  // otherwise live numbers + flags:
  //   affordable        = on-hand cash + live proceeds of ALL remaining sells >= live buy cost
  //   alreadyAffordable = on-hand cash alone already covers the buy (skip remaining sells)
  //   nextSell          = the next unit to sell, re-priced and clamped to live owned shares
  // Conservative on purpose: proceeds are clamped to live owned shares (decremented per
  // stock across the plan), so a multi-tier sell of one stock never over-counts.
  function qtUpgradeLiveCheck(remainingSells, buy, expectedCash) {
    if (!buy || !remainingSells) return null;
    qtBuildMaps();
    var buyPrice = qtGetPrice(buy.sym);
    if (buyPrice <= 0) return null;
    var liveBuyCost = buy.shares * buyPrice;
    // Cash floor = larger of live DOM money and the cash we KNOW we have this
    // upgrade (starting on-hand cash + proceeds of every completed sell). A
    // direct-POST sale may not have refreshed
    // Torn's #user-money yet, so on the mid-upgrade re-check qtGetMoneyFast() can
    // still read the pre-sale (~$0) balance; without the floor cashAfterAll would
    // fall short of the buy and the pill falsely shows "paused — prices moved".
    // Same DOM-lag guard the buy step uses (see the buy pill's availCash).
    var cashNow = Math.max(qtGetMoneyFast(), expectedCash || 0);
    var cashAvail = cashNow > 0 ? cashNow : 0;
    var ownedRemaining = {}; // sym -> live owned, decremented as the plan consumes shares
    var liveProceeds = 0;
    var nextSell = null;
    for (var i = 0; i < remainingSells.length; i++) {
      var u = remainingSells[i];
      var sp = qtGetPrice(u.sym);
      if (sp <= 0) return null; // can't price a remaining sell → bail, never sell blind
      if (ownedRemaining[u.sym] === undefined) ownedRemaining[u.sym] = qtGetOwnedShares(u.sym);
      var sh = Math.min(u.shares, ownedRemaining[u.sym]);
      if (i === 0) {
        // A tier is released by selling EXACTLY its marginal shares (2^(t-1)·req). Selling
        // fewer still drops you under the tier threshold — you lose that tier's payout AND
        // keep shares that no longer earn it, for less cash than the plan needs. So a first
        // sell that has to be clamped means our snapshot disagrees with live holdings (a
        // manual trade in between): refuse, let the pill pause, and re-plan on fresh data.
        // Later units may still clamp — there the clamp only UNDER-counts proceeds, which is
        // the safe direction.
        // `sh < 1` is kept alongside: a degenerate unit with shares 0 would pass `sh < u.shares`
        // (0 < 0 is false) and build a 0-share sell. Unreachable with today's plans, cheap to keep.
        if (sh < 1 || sh < u.shares) return null;
        nextSell = { sym: u.sym, tier: u.tier, shares: sh, sellPrice: sp };
      }
      ownedRemaining[u.sym] -= sh;
      liveProceeds += sh * sp * SELL_FEE;
    }
    var cashAfterAll = cashAvail + liveProceeds;
    return {
      buyPrice: buyPrice, liveBuyCost: liveBuyCost, cashNow: cashAvail,
      liveProceeds: liveProceeds, cashAfterAll: cashAfterAll,
      affordable: cashAfterAll >= liveBuyCost,
      alreadyAffordable: cashAvail >= liveBuyCost,
      nextSell: nextSell
    };
  }

  // Builds the Quick Buy / Swing pill panel under the QT bar. Driven by the
  // last data load's Top-5 buy list and swing holdings; re-run on every
  // loadData and on theme change.
  function renderQtPills() {
    var container = document.getElementById("qt-pills");
    if (!container) return;
    injectQtPillCss();
    var isDark = lsGet("tsa_dark", "false") === "true";
    // tsa-dark is what switches the --tsa-* tokens on this root; the qt-pills-* class
    // only drives the hover brightness rule.
    container.className = isDark ? "qt-pills-dark tsa-dark" : "qt-pills-light";
    container.innerHTML = "";

    var hasBuy = lastBuySymbols && lastBuySymbols.length > 0;
    var hasSwing = lastSwingPills && lastSwingPills.length > 0;
    var labelColor = "var(--tsa-fg-faint)";

    // Shared plan (target + bridge chain), recomputed on EVERY pill render so
    // skip-list changes made in the planner take effect immediately — the
    // planner-close path re-renders from cache without a loadData refresh.
    // Capital: API money_onhand + swing value + faction armory (planner parity).
    var bpPlan = null;
    if (lastOwnedMap && lastRaw) {
      // Swing net of Torn's 0.1% sell fee — deployable cash if liquidated (planner parity).
      bpPlan = benefitPlan(lastOwnedMap, lastRaw, planCapital(lastOwnedMap, lastRaw),
        calcWeeklyIncome(lastOwnedMap, lastRaw, null));
      // Keep the bank pill and rec widget on the same (skip-filtered) target.
      lastBestRec = bpPlan.target;
      updateQtRecommendation(null);
    }

    // ROI "bank" pill — deposit cash into the next recommended benefit increment,
    // building up to the block over time. Caps each buy at the shares still
    // needed so it never overshoots. Follows lastBestRec dynamically.
    if (lastBestRec && lastBestRec.tierInfo) {
      // Bridge pill = the planner's bridgeChain[0] from the same shared plan.
      var bpFirst = bpPlan ? (bpPlan.bridgeChain[0] || null) : null;
      var bpEmpty = !!(bpPlan && bpPlan.target && !bpFirst); // mirror the planner's "No bridgebuilder options"

      var ti = lastBestRec.tierInfo;
      var ownedSh = Math.max(0, ti.totalSharesNeeded - ti.sharesNeeded);
      var bankWrap = document.createElement("div");
      bankWrap.style.marginBottom = (hasBuy || hasSwing) ? "10px" : "0";
      var bankLbl = document.createElement("span");
      bankLbl.className = "qt-pill-group-label";
      bankLbl.style.color = labelColor;
      bankLbl.textContent = (bpFirst || bpEmpty) ? "🏦 ROI Bank  ·  🔗 Bridgebuilder" : "🏦 ROI Bank → benefit block";
      bankWrap.appendChild(bankLbl);
      var bankRow = document.createElement("div");
      bankRow.className = "qt-pill-row";
      var bankLabel = qtFmtNum(ownedSh) + "/" + qtFmtNum(ti.totalSharesNeeded);
      // Money sub-text: owned-share value / full cost of the target tier, at live price
      var bankPrice = ti.livePrice || 0;
      var bankMoney = bankPrice > 0
        ? fmRoi(ownedSh * bankPrice) + "/" + fmRoi(ti.totalSharesNeeded * bankPrice)
        : "";
      bankRow.appendChild(makeQtPill(lastBestRec.sym, true, bankLabel, isDark, function() {
        qtBuildMaps();
        var r = lastBestRec;
        if (!r || !r.tierInfo) { showToast("No ROI recommendation yet", "warn"); return; }
        if (!(r.tierInfo.sharesNeeded > 0)) { showToast(r.sym + " T" + r.tierInfo.nextIncrement + " is already bought — it pays from the next payout", "info"); return; }
        var sym = r.sym;
        var price = qtGetPrice(sym) || r.tierInfo.livePrice || 0;
        if (price <= 0) { showToast("Could not read price for " + sym, "error"); return; }
        var money = qtGetMoneyFast();
        if (money <= 0) { showToast("No money found", "warn"); return; }
        var shares = Math.min(Math.floor(money / price), r.tierInfo.sharesNeeded);
        if (shares < 1) { showToast("Not enough cash for 1 share of " + sym, "warn"); return; }
        qtUiTrade(sym, shares, "buyShares", "Banked " + shares.toLocaleString("en-US") + " " + sym + " → T" + r.tierInfo.nextIncrement);
      }, bankMoney, qtPillPaletteBank(isDark)));

      if (bpFirst) {
        // Up to two bridge pills mirroring the planner's two rows: the affordable-now
        // tier ("✓ Buy now") and the drip target ("~Nd"). Each click buys with on-hand
        // cash, capped at the shares still needed so it never overshoots the tier — so
        // the drip pill lets you bank into the next bridge gradually.
        bpPlan.bridgeChain.slice(0, 2).forEach(function(b) {
          var bpIsNow = b.status === "now";
          // 🔗 prefix ties the pill to the planner's "🔗 Bridgebuilder" section
          // (without it, the "now" state looks identical to a Quick Buy pill).
          var bpLabel = bpIsNow
            ? "🔗 ✓ " + b.tier
            : "🔗 ~" + b.daysUntil + "d " + b.tier;
          var bpSub = bpIsNow
            ? fmRoi(b.cost) + " +" + fmRoi(b.extraIncome) + "/7d"
            : "saves " + b.daysSaved + "d · " + fmRoi(b.cost);
          bankRow.appendChild(makeQtPill(b.sym, true, bpLabel, isDark, function() {
            qtBuildMaps();
            var price = qtGetPrice(b.sym) || b.tierInfo.livePrice || 0;
            if (price <= 0) { showToast("Could not read price for " + b.sym, "error"); return; }
            var m = qtGetMoneyFast();
            if (m <= 0) { showToast("No money found", "warn"); return; }
            var shares = Math.min(Math.floor(m / price), b.tierInfo.sharesNeeded);
            if (shares < 1) { showToast("Not enough cash for 1 share of " + b.sym, "warn"); return; }
            qtUiTrade(b.sym, shares, "buyShares", "Bridged " + shares.toLocaleString("en-US") + " " + b.sym + " → " + b.tier);
          }, bpSub, qtPillPaletteBridge(bpIsNow, isDark)));
        });
      } else if (bpEmpty) {
        // Planner shows "No bridgebuilder options" here — give the pill row the
        // same explicit empty state instead of silently rendering nothing.
        var bpNone = document.createElement("span");
        bpNone.textContent = "🔗 no bridge options";
        bpNone.style.cssText = "align-self:center;font-size:var(--tsa-fs-micro);color:" + labelColor + ";font-family:var(--tsa-mono);white-space:nowrap;";
        bankRow.appendChild(bpNone);
      }

      bankWrap.appendChild(bankRow);
      container.appendChild(bankWrap);
    }

    // ⤴ Upgrade swap — sell one or more worse-ROI benefit tiers (lowest ROI first, only
    // as many as needed), then buy a strictly-better tier. Each sell and the final buy
    // is one click = one POST. MONEY SAFETY: a sell never fires unless, at LIVE prices,
    // on-hand cash + the proceeds of ALL remaining planned sells cover the buy — so an
    // irreversible benefit-block sale can't strand the user mid-upgrade. Mirrors the ROI
    // Planner's "⤴ Upgrade" line (same computeUpgradeSwap plan).
    var upSwap = (bpPlan && lastOwnedMap && lastRaw && !qtPendingUpgrade)
      ? benefitSwap(lastOwnedMap, lastRaw, lastCashBalance, bpPlan) : null;

    if (qtPendingUpgrade) {
      // ── Mid-upgrade: sell the remaining planned tiers one click at a time, then buy. ──
      var pend = qtPendingUpgrade;
      var lp = qtUpgradeLiveCheck(pend.sells, pend.buy, pend.expectedCash);
      var doneSells = pend.total - pend.sells.length;
      var sellNext = pend.sells.length > 0 && lp && lp.nextSell && !lp.alreadyAffordable && lp.affordable;
      var canBuy = pend.sells.length === 0 || (lp && lp.alreadyAffordable);

      var upWrap = document.createElement("div");
      upWrap.style.marginBottom = (hasBuy || hasSwing) ? "10px" : "0";
      var upLbl = document.createElement("span");
      upLbl.className = "qt-pill-group-label";
      upLbl.style.color = labelColor;
      upLbl.textContent = sellNext ? ("⤴ Upgrade · sell " + (doneSells + 1) + "/" + pend.total) : "⤴ Upgrade · buy step";
      upWrap.appendChild(upLbl);
      var upRow = document.createElement("div");
      upRow.className = "qt-pill-row";

      if (sellNext) {
        var ns = lp.nextSell;
        upRow.appendChild(makeQtPill(ns.sym, false,
          "⤴ Sell " + (doneSells + 1) + "/" + pend.total + " · " + ns.sym + " " + ns.tier, isDark, function() {
          // Re-price the WHOLE remaining plan live at click; never sell unless the
          // remaining sells + cash will cover the buy (or it's already affordable).
          var lc = qtUpgradeLiveCheck(pend.sells, pend.buy, pend.expectedCash);
          if (!lc || !lc.nextSell) { showToast("Could not read live prices — try again", "warn"); return; }
          if (lc.alreadyAffordable) { renderQtPills(); return; } // enough cash now — skip to buy
          if (!lc.affordable) {
            showToast("Upgrade paused: at live prices the remaining sales won't cover " +
              pend.buy.sym + " " + pend.buy.tier + " (" + fmRoi(lc.liveBuyCost) + "). Not selling more.", "warn");
            return;
          }
          var sns = lc.nextSell;
          qtUiTrade(sns.sym, sns.shares, "sellShares",
            "Upgrade: sold " + sns.shares.toLocaleString("en-US") + " " + sns.sym + " (" + sns.tier + ")",
            { blockMaxShares: sns.shares })
            .then(function(fired) {
              if (fired) {
                pend.sells = pend.sells.slice(1);
                pend.expectedCash = (pend.expectedCash || 0) + sns.shares * sns.sellPrice * SELL_FEE;
                renderQtPills();
              }
            });
        }, "→ " + pend.buy.sym + " " + pend.buy.tier, qtPillPaletteUpgrade(isDark)));
      } else if (canBuy) {
        // Buy step: all needed sells are done (or cash already covers it). Buy the exact
        // shares that unlock the better tier (a partial buy wastes shares).
        upRow.appendChild(makeQtPill(pend.buy.sym, true, "⤴ Buy " + pend.buy.tier, isDark, function() {
          qtBuildMaps();
          var price = qtGetPrice(pend.buy.sym) || pend.buyPrice || 0;
          if (price <= 0) { showToast("Could not read price for " + pend.buy.sym, "error"); return; }
          // Funds floor = larger of live DOM money and accumulated expectedCash (a
          // direct-POST sale may not have refreshed #user-money). If too optimistic,
          // Torn rejects the buy and qtFireTrade toasts it — no silent failure.
          var availCash = Math.max(qtGetMoneyFast(), pend.expectedCash || 0);
          if (availCash <= 0) { showToast("No money found", "warn"); return; }
          var needCost = pend.buy.shares * price;
          if (needCost > availCash) {
            showToast("Need $" + Math.ceil(needCost - availCash).toLocaleString("en-US") + " more for " + pend.buy.sym + " " + pend.buy.tier, "warn");
            return;
          }
          qtUiTrade(pend.buy.sym, pend.buy.shares, "buyShares",
            "Upgraded → bought " + pend.buy.shares.toLocaleString("en-US") + " " + pend.buy.sym + " (" + pend.buy.tier + ")")
            .then(function(fired) { if (fired) { qtPendingUpgrade = null; renderQtPills(); } });
        }, fmRoi(pend.buy.shares * (pend.buyPrice || 0)), qtPillPaletteUpgrade(isDark)));
      } else {
        // lp unreadable, or the remaining sells can't cover the buy at live prices —
        // paused. Cash already freed by completed sells stays in the wallet.
        var upPaused = document.createElement("span");
        upPaused.textContent = "⤴ paused — prices moved; ✕ to stop (cash kept)";
        upPaused.style.cssText = "align-self:center;font-size:var(--tsa-fs-micro);color:" + labelColor + ";font-family:var(--tsa-mono);white-space:nowrap;";
        upRow.appendChild(upPaused);
      }

      // ✕ cancel — abandon the upgrade; any cash already freed by completed sells stays.
      var cxSym = (sellNext && lp && lp.nextSell) ? lp.nextSell.sym : pend.buy.sym;
      var cancel = makeQtPill(cxSym, true, "✕", isDark, function() {
        qtPendingUpgrade = null; renderQtPills();
      }, null, qtPillPaletteUpgrade(isDark));
      cancel.classList.add("qt-pill-mini");
      var cImg = cancel.querySelector("img"); if (cImg) cImg.style.display = "none";
      var cBadge = cancel.querySelector(".qt-pill-badge"); if (cBadge) cBadge.style.display = "none";
      cancel.title = "Cancel the upgrade (any cash already freed by sells stays in your wallet)";
      upRow.appendChild(cancel);

      upWrap.appendChild(upRow);
      container.appendChild(upWrap);

    } else if (upSwap) {
      // ── Start of an upgrade: re-price the full plan live before offering the first sell. ──
      var upLive = qtUpgradeLiveCheck(upSwap.sells, upSwap.buy);
      if (upLive) {
        var nSells = upSwap.sells.length;
        var upWrap2 = document.createElement("div");
        upWrap2.style.marginBottom = (hasBuy || hasSwing) ? "10px" : "0";
        var upLbl2 = document.createElement("span");
        upLbl2.className = "qt-pill-group-label";
        upLbl2.style.color = labelColor;
        upLbl2.textContent = "⤴ Upgrade · swap to better ROI";
        upWrap2.appendChild(upLbl2);
        var upRow2 = document.createElement("div");
        upRow2.className = "qt-pill-row";

        if (upLive.affordable && upLive.nextSell) {
          var firstSym = upLive.nextSell.sym;
          var lbl = (nSells > 1 ? "⤴ Sell 1/" + nSells + " · " : "⤴ Sell ") + firstSym + " " + upLive.nextSell.tier;
          upRow2.appendChild(makeQtPill(firstSym, false,
            lbl + " → " + upSwap.buy.sym + " " + upSwap.buy.tier, isDark, function() {
            // MONEY SAFETY: re-price the full plan live at click; never sell unless the
            // whole plan + cash covers the buy at current prices.
            var lc = qtUpgradeLiveCheck(upSwap.sells, upSwap.buy);
            if (!lc || !lc.nextSell) { showToast("Could not read live prices — try again", "warn"); return; }
            if (lc.alreadyAffordable) {
              // Live cash already covers the buy — no sell needed; go straight to buy.
              qtPendingUpgrade = { sells: [], total: nSells, buy: upSwap.buy, buyPrice: lc.buyPrice, expectedCash: lc.cashNow };
              renderQtPills();
              return;
            }
            if (!lc.affordable) {
              showToast("Upgrade blocked: at live prices selling " + nSells + " block(s) won't cover " +
                upSwap.buy.sym + " " + upSwap.buy.tier + " (" + fmRoi(lc.liveBuyCost) + "). Not selling.", "warn");
              return;
            }
            var sns = lc.nextSell;
            qtUiTrade(sns.sym, sns.shares, "sellShares",
              "Upgrade: sold " + sns.shares.toLocaleString("en-US") + " " + sns.sym + " (" + sns.tier + ")",
              { blockMaxShares: sns.shares })
              .then(function(fired) {
                if (fired) {
                  qtPendingUpgrade = {
                    sells: upSwap.sells.slice(1), total: nSells, buy: upSwap.buy,
                    buyPrice: lc.buyPrice, expectedCash: lc.cashNow + sns.shares * sns.sellPrice * SELL_FEE
                  };
                  renderQtPills();
                }
              });
          }, "+" + fmRoi(upSwap.netWeekly) + "/7d" + (nSells > 1 ? " · " + nSells + " blocks" : ""), qtPillPaletteUpgrade(isDark)));
        } else {
          // Plan exists on the snapshot but, at LIVE prices, the sales wouldn't cover the
          // buy (e.g. a sell stock dropped — a real loss). Show a muted, non-clickable
          // hint instead of a sell pill we'd refuse: never lure an unaffordable sale.
          var upNone = document.createElement("span");
          upNone.textContent = "⤴ not affordable at live price (" + nSells + " block→" + upSwap.buy.sym + ")";
          upNone.style.cssText = "align-self:center;font-size:var(--tsa-fs-micro);color:" + labelColor + ";font-family:var(--tsa-mono);white-space:nowrap;";
          upRow2.appendChild(upNone);
        }
        upWrap2.appendChild(upRow2);
        container.appendChild(upWrap2);
      }
    }

    if (hasBuy) {
      var buyWrap = document.createElement("div");
      buyWrap.style.marginBottom = hasSwing ? "10px" : "0";
      // Header row: group label on the left, ⚙ buy-budget setter on the right.
      var buyHead = document.createElement("div");
      buyHead.style.cssText = "display:flex;align-items:center;gap:8px;";
      var buyLbl = document.createElement("span");
      buyLbl.className = "qt-pill-group-label";
      buyLbl.style.color = labelColor;
      // The label names the SOURCE, not just a count: two different lists can produce
      // the same number of pills, and a wrong assumption here costs money.
      buyLbl.textContent = (lastBuySource === "buyzone")
        ? "▲ Quick Buy — Buy zone " + lastBuySymbols.length
        : "▲ Quick Buy — Top " + lastBuySymbols.length;
      buyHead.appendChild(buyLbl);
      var pillAmt = getQtBuyPillAmt();
      var gearBtn = document.createElement("button");
      gearBtn.textContent = pillAmt > 0 ? "⚙ " + fmtQtAmt(pillAmt) : "⚙";
      gearBtn.title = "Set buy amount per Quick Buy pill (blank = all available cash)";
      gearBtn.style.cssText = "padding:2px 8px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-accent-border);background:var(--tsa-accent-bg);color:var(--tsa-accent);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;";
      gearBtn.onclick = function() {
        var cur = getQtBuyPillAmt();
        var input = prompt("Buy amount per Quick Buy pill (e.g. 25m — blank = all available cash):", cur > 0 ? fmtQtAmt(cur) : "");
        if (input === null) return; // cancelled
        lsSet("qt_buy_pill_amount", String(parseQtMoney(input)));
        renderQtPills();
      };
      buyHead.appendChild(gearBtn);
      buyWrap.appendChild(buyHead);
      var buyRow = document.createElement("div");
      buyRow.className = "qt-pill-row";
      var buyPillLabel = pillAmt > 0 ? "Buy " + fmtQtAmt(pillAmt) : "Buy";
      lastBuySymbols.forEach(function(sym) {
        var d = lastBuyInvDelta[sym];
        var pct = lastBuyPriceDelta[sym];
        var sc = lastBuyScores[sym];
        var scStr = (sc != null) ? sc + "p" : null;
        // Only populated in Buy-zone mode: how deep in its own 30-day range the stock
        // sits, which is the entire reason the row is in the zone.
        var zp = lastBuyZonePos[sym];
        var zpStr = (zp != null) ? "▾ " + zp.toFixed(0) + "% of range" : null;
        var pctStr = (pct != null) ? (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%" : null;
        var invStr = (d != null) ? "👥 " + (d >= 0 ? "+" : "") + d.toLocaleString("en-US") : null;
        var subText = [zpStr, scStr, pctStr, invStr].filter(Boolean).join(" · ");
        buyRow.appendChild(makeQtPill(sym, true, buyPillLabel, isDark, function() {
          qtBuildMaps();
          var amt = getQtBuyPillAmt();
          if (amt > 0) qtExecuteBuy(sym, amt); // buy for the set $ budget (capped at available cash)
          else qtVault(sym);                   // buy max shares with all available cash
        }, subText));
      });
      buyWrap.appendChild(buyRow);
      container.appendChild(buyWrap);
    }

    if (hasSwing) {
      var swWrap = document.createElement("div");
      // Header row: group label on the left, ⚙ sell-budget setter next to it.
      var swHead = document.createElement("div");
      swHead.style.cssText = "display:flex;align-items:center;gap:8px;";
      var swLbl = document.createElement("span");
      swLbl.className = "qt-pill-group-label";
      swLbl.style.color = labelColor;
      swLbl.textContent = "▼ Swing — sell now (net of fee)";
      swHead.appendChild(swLbl);
      var sellPillAmt = getQtSellPillAmt();
      var sellGear = document.createElement("button");
      sellGear.textContent = sellPillAmt > 0 ? "⚙ " + fmtQtAmt(sellPillAmt) : "⚙";
      sellGear.title = "Set sell amount per Swing pill (blank = sell the whole swing position)";
      sellGear.style.cssText = "padding:2px 8px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-neg-border);background:var(--tsa-neg-bg);color:var(--tsa-neg);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;";
      sellGear.onclick = function() {
        var cur = getQtSellPillAmt();
        var input = prompt("Sell amount per Swing pill (e.g. 25m — blank = sell the whole swing position):", cur > 0 ? fmtQtAmt(cur) : "");
        if (input === null) return; // cancelled
        lsSet("qt_sell_pill_amount", String(parseQtMoney(input)));
        renderQtPills();
      };
      swHead.appendChild(sellGear);
      swWrap.appendChild(swHead);
      var swRow = document.createElement("div");
      swRow.className = "qt-pill-row";
      var profitTarget = getProfitTarget();
      lastSwingPills.forEach(function(p) {
        var positive = (p.profit || 0) >= 0;
        // 🎯 marks a swing position whose net profit % has reached the profit
        // target set in Settings (tsa_profit_target) — i.e. ready to sell.
        var atTarget = (p.pct !== null && p.pct !== undefined) && (p.pct >= profitTarget);
        var label = (p.profit === null || p.profit === undefined) ? "Sell" : qtFmtSignedDollar(p.profit);
        if (atTarget) label += " 🎯";
        // Sub-text: optional sell amount · position value · net profit % (the unit
        // the user's profit-target/stop-loss thresholds are set in)
        var pctTxt = (p.pct === null || p.pct === undefined) ? "" : (p.pct >= 0 ? "+" : "") + p.pct.toFixed(2) + "%";
        var valTxt = (p.value === null || p.value === undefined) ? "" : qtFmtDollar(p.value);
        var subText = valTxt && pctTxt ? valTxt + " · " + pctTxt : (valTxt || pctTxt);
        if (sellPillAmt > 0) subText = "Sell " + fmtQtAmt(sellPillAmt) + (subText ? " · " + subText : "");
        var pill = makeQtPill(p.sym, positive, label, isDark, function() {
          qtBuildMaps();
          var owned = qtGetOwnedShares(p.sym);
          if (owned <= 0) { showToast("You have no shares of " + p.sym, "warn"); return; }
          var sellAmt = getQtSellPillAmt();
          var partial = sellAmt > 0;
          var shares;
          if (partial) {
            var price = qtGetPrice(p.sym);
            if (price <= 0) { showToast("Could not read price for " + p.sym, "error"); return; }
            shares = Math.ceil((sellAmt / SELL_FEE) / price); // shares worth ~$sellAmt net of the 0.1% fee
          } else {
            shares = p.shares; // whole swing position
          }
          if (shares > owned) shares = owned;
          shares = qtApplyBenefitLock(p.sym, shares);
          if (shares === null) return;
          qtUiTrade(p.sym, shares, "sellShares",
            "Sold " + shares.toLocaleString("en-US") + " " + p.sym + " (swing)",
            { blockMaxShares: shares }).then(function(fired) {
              // Only remove the pill when the whole swing position was sold; a
              // partial $-amount sell leaves shares, so keep the pill. Remove the
              // whole pair so the glued green ＋ buy pill goes with it.
              if (fired && !partial && pair.parentNode) pair.parentNode.removeChild(pair);
            });
        }, subText);
        if (atTarget) pill.title = "Reached your " + profitTarget + "% profit target";

        // Small green "buy more" pill glued to the right of the sell pill: drips
        // all available cash into this same holding (vault), so you can add to a
        // swing position without leaving the pill panel. Same one-click POST flow.
        var buyMore = makeQtPill(p.sym, true, "＋", isDark, function() {
          qtBuildMaps();
          qtVault(p.sym);
        });
        buyMore.classList.add("qt-pill-mini");
        // Compact variant drops the logo/badge so it reads as a +, not a stock pill.
        var bmImg = buyMore.querySelector("img");
        if (bmImg) bmImg.style.display = "none";
        var bmBadge = buyMore.querySelector(".qt-pill-badge");
        if (bmBadge) bmBadge.style.display = "none";
        buyMore.title = "Buy more " + p.sym + " with all available cash";

        var pair = document.createElement("span");
        pair.className = "qt-pill-pair";
        pair.appendChild(pill);
        pair.appendChild(buyMore);
        swRow.appendChild(pair);
      });
      swWrap.appendChild(swRow);
      container.appendChild(swWrap);
    }

    applyQtBarVisibility();
  }

  function qtChartPoints(sym, mode, h1Store, history, pLive, now) {
    var localPoints = (history[sym.toUpperCase()] || []).map(function(h) { return { ts: h.ts, price: h.price }; });
    var dossierUsed = false;
    var points = localPoints;
    if (mode === "dossier") {
      var h1 = h1Store[sym.toUpperCase()];
      if (h1 && Array.isArray(h1.closes) && Array.isArray(h1.stamps) && h1.closes.length >= 2 && h1.stamps.length >= 2) {
        var dossierPoints = [];
        for (var hi = 0; hi < h1.closes.length && hi < h1.stamps.length; hi++) {
          var hc = parseFloat(h1.closes[hi]), hs = Number(h1.stamps[hi]);
          if (isFinite(hc) ? hc > 0 : false) { if (isFinite(hs) && hs > 0) dossierPoints.push({ ts: hs * 1000, price: hc }); }
        }
        if (dossierPoints.length >= 2) {
          dossierPoints.sort(function(a, b) { return a.ts - b.ts; });
          var dossierLastTs = dossierPoints[dossierPoints.length - 1].ts;
          points = dossierPoints.concat(localPoints.filter(function(p) { return p.ts > dossierLastTs; }));
          dossierUsed = true;
        }
      }
    }
    if (pLive > 0) {
      var liveTs = Math.round(now / 60000) * 60000;
      points = points.filter(function(p) { return p.ts !== liveTs; });
      points.push({ ts: liveTs, price: pLive });
    }
    points.sort(function(a, b) { return a.ts - b.ts; });
    points = points.reduce(function(out, p) { if (out.length && out[out.length - 1].ts === p.ts) out[out.length - 1] = p; else out.push(p); return out; }, []);
    return { points: points, dossierUsed: dossierUsed };
  }

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return [];
    if (max < min) { var swap = min; min = max; max = swap; }
    var span = max - min || Math.abs(max) * 0.01 || 1;
    var raw = span / Math.max(1, count - 1), power = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / power, step = (norm <= 1.5 ? 1 : norm <= 2.25 ? 2 : norm <= 3.5 ? 2.5 : norm <= 7.5 ? 5 : 10) * power;
    var out = []; for (var v = Math.ceil(min / step) * step; v <= max + step * 1e-8; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function qtReferencePrices(base, targetPct, stopPct, fee) {
    var refs = [];
    if (base > 0 && fee > 0) {
      refs.push({ key: "avg", label: "Avg", price: base });
      if (isFinite(targetPct)) refs.push({ key: "target", label: "Target", price: base * (1 + targetPct / 100) / fee });
      if (stopPct > 0) refs.push({ key: "stop", label: "Stop", price: base * (1 - stopPct / 100) / fee });
    }
    return refs;
  }
  function qtChartDomain(prices, refs) {
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices), range = max - min || Math.abs(max) * 0.001 || 1;
    var pad = range * 0.08 || Math.abs(max) * 0.004 || 0.01;
    var lo = min - pad, hi = max + pad;
    var lines = (refs || []).map(function(r) {
      var far = r.price < min - range * 0.25 || r.price > max + range * 0.25;
      if (!far) { lo = Math.min(lo, r.price); hi = Math.max(hi, r.price); }
      return { key: r.key, label: r.label, price: r.price, pinned: far ? (r.price < min ? "bottom" : "top") : null };
    });
    return { min: lo, max: hi, refs: lines };
  }
  function qtNearestPoint(points, ts) {
    var best = null, dist = Infinity;
    (points || []).forEach(function(p) { var d = Math.abs(p.ts - ts); if (d < dist) { dist = d; best = p; } });
    return best;
  }
  function qtMarkersInRange(transactions, minTs, maxTs) {
    return (transactions || []).filter(function(t) { var ts = Number(t.time_bought) * 1000; return isFinite(ts) && ts >= minTs && ts <= maxTs && Number(t.bought_price) > 0; })
      .map(function(t) { return { ts: Number(t.time_bought) * 1000, price: Number(t.bought_price), shares: Number(t.shares) || 0 }; });
  }
  function qtSellMarkersInRange(events, sym, minTs, maxTs) {
    return (events || []).filter(function(e) {
      var ts = Number(e.ts) * 1000;
      return e.sym === sym && Number(e.sell_price) > 0 && isFinite(ts) && ts >= minTs && ts <= maxTs;
    }).map(function(e) {
      return { ts: Number(e.ts) * 1000, price: Number(e.sell_price), shares: Number(e.shares) || 0 };
    });
  }
  function qtDossierTradeMarkers(trades, sym, idMap, minTs, maxTs) {
    var id = Object.keys(idMap || {}).find(function(k) { return idMap[k] === sym; });
    if (!id) return [];
    return (trades || []).filter(function(t) {
      var ts = Number(t.ts) * 1000;
      return Number(t.stock_id) === Number(id) && isFinite(ts) && ts >= minTs && ts <= maxTs &&
        (t.side === "buy" || t.side === "sell") && Number(t.price) > 0;
    }).map(function(t) { return { ts: Number(t.ts) * 1000, price: Number(t.price), shares: Number(t.shares) || 0,
      side: t.side, net_profit: typeof t.net_profit === "number" && isFinite(t.net_profit) ? t.net_profit : null }; });
  }
  function qtChartTradeMarkers(mode, trades, sym, idMap, transactions, realized, minTs, maxTs) {
    var all = mode === "dossier" ? qtDossierTradeMarkers(trades, sym, idMap, -Infinity, Infinity) : [];
    if (all.length) {
      var visible = qtDossierTradeMarkers(trades, sym, idMap, minTs, maxTs);
      return { buys: visible.filter(function(m) { return m.side === "buy"; }), sells: visible.filter(function(m) { return m.side === "sell"; }) };
    }
    return { buys: transactions ? qtMarkersInRange(transactions, minTs, maxTs) : [], sells: qtSellMarkersInRange(realized, sym, minTs, maxTs) };
  }
  function qtSegmentPoints(points, gap) {
    var segments = [];
    (points || []).forEach(function(point) {
      var segment = segments[segments.length - 1];
      if (!segment || point.ts - segment[segment.length - 1].ts > gap) {
        segment = [];
        segments.push(segment);
      }
      segment.push(point);
    });
    return segments;
  }
  function qtDecollideLabels(labels, minY, maxY, gap) {
    var a = (labels || []).map(function(x) { return { label: x.label, y: x.y, source: x }; }).sort(function(x,y){return x.y-y.y;});
    for (var i=0;i<a.length;i++) a[i].y = Math.max(minY, Math.min(maxY, Math.max(a[i].y, i ? a[i-1].y+gap : minY)));
    if (a.length && a[a.length-1].y > maxY) { a[a.length-1].y=maxY; for(var j=a.length-2;j>=0;j--) a[j].y=Math.min(a[j].y,a[j+1].y-gap); }
    return a.filter(function(x){return x.y>=minY;}).map(function(x){return {label:x.label,y:x.y,source:x.source && x.source.source ? x.source.source : x.source};});
  }
  function qtTicksAwayFromLabels(ticks, chipYs, gap) {
    return (ticks || []).filter(function(tick) {
      return !(chipYs || []).some(function(y) { return Math.abs(tick.y - y) <= gap; });
    });
  }

  function qtDrawChart(sym) {
    var container = document.getElementById("qt-chart-container");
    var canvas = document.getElementById("qt-chart-canvas");
    var title = document.getElementById("qt-chart-title");
    var liveEl = document.getElementById("qt-chart-live");
    var labelsEl = document.getElementById("qt-chart-labels");
    if (!container || !canvas) return;
    if (!sym || !getShowQtChart()) {
      container.style.display = "none";
      return;
    }

    function showNoHistory() {
      container.style.display = "block";
      canvas.style.display = "none";
      var message = document.getElementById("qt-chart-nodata");
      if (!message) {
        message = document.createElement("div");
        message.id = "qt-chart-nodata";
        container.appendChild(message);
      }
      message.style.cssText = "padding:18px;text-align:center;color:var(--tsa-fg-faint)";
      message.textContent = "Not enough history for " + sym + " \u2014 check back after next refresh";
    }

    function preparePoints() {
      var raw = lastRaw && lastRaw.find(function(item) { return item.stock === sym.toUpperCase(); });
      var live = raw ? (parseFloat(raw.price) || 0) : 0;
      var built = qtChartPoints(sym, dataMode, histH1Store, loadHistory(), live, Date.now());
      var points = built.points;
      var tf = lsGet("tsa_chart_timeframe", "all");
      var span = { "1d": 86400000, "3d": 259200000, "7d": 604800000 }[tf];
      if (span) points = points.filter(function(point) { return point.ts >= Date.now() - span; });
      points = points.filter(function(point, i, all) {
        if (all.length < 5) return true;
        var windowPrices = [];
        for (var j = Math.max(0, i - 2); j <= Math.min(all.length - 1, i + 2); j++) {
          if (j !== i) windowPrices.push(all[j].price);
        }
        windowPrices.sort(function(a, b) { return a - b; });
        var median = windowPrices[Math.floor(windowPrices.length / 2)];
        return median <= 0 || Math.abs(point.price - median) / median < 0.12;
      });
      var buckets = {};
      points.forEach(function(point) {
        var key = Math.floor(point.ts / 1800000);
        (buckets[key] || (buckets[key] = [])).push(point.price);
      });
      points = Object.keys(buckets).map(Number).sort(function(a, b) { return a - b; }).map(function(key) {
        var prices = buckets[key].sort(function(a, b) { return a - b; });
        return { ts: key * 1800000 + 900000, price: prices[Math.floor(prices.length / 2)] };
      });
      return { points: points, built: built, live: live, tf: tf };
    }

    function drawGridAndTicks(ctx, ticks, yOf, w, padL, padR, fg, grid, chipYs) {
      ctx.font = "10px " + tsaToken("mono", canvas);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 1;
      ctx.strokeStyle = grid;
      ctx.fillStyle = fg;
      qtTicksAwayFromLabels(ticks.map(function(value) { return { value: value, y: yOf(value) }; }), chipYs, 14).forEach(function(tick) {
        var value = tick.value, y = tick.y;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR + 3, y);
        ctx.stroke();
        ctx.fillText("$" + value.toFixed(2), w - 3, y);
      });
    }

    function drawLineAndArea(ctx, segments, xOf, yOf, floorY, line) {
      segments.forEach(function(segment) {
        if (!segment.length) return;
        ctx.beginPath();
        segment.forEach(function(point, index) {
          var x = xOf(point.ts), y = yOf(point.price);
          if (!index) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.lineWidth = 2;
        ctx.strokeStyle = line;
        ctx.stroke();
        // Close each segment independently so the wash never bridges a history gap.
        ctx.lineTo(xOf(segment[segment.length - 1].ts), floorY);
        ctx.lineTo(xOf(segment[0].ts), floorY);
        ctx.closePath();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = line;
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }

    function drawReferenceLines(ctx, refs, yOf, padT, chartH, w, padL, padR, surface, fgStrong) {
      var positioned = refs.map(function(ref) {
        var y = ref.pinned === "top" ? padT : ref.pinned === "bottom" ? padT + chartH : yOf(ref.price);
        var color = ref.key === "target" ? tsaToken("pos", canvas) : ref.key === "stop" ? tsaToken("neg", canvas) : tsaToken("fg-faint", canvas);
        return { ref: ref, y: y, color: color };
      });
      positioned.forEach(function(item) {
        ctx.strokeStyle = item.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, item.y);
        ctx.lineTo(w - padR, item.y);
        ctx.stroke();
      });
      qtDecollideLabels(positioned.map(function(item) {
        return { label: item.ref.label, y: item.y, source: item };
      }), padT + 5, padT + chartH - 5, 15).forEach(function(item) {
        var source = item.source;
        var glyph = source.ref.pinned === "top" ? "\u25B2 " : source.ref.pinned === "bottom" ? "\u25BC " : "";
        var text = glyph + source.ref.label + " $" + source.ref.price.toFixed(2);
        var textWidth = ctx.measureText(text).width + 8;
        ctx.fillStyle = surface;
        ctx.fillRect(w - textWidth - 2, item.y - 7, textWidth, 14);
        ctx.fillStyle = fgStrong;
        ctx.textAlign = "right";
        ctx.fillText(text, w - 5, item.y);
      });
    }

    function drawMarkers(ctx, markers, xOf, yOf, surface, color) {
      markers.forEach(function(marker) {
        ctx.beginPath();
        ctx.arc(xOf(marker.ts), yOf(marker.price), 6, 0, Math.PI * 2);
        ctx.fillStyle = surface;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(xOf(marker.ts), yOf(marker.price), 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    }

    function drawXLabels(points, labels, minTs, maxTs) {
      if (!labels) return;
      var picks = [0, Math.floor(points.length * 0.25), Math.floor(points.length * 0.5), Math.floor(points.length * 0.75), points.length - 1];
      labels.innerHTML = "";
      picks.filter(function(value, index, all) { return all.indexOf(value) === index; }).forEach(function(index) {
        var span = document.createElement("span");
        var point = points[index];
        var date = new Date(point.ts);
        span.textContent = index === points.length - 1 ? "Now" : (date.getDate() + "/" + (date.getMonth() + 1));
        span.style.cssText = "position:absolute;left:" + ((point.ts - minTs) / (maxTs - minTs || 1) * 100) + "%;transform:translateX(-50%)";
        labels.appendChild(span);
      });
    }

    function bindTooltip(ctx, points, buys, sells, xOf, yOf, minTs, maxTs, chartW, chartH, padT, line, surface, firstPrice, dpr, snapshot) {
      var tip = document.getElementById("qt-chart-tip");
      if (!tip) {
        tip = document.createElement("div");
        tip.id = "qt-chart-tip";
        tip.style.cssText = "position:absolute;display:none;z-index:9;pointer-events:none;padding:6px 8px;background:var(--tsa-bg-raised);border:1px solid var(--tsa-border);border-radius:var(--tsa-r-2);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);color:var(--tsa-fg-strong);";
        container.style.position = "relative";
        container.appendChild(tip);
      }
      var hideTimer = 0;
      function showAt(event, touchEvent) {
        var rect = canvas.getBoundingClientRect();
        var mouseX = event.clientX - rect.left;
        var hit = qtNearestPoint(points, minTs + Math.max(0, Math.min(1, (mouseX - 4) / chartW)) * (maxTs - minTs));
        if (!hit) return;
        var px = xOf(hit.ts), py = yOf(hit.price);
        ctx.putImageData(snapshot, 0, 0);
        tip.innerHTML = "";
        var strong = document.createElement("strong");
        strong.textContent = "$" + hit.price.toFixed(2);
        tip.appendChild(strong);
        var sub = document.createElement("div"), date = new Date(hit.ts);
        sub.textContent = date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        tip.appendChild(sub);
        var pct = document.createElement("div"), delta = (hit.price - firstPrice) / firstPrice * 100;
        pct.textContent = (delta >= 0 ? "+" : "") + delta.toFixed(2) + "%";
        tip.appendChild(pct);
        [buys, sells].forEach(function(markers, index) {
          var marker = markers.find(function(item) {
            var dx = xOf(item.ts) - px, dy = yOf(item.price) - py;
            return Math.sqrt(dx * dx + dy * dy) <= 24;
          });
          if (!marker) return;
          var row = document.createElement("div");
          row.textContent = index ? (marker.shares ? "Sold " + marker.shares + " @ $" : "Sold @ $") + marker.price.toFixed(2) +
            (marker.net_profit == null ? "" : " \u00b7 net " + (marker.net_profit >= 0 ? "+$" : "-$") + Math.abs(Math.round(marker.net_profit)).toLocaleString("en-US")) : "Bought " + marker.shares + " @ $" + marker.price.toFixed(2);
          tip.appendChild(row);
        });
        tip.style.display = "block";
        var left = canvas.offsetLeft - container.offsetLeft + mouseX + 10;
        if (left + 150 > container.clientWidth) left = canvas.offsetLeft - container.offsetLeft + mouseX - 160;
        tip.style.left = Math.max(2, left) + "px";
        tip.style.top = Math.max(2, Math.min(container.clientHeight - 62, canvas.offsetTop - container.offsetTop + py - 28)) + "px";
        // Keep the readout in the chart box; the canvas is redrawn by the next chart refresh.
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue("--tsa-fg-faint").trim();
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + chartH); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.strokeStyle = surface; ctx.lineWidth = 3; ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fillStyle = line; ctx.fill();
        ctx.restore();
        if (touchEvent) {
          clearTimeout(hideTimer);
          hideTimer = setTimeout(function() { tip.style.display = "none"; qtDrawChart(sym); }, 2000);
        }
      }
      canvas.onpointerdown = function(event) { if (canvas.setPointerCapture) { try { canvas.setPointerCapture(event.pointerId); } catch(_) {} } showAt(event, true); };
      canvas.onpointermove = function(event) { if (event.pointerType === "mouse" || event.buttons || event.pressure > 0) showAt(event, event.pointerType !== "mouse"); };
      canvas.onpointerup = function(event) { showAt(event, true); clearTimeout(hideTimer); hideTimer = setTimeout(function() { tip.style.display = "none"; qtDrawChart(sym); }, 2000); };
      canvas.onpointercancel = canvas.onpointerup;
      canvas.onpointerleave = function(event) {
        if (event.pointerType === "mouse") { tip.style.display = "none"; clearTimeout(hideTimer); qtDrawChart(sym); }
      };
    }

    var prepared = preparePoints();
    var points = prepared.points, built = prepared.built, live = prepared.live, tf = prepared.tf;
    document.querySelectorAll(".qt-tf-btn").forEach(function(button) {
      var selected = button.getAttribute("data-tf") === tf;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.style.background = selected ? "var(--tsa-bg-raised)" : "none";
      button.style.color = selected ? "var(--tsa-fg-strong)" : "var(--tsa-fg-faint)";
    });
    if (points.length < 2) { showNoHistory(); return; }
    container.style.display = "block";
    canvas.style.display = "block";
    var noData = document.getElementById("qt-chart-nodata");
    if (noData) noData.style.display = "none";
    if (title) title.textContent = sym + " \u00B7 " + points.length + " pts \u00B7 " + tf + (built.dossierUsed ? " \u00B7 Dossier 1h" : "");
    if (liveEl) liveEl.textContent = live > 0 ? "$" + live.toFixed(2) : "";

    var owned = lastOwnedMap && lastOwnedMap[sym.toUpperCase()];
    var avg = owned ? calcSwingAvgPrice(owned, owned.transactions, owned.avg_price) : 0;
    if (!(avg > 0) && owned) avg = owned.avg_price;
    var refs = owned ? qtReferencePrices(avg, getProfitTarget(), getStopLoss(), SELL_FEE) : [];
    var minTs = points[0].ts, maxTs = points[points.length - 1].ts;
    var chartTrades = qtChartTradeMarkers(dataMode, lastDossierTrades, sym, STOCK_ID_MAP, owned && owned.transactions, getRealizedEvents(), minTs, maxTs);
    var buys = chartTrades.buys, sells = chartTrades.sells;
    var domain = qtChartDomain(points.map(function(point) { return point.price; }), refs);
    var dpr = window.devicePixelRatio || 1;
    var touch = window.matchMedia("(hover: none)").matches || window.matchMedia("(pointer: coarse)").matches;
    var height = touch ? 100 : 160, width = canvas.clientWidth || canvas.offsetWidth || 300;
    var tfRow = document.getElementById("qt-tf-row");
    var chartHeader = title && title.parentNode;
    if (tfRow && chartHeader && touch) chartHeader.insertBefore(tfRow, liveEl || null);
    else if (tfRow && chartHeader && !touch && tfRow.parentNode === chartHeader) chartHeader.parentNode.insertBefore(tfRow, canvas);
    canvas.style.height = height + "px";
    canvas.style.touchAction = "pan-y";
    canvas.setAttribute("role", "img");
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    var padT = 10, padB = 12, padL = 4, padR = 66;
    var chartW = width - padL - padR, chartH = height - padT - padB;
    var timeRange = maxTs - minTs || 1, priceRange = domain.max - domain.min || 1;
    function xOf(ts) { return padL + (ts - minTs) / timeRange * chartW; }
    function yOf(price) { return padT + (1 - (price - domain.min) / priceRange) * chartH; }
    var style = getComputedStyle(canvas);
    var fg = style.getPropertyValue("--tsa-fg-faint").trim() || tsaToken("fg-faint", canvas);
    var fgStrong = style.getPropertyValue("--tsa-fg-strong").trim() || tsaToken("fg-strong", canvas);
    var grid = style.getPropertyValue("--tsa-border").trim() || tsaToken("border", canvas);
    var surface = style.getPropertyValue("--tsa-bg-chart").trim() || tsaToken("bg-chart", canvas);
    ctx.font = "10px " + tsaToken("mono", canvas);
    var chartTicks = niceTicks(domain.min, domain.max, 4);
    var chipYs = qtDecollideLabels(domain.refs.map(function(ref) {
      return { label: ref.label, y: ref.pinned === "top" ? padT : ref.pinned === "bottom" ? padT + chartH : yOf(ref.price) };
    }), padT + 5, padT + chartH - 5, 15).map(function(item) { return item.y; });
    var gutterWidth = chartTicks.reduce(function(max, value) { return Math.max(max, ctx.measureText("$" + value.toFixed(2)).width); }, 0);
    domain.refs.forEach(function(ref) {
      var glyph = ref.pinned === "top" ? "\u25B2 " : ref.pinned === "bottom" ? "\u25BC " : "";
      gutterWidth = Math.max(gutterWidth, ctx.measureText(glyph + ref.label + " $" + ref.price.toFixed(2)).width);
    });
    padR = gutterWidth + 10;
    chartW = width - padL - padR;
    var segments = qtSegmentPoints(points, 4 * 3600000);
    var rising = points[points.length - 1].price >= points[0].price;
    var line = style.getPropertyValue(rising ? "--tsa-pos" : "--tsa-neg").trim() || tsaToken(rising ? "pos" : "neg", canvas);
    drawGridAndTicks(ctx, chartTicks, yOf, width, padL, padR, fg, grid, chipYs);
    drawLineAndArea(ctx, segments, xOf, yOf, height - padB, line);
    var last = points[points.length - 1], lastX = xOf(last.ts), lastY = yOf(last.price);
    ctx.beginPath(); ctx.arc(lastX, lastY, 6, 0, Math.PI * 2); ctx.fillStyle = surface; ctx.fill();
    ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, Math.PI * 2); ctx.fillStyle = line; ctx.fill();
    drawReferenceLines(ctx, domain.refs, yOf, padT, chartH, width, padL, padR, surface, fgStrong);
    drawMarkers(ctx, buys, xOf, yOf, surface, tsaToken("pos", canvas));
    // Sale markers use a smaller dot with a crisp chart-surface ring.
    sells.forEach(function(marker) {
      ctx.beginPath(); ctx.arc(xOf(marker.ts), yOf(marker.price), 6, 0, Math.PI * 2); ctx.fillStyle = surface; ctx.fill();
      ctx.beginPath(); ctx.arc(xOf(marker.ts), yOf(marker.price), 4, 0, Math.PI * 2); ctx.fillStyle = tsaToken("neg", canvas); ctx.fill();
    });
    drawXLabels(points, labelsEl, minTs, maxTs);
    var firstPrice = points[0].price;
    var prices = points.map(function(point) { return point.price; });
    var change = (last.price - firstPrice) / firstPrice * 100;
    canvas.setAttribute("aria-label", sym + " chart, " + tf + " range. First $" + firstPrice.toFixed(2) + ", last $" + last.price.toFixed(2) + ", min $" + Math.min.apply(null, prices).toFixed(2) + ", max $" + Math.max.apply(null, prices).toFixed(2) + ", change " + (change >= 0 ? "+" : "") + change.toFixed(2) + "%.");
    var snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bindTooltip(ctx, points, buys, sells, xOf, yOf, minTs, maxTs, chartW, chartH, padT, line, surface, firstPrice, dpr, snapshot);
  }
  function applyQtTheme(isDark) {
    var bar = document.getElementById("qt-bar");
    if (!bar) return;
    // #qt-bar is one of the token roots, so this class is what switches the whole
    // bar's --tsa-* values. Everything below then only has to name a token.
    bar.classList.toggle("tsa-dark", !!isDark);
    // The direction toggle is static markup like the search box and the chart, so it
    // needs re-colouring here — renderQtRows only touches opacity and aria. Without
    // this, light mode shows neon-on-white. Both elements live inside #qt-bar, so
    // this belongs below the guard. The consequence line repaints itself from
    // lsGet("tsa_dark") on every render, and renderQtRows resets it, so it needs no
    // call of its own here.
    var dBuy = document.getElementById("qt-dir-buy");
    var dSell = document.getElementById("qt-dir-sell");
    if (dBuy) {
      dBuy.style.borderColor = "var(--tsa-pos-border)";
      dBuy.style.background  = "var(--tsa-pos-bg-hi)";
      dBuy.style.color       = "var(--tsa-pos)";
    }
    if (dSell) {
      dSell.style.borderColor = "var(--tsa-neg-border)";
      dSell.style.background  = "var(--tsa-neg-bg-hi)";
      dSell.style.color       = "var(--tsa-neg)";
    }
    var bg       = "var(--tsa-bg-bar)";
    var border   = "var(--tsa-border-strong)";
    var selBg    = "var(--tsa-bg-input)";
    var selColor = "var(--tsa-fg-strong)";
    var selBord  = "var(--tsa-border)";
    var chartBg  = "var(--tsa-bg-chart)";
    var chartBrd = "var(--tsa-border)";
    var labelCol = "var(--tsa-fg-faint)";
    var liveCol  = "var(--tsa-fg-strong)";

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
      lockLabel.style.border      = "1px solid var(--tsa-warn-border)";
      lockLabel.style.background  = "var(--tsa-warn-bg)";
    }
    if (lockText) {
      lockText.style.color = "var(--tsa-warn)";
    }
    var minBtn = document.getElementById("qt-min-btn");
    if (minBtn) {
      minBtn.style.color = "var(--tsa-fg-faint)";
      minBtn.style.borderColor = "var(--tsa-border)";
    }
    // Re-render buttons with new theme colors
    renderQtRows();
    renderQtPills();
  }

  function createQuickTradeBar() {
    var bar = document.createElement("div");
    bar.id = "qt-bar";
    bar.style.cssText = "background:var(--tsa-bg-bar);border-bottom:2px solid var(--tsa-border-strong);padding:8px 12px;box-shadow:0 4px 16px var(--tsa-shadow);font-family:var(--tsa-mono);position:sticky;top:0;z-index:9999;";
    if (!getShowQtBar()) bar.style.display = "none";
    bar.innerHTML =
      // Row 1: Minimize button + Stock searchable combobox + edit + lock
      "<div id='qt-row1' style='display:flex;flex-wrap:wrap;gap:7px;margin-bottom:6px;align-items:center'>" +
        "<button id='qt-min-btn' title='Minimize Quick Trade bar' style='padding:4px 7px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-border);background:transparent;color:var(--tsa-fg-faint);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);cursor:pointer;flex-shrink:0;'>&#9660;</button>" +
        // min-width:0 so the search field can shrink below its intrinsic input width;
        // without it a flex item refuses to go under its content size and the row
        // overflows on a narrow phone instead of fitting on one line.
        "<div id='qt-stock-wrap' style='position:relative;flex:1;min-width:0'>" +
          "<input id='qt-stock-search' type='text' placeholder='Search stock…' autocomplete='off' style='width:100%;box-sizing:border-box;background:var(--tsa-bg-input);border:1px solid var(--tsa-border);border-radius:var(--tsa-r-2);color:var(--tsa-fg-strong);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;padding:7px 26px 7px 10px;outline:none;'>" +
          "<input type='hidden' id='qt-stock' value=''>" +
          "<span style='position:absolute;right:9px;top:50%;transform:translateY(-50%);color:var(--tsa-fg-faint);font-size:var(--tsa-fs-micro);pointer-events:none'>▼</span>" +
          "<div id='qt-stock-list' style='display:none;position:absolute;top:calc(100% + 3px);left:0;right:0;background:var(--tsa-bg-input);border:1px solid var(--tsa-border);border-radius:var(--tsa-r-2);z-index:99999;max-height:200px;overflow-y:auto;box-shadow:0 4px 16px var(--tsa-shadow);'></div>" +
        "</div>" +
        "<button id='qt-edit' title='Edit trade amounts' style='padding:6px 8px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-border);background:transparent;color:var(--tsa-fg-faint);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);cursor:pointer;flex-shrink:0;'>✎</button>" +
        "<label id='qt-lock-label' title='When ON, sells are capped to swing shares so benefit-tier blocks are protected' style='display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0;padding:8px 10px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-warn-border);background:var(--tsa-warn-bg);min-height:32px;'>" +
          "<input type='checkbox' id='qt-lock-benefit' checked style='accent-color:var(--tsa-warn);width:18px;height:18px;cursor:pointer;flex-shrink:0;'>" +
          "<span id='qt-lock-text' style='font-size:var(--tsa-fs-micro);font-weight:700;color:var(--tsa-warn);font-family:var(--tsa-mono);letter-spacing:0.04em;white-space:nowrap;'>🔒 Benefit Lock</span>" +
        "</label>" +
      "</div>" +
      // Collapsible body: benefit info + direction toggle + amount row + rec + chart
      "<div id='qt-body'>" +
        "<div id='qt-benefit-info' style='display:none;margin-bottom:4px;padding:0 2px;'>" +
          "<span id='qt-swing-available' style='font-size:var(--tsa-fs-micro);color:var(--tsa-warn);font-family:var(--tsa-mono);font-weight:600;'></span>" +
        "</div>" +
        // Row 2: direction, then one row of amounts.
        //
        // This replaced two mirrored rows that were told apart only by colour — an
        // easy mis-click on a trade that spends real money and cannot be undone.
        // Now the direction is chosen once, in words, and the amounts inherit it.
        // Costs one extra click only when you actually switch sides.
        "<div id='qt-trade-controls' style='display:flex;gap:5px;align-items:flex-start'>" +
          "<div role='group' aria-label='Trade direction' style='display:flex;gap:3px;flex-shrink:0;margin-right:4px;'>" +
            "<button id='qt-dir-buy' aria-pressed='true' title='Buy' style='padding:6px 9px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-pos-border);background:var(--tsa-pos-bg-hi);color:var(--tsa-pos);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;cursor:pointer;letter-spacing:0.04em;'>BUY</button>" +
            "<button id='qt-dir-sell' aria-pressed='false' title='Sell' style='padding:6px 9px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-neg-border);background:var(--tsa-neg-bg-hi);color:var(--tsa-neg);font-family:var(--tsa-mono);font-size:var(--tsa-fs-micro);font-weight:700;cursor:pointer;letter-spacing:0.04em;'>SELL</button>" +
          "</div>" +
          // Wraps rather than scrolls: on a phone the row is wider than the screen,
          // and a horizontal swipe inside a vertically-scrolling page hid ALL and the
          // largest preset behind a gesture nobody discovers. Wrapping costs one row
          // of height on mobile and nothing on desktop, where it still fits on one line.
          "<div id='qt-amount-row' style='display:flex;flex-wrap:wrap;gap:5px;flex:1;'></div>" +
        "</div>" +
        // The consequence line: what the next click does, in shares.
        "<div id='qt-consequence' role='status' aria-live='polite' style='margin-top:5px;padding-left:8px;border-left:2px solid transparent;font-size:var(--tsa-fs-micro);color:var(--tsa-fg-muted);font-family:var(--tsa-mono);min-height:15px;line-height:15px;transition:color .12s,border-color .12s;'>Select a stock to see what a trade would do.</div>" +
        // ROI recommendation
        "<div id='qt-rec' style='display:none;margin-top:6px;'></div>" +
        // Chart
        "<div id='qt-chart-container' style='display:none;margin-top:8px;background:var(--tsa-bg-chart);border-radius:var(--tsa-r-3);border:1px solid var(--tsa-border);padding:8px 10px 6px;'>" +
          "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;'>" +
            "<span id='qt-chart-title' style='font-size:var(--tsa-fs-micro);font-weight:700;color:var(--tsa-fg-faint);font-family:var(--tsa-mono);letter-spacing:0.08em;text-transform:uppercase;'></span>" +
            "<span id='qt-chart-live' style='font-size:var(--tsa-fs-micro);font-weight:700;font-family:var(--tsa-mono);color:var(--tsa-fg-strong);'></span>" +
          "</div>" +
          "<canvas id='qt-chart-canvas' height='110' style='width:100%;height:110px;display:block;'></canvas>" +
          "<div id='qt-chart-labels' style='position:relative;height:14px;font-size:var(--tsa-fs-micro);color:var(--tsa-fg-faint);font-family:var(--tsa-mono);margin-top:2px;'></div>" +
          "<div id='qt-tf-row' style='display:flex;gap:3px;margin-top:5px;'>" +
            "<button class='qt-tf-btn' data-tf='1d' style='flex:1;min-height:32px;padding:7px 0;border-radius:var(--tsa-r-1);border:1px solid var(--tsa-border);background:none;color:var(--tsa-fg-faint);font-size:var(--tsa-fs-micro);font-family:var(--tsa-mono);cursor:pointer;'>1d</button>" +
            "<button class='qt-tf-btn' data-tf='3d' style='flex:1;min-height:32px;padding:7px 0;border-radius:var(--tsa-r-1);border:1px solid var(--tsa-border);background:none;color:var(--tsa-fg-faint);font-size:var(--tsa-fs-micro);font-family:var(--tsa-mono);cursor:pointer;'>3d</button>" +
            "<button class='qt-tf-btn' data-tf='7d' style='flex:1;min-height:32px;padding:7px 0;border-radius:var(--tsa-r-1);border:1px solid var(--tsa-border);background:none;color:var(--tsa-fg-faint);font-size:var(--tsa-fs-micro);font-family:var(--tsa-mono);cursor:pointer;'>7d</button>" +
            "<button class='qt-tf-btn' data-tf='all' style='flex:1;min-height:32px;padding:7px 0;border-radius:var(--tsa-r-1);border:1px solid var(--tsa-border);background:none;color:var(--tsa-fg-faint);font-size:var(--tsa-fs-micro);font-family:var(--tsa-mono);cursor:pointer;'>All</button>" +
          "</div>" +
        "</div>" +
      "</div>";

    var qtResponsive = document.createElement("style");
    qtResponsive.textContent = "@media (hover:none),(pointer:coarse){#qt-bar button,#qt-bar input{min-height:32px;padding:4px 8px;font-size:var(--tsa-fs-micro)}#qt-row1{gap:6px!important;margin-bottom:6px!important}#qt-trade-controls{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}#qt-trade-controls>[role=group]{width:100%;height:32px;box-sizing:border-box;margin:0!important;gap:0!important}#qt-trade-controls>[role=group] button{flex:1;height:32px;padding:4px 8px!important}#qt-amount-row{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:32px;gap:6px!important;width:100%;flex:none}#qt-amount-row button{width:100%;height:32px;padding:4px 8px!important}#qt-lock-label{padding:4px 8px!important;min-height:32px!important}#qt-lock-benefit{width:16px!important;height:16px!important}#qt-lock-text{font-size:var(--tsa-fs-micro)!important}#qt-consequence{margin:4px 0!important;padding:4px 8px!important}#qt-rec{margin:4px 0!important;padding:4px 8px!important}#qt-chart-container{padding:6px 8px!important;margin-top:6px!important}#qt-chart-canvas{height:100px!important;touch-action:pan-y}#qt-chart-container>div:first-child{display:flex;gap:4px;min-width:0}#qt-chart-title{flex:1;min-width:0}#qt-tf-row{display:flex;flex:0 0 auto;gap:2px!important;margin:0!important}#qt-tf-row .qt-tf-btn{min-height:26px!important;height:26px;padding:2px 8px!important;font-size:12px!important;flex:0 0 auto!important}}#qt-bar.qt-minimized{padding:4px 10px!important}#qt-bar.qt-minimized #qt-body{display:none!important}";
    bar.appendChild(qtResponsive);

    var pillsDiv = document.createElement("div");
    pillsDiv.id = "qt-pills";
    pillsDiv.style.cssText = "display:none;padding:4px 12px 8px;";

    var target = document.getElementById("stockmarketroot") ||
                 document.querySelector(".content-wrapper") ||
                 document.querySelector("#page-wrapper > div") ||
                 document.body;
    if (target && target.firstChild) target.insertBefore(bar, target.firstChild);
    else document.body.insertBefore(bar, document.body.firstChild);
    bar.insertAdjacentElement("afterend", pillsDiv);
    var tfRow = document.getElementById("qt-tf-row"), chartCanvas = document.getElementById("qt-chart-canvas");
    if (tfRow && chartCanvas && chartCanvas.parentNode) chartCanvas.parentNode.insertBefore(tfRow, chartCanvas);

    renderQtRows();
    setTimeout(qtBuildMaps, 1000);
    setTimeout(function() { updateQtRecommendation(null); }, 1500);
    // Apply initial theme
    applyQtTheme(lsGet("tsa_dark", "false") === "true");
    // Apply initial bar / pills / minimize visibility
    (function() {
      var minimized = lsGet("qt_minimized", "false") === "true";
      var qtMinBtn = document.getElementById("qt-min-btn");
      if (qtMinBtn) qtMinBtn.textContent = minimized ? "\u25B6" : "\u25BC";
      applyQtBarVisibility();
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
        listEl.innerHTML = "";
        items.forEach(function(sym) {
          var item = document.createElement("div");
          item.className = "qt-stock-list-item";
          item.textContent = sym;
          item.style.color = "var(--tsa-fg-strong)";
          item.onmousedown = function(e) {
            e.preventDefault(); // prevent blur before click fires
            hiddenEl.value = sym;
            searchEl.value = sym;
            listEl.style.display = "none";
            lsSet("qt_last_stock", sym);
            qtDrawChart(sym);
            qtUpdateExec();
            // Without this the line keeps quoting the PREVIOUS stock's price and
            // holding while the buttons are armed on this one.
            qtRenderConsequence(null);
          };
          listEl.appendChild(item);
        });
        listEl.style.display = items.length ? "block" : "none";
      }

      searchEl.addEventListener("focus", function() { this.select(); buildList(""); });
      searchEl.addEventListener("input", function() {
        hiddenEl.value = "";
        qtRenderConsequence(null);   // selection cleared — the line must not keep one
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
        // renderQtRows already ran, before this restore — repaint the line now that
        // the bar actually has a stock, or it reads "select a stock" under one.
        qtRenderConsequence(null);
        // Torn renders the stock cards after document-end, so the call above can land
        // while qtBuildMaps still has nothing to read and settle on "price not
        // readable". Nothing else would re-render it until the user interacts, so
        // repaint once the cards exist. Purely a DOM re-read — no network.
        setTimeout(function() { qtRenderConsequence(null); }, 1600);
      }
    })();

    $("#qt-edit").on("click", function() {
      qtEditMode = !qtEditMode;
      $(this).css({color: qtEditMode ? "var(--tsa-accent)" : "var(--tsa-fg-faint)", borderColor: qtEditMode ? "var(--tsa-accent)" : "var(--tsa-border)"});
      $(this).text(qtEditMode ? "✓" : "✎");
      renderQtRows();
    });

    document.getElementById("qt-lock-benefit") && document.getElementById("qt-lock-benefit").addEventListener("change", function() {
      qtUpdateExec();
      // The sell preview reads this checkbox to decide whether to say "capped by
      // Benefit Lock", so a keyboard or programmatic toggle must repaint it.
      qtRenderConsequence(null);
    });

    // Direction toggle. setQtDir re-renders the amount row in the new colour and
    // clears the consequence line, so nothing left over from the old direction can
    // be read as applying to the new one.
    document.getElementById("qt-dir-buy") && document.getElementById("qt-dir-buy")
      .addEventListener("click", function() { setQtDir("buy"); });
    document.getElementById("qt-dir-sell") && document.getElementById("qt-dir-sell")
      .addEventListener("click", function() { setQtDir("sell"); });

    document.getElementById("qt-min-btn") && document.getElementById("qt-min-btn").addEventListener("click", function() {
      var minimized = lsGet("qt_minimized", "false") === "true";
      minimized = !minimized;
      lsSet("qt_minimized", String(minimized));
      this.textContent = minimized ? "\u25B6" : "\u25BC";
      applyQtBarVisibility();
    });
  }

  // ============================================================
  // TSA LICENCE (optional) — the Settings line
  // ============================================================
  // Built with createElement + textContent throughout: name, renew and expiry come
  // from the server and are never parsed as HTML. The licence only switches the
  // data source; nothing here can lock TSA (owner decision 2026-11-02).
  var licenseLast = null;         // the last licence decision
  var licenseGen = 0;             // bumped by every load and every licence key change; older loads are dropped
  var LICENSE_SITE_URL = "https://dossier.aec3.org";

  function licenseEnsure(force, cb) {
    return TSALicense.ensure(licenseDeps, force, function (d) {
      licenseLast = d;
      cb(d);
    });
  }

  function licenseFmtDate(ms) {
    try {
      return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) { return new Date(ms).toISOString(); }
  }

  function licenseEl(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  var LICENSE_BTN_SECONDARY = "width:100%;padding:8px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-border);background:none;color:var(--tsa-fg-muted);font-size:var(--tsa-fs-micro);cursor:pointer";
  var LICENSE_INPUT = "width:100%;box-sizing:border-box;padding:8px 10px;border-radius:var(--tsa-r-2);border:1px solid var(--tsa-border);background:var(--tsa-bg-raised);color:var(--tsa-fg);font-size:var(--tsa-fs-micro);font-family:var(--tsa-mono)";

  function licenseReasonText(d) {
    var s = d.state;
    switch (d.reason) {
      case "bad_format": return "That is not a TSA licence key. A key starts with tsa1_ and is 48 characters long.";
      case "rejected":   return "The key was not accepted — it is wrong, revoked or replaced by a newer key. Get a new key on Dossier.";
      case "inactive":   return "Your TSA licence has expired" + (s.expires_ts ? " (" + licenseFmtDate(s.expires_ts * 1000) + ")" : "") + ".";
      case "grace_over":
        return "Your licence could not be verified for more than 72 hours, because dossier-api.aec3.org " +
          (s.fail === "rate_limited" ? "refused the checks as too many" : "could not be reached") +
          ". Licence mode resumes as soon as a check succeeds.";
      case "unverified":
        return s.fail === "rate_limited"
          ? "Too many licence checks right now. Try again in a few minutes."
          : "Could not reach dossier-api.aec3.org to check the key. Try again in a few minutes.";
      default: return "";
    }
  }

  // A malformed key is refused locally and never sent. A well-formed one is checked
  // BEFORE it replaces anything: with TSA open, a key that fails leaves the working
  // key in place and only says why.
  function licenseSubmit(value, msgEl, btn) {
    var val = (value || "").trim();
    if (!TSALicense.validToken(val)) {
      msgEl.textContent = "That is not a TSA licence key. A key starts with tsa1_ and is 48 characters long.";
      msgEl.style.color = "var(--tsa-neg)";
      return;
    }
    msgEl.textContent = "Checking key…";
    msgEl.style.color = "var(--tsa-fg-muted)";
    if (btn) btn.disabled = true;
    var before = TSALicense.peek(licenseDeps).state.token;
    TSALicense.tryToken(licenseDeps, val, function (r) {
      if (btn) btn.disabled = false;
      if (!r.applied) {
        msgEl.textContent = licenseReasonText(r.decision) + (TSALicense.validToken(before) ? " Your current key is still in use." : " TSA keeps using your own Torn key.");
        msgEl.style.color = "var(--tsa-neg)";
        return;
      }
      // A different key may belong to a different Dossier account: never show the
      // previous one's holdings under it.
      if (val !== before) dataForgetAccount(TSALicense.validToken(before));
      licenseEnsure(false, function (d) {
        showToast(d.locked ? "Licence saved, but not active \u2014 TSA keeps using your own Torn key"
                           : "TSA licence active \u2014 data now comes from Dossier", d.locked ? "warn" : "success");
        loadData();
      });
    });
  }

  // The Settings → Dossier line: status plus Add key / Change key / Remove.
  function renderLicenseStatus(host) {
    if (!host) return;
    host.textContent = "";
    var d = TSALicense.peek(licenseDeps);
    var s = d.state;
    var line;
    var expMs = s.expires_ts ? s.expires_ts * 1000 : null;
    if (!d.locked && expMs != null && expMs <= Date.now()) {
      // past its end date but not yet re-confirmed (Dossier unreachable): say both
      line = "Licence period ended " + licenseFmtDate(expMs) + " — waiting for Dossier to confirm a renewal";
    } else if (!d.locked && d.reason === "grace" && s.fail) {
      // rate_limited: the server answered "too many checks", it is not down.
      line = (s.fail === "rate_limited"
        ? "Licence server busy (too many checks) — using the last confirmed licence until "
        : "Licence server unreachable — working offline until ") + licenseFmtDate(s.ok_ms + TSALicense.GRACE_MS);
    } else if (!d.locked) {
      line = s.expires_ts ? "Licence active until " + licenseFmtDate(s.expires_ts * 1000) : "Licence active (no expiry)";
    } else if (!s.token) {
      line = "No licence \u2014 TSA runs free on your own Torn API key";
    } else {
      line = "Licence not active \u2014 TSA runs free on your own Torn API key";
      var why = licenseReasonText(d);
      if (why) line += ". " + why;
      if (d.reason === "inactive" && s.renew) line += " To renew: " + s.renew;
    }
    if (s.name) line += " · " + s.name;
    host.appendChild(licenseEl("div", "font-size:var(--tsa-fs-micro);color:var(--tsa-fg);margin-bottom:6px", line));

    var row = licenseEl("div", "display:flex;gap:8px");
    var change = licenseEl("button", LICENSE_BTN_SECONDARY + ";flex:1;width:auto", s.token ? "Change key" : "Add licence key");
    var remove = licenseEl("button", LICENSE_BTN_SECONDARY + ";flex:1;width:auto", "Remove");
    row.appendChild(change);
    if (s.token) row.appendChild(remove);
    host.appendChild(row);

    change.addEventListener("click", function () {
      host.textContent = "";
      var input = licenseEl("input", LICENSE_INPUT + ";margin-bottom:6px");
      input.type = "text";
      input.placeholder = "tsa1_…";
      input.autocomplete = "off";
      input.spellcheck = false;
      var msg = licenseEl("div", "font-size:var(--tsa-fs-micro);color:var(--tsa-fg-muted);margin-top:6px;line-height:1.4");
      msg.setAttribute("aria-live", "polite");
      var r2 = licenseEl("div", "display:flex;gap:8px");
      var ok = licenseEl("button", LICENSE_BTN_SECONDARY + ";flex:1;width:auto;color:var(--tsa-accent);font-weight:bold", "Save key");
      var cancel = licenseEl("button", LICENSE_BTN_SECONDARY + ";flex:1;width:auto", "Cancel");
      ok.addEventListener("click", function () { licenseSubmit(input.value, msg, ok); });
      cancel.addEventListener("click", function () { renderLicenseStatus(host); });
      r2.appendChild(ok);
      r2.appendChild(cancel);
      host.appendChild(input);
      host.appendChild(r2);
      host.appendChild(msg);
      input.focus();
    });

    // Two taps within 4 s, no dialog: removing the key switches TSA to free mode.
    var armed = false;
    remove.addEventListener("click", function () {
      if (!armed) {
        armed = true;
        remove.textContent = "Tap again to remove";
        remove.style.color = "var(--tsa-neg)";
        setTimeout(function () {
          armed = false;
          remove.textContent = "Remove";
          remove.style.color = "";
        }, 4000);
        return;
      }
      TSALicense.clear(licenseDeps);
      dataForgetAccount(false);
      renderLicenseStatus(host);
      showToast("Licence removed \u2014 TSA uses your own Torn API key", "success");
      loadData();
    });
  }

  // On touch-only devices native title bubbles can remain stuck in TornPDA's
  // WebView. Keep their text available to assistive technology without exposing
  // the native tooltip. This observer is deliberately limited to TSA roots.
  // (hover: none) alone misses phones with a stylus, which report hover support;
  // a coarse primary pointer is the other touch-first signal.
  function tsaIsTouchOnly() {
    if (!window.matchMedia) return false;
    return window.matchMedia("(hover: none)").matches || window.matchMedia("(pointer: coarse)").matches;
  }

  function tsaStripTitles(root) {
    if (!tsaIsTouchOnly() || !root) return;
    function strip(el) {
      if (!el || el.nodeType !== 1 || !el.hasAttribute("title")) return;
      if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", el.getAttribute("title"));
      el.removeAttribute("title");
    }
    strip(root);
    if (root.querySelectorAll) Array.prototype.forEach.call(root.querySelectorAll("[title]"), strip);
  }

  var tsaTitleObserver = null;
  function tsaObserveTitles() {
    if (!tsaIsTouchOnly() || tsaTitleObserver) return;
    var roots = ["tsa-overlay", "qt-bar", "qt-pills"].map(function(id) { return document.getElementById(id); }).filter(Boolean);
    roots.forEach(tsaStripTitles);
    if (!roots.length) return;
    tsaTitleObserver = new MutationObserver(function(records) {
      records.forEach(function(record) {
        if (record.type === "attributes") tsaStripTitles(record.target);
        else Array.prototype.forEach.call(record.addedNodes || [], tsaStripTitles);
      });
    });
    roots.forEach(function(root) {
      tsaTitleObserver.observe(root, { attributes: true, attributeFilter: ["title"], childList: true, subtree: true });
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
      ".tsa-pin-btn{background:none;border:none;cursor:pointer;font-size:var(--tsa-fs-micro);padding:0 2px;opacity:0.35;transition:opacity 0.15s;line-height:1;vertical-align:middle}",
      ".tsa-pin-btn.pinned{opacity:1}",
      ".tsa-pin-btn:hover{opacity:1}",
      "#tsa-scroll-top{position:sticky;bottom:8px;float:right;margin-right:8px;z-index:10;background:var(--tsa-accent);color:var(--tsa-on-accent);border:none;border-radius:var(--tsa-r-circle);width:26px;height:26px;font-size:var(--tsa-fs-body);cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 2px 8px var(--tsa-shadow);line-height:1}",
      "#tsa-scroll-top:hover{background:var(--tsa-accent-hover)}",
      ".qt-stock-list-item{padding:7px 10px;cursor:pointer;font-size:var(--tsa-fs-micro);font-weight:700;font-family:var(--tsa-mono)}",
      ".qt-stock-list-item:hover{background:var(--tsa-accent-bg)}"
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
    tsaObserveTitles();
    applyOverlayPosition(getOverlayPosition());

    // Apply theme changes from the Settings panel.
    function applyThemeChange(isDark) {
      if (isDark) overlay.classList.add("tsa-dark");
      else overlay.classList.remove("tsa-dark");
      lsSet("tsa_dark", isDark.toString());
      applyQtTheme(isDark);
    }

    document.getElementById("tsa-settings-btn").addEventListener("click", function() {
      var content = document.getElementById("tsa-content");
      var isDarkNow = overlay.classList.contains("tsa-dark");
      var bg2 = "var(--tsa-bg-raised)";
      var border = "var(--tsa-border)";
      var text = "var(--tsa-fg)";
      var muted = "var(--tsa-fg-faint)";

      var inputStyle = "width:100%;padding:7px 10px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:var(--tsa-fs-body);";
      var labelTitle = "font-size:var(--tsa-fs-micro);color:" + muted + ";margin-bottom:4px";
      var hint       = "font-size:var(--tsa-fs-micro);color:" + muted + ";margin-top:4px;line-height:1.4";
      var section    = "border-top:1px solid " + border + ";margin-bottom:12px;padding-top:12px";
      var sectionH   = "font-size:var(--tsa-fs-micro);letter-spacing:0.1em;color:" + muted + ";text-transform:uppercase;font-weight:bold;margin-bottom:10px";
      var checkLabel = "display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:10px";

      content.innerHTML =
        "<div style=\"padding:14px\">" +
        "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + muted + ";text-transform:uppercase;font-weight:bold;margin-bottom:14px\">Settings</div>" +

        // ── Trades & alerts ─────────────────────
        "<div style=\"" + sectionH + "\">Trades & alerts</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Profit target (%)</div>" +
          "<input id=\"tsa-setting-profit\" type=\"number\" step=\"0.1\" min=\"0.1\" max=\"10\" value=\"" + getProfitTarget() + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">Default 1.0%. Backtesting found this the best return per day of tied-up capital; below it the 0.1% round-trip fee eats the gain.</div>" +
        "</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Stop loss (%)</div>" +
          "<input id=\"tsa-setting-stoploss\" type=\"number\" step=\"0.1\" min=\"0\" max=\"20\" value=\"" + getStopLoss() + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">0 = off (default). Torn stocks mean-revert, so a stop loss mostly realizes dips that recover. Set 2–5% only if you want a hard exit.</div>" +
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
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Show Watch section</span>" +
        "</label>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-show-qt-chart\"" + (getShowQtChart() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Show Quick Trade chart</span>" +
        "</label>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-show-qt-bar\"" + (getShowQtBar() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Show Quick Trade bar</span>" +
        "</label>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-pills-always\"" + (getPillsAlways() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Always show Quick pills (even when bar is hidden)</span>" +
        "</label>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Quick Buy pill source</div>" +
          "<select id=\"tsa-setting-qt-buy-source\" style=\"" + inputStyle + "\">" +
            "<option value=\"top5\"" + (getQtBuySource() === "top5" ? " selected" : "") + ">Top 5 buy</option>" +
            "<option value=\"buyzone\"" + (getQtBuySource() === "buyzone" ? " selected" : "") + ">Buy zone</option>" +
          "</select>" +
        "</div>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-show-top5\"" + (getShowTop5() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Show Top 5 buy section (always shown while the pill source is Top 5)</span>" +
        "</label>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Min score for Top 5 (0–160)</div>" +
          "<input id=\"tsa-setting-top5-min\" type=\"number\" step=\"1\" min=\"0\" max=\"160\" value=\"" + getTop5MinScore() + "\" style=\"" + inputStyle + "\">" +
        "</div>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-req-investors\"" + (getRequirePositiveInvestors() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer;accent-color:var(--tsa-accent)\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Require positive investor-delta in Top 5 Buy</span>" +
        "</label>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Overlay position</div>" +
          "<select id=\"tsa-setting-position\" style=\"" + inputStyle + "\">" +
            "<option value=\"bottom-right\"" + (getOverlayPosition() === "bottom-right" ? " selected" : "") + ">Bottom right</option>" +
            "<option value=\"bottom-left\""  + (getOverlayPosition() === "bottom-left"  ? " selected" : "") + ">Bottom left</option>" +
            "<option value=\"middle-right\"" + (getOverlayPosition() === "middle-right" ? " selected" : "") + ">Middle right</option>" +
            "<option value=\"middle-left\""  + (getOverlayPosition() === "middle-left"  ? " selected" : "") + ">Middle left</option>" +
            "<option value=\"top-right\""    + (getOverlayPosition() === "top-right"    ? " selected" : "") + ">Top right</option>" +
            "<option value=\"top-left\""     + (getOverlayPosition() === "top-left"     ? " selected" : "") + ">Top left</option>" +
            (getOverlayPosition() === "custom" ? "<option value=\"custom\" selected>Custom (dragged)</option>" : "") +
          "</select>" +
          "<div style=\"font-size:var(--tsa-fs-micro);color:" + muted + ";margin-top:4px\">Tip: drag the Stocks button to place it anywhere.</div>" +
        "</div>" +
        "</div>" +

        // ── Realized profits ─────────────────────
        "<div style=\"" + section + "\">" +
        "<div style=\"" + sectionH + "\">Realized profits</div>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-swing-only\"" + (getProfitSwingOnly() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Swing trade profit only</span>" +
        "</label>" +
        "<label style=\"" + checkLabel + "\">" +
          "<input type=\"checkbox\" id=\"tsa-setting-show-realized\"" + (getShowRealized() ? " checked" : "") + " style=\"width:15px;height:15px;cursor:pointer\">" +
          "<span style=\"font-size:var(--tsa-fs-micro);color:" + text + "\">Show realized profit</span>" +
        "</label>" +
        "<div id=\"tsa-realized-options\" style=\"display:" + (getShowRealized() ? "block" : "none") + ";padding-left:23px\">" +
          "<div style=\"" + labelTitle + "\">Period (days, 1–90)</div>" +
          "<input id=\"tsa-setting-realized-days\" type=\"number\" step=\"1\" min=\"1\" max=\"90\" value=\"" + getRealizedDays() + "\" style=\"" + inputStyle + ";margin-bottom:8px\">" +
          "<button id=\"tsa-realized-reset\" style=\"width:100%;padding:7px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:none;color:" + muted + ";font-size:var(--tsa-fs-micro);cursor:pointer\">Reset realized profit</button>" +
        "</div>" +
        "</div>" +

        // ── Account ─────────────────────
        "<div style=\"" + section + "\">" +
        "<div style=\"" + sectionH + "\">Account</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">Torn API key</div>" +
          "<input id=\"tsa-setting-apikey\" type=\"password\" autocomplete=\"off\" value=\"" + escHtml(TORN_API_KEY || "") + "\" style=\"" + inputStyle + "\">" +
          "<div style=\"" + hint + "\">Stored in your browser only — never sent anywhere except <code>api.torn.com</code>. Get a key at torn.com/preferences.php#tab=api.</div>" +
        "</div>" +
        "</div>" +

        // ── Dossier (optional, paid) ────
        "<div style=\"" + section + "\">" +
        "<div style=\"" + sectionH + "\">Dossier (optional, paid)</div>" +
        "<div style=\"" + hint + ";margin:0 0 12px\">TSA is free with your own Torn API key above. Optionally, with an active TSA licence from dossier.aec3.org, TSA reads the same data from Dossier instead (Dossier uses the Torn API key saved in your Dossier account). Only the licence key is sent, only to dossier-api.aec3.org. If the licence lapses or Dossier is unavailable, TSA uses your own Torn API key.</div>" +
        "<div style=\"" + hint + ";margin:0 0 12px\">With a licence, also stored in this browser (torn.com site storage, which other scripts on torn.com can read): your licence key; your holdings as last read from Dossier (shares, buy prices and times per lot), cash and armoury balance, shown for up to 6 hours, so TSA can show them while Dossier is unreachable; public market prices for up to 24 hours; your Quick Trade trades for 30 minutes. Stored Dossier holdings older than 6 hours are no longer shown and are deleted the next time TSA loads from Dossier; removing or changing the licence key deletes them at once (Remove works for an expired key too).</div>" +
        "<div style=\"margin-bottom:12px\">" +
          "<div style=\"" + labelTitle + "\">TSA licence</div>" +
          "<div id=\"tsa-license-status\"></div>" +
        "</div>" +
        "</div>" +

        "<div style=\"display:flex;gap:8px\">" +
        "<button id=\"tsa-settings-save\" style=\"flex:1;padding:8px;border-radius:var(--tsa-r-2);border:none;background:var(--tsa-accent);color:var(--tsa-on-accent);font-size:var(--tsa-fs-body);font-weight:bold;cursor:pointer\">Save</button>" +
        "<button id=\"tsa-settings-cancel\" style=\"flex:1;padding:8px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:none;color:" + muted + ";font-size:var(--tsa-fs-body);cursor:pointer\">Cancel</button>" +
        "</div>" +
        "</div>";

      renderLicenseStatus(document.getElementById("tsa-license-status"));

      // Toggle realized options visibility
      document.getElementById("tsa-setting-show-realized").addEventListener("change", function() {
        document.getElementById("tsa-realized-options").style.display = this.checked ? "block" : "none";
      });

      document.getElementById("tsa-realized-reset").addEventListener("click", function() {
        // Stash the events for one-tap undo. tsa_prev_holdings is NOT backed
        // up: it self-heals on the next load, and restoring an old snapshot
        // later would fabricate realized events from a stale diff.
        lsSet("tsa_realized_events_backup", localStorage.getItem("tsa_realized_events") || "[]");
        lsSet("tsa_realized_events", "[]");
        lsSet("tsa_prev_holdings", "{}");
        showRealizedUndoToast();
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
        var showQtBar = document.getElementById("tsa-setting-show-qt-bar").checked;
        var pillsAlways = document.getElementById("tsa-setting-pills-always").checked;
        var qtBuySource = (document.getElementById("tsa-setting-qt-buy-source") || {}).value;
        var showTop5 = !!(document.getElementById("tsa-setting-show-top5") || {}).checked;
        var top5Min = parseInt(document.getElementById("tsa-setting-top5-min").value, 10);
        var reqInv = document.getElementById("tsa-setting-req-investors").checked;
        var rd = parseInt((document.getElementById("tsa-setting-realized-days") || {}).value || "7", 10);
        var posVal = document.getElementById("tsa-setting-position").value;
        var themeVal = document.getElementById("tsa-setting-theme").value;
        var keyVal = (document.getElementById("tsa-setting-apikey").value || "").trim();
        // The max= attributes are advisory only — a browser does not enforce them
        // on a non-submitted input read via .value, so bound them here too.
        if (isNaN(profit) || profit <= 0 || profit > 10) { showToast("Profit target must be 0.1–10%", "warn"); return; }
        if (isNaN(stop) || stop < 0 || stop > 20) { showToast("Stop loss must be 0–20% (0 = off)", "warn"); return; }
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
        lsSet("tsa_show_qt_bar", showQtBar ? "true" : "false");
        lsSet("tsa_pills_always", pillsAlways ? "true" : "false");
        // Anything but the top5 literal stores as buyzone (the default), so a missing
        // element or a hand-edited value can never leave the pills pointed at nothing.
        lsSet("tsa_qt_buy_source", qtBuySource === "top5" ? "top5" : "buyzone");
        lsSet("tsa_show_top5", showTop5 ? "true" : "false");
        applyQtBarVisibility();
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
        // Cleared on ANY settings save, not only on a CHANGED key: widening a key's
        // permissions on Torn's side leaves the key string identical, so gating this
        // on "the key changed" made the obvious fix — re-save the key — a no-op, and
        // left the stale reason on screen for an hour.
        if (keyVal) lsSet("tsa_stock_catalogue_fail_ts", "0");
        var saveBtn = document.getElementById("tsa-settings-save");
        if (saveBtn) {
          saveBtn.textContent = "Saved ✓";
          saveBtn.style.background = "var(--tsa-pos)";
          setTimeout(function() { loadData(); }, 700);
        } else {
          loadData();
        }
      });

      document.getElementById("tsa-settings-cancel").addEventListener("click", function() {
        renderCached();
      });
    });

    document.getElementById("tsa-update-btn").addEventListener("click", function() {
      // An explicit refresh clears the catalogue failure marker (free mode) and ends
      // the 5-min wait after a failed Dossier history/reference call (licence mode):
      // pressing this IS the request to try again. Costs at most one extra call, and
      // only when the user asked for it. A 429's Retry-After is still honoured.
      lsSet("tsa_stock_catalogue_fail_ts", "0");
      TSAData.resetWaits();
      loadData();
    });

    document.getElementById("tsa-alerts-btn").addEventListener("click", function() {
      var content = document.getElementById("tsa-content");
      var bg2 = "var(--tsa-bg-raised)";
      var border = "var(--tsa-border)";
      var text = "var(--tsa-fg)";
      var muted = "var(--tsa-fg-faint)";
      var alerts = loadAlerts();

      var rows = alerts.length ? alerts.map(function(a) {
        var repeatBadge = a.repeat
          ? "<span title=\"Repeating alert\" style=\"font-size:var(--tsa-fs-micro);margin-left:4px;opacity:0.7\">🔁</span>"
          : "";
        return "<div style=\"display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid " + border + ";font-size:var(--tsa-fs-micro);\">" +
          "<span style=\"color:" + text + ";font-weight:bold\">" + a.sym + repeatBadge + "</span>" +
          "<span style=\"color:" + muted + "\">" + (a.dir === "above" ? "≥" : "≤") + " $" + parseFloat(a.price).toFixed(2) + "</span>" +
          "<button data-sym=\"" + a.sym + "\" data-dir=\"" + a.dir + "\" class=\"tsa-alert-del\" style=\"border:none;background:none;color:var(--tsa-neg);cursor:pointer;font-size:var(--tsa-fs-body);\">✕</button>" +
          "</div>";
      }).join("") : "<div style=\"color:" + muted + ";font-size:var(--tsa-fs-micro);padding:8px 0\">No active alerts</div>";

      var stockOpts = ["ASS","BAG","CBD","CNC","ELT","EVL","EWM","FHG","GRN","HRG","IIL","IOU","IST","LAG","LOS","LSC","MCS","MSG","MUN","PRN","PTS","SYM","SYS","TCC","TCI","TCM","TCP","TCT","TGP","THS","TMI","TSB","WLT","WSU","YAZ"]
        .map(function(s) { return "<option value=\"" + s + "\">" + s + "</option>"; }).join("");

      content.innerHTML =
        "<div style=\"padding:14px\">" +
        "<div style=\"font-size:var(--tsa-fs-micro);letter-spacing:0.12em;color:" + muted + ";text-transform:uppercase;font-weight:bold;margin-bottom:14px\">Price Alerts</div>" +
        "<div style=\"margin-bottom:14px\">" + rows + "</div>" +
        "<div style=\"display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin-bottom:6px;align-items:center\">" +
        "<select id=\"tsa-alert-sym\" style=\"padding:6px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:var(--tsa-fs-micro)\">" + stockOpts + "</select>" +
        "<input id=\"tsa-alert-price\" type=\"number\" step=\"0.01\" min=\"0\" placeholder=\"Price\" style=\"padding:6px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:var(--tsa-fs-micro)\">" +
        "<select id=\"tsa-alert-dir\" style=\"padding:6px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:" + bg2 + ";color:" + text + ";font-size:var(--tsa-fs-micro)\"><option value=\"above\">≥ Over</option><option value=\"below\">≤ Under</option></select>" +
        "<button id=\"tsa-alert-add\" style=\"padding:6px 10px;border-radius:var(--tsa-r-2);border:none;background:var(--tsa-accent);color:var(--tsa-on-accent);font-size:var(--tsa-fs-body);font-weight:bold;cursor:pointer\">+</button>" +
        "</div>" +
        "<label style=\"display:flex;align-items:center;gap:6px;font-size:var(--tsa-fs-micro);color:" + muted + ";margin-bottom:10px;cursor:pointer\">" +
        "<input type=\"checkbox\" id=\"tsa-alert-repeat\" style=\"cursor:pointer\"> 🔁 Repeat — keep alert active after it fires" +
        "</label>" +
        "<button id=\"tsa-alerts-back\" style=\"width:100%;padding:8px;border-radius:var(--tsa-r-2);border:1px solid " + border + ";background:none;color:" + muted + ";font-size:var(--tsa-fs-body);cursor:pointer\">Back</button>" +
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

      document.getElementById("tsa-alerts-back").addEventListener("click", function() { renderCached(); });
    });

    document.getElementById("tsa-roi-btn").addEventListener("click", function() {
      roiPlannerActive = !roiPlannerActive;
      document.getElementById("tsa-roi-btn").style.opacity = roiPlannerActive ? "1" : "0.7";
      if (roiPlannerActive && lastOwnedMap) {
        showROIPlanner(lastOwnedMap, lastRaw);
      } else if (!roiPlannerActive) {
        renderCached();
      }
    });

    document.body.appendChild(overlay);

    // Free-drag the button: a plain tap still toggles the panel (click handler
    // below), but pressing and moving past a 6px threshold drags the button to
    // a custom position. Pointer events unify mouse + touch (PDA); touch-action
    // is none on #tsa-btn so a drag isn't stolen by page scrolling.
    var dragState = null;
    var tsaJustDragged = false;
    btn.addEventListener("pointerdown", function(e) {
      if (typeof e.button === "number" && e.button !== 0) return; // primary/touch only
      tsaJustDragged = false; // cleared every press so a swallowed click can't get stuck
      var rect = btn.getBoundingClientRect();
      dragState = { startX: e.clientX, startY: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top, moved: false, pid: e.pointerId };
    });
    btn.addEventListener("pointermove", function(e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.startX, dy = e.clientY - dragState.startY;
      if (!dragState.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        dragState.moved = true;
        try { btn.setPointerCapture(dragState.pid); } catch(_) {}
      }
      if (dragState.moved) {
        e.preventDefault();
        var nx = Math.max(0, Math.min(e.clientX - dragState.offX, window.innerWidth - btn.offsetWidth));
        var ny = Math.max(0, Math.min(e.clientY - dragState.offY, window.innerHeight - btn.offsetHeight));
        btn.style.left = nx + "px"; btn.style.top = ny + "px";
        btn.style.right = "auto"; btn.style.bottom = "auto"; btn.style.transform = "none";
      }
    });
    btn.addEventListener("pointerup", function(e) {
      if (!dragState) return;
      if (dragState.moved) {
        tsaJustDragged = true; // suppress the click that follows this drag
        var r = btn.getBoundingClientRect();
        lsSet("tsa_overlay_position", "custom");
        lsSet("tsa_btn_custom", JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
        positionOverlayNearButton();
        try { btn.releasePointerCapture(dragState.pid); } catch(_) {}
      }
      dragState = null;
    });
    btn.addEventListener("pointercancel", function() { dragState = null; }); // PDA system gesture interrupted the drag

    btn.addEventListener("click", function() {
      if (tsaJustDragged) { tsaJustDragged = false; return; } // just finished a drag, not a tap
      var isOpen = overlay.style.display === "block";
      if (isOpen) {
        overlay.style.display = "none";
        overlay.classList.remove("tsa-visible");
      } else {
        if (getOverlayPosition() === "custom") positionOverlayNearButton();
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
    qtObserveOwnedList();
    createUI();
    initialLoad();
    // Per-symbol history warm-up (free mode). Independent of loadData: it is its own
    // paced round-robin, and every tick re-checks visibility, the stand-down and the
    // data mode (licence mode makes no tornsy call) before it spends a call.
    histStart();
  }

  // Populate the panel + Quick pills on load so they appear without opening
  // TSA. Full load whenever the page isn't a hidden/background tab — we gate
  // on visibilityState only (NOT isActivelyViewed) because TornPDA's webview
  // reports document.hasFocus()===false even when the page is on-screen, which
  // would otherwise block the on-load fetch on PDA. A genuinely backgrounded
  // tab (visibilityState "hidden") falls through to the light owned-only
  // prefetch and defers the full load to the focus / visibility handler.
  function initialLoad() {
    var licensed = licenceModeOn();
    if (!licensed && !hasTornKey()) return;
    if (document.visibilityState !== "hidden") { _firstLoadKicked = true; loadData(); return; }
    var gen = licenseGen;
    if (!licensed) {
      fetchJSON("https://api.torn.com/user/?selections=stocks&key=" + getTornKey())
        .then(function(tornData) {
          if (gen !== licenseGen) return;
          if (!tornData || tornData.error) return;
          var map = buildOwnedMap(tornData);
          enrichOwnedMap(map, null);
          lastOwnedMap = map;
          qtUpdateExec(); // refresh swing shares label in QT bar
        })
        .catch(function() {});
      return;
    }
    TSAData.get(licenseDeps, "me", ME_MAX_AGE_MS, function(res) {
      if (gen !== licenseGen) return;
      if (res.kind !== "ok" || !res.body || res.body.holdings_status !== "ok") return;
      var map = buildOwnedMap(meWithTrades(res.body));
      enrichOwnedMap(map, null);
      lastOwnedMap = map;
      qtUpdateExec(); // refresh swing shares label in QT bar
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createUIOnce);
  } else if (document.readyState === "interactive") {
    window.addEventListener("load", createUIOnce);
  } else {
    createUIOnce();
  }

  // Resume auto-refresh when the page is on screen again. Same gate as the
  // scheduling side — a resume that waits for focus would never fire in PDA.
  function resumeAutoRefreshIfActive() {
    if (!isOnScreen()) return;
    if (!_firstLoadKicked) { _firstLoadKicked = true; loadData(); return; } // first full load (e.g. tab opened in background)
    if (getAutoRefreshInterval() <= 0) return;
    if (autoRefreshTimer) return; // already scheduled
    loadData();
  }
  document.addEventListener("visibilitychange", resumeAutoRefreshIfActive);
  window.addEventListener("focus", resumeAutoRefreshIfActive);
})();
