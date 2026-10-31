// Tests for the TSA licence module. Run: node --test tests/license.test.mjs
//
// The module lives inside the userscript between the TSA-LICENSE markers; the
// network adapter it uses in the script (gmXhr) between the TSA-NET markers. Both
// are loaded here unchanged from torn_stock_analyzer.js into a fresh vm context per
// test, with GM_xmlhttpRequest / PDA_httpGet / fetch stubs as the only transports.
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

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const TOKEN = "tsa1_" + "A".repeat(20) + "b-_9" + "z".repeat(19);   // 5 + 43 = 48

// globals: extra names visible to the loaded code (GM_xmlhttpRequest, PDA_httpGet, fetch)
function load(globals = {}) {
  const ctx = vm.createContext({ console, ...globals });
  vm.runInContext(block("TSA-NET") + "\n" + block("TSA-LICENSE"), ctx);
  return ctx;
}

// A GM_xmlhttpRequest stub that records each request and lets the test answer it.
function gmStub() {
  const calls = [];
  const fn = (opts) => { calls.push(opts); };
  return { fn, calls };
}

function memStore(init = {}) {
  const m = { ...init };
  return { get: (k) => (k in m ? m[k] : null), set: (k, v) => { m[k] = v; }, m };
}

function fakeTimers() {
  const pending = [];
  return {
    set: (fn, ms) => { const t = { fn, ms, live: true }; pending.push(t); return t; },
    clear: (t) => { t.live = false; },
    fire: () => { pending.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }); },
    pending,
  };
}

function deps(ctx, { now = () => T0, store = memStore(), timers = fakeTimers() } = {}) {
  return { xhr: (o) => ctx.gmXhr(o), store, now, setTimer: timers.set, clearTimer: timers.clear, timers };
}

const active = (expires_ts = null) => ({ kind: "response", status: 200, body: { active: true, expires_ts, name: "Tester" } });
const inactive = (expires_ts = 1790000000) => ({ kind: "response", status: 200, body: { active: false, expires_ts, renew: "send a Xanax to Owner (14 days each)" } });
const status = (code, body = null) => ({ kind: "response", status: code, body });
const neterr = { kind: "error", error: "network" };

// A state that had a successful active check at time t.
function activeAt(L, t, expires_ts = null) {
  return L.decide({ token: TOKEN }, t, active(expires_ts)).state;
}

// ---------------------------------------------------------------- format

test("only tsa1_ + 43 url-safe characters is accepted", () => {
  const L = load().TSALicense;
  assert.equal(TOKEN.length, 48);
  assert.equal(L.validToken(TOKEN), true);
  assert.equal(L.validToken(TOKEN.slice(0, 47)), false);            // 42 chars
  assert.equal(L.validToken(TOKEN + "x"), false);                   // 44 chars
  assert.equal(L.validToken("dsk1_" + TOKEN.slice(5)), false);      // other prefix
  assert.equal(L.validToken("tsa1_" + "+".repeat(43)), false);      // not url-safe
  assert.equal(L.validToken(" " + TOKEN), false);
  assert.equal(L.validToken(null), false);
});

test("no key and a malformed key lock locally, without a request", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const L = ctx.TSALicense;
  let d = L.decide({}, T0, null);
  assert.equal(d.locked, true); assert.equal(d.reason, "no_key"); assert.equal(d.nextCheck, null);
  d = L.decide({ token: "tsa1_short" }, T0, null);
  assert.equal(d.locked, true); assert.equal(d.reason, "bad_format"); assert.equal(d.needsCheck, false);

  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: "tsa1_short" }) }) });
  let got = null;
  L.ensure(dp, true, (x) => { got = x; });     // even forced
  assert.equal(got.reason, "bad_format");
  assert.equal(gm.calls.length, 0);
});

test("never verified = locked, and a check is due", () => {
  const L = load().TSALicense;
  const d = L.decide({ token: TOKEN }, T0, null);
  assert.equal(d.locked, true);
  assert.equal(d.reason, "unverified");
  assert.equal(d.needsCheck, true);
});

