import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../torn_stock_analyzer.js", import.meta.url), "utf8");
const start = SRC.indexOf("  function tsaIsTouchOnly() {");
const end = SRC.indexOf("  function createUI() {", start);
assert.ok(start >= 0 && end > start, "title helper block missing");
const BLOCK = SRC.slice(start, end);

const pointerQuery = "(pointer: coarse)";
// hover = "(hover: none)" matches; coarse = "(pointer: coarse)" matches.
function environment(hover, coarse = false) {
  const roots = {};
  const observers = [];
  function el(attrs = {}) {
    return {
      nodeType: 1, attrs: { ...attrs }, children: [],
      hasAttribute(k) { return Object.hasOwn(this.attrs, k); },
      getAttribute(k) { return this.hasAttribute(k) ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      querySelectorAll(selector) {
        assert.equal(selector, "[title]");
        const found = [];
        const visit = (n) => { for (const c of n.children) { if (c.hasAttribute("title")) found.push(c); visit(c); } };
        visit(this); return found;
      },
    };
  }
  for (const id of ["tsa-overlay", "qt-bar", "qt-pills"]) roots[id] = el();
  const ctx = {
    window: { matchMedia: (q) => ({ matches: q === pointerQuery ? coarse : hover }) },
    document: { getElementById: (id) => roots[id] },
    MutationObserver: class { constructor(cb) { this.cb = cb; this.observed = []; observers.push(this); } observe(root, opts) { this.observed.push({ root, opts }); } },
    Array,
  };
  vm.runInNewContext(BLOCK + "\ntsaObserveTitles();", ctx);
  return { roots, observers, el };
}

test("touch devices strip TSA titles on render and later mutations only", () => {
  const { roots, observers, el } = environment(true);
  const button = el({ title: "Gear help" });
  roots["qt-pills"].children.push(button);
  // Initial scan occurred before simulated render insertion; child-list record handles it.
  observers[0].cb([{ type: "childList", addedNodes: [button] }]);
  assert.equal(button.getAttribute("aria-label"), "Gear help");
  assert.equal(button.hasAttribute("title"), false);

  const swing = el();
  roots["qt-pills"].children.push(swing);
  swing.setAttribute("title", "Reached your 5% profit target");
  observers[0].cb([{ type: "attributes", target: swing }]);
  assert.equal(swing.getAttribute("aria-label"), "Reached your 5% profit target");
  assert.equal(swing.hasAttribute("title"), false);

  const labeled = el({ title: "Keep existing label", "aria-label": "Existing" });
  observers[0].cb([{ type: "childList", addedNodes: [labeled] }]);
  assert.equal(labeled.getAttribute("aria-label"), "Existing");
  assert.equal(labeled.hasAttribute("title"), false);
  const torn = el({ title: "Torn tooltip" });
  assert.equal(torn.getAttribute("title"), "Torn tooltip");
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].observed.map((x) => Object.keys(roots).find((id) => roots[id] === x.root)), ["tsa-overlay", "qt-bar", "qt-pills"]);
  assert.equal(JSON.stringify(observers[0].observed[0].opts), JSON.stringify({ attributes: true, attributeFilter: ["title"], childList: true, subtree: true }));
});

test("a stylus phone that reports hover but has a coarse pointer still strips titles", () => {
  const { observers } = environment(false, true);
  assert.equal(observers.length, 1);
});

test("hover devices leave TSA titles untouched", () => {
  const { roots, observers, el } = environment(false);
  const button = el({ title: "Desktop help" });
  roots["tsa-overlay"].children.push(button);
  assert.equal(observers.length, 0);
  assert.equal(button.getAttribute("title"), "Desktop help");
  assert.equal(button.hasAttribute("aria-label"), false);
});
