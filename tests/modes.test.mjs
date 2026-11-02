// Free mode vs licence mode, run on the WHOLE userscript. Run: node --test tests/modes.test.mjs
//
// torn_stock_analyzer.js is evaluated unchanged in a vm with a small fake browser:
// a permissive DOM stub, an in-memory localStorage, fake timers, and a
// GM_xmlhttpRequest stub that records every request and answers it from a table.
// No network, no real key: the Torn key below is a dummy string.
//
// What is checked (owner decision 2026-11-02):
//   - free mode (own Torn key, no licence) calls api.torn.com + tornsy.com, never Dossier
//   - licence mode (active tsa1_ licence) calls only Dossier, never Torn or tornsy
//   - a Dossier failure with a Torn key falls back to the direct calls for that load
//   - an invalid / expired / unconfirmable licence never locks TSA
//   - start-up deletes and overwrites no stored key (2.50-style and 2.53.1-style stores)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");

const TORN_KEY = "dummyTornKey0000";   // not a real key
const TOKEN = "tsa1_" + "A".repeat(20) + "b-_9" + "z".repeat(19);
const NOW = Date.now();

// ---------------------------------------------------------------- fake browser

function makeEl(tag, reg) {
  const t = {
    tagName: String(tag || "div").toUpperCase(), children: [], listeners: {}, attrs: {},
    _html: "", _text: "", id: "", className: "", value: "", checked: false, disabled: false,
    style: {}, dataset: {}, parentNode: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }, toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; if (on) this._s.add(c); else this._s.delete(c); return on; },
    },
  };
  const api = {
    appendChild(c) { t.children.push(c); try { c.parentNode = p; } catch (e) {} if (c && c.id) reg[c.id] = c; return c; },
    insertBefore(c) { return api.appendChild(c); },
    removeChild(c) { t.children = t.children.filter((x) => x !== c); return c; },
    remove() {}, addEventListener(ev, fn) { (t.listeners[ev] = t.listeners[ev] || []).push(fn); },
    removeEventListener() {}, setAttribute(k, v) { t.attrs[k] = String(v); if (k === "id") reg[v] = p; },
    getAttribute(k) { return k in t.attrs ? t.attrs[k] : null; }, removeAttribute(k) { delete t.attrs[k]; },
    querySelector() { return null; }, querySelectorAll() { return []; }, getElementsByTagName() { return []; },
    getElementsByClassName() { return []; }, closest() { return null; }, contains() { return false; },
    insertAdjacentText(pos, s) { t._text += s; }, insertAdjacentHTML(pos, s) { t._html += s; },
    focus() {}, blur() {}, click() {}, scrollTo() {}, scrollIntoView() {},
    insertAdjacentElement(pos, c) { return api.appendChild(c); }, append(c) { if (c && typeof c === "object") api.appendChild(c); },
    prepend(c) { if (c && typeof c === "object") api.appendChild(c); }, after() {}, before() {}, replaceWith() {},
    replaceChild(c) { return api.appendChild(c); }, cloneNode() { return makeEl(t.tagName, reg); },
    hasAttribute(k) { return k in t.attrs; }, matches() { return false; }, dispatchEvent() { return true; },
    setPointerCapture() {}, releasePointerCapture() {}, animate() { return { finished: Promise.resolve() }; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    getContext() { return new Proxy({}, { get: () => () => ({}) }); },
  };
  const p = new Proxy(t, {
    get(o, k) {
      if (k === "innerHTML") return o._html;
      if (k === "textContent" || k === "innerText") return o._text;
      if (k in api) return api[k];
      if (k in o) return o[k];
      if (typeof k === "symbol") return undefined;
      if (/^(offset|client|scroll)(Width|Height|Top|Left)$/.test(k)) return 0;
      if (/^on[a-z]+$/.test(k)) return null;
      return undefined;
    },
    set(o, k, v) {
      if (k === "innerHTML") { o._html = String(v); o.children = []; return true; }
      if (k === "textContent" || k === "innerText") { o._text = String(v); o._html = ""; o.children = []; return true; }
      if (k === "id") { o.id = v; reg[v] = p; return true; }
      o[k] = v; return true;
    },
  });
  return p;
}

function allText(el, seen = new Set()) {
  if (!el || seen.has(el)) return "";
  seen.add(el);
  return el.innerHTML + " " + el.textContent + " " + el.children.map((c) => allText(c, seen)).join(" ");
}