// ---------------------------------------------------------------- 200 active + 12 h cache

test("200 active unlocks and is trusted for 12 h; at exactly 12 h it re-checks", () => {
  const L = load().TSALicense;
  const d = L.decide({ token: TOKEN }, T0, active(null));
  assert.equal(d.locked, false);
  assert.equal(d.reason, "active");
  assert.equal(d.nextCheck, T0 + 12 * H);
  assert.equal(d.state.name, "Tester");

  const s = d.state;
  const before = L.decide(s, T0 + 12 * H - 1, null);
  assert.equal(before.locked, false); assert.equal(before.reason, "active"); assert.equal(before.needsCheck, false);
  const at = L.decide(s, T0 + 12 * H, null);
  assert.equal(at.needsCheck, true);
  assert.equal(at.locked, false);       // still inside the 72 h grace while the check runs
});

test("an expires_ts sooner than 12 h ends the cache at expires_ts", () => {
  const L = load().TSALicense;
  const exp = (T0 + 3 * H) / 1000;
  const s = activeAt(L, T0, exp);
  assert.equal(L.decide(s, T0, null).nextCheck, T0 + 3 * H);
  assert.equal(L.decide(s, T0 + 3 * H - 1, null).needsCheck, false);
  const at = L.decide(s, T0 + 3 * H, null);
  assert.equal(at.needsCheck, true);
});

test("active:true with an expires_ts already in the past does not re-check on every call", () => {
  const L = load().TSALicense;
  const s = activeAt(L, T0, (T0 - H) / 1000);
  const d = L.decide(s, T0 + H, null);
  assert.equal(d.locked, false);
  assert.equal(d.needsCheck, false);
  assert.equal(d.nextCheck, T0 + 12 * H);
});

// ---------------------------------------------------------------- failures + 72 h grace

test("network error / timeout / 5xx / unreadable 200 after a good check: open until exactly 72 h", () => {
  const L = load().TSALicense;
  const outcomes = [neterr, { kind: "error", error: "timeout" }, status(500), status(502, { error: "bad gateway" }), status(200, null), status(200, { foo: 1 }), status(418)];
  for (const o of outcomes) {
    const s = activeAt(L, T0);
    const just = L.decide(s, T0 + 72 * H - 1, o);
    assert.equal(just.locked, false, JSON.stringify(o));
    assert.equal(just.reason, "grace");
    assert.equal(just.state.fail, "unreachable");
    assert.equal(just.nextCheck, T0 + 72 * H - 1 + L.RETRY_MS);
    const at = L.decide(s, T0 + 72 * H, o);
    assert.equal(at.locked, true, JSON.stringify(o));
    assert.equal(at.reason, "grace_over");
  }
});

test("grace counts from the last SUCCESSFUL check, not the last attempt", () => {
  const L = load().TSALicense;
  let s = activeAt(L, T0);
  s = L.decide(s, T0 + 13 * H, neterr).state;         // a failed attempt in between
  s = L.decide(s, T0 + 50 * H, neterr).state;
  assert.equal(s.ok_ms, T0);
  assert.equal(L.decide(s, T0 + 72 * H, neterr).locked, true);
});

test("network error when never verified stays locked and waits RETRY_MS", () => {
  const L = load().TSALicense;
  const d = L.decide({ token: TOKEN }, T0, neterr);
  assert.equal(d.locked, true);
  assert.equal(d.reason, "unverified");
  assert.equal(d.state.fail, "unreachable");
  assert.equal(L.decide(d.state, T0 + L.RETRY_MS - 1, null).needsCheck, false);
  assert.equal(L.decide(d.state, T0 + L.RETRY_MS, null).needsCheck, true);
});

// ---------------------------------------------------------------- 401

