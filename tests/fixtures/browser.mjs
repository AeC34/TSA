// A small fake browser that runs the whole userscript in a node vm. Not a test file
// itself (tests/*.mjs does not reach this folder); imported by tests/datasafety.test.mjs.
//
// boot(src, opts) evaluates `src` unchanged with: a permissive DOM stub, an in-memory
// localStorage (Object.keys(localStorage) lists the stored keys, as in a browser),
// fake timers that only run when asked, and a GM_xmlhttpRequest stub that records
// every request and answers it from a route table. No network at all.
import vm from "node:vm";

function makeEl(tag, reg) {
  const t = {
    tagName: String(tag || "div").toUpperCase(), children: [], listeners: {}, attrs: {},
    _html: "", _text: "", id: "", className: "", value: "", checked: false, disabled: false,
    style: {}, dataset: {}, parentNode: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); }, remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; if (on) this._s.add(c); else this._s.delete(c); return on; },
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

// routes: [[urlPrefix, answer]], first matching prefix wins. answer: {status, body,
// headers} | "error" (network error) | "hang" | a function of the request object.
// Unmatched URLs hang.
export function boot(src, { store = {}, routes = [], visible = true } = {}) {
  const m = { ...store };
  const removed = [];
  const ls = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { if (Object.prototype.hasOwnProperty.call(m, k)) removed.push(k); delete m[k]; },
    clear: () => { Object.keys(m).forEach((k) => { removed.push(k); delete m[k]; }); },
    key: (i) => Object.keys(m)[i] || null,
    get length() { return Object.keys(m).length; },
  };
  const lsProxy = new Proxy(ls, {
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
    createTextNode: () => makeEl("#text", reg),
    getElementById: (id) => { if (!reg[id]) { const e = makeEl("div", reg); e.id = id; } return reg[id]; },
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
  const gm = (o) => { calls.push(o); answer(o); };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    localStorage: lsProxy, document, navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
    innerWidth: 1280, innerHeight: 800,
    location: { href: "https://www.torn.com/page.php?sid=stocks", search: "?sid=stocks", hash: "", pathname: "/page.php" },
    GM_xmlhttpRequest: gm,
    setTimeout: (fn, ms) => { const t = { fn, ms: ms || 0, id: ++seq, live: true, every: false }; timers.push(t); return t.id; },
    setInterval: (fn, ms) => { const t = { fn, ms: ms || 0, id: ++seq, live: true, every: true }; timers.push(t); return t.id; },
    clearTimeout: (id) => { timers.forEach((t) => { if (t.id === id) t.live = false; }); },
    clearInterval: (id) => { timers.forEach((t) => { if (t.id === id) t.live = false; }); },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {},
  };
  const chain = new Proxy(function () {}, {
    get: (o, k) => (k === "length" ? 0 : (typeof k === "symbol" ? undefined : (/^(attr|text|val|html|css|prop|data)$/.test(k) ? () => "" : () => chain))),
    apply: () => chain,
  });
  const jq = () => chain;
  jq.ajax = () => {};
  sandbox.$ = jq; sandbox.jQuery = jq;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  let error = null;
  try { vm.runInContext(src, ctx, { filename: "torn_stock_analyzer.js" }); } catch (e) { error = e; }
  return {
    ctx, calls, store: m, removed, timers, reg, error,
    content: () => allText(reg["tsa-content"]),
    page: () => Object.values(reg).map((e) => allText(e)).join(" "),
    hosts: () => calls.map((c) => new URL(c.url).host),
    click: (id) => { const e = reg[id]; ((e && e.listeners.click) || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} })); },
    // run every live timer of at most maxMs once (intervals stay live)
    runTimers(maxMs) {
      timers.filter((t) => t.live && t.ms <= maxMs).forEach((t) => { if (!t.every) t.live = false; try { t.fn(); } catch (e) {} });
    },
  };
}

export async function settle(n = 40) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
