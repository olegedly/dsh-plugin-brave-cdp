# dsh-plugin-brave-cdp

Drive **your own, already-running Brave** over the Chrome DevTools Protocol: the
real window, your profile, your cookies, your logins, your tabs — including the
tab you are looking at right now.

Most browser automation launches a fresh browser it owns. This one attaches to the
one you already have open, so an agent can read a login-walled page, fill a form in
a session you are signed into, or hand a task back to you mid-flight in the same
window. Nothing is scraped from a parallel profile.

Two surfaces, one implementation:

| Surface | Use it when |
|---|---|
| **DSH tools** (`brave_tabs`, `brave_goto`, …) | an agent drives the browser — schemas, rendered results, no shell quoting |
| **`brave-cdp` CLI** (shipped in this package) | a human or script drives it, or you want `jq`/`batch` pipelines |

Both call the same CDP client, so behaviour and failure messages match.

## Tools

| Tool | Does |
|---|---|
| `brave_tabs` | list / open / focus / close tabs |
| `brave_goto` | navigate a tab (or a new one) and wait for load |
| `brave_snapshot` | interactive elements with `@eN` refs (role, name, value, href, state) |
| `brave_click` | real mouse click by `@eN` ref, CSS selector, or visible text |
| `brave_fill` | set an input / textarea / contenteditable, firing `input`/`change` |
| `brave_key` | press a key, optionally with ctrl / shift / alt / meta |
| `brave_eval` | evaluate JavaScript in the page, awaiting promises |
| `brave_wait` | wait for a selector, text, url, or document load |
| `brave_screenshot` | capture a PNG and return its path |

With no `tab` argument a tool acts on the tab the user is looking at
(`document.visibilityState === 'visible'`), and every result carries the CLI's
`tab:` header so it is clear which tab ran the call. `@eN` refs come from
`brave_snapshot` and stay valid until the page navigates.

Screenshots return a **path** rather than inline pixels: the agent reads the PNG
with whatever image-reading tool it already has, so this plugin needs no vision
pipeline of its own.

## Requirements

1. **Brave started with a CDP port.** Add the flag to the launcher's flag file
   (`~/.config/brave-flags.conf` for the Arch `brave-bin` wrapper):

   ```
   --remote-debugging-port=9222
   ```

   The flag applies at startup only, so Brave must be restarted after adding it.
   The port binds to loopback, but see [Security](#security) before enabling it.

2. **Node ≥ 22** for the CLI (it uses the built-in `fetch` and `WebSocket`; no
   dependencies). Node ≥ 22 is also required by DSH itself.

3. **DSH** with the `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` peer
   packages (present in any DSH install) for the tool surface.

The CLI itself is bundled at `bin/brave-cdp.mjs`; the tools resolve it from the
package, falling back to `~/.local/bin/brave-cdp`, then to `cliPath` /
`BRAVE_CDP_CLI`.

## Install

```bash
# into a DSH profile (declares dsh.bundle.patch, so the tools row mounts itself)
dsh plugin --profile web add "github:olegedly/dsh-plugin-brave-cdp"

# or from a checkout / tarball
dsh plugin --profile web add /path/to/dsh-plugin-brave-cdp
```

Then confirm the endpoint is reachable:

```bash
brave-cdp status     # endpoint UP + browser version + tab count => ready
```

Standalone CLI, without DSH (not on npm yet, so install it from the repository):

```bash
npm install -g "github:olegedly/dsh-plugin-brave-cdp"   # provides `brave-cdp`
brave-cdp tabs
brave-cdp snapshot -i
brave-cdp click '@e4'
brave-cdp eval 'document.title'
brave-cdp shot page.png --full
```

## CLI

```
brave-cdp status                     endpoint, browser version, tab count
brave-cdp tabs [list]                tabs, 1-based indices, * marks the target
brave-cdp tabs new <url>             open a tab
brave-cdp tabs select <n|id|text>    focus a tab and raise its window
brave-cdp tabs close <n|id|text>     close a tab
brave-cdp open <url> [--new]         navigate (or open) and wait for load
brave-cdp back | forward | reload [--hard]
brave-cdp snapshot [scope] [-i] [--compact] [--json]
brave-cdp click <@eN|css|--text T> [--exact] [--dblclick]
brave-cdp fill <@eN|css> <text> [--append]
brave-cdp type [@eN|css] <text>
brave-cdp key <Enter|Tab|Escape|ArrowDown|...> [--ctrl --shift --alt --meta]
brave-cdp eval <js> [--file <path>|-]     evaluate JS, print JSON
brave-cdp html [css] [--text] / text [css]
brave-cdp shot [file] [--full]
brave-cdp wait <ms>|@eN|--selector S|--text T|--url U|--load
brave-cdp batch "open https://x" "wait --text Done" "shot done.png"
```

Global flags: `--tab <n|id|url-substr>`, `--json`, `--timeout <ms>`, `--port <n>`.
Env: `BRAVE_CDP_PORT` (9222), `BRAVE_CDP_HOST` (127.0.0.1), `BRAVE_CDP_TIMEOUT`.

`brave-cdp help` is the source of truth.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `cliPath` | packaged `bin/brave-cdp.mjs` | CLI to invoke |
| `port` | `9222` | CDP port (must match the Brave flag) |
| `timeoutMs` | `60000` | Per-call timeout |
| `screenshotTimeoutMs` | `120000` | Screenshot timeout |

The bundled patch mounts the row as `brave-cdp`; a profile's own
`cordis.patch.yml` is applied afterwards, so override that id to change the port
or point at another CLI:

```yaml
- id: brave-cdp
  config:
    port: 9223
```

## Security

CDP is **full control of the browser**: page contents, cookies, and any session
you are logged into are readable, and it can act as you on any site. The port
binds to loopback only, which limits it to local processes — that is a boundary,
not a guarantee. Add the flag when you want an agent to drive the browser, and
remove it (and restart) when you do not.

## Development

```bash
npm run check    # node --check on the plugin and the CLI
npm test         # node --test test/ (no network, no browser needed)
```

| Path | What |
|---|---|
| `lib/index.js` | the nine tools: schemas, argument mapping, result rendering |
| `bin/brave-cdp.mjs` | the CDP client — transport, target selection, DOM refs, input, screenshots |
| `cordis.patch.yml` | the bundle patch that mounts the tools row |
| `test/` | CLI behaviour and packaging invariants |

Because the CDP client lives in the CLI, the plugin is a thin adapter: one tested
code path serves both the tool surface and the shell, and the DSH host process
never imports a browser-automation dependency.

## License

MIT — see [LICENSE](LICENSE).
