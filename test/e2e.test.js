// End-to-end tests: drive a real Firefox with the extension installed, in a
// throwaway profile. Firefox is downloaded into .cache/ (never the system one).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Browser, install, resolveBuildId, detectBrowserPlatform, computeExecutablePath } from "@puppeteer/browsers";
import seleniumPkg from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

const { Builder } = seleniumPkg;
const { Context } = firefox;

// Chrome-context access (used to drive tab state) must be enabled in the
// browser process. It is only ever set on the throwaway test Firefox.
process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, ".cache", "browsers");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDLE_MS = 2000; // shrink the event-page idle timeout so suspension is testable

let driver;

async function firefoxBinary() {
  const platform = detectBrowserPlatform();
  const buildId = process.env.FIREFOX_BUILD_ID || (await resolveBuildId(Browser.FIREFOX, platform, "stable"));
  await install({ browser: Browser.FIREFOX, buildId, cacheDir });
  return computeExecutablePath({ browser: Browser.FIREFOX, buildId, cacheDir });
}

// Run a function in Firefox's chrome context, where `gBrowser` is the window's tab browser.
const chrome = async (fn, ...args) => {
  await driver.setContext(Context.CHROME);
  try { return await driver.executeScript(fn, ...args); }
  finally { await driver.setContext(Context.CONTENT); }
};
const urls = () => chrome(() => Array.from(gBrowser.tabs, (t) => t.linkedBrowser.currentURI.spec));
const selected = () => chrome(() => Array.from(gBrowser.tabs).indexOf(gBrowser.selectedTab));
const select = (i) => chrome((i) => { gBrowser.selectedTab = gBrowser.tabs[i]; }, i);
const close = (i) => chrome((i) => gBrowser.removeTab(gBrowser.tabs[i], { animate: false }), i);

// Tab 0 is a sentinel that no test closes, so WebDriver always has a live tab.
// Test tabs are created and removed entirely in chrome, so WebDriver never re-attaches.
async function resetTabs(names) {
  await chrome((names) => {
    for (let i = gBrowser.tabs.length - 1; i >= 1; i--) gBrowser.removeTab(gBrowser.tabs[i], { animate: false });
    for (const n of names) gBrowser.addTab(`data:text/html,${n}`, { triggeringPrincipal: document.nodePrincipal, skipAnimation: true });
    gBrowser.selectedTab = gBrowser.tabs[1];
  }, names);
  // addTab returns before the data: URL is committed, so poll until the names settle.
  const got = async () => (await urls()).slice(1).map((u) => u.split(",")[1]);
  for (let i = 0; i < 50 && JSON.stringify(await got()) !== JSON.stringify(names); i++) await sleep(100);
  assert.deepEqual(await got(), names);
}
// Test index i refers to names[i], which lives at tab index i + 1.
const T = (i) => i + 1;

const label = async () => (await urls())[await selected()].split(",")[1];
// The extension acts asynchronously after a close, so poll.
async function waitFor(expected) {
  for (let i = 0; i < 40; i++) {
    if ((await label()) === expected) return;
    await sleep(100);
  }
  assert.equal(await label(), expected);
}
const settle = () => sleep(800);

before(async () => {
  // CI passes the already-built artifact via XPI; locally, build it.
  const xpi = process.env.XPI ? path.resolve(process.env.XPI) : path.join(root, "tab-close-to-left.xpi");
  if (!process.env.XPI) execFileSync("make", ["-s"], { cwd: root });
  const opts = new firefox.Options()
    .setBinary(await firefoxBinary())
    .addArguments("-headless")
    .setPreference("extensions.background.idle.timeout", IDLE_MS)
    .setPreference("browser.tabs.selectOwnerOnClose", false);
  driver = await new Builder().forBrowser("firefox").setFirefoxOptions(opts).build();
  await driver.installAddon(xpi, true);
  await sleep(1000);
});

after(async () => { await driver?.quit(); });

test("closing the active middle tab selects the tab to its left", async () => {
  await resetTabs(["A", "B", "C", "D"]);
  await select(T(2)); // C
  await close(T(2));
  await waitFor("B");
});

test("closing the active last tab selects the tab to its left", async () => {
  await resetTabs(["A", "B", "C"]);
  await select(T(2));
  await close(T(2));
  await waitFor("B");
});

// The sentinel sits to the left of the first test tab, so "first" here still has a
// left neighbour. Firefox's default-right case is covered by the unit tests.
test("closing the first test tab selects the sentinel on its left", async () => {
  await resetTabs(["A", "B", "C"]);
  await select(T(0));
  await close(T(0));
  await settle();
  assert.equal(await selected(), 0);
});

test("closing a background tab does not change the selection", async () => {
  await resetTabs(["A", "B", "C", "D"]);
  await select(T(3)); // D
  await close(T(1)); // B, in the background
  await settle();
  assert.equal(await label(), "D");
});

test("repeated closes keep moving left", async () => {
  await resetTabs(["A", "B", "C", "D"]);
  await select(T(3));
  await close(T(3));
  await waitFor("C");
  await close(T(2));
  await waitFor("B");
});

test("still works after the background page has been suspended", async () => {
  await resetTabs(["A", "B", "C", "D"]);
  await select(T(2));
  await sleep(IDLE_MS * 3); // let the event page go idle and unload
  await close(T(2));
  await waitFor("B");
});
