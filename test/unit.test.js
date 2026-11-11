// Unit tests: run the real background.js against a fake `browser` API that
// mimics Firefox's tab model (including its default selection on close).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "background.js"), "utf8");
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// Fake Firefox. `windows` maps windowId -> array of { id, active } in tab order.
function makeFirefox(windows, storage = new Map()) {
  let nextId = 1000;
  const updates = [];
  const listeners = {};
  const ev = (n) => (listeners[n] ??= []);
  const evt = (n) => ({ addListener: (fn) => ev(n).push(fn) });
  const tabsIn = (windowId) => windows.get(windowId);
  const api = {
    tabs: {
      query: async ({ windowId, active }) => {
        const list = tabsIn(windowId) ?? [];
        const all = list.map((t, index) => ({ ...t, index, windowId }));
        // Return in scrambled order so the extension's sort is exercised.
        return (active ? all.filter((t) => t.active) : all).reverse();
      },
      update: async (id, { active }) => {
        updates.push(id);
        for (const list of windows.values()) {
          const t = list.find((x) => x.id === id);
          if (t && active) list.forEach((x) => (x.active = x === t));
        }
      },
      onCreated: evt("created"), onActivated: evt("activated"), onMoved: evt("moved"),
      onAttached: evt("attached"), onDetached: evt("detached"), onRemoved: evt("removed"),
    },
    windows: { getAll: async () => [...windows.keys()].map((id) => ({ id })) },
    storage: {
      session: {
        get: async (k) => (k === null ? Object.fromEntries(storage) : storage.has(k) ? { [k]: storage.get(k) } : {}),
        remove: async (k) => { storage.delete(k); },
        set: async (o) => { for (const [k, v] of Object.entries(o)) storage.set(k, structuredClone(v)); },
      },
    },
    runtime: { onInstalled: evt("installed"), onStartup: evt("startup") },
  };
  // Load the extension script fresh, as Firefox does when it wakes the event page.
  const load = () => vm.runInNewContext(src, { browser: api, console });
  const fire = async (name, ...args) => { for (const fn of ev(name)) fn(...args); await flush(); };

  return {
    windows, storage, load, fire, updates,
    open(windowId, { active = false } = {}) {
      const list = tabsIn(windowId) ?? [];
      const tab = { id: nextId++, active: false, hidden: false };
      if (active || list.length === 0) list.forEach((t) => (t.active = false));
      list.push(tab);
      if (active || list.length === 1) { tab.active = true; }
      windows.set(windowId, list);
      return tab.id;
    },
    // Close a tab the way Firefox does: default selection is the tab on the right,
    // or the one on the left if it was last. Then fire onRemoved.
    async close(windowId, id, { isWindowClosing = false } = {}) {
      const list = tabsIn(windowId);
      const i = list.findIndex((t) => t.id === id);
      const [gone] = list.splice(i, 1);
      if (gone.active && list.length) {
        const next = list[Math.min(i, list.length - 1)];
        next.active = true;
      }
      await this.fire("removed", id, { windowId, isWindowClosing });
    },
    activeId: (windowId) => tabsIn(windowId).find((t) => t.active)?.id,
  };
}

const activate = async (ff, windowId, id) => {
  for (const t of ff.windows.get(windowId)) t.active = t.id === id;
  await ff.fire("activated", { tabId: id, windowId });
};

const setup = (ids = 4, windowId = 1) => {
  const ff = makeFirefox(new Map([[windowId, []]]));
  const tabs = Array.from({ length: ids }, () => ff.open(windowId));
  return { ff, tabs, windowId };
};

test("closing the active middle tab selects the tab to its left", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[2]);
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[1]);
});

test("closing the active last tab selects the tab to its left", async () => {
  const { ff, tabs, windowId } = setup(3);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[2]);
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[1]);
});

test("closing the active first tab leaves Firefox's default (right) selection", async () => {
  const { ff, tabs, windowId } = setup(3);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[0]);
  await ff.close(windowId, tabs[0]);
  assert.equal(ff.activeId(windowId), tabs[1]);
});

test("closing a background tab does not change the selection", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[3]);
  await ff.close(windowId, tabs[1]);
  assert.equal(ff.activeId(windowId), tabs[3]);
});

test("closing a window does not select anything", async () => {
  const { ff, tabs, windowId } = setup(3);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[2]);
  await ff.close(windowId, tabs[2], { isWindowClosing: true });
  assert.deepEqual(ff.updates, []);
  assert.equal(ff.storage.has("w1"), false);
});

test("repeated closes keep moving left", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[3]);
  await ff.close(windowId, tabs[3]);
  assert.equal(ff.activeId(windowId), tabs[2]);
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[1]);
});

test("still works after the event page is suspended and woken", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[2]);
  // Suspension: the old script instance is gone; only storage.session survives.
  ff.load();
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[1]);
});

test("a wake-up from a close does not overwrite the snapshot before it is read", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[2]);
  ff.load(); // re-running the script must not reseed (only install/startup do)
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[1]);
});

test("containers: a new tab opened and activated before the original closes stays selected", async () => {
  const { ff, tabs, windowId } = setup(3);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[1]);
  // "Always open in" opens the container tab, activates it, then closes the original.
  const container = ff.open(windowId, { active: true });
  await ff.fire("created", { id: container, windowId });
  await activate(ff, windowId, container);
  await ff.close(windowId, tabs[1]);
  assert.equal(ff.activeId(windowId), container);
});

test("re-enabling (a wake with no install/startup event) seeds missing snapshots", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.windows.get(windowId).forEach((t) => (t.active = t.id === tabs[2]));
  ff.load(); await flush(); // no onInstalled/onStartup
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[1]);
});

test("a wake-up does not overwrite an existing snapshot", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[2]);
  const snap = structuredClone(ff.storage.get("w1"));
  // Firefox has already moved selection before the page wakes for onRemoved.
  ff.windows.get(windowId).forEach((t) => (t.active = t.id === tabs[3]));
  ff.load(); await flush();
  assert.deepEqual(ff.storage.get("w1"), snap);
});

test("hidden tabs to the left are skipped", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  ff.windows.get(windowId)[1].hidden = true;
  await activate(ff, windowId, tabs[2]);
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[0]);
});

test("a left neighbour closed in the same batch is skipped", async () => {
  const { ff, tabs, windowId } = setup(4);
  ff.load(); await ff.fire("startup");
  await activate(ff, windowId, tabs[2]);
  // Multi-select close: tabs[1] goes too, before onRemoved for tabs[2] is handled.
  ff.windows.get(windowId).splice(1, 1);
  await ff.close(windowId, tabs[2]);
  assert.equal(ff.activeId(windowId), tabs[0]);
});
