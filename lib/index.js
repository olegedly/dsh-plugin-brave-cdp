/**
 * dsh-plugin-brave-cdp — model-facing tools over the user's *live* Brave session.
 *
 * Every tool is a thin, argument-safe wrapper around the `brave-cdp` CLI shipped
 * in this package (`bin/brave-cdp.mjs`), which speaks CDP to the Brave instance the
 * user is actually using: their profile, cookies, logins and tabs. Keeping the
 * CDP client in the CLI means one tested code path for both the shell and the
 * model, and no browser-automation dependency inside the DSH host process.
 *
 * @module dsh-plugin-brave-cdp
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';

export const name = 'brave-cdp';
export const inject = ['tools'];

/** The CLI shipped alongside this plugin. */
const PACKAGED_CLI = fileURLToPath(new URL('../bin/brave-cdp.mjs', import.meta.url));

/**
 * Default CLI location: the copy packaged with this plugin, falling back to a
 * user-installed one (a deployment may keep `brave-cdp` on its PATH instead).
 * @returns an absolute path to the CLI to invoke.
 */
function defaultCliPath() {
  if (fs.existsSync(PACKAGED_CLI)) return PACKAGED_CLI;
  return path.join(os.homedir(), '.local', 'bin', 'brave-cdp');
}

/** Deployment configuration for the tool family. */
export const Config = z.object({
  /** Absolute path to the brave-cdp CLI; empty means the packaged copy, then ~/.local/bin. */
  cliPath: z.string().default(''),
  /** CDP port Brave listens on (must match --remote-debugging-port in brave-flags.conf). */
  port: z.natural().default(9222),
  /** Default per-call timeout. */
  timeoutMs: z.natural().default(60000),
  /** Screenshots are slower than inspection calls. */
  screenshotTimeoutMs: z.natural().default(120000),
});

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    output: {
      type: 'string',
      required: true,
      description: 'Human-readable result text (tab header, table, JSON, error detail).',
    },
    path: {
      type: 'string',
      description: 'File written by the call, when one was (screenshots).',
    },
  },
};

/** The `tab:` header the CLI writes on stderr identifies which tab ran the call. */
function renderText(value) {
  const parts = [String(value && value.output !== undefined ? value.output : '')];
  if (value && value.path) parts.push(`saved: ${value.path}`);
  return [{ type: 'text', text: parts.filter(Boolean).join('\n') }];
}

const TAB_DESCRIPTION = 'Tab to act on: a 1-based index from brave_tabs, a target id prefix, or a url/title substring. Omit to act on the tab the user is looking at.';

/**
 * Build the CLI invoker for one configured deployment.
 * @param config - the validated {@link Config}.
 * @returns a function running `brave-cdp <args...>` and resolving its output.
 */
function makeRunner(config) {
  const cli = config.cliPath || process.env.BRAVE_CDP_CLI || defaultCliPath();
  const env = { ...process.env, BRAVE_CDP_PORT: String(config.port) };

  return function run(args, { timeoutMs } = {}) {
    const limit = timeoutMs !== undefined ? timeoutMs : config.timeoutMs;
    return new Promise((resolve, reject) => {
      // Run the script through the current Node binary rather than relying on the
      // shebang and the executable bit, which survive npm install unevenly.
      execFile(
        process.execPath,
        [cli, '--port', String(config.port), ...args],
        { timeout: limit, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env },
        (error, stdout, stderr) => {
          const out = String(stdout || '').trim();
          const err = String(stderr || '').trim();
          if (error) {
            if (error.code === 'ENOENT') {
              reject(new Error(`brave-cdp CLI not found at ${cli}. Set config.cliPath or BRAVE_CDP_CLI to an existing copy.`));
              return;
            }
            if (error.killed) {
              reject(new Error(`brave-cdp ${args[0]} timed out after ${limit}ms`));
              return;
            }
            reject(new Error(err || out || `brave-cdp ${args[0]} failed (exit ${error.code})`));
            return;
          }
          // stdout is the machine-readable part; stderr carries the `tab:` header.
          const header = err.split('\n').filter((l) => l.startsWith('tab:')).join('\n');
          resolve({ output: [header, out].filter(Boolean).join('\n'), stdout: out, stderr: err });
        },
      );
    });
  };
}

/**
 * Register the Brave tools on the tool service.
 * @param ctx - Cordis context with the `tools` service injected.
 * @param config - the validated {@link Config}.
 */