test("401 locks at once and drops the cached status; the key is kept, marked rejected", () => {
  const L = load().TSALicense;
  const s = activeAt(L, T0, (T0 + 100 * H) / 1000);
  const d = L.decide(s, T0 + H, status(401, { error: "invalid licence" }));
  assert.equal(d.locked, true);
  assert.equal(d.reason, "rejected");
  assert.equal(d.state.token, TOKEN);
  assert.equal(d.state.status, "rejected");
  assert.equal(d.state.ok_ms, null);          // no grace can reopen it
  assert.equal(d.state.expires_ts, null);
  assert.equal(d.state.name, null);
  // a network error afterwards cannot reopen it either
  assert.equal(L.decide(d.state, T0 + H + 1, neterr).locked, true);
  // re-asked only after INACTIVE_MS (a stray 401 heals; a real one costs one call per 10 min)
  assert.equal(L.decide(d.state, T0 + H + L.INACTIVE_MS - 1, null).needsCheck, false);
  assert.equal(L.decide(d.state, T0 + H + L.INACTIVE_MS, null).needsCheck, true);
  assert.equal(L.decide(d.state, T0 + H + L.INACTIVE_MS, null).locked, true);
  // and a later 200 active opens it again
  assert.equal(L.decide(d.state, T0 + 2 * H, active(null)).locked, false);
});

// ---------------------------------------------------------------- active:false

test("active:false locks with the renew text, and ends the grace", () => {
  const L = load().TSALicense;
  const s = activeAt(L, T0);
  const d = L.decide(s, T0 + H, inactive());
  assert.equal(d.locked, true);
  assert.equal(d.reason, "inactive");
  assert.equal(d.state.renew, "send a Xanax to Owner (14 days each)");
  assert.equal(d.state.expires_ts, 1790000000);
  assert.equal(d.state.ok_ms, null);
  // a later network error cannot reopen it through the grace
  const e = L.decide(d.state, T0 + 2 * H, neterr);
  assert.equal(e.locked, true); assert.equal(e.reason, "inactive");
  // re-asked after INACTIVE_MS so a renewal shows up
  assert.equal(L.decide(d.state, T0 + H + L.INACTIVE_MS - 1, null).needsCheck, false);
  assert.equal(L.decide(d.state, T0 + H + L.INACTIVE_MS, null).needsCheck, true);
});

test("renewal: inactive, then active again, unlocks", () => {
  const L = load().TSALicense;
  const s = L.decide({ token: TOKEN }, T0, inactive()).state;
  const d = L.decide(s, T0 + L.INACTIVE_MS, active(null));
  assert.equal(d.locked, false); assert.equal(d.state.renew, null);
});

// ---------------------------------------------------------------- 429

test("429 keeps the current state and tries again later", () => {
  const L = load().TSALicense;
  // open (stale cache, inside grace) stays open
  const s = activeAt(L, T0);
  const d = L.decide(s, T0 + 12 * H, status(429, { error: "too many requests" }));
  assert.equal(d.locked, false);
  assert.equal(d.state.checked_ms, T0);          // not counted as a check
  assert.equal(d.state.ok_ms, T0);
  assert.equal(d.state.fail, "rate_limited");
  assert.equal(d.nextCheck, T0 + 12 * H + L.RETRY_MS);
  assert.equal(L.decide(d.state, T0 + 12 * H + L.RETRY_MS - 1, null).needsCheck, false);
  // never verified stays locked
  const n = L.decide({ token: TOKEN }, T0, status(429));
  assert.equal(n.locked, true); assert.equal(n.reason, "unverified"); assert.equal(n.state.fail, "rate_limited");
  // inactive stays inactive
  const i = L.decide(L.decide({ token: TOKEN }, T0, inactive()).state, T0 + L.INACTIVE_MS, status(429));
  assert.equal(i.locked, true); assert.equal(i.reason, "inactive");
});

// ---------------------------------------------------------------- I/O through gmXhr

