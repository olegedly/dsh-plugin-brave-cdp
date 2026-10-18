# Changelog

## 0.2.0

First public release.

- Nine model-facing tools over the Chrome DevTools Protocol: `brave_tabs`,
  `brave_goto`, `brave_snapshot`, `brave_click`, `brave_fill`, `brave_key`,
  `brave_eval`, `brave_wait`, `brave_screenshot`.
- Ships the `brave-cdp` CLI — a dependency-free Node client — as `bin/brave-cdp.mjs`.
  Tools invoke it through the current Node binary, so neither the executable bit
  nor the shebang can break the install, and the same code path serves shell use
  (`brave-cdp status`, `brave-cdp batch …`).
- Declares `dsh.bundle.patch`, so `dsh plugin add` activates the tools row instead
  of requiring a hand-edited profile.
- With no `tab` argument, tools act on the tab the user is looking at
  (`document.visibilityState === 'visible'`) and report which tab they used.
- Screenshots return a file path, so an agent can read the PNG through its own
  image-reading tool rather than depending on a vision pipeline in this plugin.
