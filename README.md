# Close Tab Selects Left

A tiny Firefox extension: when you close the active tab, the tab to its left
becomes active (instead of the one on the right). No settings.

- Requires Firefox 115+ (Manifest V3)
- Only the `tabs` and `storage` permissions (`storage.session` holds the tab
  snapshot in memory); no network access, no data collection
- If there is no visible tab to the left, Firefox's default behaviour applies
- Hidden tabs (e.g. in collapsed tab groups) are skipped; pinned tabs are not,
  so closing the first unpinned tab selects the last pinned one
- This replaces Firefox's "return to the tab that opened this one" behaviour
  (`browser.tabs.selectOwnerOnClose`)

## Build

```sh
make          # produces tab-close-to-left.xpi
make clean
```

## Install

**Temporary (any Firefox):** open `about:debugging#/runtime/this-firefox`,
click *Load Temporary Add-on…*, and select `manifest.json`. Removed on restart.

**Permanent, Developer Edition / Nightly / ESR:**
1. In `about:config`, set `xpinstall.signatures.required` to `false`.
2. In `about:addons`, ⚙ → *Install Add-on From File…* and pick the `.xpi`.

**Permanent, release Firefox:** the add-on must be signed. Submit the zip as an
unlisted add-on at <https://addons.mozilla.org/developers/addon/submit/distribution>
(or run `npx web-ext sign --channel=unlisted --api-key=… --api-secret=…`), then
install the signed `.xpi`.