test("ensure sends ONE GET with only the Bearer header, no cookies, no Torn key", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const L = ctx.TSALicense;
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
  let got = null;
  const ret = L.ensure(dp, false, (d) => { got = d; });
  assert.equal(ret, null);                       // pending
  assert.equal(gm.calls.length, 1);
  const o = gm.calls[0];
  assert.equal(o.method, "GET");
  assert.equal(o.url, "https://dossier-api.aec3.org/api/license/check");
  assert.deepEqual(Object.keys(o.headers), ["Authorization"]);
  assert.equal(o.headers.Authorization, "Bearer " + TOKEN);
  assert.equal(o.anonymous, true);
  assert.equal(o.data, undefined);
  assert.ok(!/key=/.test(o.url) && !o.url.includes(TOKEN));
  o.onload({ status: 200, responseText: JSON.stringify({ active: true, expires_ts: null, name: "Tester" }) });
  assert.equal(got.locked, false);
  assert.equal(JSON.parse(dp.store.m.tsa_license).status, "active");   // persisted
  // a second call inside 12 h is answered from the cache, synchronously
  let got2 = null;
  const ret2 = L.ensure(dp, false, (d) => { got2 = d; });
  assert.equal(ret2, got2);
  assert.equal(got2.reason, "active");
  assert.equal(gm.calls.length, 1);
  // timer cleared
  assert.ok(dp.timers.pending.every((t) => !t.live));
});

test("cache survives a reload (fresh module, same store) and re-checks at 12 h", () => {
  const store = memStore();
  let ctx = load({ GM_xmlhttpRequest: gmStub().fn });
  store.set("tsa_license", JSON.stringify(activeAt(ctx.TSALicense, T0)));
  const gm = gmStub();
  ctx = load({ GM_xmlhttpRequest: gm.fn });
  let now = T0 + 12 * H - 1;
  const dp = deps(ctx, { store, now: () => now });
  ctx.TSALicense.ensure(dp, false, () => {});
  assert.equal(gm.calls.length, 0);
  now = T0 + 12 * H;
  ctx.TSALicense.ensure(dp, false, () => {});
  assert.equal(gm.calls.length, 1);
});

test("timeout: no answer within TIMEOUT_MS counts as a network error", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const store = memStore({ tsa_license: JSON.stringify(activeAt(ctx.TSALicense, T0 - 13 * H)) });
  const dp = deps(ctx, { store });
  let got = null;
  ctx.TSALicense.ensure(dp, false, (d) => { got = d; });
  assert.equal(dp.timers.pending[0].ms, ctx.TSALicense.TIMEOUT_MS);
  dp.timers.fire();
  assert.equal(got.reason, "grace");
  assert.equal(got.state.fail, "unreachable");
  // a late answer after the timeout is ignored
  gm.calls[0].onload({ status: 401, responseText: "{}" });
  assert.equal(JSON.parse(store.m.tsa_license).status, "active");
});

test("GM onerror and ontimeout map to the failure path", () => {
  for (const cbName of ["onerror", "ontimeout"]) {
    const gm = gmStub();
    const ctx = load({ GM_xmlhttpRequest: gm.fn });
    const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
    let got = null;
    ctx.TSALicense.ensure(dp, false, (d) => { got = d; });
    gm.calls[0][cbName]({});
    assert.equal(got.locked, true); assert.equal(got.reason, "unverified");
  }
});

test("a throwing transport does not throw out of ensure", () => {
  const ctx = load({ GM_xmlhttpRequest: () => { throw new Error("boom"); } });
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
  let got = null;
  ctx.TSALicense.ensure(dp, false, (d) => { got = d; });
  assert.equal(got.reason, "unverified");
});

test("concurrent ensure calls share one request", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
  const seen = [];
  ctx.TSALicense.ensure(dp, false, (d) => seen.push(d.reason));
  ctx.TSALicense.ensure(dp, true, (d) => seen.push(d.reason));
  ctx.TSALicense.ensure(dp, false, (d) => seen.push(d.reason));
  assert.equal(gm.calls.length, 1);
  gm.calls[0].onload({ status: 200, responseText: JSON.stringify({ active: true, expires_ts: null, name: "x" }) });
  assert.deepEqual(seen, ["active", "active", "active"]);
});