// routes: url -> {status, body, headers} | "error" | "hang". First matching prefix wins.
function boot({ store = {}, routes = [], visible = true } = {}) {
  const m = { ...store };
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    key: (i) => Object.keys(m)[i] || null,
    get length() { return Object.keys(m).length; },
  };
  // Object.keys(localStorage) must list the stored keys, as in a browser.
  const lsProxy = new Proxy(localStorage, {
    ownKeys: () => Object.keys(m),
    getOwnPropertyDescriptor: (o, k) => (Object.prototype.hasOwnProperty.call(m, k) ? { enumerable: true, configurable: true, value: m[k] } : undefined),
  });
  const reg = {};
  const timers = [];
  let seq = 0;
  const calls = [];
  const body = makeEl("body", reg), head = makeEl("head", reg);
  const document = {
    readyState: "complete", visibilityState: visible ? "visible" : "hidden", cookie: "",
    body, head, documentElement: makeEl("html", reg),
    createElement: (tag) => makeEl(tag, reg),
    createTextNode: (s) => makeEl("#text", reg),
    getElementById: (id) => reg[id] || (reg[id] = Object.assign(makeEl("div", reg), {})) && (reg[id].id = id, reg[id]),
    querySelector: () => null, querySelectorAll: () => [], getElementsByClassName: () => [],
    addEventListener() {}, removeEventListener() {}, hasFocus: () => true,
  };
  function answer(o) {
    const r = routes.find(([prefix]) => o.url.startsWith(prefix));
    const a = r ? r[1] : "hang";
    const out = typeof a === "function" ? a(o) : a;
    if (out === "hang") return;
    Promise.resolve().then(() => {
      if (out === "error") { if (o.onerror) o.onerror({ error: "network" }); return; }
      o.onload({ status: out.status, responseText: typeof out.body === "string" ? out.body : JSON.stringify(out.body),
                 responseHeaders: out.headers || "content-type: application/json\r\n" });
    });
  }
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    localStorage: lsProxy, document, navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    innerWidth: 1280, innerHeight: 800, location: { href: "https://www.torn.com/page.php?sid=stocks", search: "?sid=stocks", hash: "" },
    GM_xmlhttpRequest: (o) => { calls.push(o); answer(o); },
    setTimeout: (fn, ms) => { const t = { fn, ms: ms || 0, id: ++seq, live: true, every: false }; timers.push(t); return t.id; },
    setInterval: (fn, ms) => { const t = { fn, ms: ms || 0, id: ++seq, live: true, every: true }; timers.push(t); return t.id; },
    clearTimeout: (id) => { timers.forEach((t) => { if (t.id === id) t.live = false; }); },
    clearInterval: (id) => { timers.forEach((t) => { if (t.id === id) t.live = false; }); },
    requestAnimationFrame: (fn) => 0, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
  };
  // jQuery: every call chains (TSA uses $(document).on(...) and $.ajax for trades).
  const chain = new Proxy(function () {}, { get: (o, k) => (k === "length" ? 0 : (typeof k === "symbol" ? undefined : (/^(attr|text|val|html|css|prop|data)$/.test(k) ? () => "" : () => chain))), apply: () => chain });
  const jq = () => chain;
  jq.ajax = () => {};
  sandbox.$ = jq; sandbox.jQuery = jq;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  let error = null;
  try { vm.runInContext(SRC, ctx, { filename: "torn_stock_analyzer.js" }); } catch (e) { error = e; }
  return {
    ctx, calls, store: m, timers, reg, error,
    content: () => allText(reg["tsa-content"]),
    page: () => allText(body) + " " + Object.values(reg).map((e) => allText(e)).join(" "),
    hosts: () => calls.map((c) => new URL(c.url).host),
    // run every live timer of at most maxMs once (intervals stay live)
    runTimers(maxMs) { timers.filter((t) => t.live && t.ms <= maxMs).forEach((t) => { if (!t.every) t.live = false; try { t.fn(); } catch (e) {} }); },
  };
}

