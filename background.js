// MV3 event pages get suspended, so the per-window snapshot of tab order and
// active tab lives in storage.session. All listeners are registered
// synchronously at top level so they can wake the page.
const key = (windowId) => `w${windowId}`;

async function refresh(windowId) {
  try {
    const tabs = await browser.tabs.query({ windowId });
    tabs.sort((a, b) => a.index - b.index);
    await browser.storage.session.set({
      [key(windowId)]: {
        ids: tabs.map((t) => t.id),
        active: tabs.find((t) => t.active)?.id,
      },
    });
  } catch {}
}

browser.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
  if (isWindowClosing) {
    browser.storage.session.remove(key(windowId)).catch(() => {});
    return;
  }
  try {
    const s = (await browser.storage.session.get(key(windowId)))[key(windowId)];
    if (s && s.active === tabId) {
      const tabs = await browser.tabs.query({ windowId });
      // If a tab we haven't snapshotted yet is already active (e.g. Containers'
      // "always open in" opens a new tab, then closes the original), leave it.
      const active = tabs.find((t) => t.active);
      const fresh = active && active.id !== tabId && !s.ids.includes(active.id);
      // Nearest tab to the left that still exists (multi-select closes remove
      // several at once) and isn't hidden (tabs.hide, collapsed tab groups).
      const visible = new Set(tabs.filter((t) => !t.hidden).map((t) => t.id));
      const left = s.ids.slice(0, s.ids.indexOf(tabId)).reverse().find((id) => visible.has(id));
      if (!fresh && left !== undefined) {
        await browser.tabs.update(left, { active: true });
      }
    }
  } catch {}
  refresh(windowId);
});

browser.tabs.onCreated.addListener((t) => refresh(t.windowId));
browser.tabs.onActivated.addListener((i) => refresh(i.windowId));
browser.tabs.onMoved.addListener((_, i) => refresh(i.windowId));
browser.tabs.onAttached.addListener((_, i) => refresh(i.newWindowId));
browser.tabs.onDetached.addListener((_, i) => refresh(i.oldWindowId));

// Seed every window on install/browser start. On any other wake-up (including
// re-enabling the add-on, which fires neither event) only seed windows with no
// snapshot: overwriting an existing one would lose the state onRemoved needs.
const seed = (onlyMissing) =>
  browser.windows.getAll().then(async (ws) => {
    const have = onlyMissing ? await browser.storage.session.get(null) : {};
    ws.filter((w) => !(key(w.id) in have)).forEach((w) => refresh(w.id));
  }).catch(() => {});
browser.runtime.onInstalled.addListener(() => seed(false));
browser.runtime.onStartup.addListener(() => seed(false));
seed(true);