test("force re-checks a fresh cache; setToken resets state; clear locks", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const L = ctx.TSALicense;
  const store = memStore({ tsa_license: JSON.stringify(activeAt(L, T0)) });
  const dp = deps(ctx, { store });
  L.ensure(dp, true, () => {});
  assert.equal(gm.calls.length, 1);
  gm.calls[0].onload({ status: 200, responseText: JSON.stringify({ active: true, expires_ts: null }) });

  const other = "tsa1_" + "Q".repeat(43);
  const d0 = L.setToken(dp, "  " + other + "  ");
  assert.equal(d0.state.token, other);
  assert.equal(d0.state.status, null);
  assert.equal(d0.locked, true);
  assert.equal(d0.needsCheck, true);

  L.clear(dp);
  assert.equal(L.peek(dp).reason, "no_key");
  assert.equal(JSON.parse(store.m.tsa_license).token, null);
});

test("a key replaced while its check was out: the old answer is not applied to the new key", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const L = ctx.TSALicense;
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
  let got = null;
  L.ensure(dp, false, (d) => { got = d; });
  const other = "tsa1_" + "Q".repeat(43);
  L.setToken(dp, other);
  gm.calls[0].onload({ status: 401, responseText: "{}" });   // answer for the OLD key
  assert.equal(got, null);                                     // not delivered as-is
  assert.equal(gm.calls.length, 2);
  assert.equal(gm.calls[1].headers.Authorization, "Bearer " + other);
  gm.calls[1].onload({ status: 200, responseText: JSON.stringify({ active: true, expires_ts: null }) });
  assert.equal(got.locked, false);
  assert.equal(got.state.token, other);
});

test("force does not bypass a 429 backoff, but does bypass a fresh cache or a network-error wait", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const L = ctx.TSALicense;
  let now = T0;
  const store = memStore({ tsa_license: JSON.stringify(L.decide({ token: TOKEN }, T0, status(429)).state) });
  const dp = deps(ctx, { store, now: () => now });
  L.ensure(dp, true, () => {});
  assert.equal(gm.calls.length, 0);
  now = T0 + L.RETRY_MS;
  L.ensure(dp, true, () => {});
  assert.equal(gm.calls.length, 1);
  gm.calls[0].onerror({});                     // network error: retry_ms set, fail=unreachable
  L.ensure(dp, true, () => {});
  assert.equal(gm.calls.length, 2);            // a user's Check again is not held back by it
});

test("tryToken: a working key is never replaced by one that fails", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const L = ctx.TSALicense;
  const store = memStore({ tsa_license: JSON.stringify(activeAt(L, T0)) });
  const dp = deps(ctx, { store });
  const other = "tsa1_" + "Q".repeat(43);
  for (const answer of [{ status: 401, responseText: "{}" }, { status: 503, responseText: "" }, { status: 200, responseText: JSON.stringify({ active: false, expires_ts: 1, renew: "r" }) }]) {
    let r = null;
    L.tryToken(dp, other, (x) => { r = x; });
    const call = gm.calls[gm.calls.length - 1];
    assert.equal(call.headers.Authorization, "Bearer " + other);
    call.onload(answer);
    assert.equal(r.applied, false, JSON.stringify(answer));
    assert.equal(r.decision.locked, true);
    assert.equal(JSON.parse(store.m.tsa_license).token, TOKEN);
    assert.equal(JSON.parse(store.m.tsa_license).status, "active");
  }
  // a malformed key is refused without a request
  const n = gm.calls.length;
  let bad = null;
  L.tryToken(dp, "tsa1_nope", (x) => { bad = x; });
  assert.equal(bad.applied, false); assert.equal(bad.decision.reason, "bad_format");
  assert.equal(gm.calls.length, n);
  // an active new key replaces it
  let ok = null;
  L.tryToken(dp, "  " + other + " ", (x) => { ok = x; });
  gm.calls[gm.calls.length - 1].onload({ status: 200, responseText: JSON.stringify({ active: true, expires_ts: null }) });
  assert.equal(ok.applied, true);
  assert.equal(JSON.parse(store.m.tsa_license).token, other);
});

test("tryToken with no working key stores even an unconfirmed key, so it is retried", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const store = memStore();
  const dp = deps(ctx, { store });
  let r = null;
  ctx.TSALicense.tryToken(dp, TOKEN, (x) => { r = x; });
  gm.calls[0].onerror({});
  assert.equal(r.applied, true);
  assert.equal(r.decision.reason, "unverified");
  assert.equal(JSON.parse(store.m.tsa_license).token, TOKEN);
});