export function apply(ctx, config) {
  const run = makeRunner(config);
  const inspect = (args, options) => run(args, options).then(({ output }) => ({ output }));
  const boolFlag = (value, flag) => (value === true ? [flag] : []);
  const valueFlag = (value, flag) => (value !== undefined && value !== null && value !== '' ? [flag, String(value)] : []);
  const whichTab = (tab) => valueFlag(tab, '--tab');

  ctx.tools.register(defineTool({
    name: 'brave_tabs',
    description:
      'List, open, focus or close tabs in the user\'s live Brave browser. Start here to discover tabs: indices are what every other brave_* tool accepts as `tab`. The `*` marks the tab actions target by default — the one the user is looking at.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'new', 'select', 'close'],
        description: 'list = show tabs; new = open `url` in a new tab; select = focus `tab` and raise its window; close = close `tab`.',
      },
      tab: { type: 'string', description: 'Target tab for select/close. Defaults to the current tab.' },
      url: { type: 'string', description: 'URL for action=new.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => {
      if (args.action === 'list') return inspect(['tabs']);
      if (args.action === 'new') {
        if (!args.url) throw new Error('brave_tabs action=new requires `url`');
        return inspect(['tabs', 'new', args.url]);
      }
      if (args.action === 'select') return inspect(['tabs', 'select', args.tab ? String(args.tab) : '1']);
      if (args.action === 'close') {
        if (!args.tab) throw new Error('brave_tabs action=close requires `tab`');
        return inspect(['tabs', 'close', String(args.tab)]);
      }
      throw new Error(`unknown brave_tabs action: ${args.action}`);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'brave_goto',
    description:
      'Navigate the user\'s live Brave browser to a URL (their real session, logins, cookies and history). Waits for load and reports the final title and URL. Use `new_tab` to keep the current page open.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL to open.' },
      tab: { type: 'string', description: TAB_DESCRIPTION },
      new_tab: { type: 'boolean', description: 'Open in a new tab instead of navigating the target tab.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => inspect([
      ...(args.tab ? whichTab(args.tab) : []),
      'open', args.url, ...boolFlag(args.new_tab, '--new'),
    ]),
  }));

  ctx.tools.register(defineTool({
    name: 'brave_snapshot',
    description:
      'List the interactive elements of a page in the user\'s Brave browser, each with an @eN ref that brave_click and brave_fill accept. Shows role, accessible name, value, checked/disabled state, links and editable fields. Re-run after any navigation, because refs belong to the page that was snapshotted.',
    parameters: {
      tab: { type: 'string', description: TAB_DESCRIPTION },
      compact: { type: 'boolean', description: 'Hide elements with no name or value (denser output).' },
      scope: { type: 'string', description: 'CSS selector limiting the snapshot to one subtree.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => inspect([
      'snapshot',
      ...(args.scope ? [args.scope] : []),
      ...whichTab(args.tab),
      ...boolFlag(args.compact, '--compact'),
    ]),
  }));

  ctx.tools.register(defineTool({
    name: 'brave_click',
    description:
      'Click an element in the user\'s Brave browser with a real synthetic mouse click (scrolls it into view first). Identify the element with an @eN ref from brave_snapshot, a CSS selector, or `text` to match its visible label. Clicking can submit forms, send messages or buy things — confirm intent with the user before irreversible actions.',
    parameters: {
      target: { type: 'string', description: 'An @eN ref from brave_snapshot or a CSS selector. Omit when using `text`.' },
      text: { type: 'string', description: 'Visible text of the element to click (innermost match wins).' },
      tab: { type: 'string', description: TAB_DESCRIPTION },
      exact: { type: 'boolean', description: 'With `text`, require an exact match instead of a substring match.' },
      double_click: { type: 'boolean', description: 'Send a double click.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => {
      if (!args.target && !args.text) throw new Error('brave_click needs `target` (@eN or CSS) or `text`');
      return inspect([
        'click',
        ...(args.target ? [args.target] : []),
        ...valueFlag(args.text, '--text'),
        ...whichTab(args.tab),
        ...boolFlag(args.exact, '--exact'),
        ...boolFlag(args.double_click, '--dblclick'),
      ]);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'brave_fill',
    description:
      'Set the value of an input, textarea or contenteditable element in the user\'s Brave browser, firing the input/change events frameworks listen for. Identify it with an @eN ref from brave_snapshot or a CSS selector. This does not submit — follow with brave_click or brave_key when the user wants the form sent.',
    parameters: {
      target: { type: 'string', required: true, description: 'An @eN ref from brave_snapshot or a CSS selector.' },
      text: { type: 'string', required: true, description: 'Text to put in the field.' },
      tab: { type: 'string', description: TAB_DESCRIPTION },
      append: { type: 'boolean', description: 'Append to the current value instead of replacing it.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => inspect([
      'fill', args.target, args.text,
      ...whichTab(args.tab),
      ...boolFlag(args.append, '--append'),
    ]),
  }));

  ctx.tools.register(defineTool({
    name: 'brave_key',
    description:
      'Press one key in the user\'s Brave browser (Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or a single letter/digit), optionally with ctrl/shift/alt/meta held. Useful to submit a search box or dismiss an overlay.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key name, e.g. Enter, Tab, Escape, ArrowDown, a.' },
      tab: { type: 'string', description: TAB_DESCRIPTION },
      ctrl: { type: 'boolean', description: 'Hold Ctrl.' },
      shift: { type: 'boolean', description: 'Hold Shift.' },
      alt: { type: 'boolean', description: 'Hold Alt.' },
      meta: { type: 'boolean', description: 'Hold Meta/Super.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => inspect([
      'key', args.key,
      ...whichTab(args.tab),
      ...boolFlag(args.ctrl, '--ctrl'),
      ...boolFlag(args.shift, '--shift'),
      ...boolFlag(args.alt, '--alt'),
      ...boolFlag(args.meta, '--meta'),
    ]),
  }));

  ctx.tools.register(defineTool({
    name: 'brave_eval',
    description:
      'Evaluate JavaScript in a page of the user\'s Brave browser and return the value. The expression may use await (it runs with a user gesture, in the page\'s own world, with the user\'s cookies). Prefer this over reading raw HTML for facts the snapshot does not expose; return JSON-serializable values.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression to evaluate, e.g. `document.title` or `[...document.querySelectorAll("h2")].map(h => h.innerText)`.' },
      tab: { type: 'string', description: TAB_DESCRIPTION },
      timeout_ms: { type: 'number', description: 'Timeout for this call in milliseconds.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => inspect([
      'eval', args.expression,
      ...whichTab(args.tab),
    ], args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}),
  }));

  ctx.tools.register(defineTool({
    name: 'brave_wait',
    description:
      'Wait in the user\'s Brave browser until a condition holds: an element matches a CSS selector or @eN ref exists, page text appears, the URL contains a substring, or the document finishes loading. Use it instead of guessing with sleeps after navigation or a click that triggers work.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector that must match.' },
      text: { type: 'string', description: 'Substring that must appear in the page text.' },
      url: { type: 'string', description: 'Substring the current URL must contain.' },
      load: { type: 'boolean', description: 'Wait for document.readyState === "complete".' },
      ms: { type: 'number', description: 'Plain delay in milliseconds.' },
      tab: { type: 'string', description: TAB_DESCRIPTION },
      timeout_ms: { type: 'number', description: 'How long to keep polling (default 15000).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: (args) => {
      const condition = [
        ...valueFlag(args.selector, '--selector'),
        ...valueFlag(args.text, '--text'),
        ...valueFlag(args.url, '--url'),
        ...boolFlag(args.load, '--load'),
      ];
      if (!condition.length && args.ms === undefined) {
        throw new Error('brave_wait needs one of `selector`, `text`, `url`, `load`, or `ms`');
      }
      const delay = args.ms !== undefined ? [String(args.ms)] : [];
      const timeout = args.timeout_ms !== undefined ? ['--timeout', String(args.timeout_ms)] : [];
      return inspect(['wait', ...delay, ...condition, ...whichTab(args.tab), ...timeout]);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'brave_screenshot',
    description:
      'Capture a PNG of a page in the user\'s Brave browser and return its path. The file is written to disk; read it with the read_image tool when you need to see the pixels (layout, charts, canvas, visual state) rather than the DOM.',
    parameters: {
      tab: { type: 'string', description: TAB_DESCRIPTION },
      path: { type: 'string', description: 'Where to write the PNG. Defaults to a timestamped file under the system temp directory.' },
      full_page: { type: 'boolean', description: 'Capture the whole scrollable page instead of just the viewport.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderText(value) },
    execute: async (args) => {
      const file = args.path || path.join(os.tmpdir(), 'brave-cdp-shots', `shot-${Date.now()}.png`);
      const result = await run([
        'shot', file,
        ...whichTab(args.tab),
        ...boolFlag(args.full_page, '--full'),
      ], { timeoutMs: config.screenshotTimeoutMs });
      return { output: result.output, path: file };
    },
  }));
}