async function settle(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

function count(hosts, h) { return hosts.filter((x) => x === h).length; }

// ---------------------------------------------------------------- canned answers

const J = (body, status = 200) => ({ status, body });
const TORN_USER = { player_id: 7, money_onhand: 1000, stocks: {} };
const TORNSY_BATCH = { data: [{ stock: "FHG", price: "500.00", interval: { m30: { price: "499.00" } } }] };
const TORNSY_SYMBOL = { data: [[NOW / 1000 - 86400, "1", "2", "0.5", "1.5", 1], [NOW / 1000, "1", "2", "0.5", "1.6", 1]] };
const DIRECT = [
  ["https://api.torn.com/user/", J(TORN_USER)],
  ["https://api.torn.com/faction/", J({ donations: {} })],
  ["https://api.torn.com/torn/", J({ stocks: { 1: { acronym: "FHG", benefit: { requirement: 1000, frequency: 7, description: "x" } } }, items: {} })],
  ["https://api.torn.com/market/", J({ itemmarket: { listings: [] } })],
  ["https://tornsy.com/api/stocks", J(TORNSY_BATCH)],
  ["https://tornsy.com/api/", J(TORNSY_SYMBOL)],
];
const D = "https://dossier-api.aec3.org";
const DOSSIER_OK = [
  [D + "/api/license/check", J({ active: true, expires_ts: NOW / 1000 + 30 * 86400, name: "test" })],
  [D + "/api/tsa/me", J({ player_id: 7, holdings_status: "ok", stocks: {}, money_onhand: 5, armory: { ok: false, money_balance: 0 }, meta: { source_ts: NOW / 1000 - 60 } })],
  [D + "/api/tsa/market", J({ data: [{ stock: "FHG", price: "500.00", interval: { m30: { price: "499" } }, ohlc: {} }], missing_batches: 0, meta: {} })],
  [D + "/api/tsa/history", J({ symbols: {}, meta: {} })],
  [D + "/api/tsa/reference", J({ stocks: null, items: null, meta: {} })],
];
const activeLicence = (extra = {}) => JSON.stringify({ token: TOKEN, status: "active", checked_ms: NOW - 60000, ok_ms: NOW - 60000,
  expires_ts: Math.floor(NOW / 1000) + 30 * 86400, name: "test", renew: null, retry_ms: null, fail: null, ...extra });
const LOCK_WORDS = /TSA licence required|Torn API key needed in Dossier|Checking TSA licence/;

// ---------------------------------------------------------------- free mode

test("free mode with a Torn key: calls api.torn.com and tornsy.com, never Dossier", async () => {
  const b = boot({ store: { "tsa-torn-apikey": TORN_KEY }, routes: DIRECT });
  assert.equal(b.error, null, String(b.error && b.error.stack));
  await settle();
  const h = b.hosts();
  assert.ok(count(h, "api.torn.com") >= 2, "no Torn call: " + h);
  assert.ok(count(h, "tornsy.com") >= 4, "no tornsy batch: " + h);
  assert.equal(count(h, "dossier-api.aec3.org"), 0);
  assert.ok(b.calls.filter((c) => c.url.includes("api.torn.com")).every((c) => c.url.includes("key=" + TORN_KEY)));
  // the 2.50 history warm-up runs on its own timer, against tornsy
  const before = b.calls.length;
  b.runTimers(3000);
  await settle();
  assert.ok(b.calls.slice(before).some((c) => /^https:\/\/tornsy\.com\/api\/[A-Z]+\?interval=(d1|h1)/.test(c.url)), "warm-up made no tornsy call");
  assert.equal(count(b.hosts(), "dossier-api.aec3.org"), 0);
  assert.doesNotMatch(b.content(), /tsa-error|API Key Required/);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

test("no Torn key and no licence: the 2.50 'enter your API key' prompt, and no request at all", async () => {
  const b = boot({ routes: DIRECT });
  assert.equal(b.error, null, String(b.error && b.error.stack));
  await settle();
  // nothing loads before the panel is opened (as in 2.50); opening it shows the prompt

  assert.equal(b.calls.filter((c) => !/^https:\/\/tornsy\.com\/api\/[A-Z]/.test(c.url)).length, 0);
  b.reg["tsa-btn"] && (b.reg["tsa-btn"].listeners.click || []).forEach((fn) => fn({}));
  await settle();
  assert.match(b.content(), /API Key Required/);
  assert.match(b.content(), /id="tsa-key-input"/);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

// ---------------------------------------------------------------- licence mode

test("licence mode (active licence, Torn key also stored): only Dossier is called, never Torn or tornsy", async () => {
  const b = boot({ store: { "tsa-torn-apikey": TORN_KEY, tsa_license: activeLicence() }, routes: DOSSIER_OK.concat(DIRECT) });
  assert.equal(b.error, null, String(b.error && b.error.stack));
  await settle();
  b.runTimers(3000);   // warm-up ticks: must not reach tornsy in licence mode
  b.runTimers(3000);
  await settle();
  const h = b.hosts();
  assert.ok(count(h, "dossier-api.aec3.org") >= 2, "no Dossier call: " + h);
  assert.equal(count(h, "api.torn.com"), 0, h.join(","));
  assert.equal(count(h, "tornsy.com"), 0, h.join(","));
  // only the licence key travels, as a Bearer header; no Torn key anywhere
  b.calls.forEach((c) => {
    assert.equal(c.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(c.url.includes(TORN_KEY), false);
  });
  assert.doesNotMatch(b.content(), /tsa-error/);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

for (const [name, answer] of [
  ["503", J({ error: "down" }, 503)],
  ["a network error", "error"],
  ["403 torn key required", J({ error: "torn key required" }, 403)],
  ["403 licence inactive", J({ error: "licence inactive" }, 403)],
  ["401", J({ error: "unauthorized" }, 401)],
]) {
  test("Dossier answering " + name + " with a Torn key in TSA: this load falls back to the direct calls", async () => {
    const routes = [
      [D + "/api/license/check", J({ active: true, expires_ts: NOW / 1000 + 86400 })],
      [D + "/api/tsa/", answer],
    ].concat(DIRECT);
    const b = boot({ store: { "tsa-torn-apikey": TORN_KEY, tsa_license: activeLicence() }, routes });
    assert.equal(b.error, null, String(b.error && b.error.stack));
    await settle(60);
    const h = b.hosts();
    assert.ok(count(h, "dossier-api.aec3.org") >= 1, h.join(","));
    assert.ok(count(h, "api.torn.com") >= 2, "no fallback to Torn: " + h);
    assert.ok(count(h, "tornsy.com") >= 4, "no fallback to tornsy: " + h);
    assert.match(b.content(), /this load used your own Torn API key/);
    assert.doesNotMatch(b.page(), LOCK_WORDS);
    assert.equal(b.store["tsa-torn-apikey"], TORN_KEY);
  });
}

// ---------------------------------------------------------------- a licence never locks

test("an expired licence (cached inactive) never locks: free mode, no Dossier data call", async () => {
  const b = boot({ store: { "tsa-torn-apikey": TORN_KEY,
    tsa_license: activeLicence({ status: "inactive", ok_ms: null, checked_ms: NOW - 60000 }) }, routes: DIRECT });
  assert.equal(b.error, null, String(b.error && b.error.stack));
  await settle();
  const h = b.hosts();
  assert.ok(count(h, "api.torn.com") >= 2 && count(h, "tornsy.com") >= 4, h.join(","));
  assert.equal(b.calls.filter((c) => c.url.includes("/api/tsa/")).length, 0);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
  assert.ok(b.reg["qt-bar"], "Quick Trade bar missing");
});

test("a malformed licence key never locks and is never sent", async () => {
  const b = boot({ store: { "tsa-torn-apikey": TORN_KEY, tsa_license: JSON.stringify({ token: "tsa1_short" }) }, routes: DIRECT });
  await settle();
  assert.equal(count(b.hosts(), "dossier-api.aec3.org"), 0);
  assert.ok(count(b.hosts(), "api.torn.com") >= 2);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

test("a licence check answering active:false or 401 at start: free mode for that load, never a lock", async () => {
  for (const ans of [J({ active: false, renew: "renew on Dossier" }), J({}, 401), "error"]) {
    const b = boot({ store: { "tsa-torn-apikey": TORN_KEY, tsa_license: JSON.stringify({ token: TOKEN }) },
      routes: [[D + "/api/license/check", ans]].concat(DIRECT) });
    await settle(60);
    const h = b.hosts();
    assert.equal(b.calls.filter((c) => c.url.includes("/api/tsa/")).length, 0, h.join(","));
    assert.ok(count(h, "api.torn.com") >= 2, h.join(","));
    assert.doesNotMatch(b.page(), LOCK_WORDS);
  }
});

test("an expired licence and no Torn key: the free-mode key prompt, not a lock screen", async () => {
  const b = boot({ store: { tsa_license: activeLicence({ status: "inactive", ok_ms: null }) }, routes: DIRECT });
  await settle();

  (b.reg["tsa-btn"].listeners.click || []).forEach((fn) => fn({}));
  await settle();
  assert.match(b.content(), /API Key Required/);
  assert.match(b.content(), /Your TSA licence is not active/);
  assert.doesNotMatch(b.page(), LOCK_WORDS);
});

test("realized profit: a Dossier poll older than the snapshot's own source is neither diffed nor saved", async () => {
  const snap = JSON.stringify({ FHG: { shares: 10, avg_price: 400 } });
  // the snapshot was taken by a free-mode load AFTER Dossier's poll (poll = NOW - 60 s)
  const b = boot({ store: { tsa_license: activeLicence(), tsa_prev_holdings: snap, tsa_prev_holdings_src_ms: String(NOW),
    tsa_show_realized: "true", tsa_realized_events: "[]" }, routes: DOSSIER_OK });
  await settle();
  assert.equal(b.store.tsa_prev_holdings, snap);
  assert.equal(b.store.tsa_realized_events, "[]");
  // control: with no newer snapshot, the same poll is today's book and is saved
  const c = boot({ store: { tsa_license: activeLicence(), tsa_prev_holdings: snap, tsa_show_realized: "true" }, routes: DOSSIER_OK });
  await settle();
  assert.equal(c.store.tsa_prev_holdings, "{}");
  assert.ok(Number(c.store.tsa_prev_holdings_src_ms) > 0);
});

test("source: the lock screens are gone", () => {
  assert.doesNotMatch(SRC, /TSA licence required|Torn API key needed in Dossier|function showLicenseLock|licenseLocked/);
});

// ---------------------------------------------------------------- start-up never deletes or overwrites a key

const STORE_250 = {
  "tsa-torn-apikey": TORN_KEY,
  tsa_stock_catalogue_fail_ts: String(NOW - 5000),
  tsa_tornsy_blocked_until: "0",
  tsa_tornsy_throttle_step: "0",
  tsa_stock_catalogue: JSON.stringify({ 1: { acronym: "FHG" } }),
  tsa_stock_catalogue_ts: String(NOW - 1000),
  tsa_qt_buy_source: "top5",
  tsa_prev_holdings: JSON.stringify({ FHG: { shares: 10, avg_price: 400 } }),
  tsa_realized_events: JSON.stringify([{ ts: 1, profit: 5, sym: "FHG", sell_price: 500 }]),
  tsa_lt_context: "{}", tsa_lt_context_ts: "{}", tsa_h1_closes: "{}", tsa_h1_closes_ts: "{}",
  tsa_item_names: "{}", tsa_alerts: "[]", tsa_dark: "true", qt_last_stock: "",
};
const STORE_2531 = {
  ...STORE_250,
  tsa_license: activeLicence(),
  tsa_qt_buy_source_migrated_253: "1",
  tsa_show_top5: "false",
  tsa_reference_ts: String(NOW - 1000),
  tsa_hist_fetch_ts: String(NOW - 1000),
  // older than its 6 h: no longer shown, but start-up must not delete it either
  tsa_dossier_me: JSON.stringify({ ms: NOW - 7 * 3600 * 1000, body: { holdings_status: "ok", stocks: {}, meta: {} } }),
  tsa_dossier_market: JSON.stringify({ ms: NOW - 3600 * 1000, body: { data: [{ stock: "FHG", price: "1" }] } }),
  tsa_trade_log: JSON.stringify([{ sym: "FHG", delta: 1, price: 1, ts: Math.floor(NOW / 1000) - 60 }]),
};

for (const [name, store] of [["2.50-style", STORE_250], ["2.53.1-style", STORE_2531], ["2.53.1-style without a Torn key", (() => { const s = { ...STORE_2531 }; delete s["tsa-torn-apikey"]; return s; })()]]) {
  for (const visible of [true, false]) {
    test("start-up on a " + name + " store (" + (visible ? "visible" : "hidden") + " tab) removes and overwrites no key", async () => {
      // Every request hangs: this is start-up alone, before any answer arrives.
      const b = boot({ store, routes: [], visible });
      assert.equal(b.error, null, String(b.error && b.error.stack));
      await settle();
      b.runTimers(3000);
      await settle();
      for (const k of Object.keys(store)) {
        assert.ok(Object.prototype.hasOwnProperty.call(b.store, k), k + " was removed");
        assert.equal(b.store[k], store[k], k + " was overwritten");
      }
    });
  }
}