test("a key removed in another tab is seen here (storage re-read on every load)", () => {
  const ctx = load({ GM_xmlhttpRequest: gmStub().fn });
  const L = ctx.TSALicense;
  const store = memStore({ tsa_license: JSON.stringify(activeAt(L, T0)) });
  const dp = deps(ctx, { store });
  assert.equal(L.peek(dp).locked, false);
  store.set("tsa_license", JSON.stringify({ token: null }));   // the other tab
  assert.equal(L.peek(dp).reason, "no_key");
});

test("blocked localStorage cannot cause a check loop (in-memory state wins)", () => {
  const gm = gmStub();
  const ctx = load({ GM_xmlhttpRequest: gm.fn });
  const store = { get: () => { throw new Error("SecurityError"); }, set: () => { throw new Error("SecurityError"); } };
  const dp = deps(ctx, { store });
  ctx.TSALicense.setToken(dp, TOKEN);
  ctx.TSALicense.ensure(dp, false, () => {});
  gm.calls[0].onload({ status: 200, responseText: JSON.stringify({ active: true, expires_ts: null }) });
  let d = null;
  ctx.TSALicense.ensure(dp, false, (x) => { d = x; });
  assert.equal(d.reason, "active");
  assert.equal(gm.calls.length, 1);
});

test("hand-edited stored state cannot add fields", () => {
  const ctx = load();
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN, evil: 1, __proto__: { x: 1 } }) }) });
  const s = ctx.TSALicense.peek(dp).state;
  assert.equal(s.evil, undefined);
  assert.equal(s.token, TOKEN);
});

// ---------------------------------------------------------------- the other transports

test("Torn PDA: PDA_httpGet(url, headers) receives the Bearer header", async () => {
  const seen = [];
  const PDA_httpGet = (url, headers) => { seen.push({ url, headers }); return Promise.resolve({ status: 200, responseText: JSON.stringify({ active: true, expires_ts: null }) }); };
  const ctx = load({ PDA_httpGet });
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
  const d = await new Promise((r) => ctx.TSALicense.ensure(dp, false, r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://dossier-api.aec3.org/api/license/check");
  assert.equal(seen[0].headers.Authorization, "Bearer " + TOKEN);
  assert.equal(d.locked, false);
});

test("Torn PDA: existing callers without headers still pass {} (PDA's own default)", async () => {
  const seen = [];
  const ctx = load({ PDA_httpGet: (url, headers) => { seen.push(headers); return Promise.resolve({ status: 200, responseText: "{}" }); } });
  await new Promise((r) => ctx.gmXhr({ method: "GET", url: "https://api.torn.com/x", onload: r }));
  assert.equal(JSON.stringify(seen), "[{}]");   // vm-realm objects: compare by value
});

test("PDA_httpGet rejection maps to the failure path", async () => {
  const ctx = load({ PDA_httpGet: () => Promise.reject(new Error("offline")) });
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
  const d = await new Promise((r) => ctx.TSALicense.ensure(dp, false, r));
  assert.equal(d.reason, "unverified");
});

test("fetch fallback forwards headers; callers without headers get none", async () => {
  const seen = [];
  const fetch = (url, init) => { seen.push(init); return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify({ active: false, expires_ts: 1, renew: "r" })) }); };
  const ctx = load({ fetch });
  const dp = deps(ctx, { store: memStore({ tsa_license: JSON.stringify({ token: TOKEN }) }) });
  const d = await new Promise((r) => ctx.TSALicense.ensure(dp, false, r));
  assert.equal(seen[0].headers.Authorization, "Bearer " + TOKEN);
  assert.equal(d.reason, "inactive");
  await new Promise((r) => ctx.gmXhr({ method: "GET", url: "https://api.torn.com/x", onload: r }));
  assert.equal(JSON.stringify(seen[1]), JSON.stringify({ method: "GET" }));
});
