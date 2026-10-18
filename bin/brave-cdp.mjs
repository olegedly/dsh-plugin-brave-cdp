#!/usr/bin/env node
/**
 * brave-cdp — drive the running Brave browser over the Chrome DevTools Protocol.
 *
 * Talks to whatever Brave exposes at $BRAVE_CDP_PORT (default 127.0.0.1:9222),
 * which is the user's own browser session: real profile, real cookies, real tabs.
 *
 *   brave-cdp status                  is the endpoint up, which tabs exist
 *   brave-cdp tabs                    list tabs (stable indices)
 *   brave-cdp snapshot -i             interactive elements with @eN refs
 *   brave-cdp click '@e4'             real mouse click at element centre
 *   brave-cdp fill '@e2' "hello"      set an input/textarea/contenteditable
 *   brave-cdp type "hello"            insert text into the focused element
 *   brave-cdp key Enter --ctrl        press Enter (optionally with modifiers)
 *   brave-cdp eval 'document.title'   evaluate JS in the page, print as JSON
 *   brave-cdp open https://example.com
 *   brave-cdp shot page.png --full    screenshot (PNG)
 *   brave-cdp wait --text "Done"      poll until a condition holds
 *   brave-cdp batch "open https://a" "snapshot -i" "shot a.png"
 *
 * Global flags: --tab <n|id|url-substr>  --port N  --json  --timeout ms
 *
 * No dependencies beyond Node >= 22 (global fetch + WebSocket).
 *
 * This file is `.mjs` on purpose: the package sets `"type": "module"`, and an
 * extensionless bin would otherwise be parsed as ESM in that context but as
 * CommonJS on a bare PATH, so the explicit extension keeps the script's module
 * type the same wherever it is installed or symlinked.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VERSION = '1.0.0';
const HOST = process.env.BRAVE_CDP_HOST || '127.0.0.1';
let PORT = Number(process.env.BRAVE_CDP_PORT || 9222);
let BASE = `http://${HOST}:${PORT}`;

function setPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`bad port: ${p}`);
  PORT = n;
  BASE = `http://${HOST}:${PORT}`;
}
const STATE_DIR = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'brave-cdp');
const STATE_FILE = path.join(STATE_DIR, 'current.json');
const DEFAULT_TIMEOUT = Number(process.env.BRAVE_CDP_TIMEOUT || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every open CDP socket, so the process can never linger on a forgotten one. */
const LIVE = new Set();

/**
 * Remediation text for a closed port, resolved lazily so it names the port the
 * caller actually targeted (`--port` / BRAVE_CDP_PORT), not the default.
 * @returns the multi-line hint to write to stderr.
 */
function hintDown() {
  return [
    `Brave is not exposing CDP on ${BASE}.`,
    `Fix: keep --remote-debugging-port=${PORT} in the Brave launcher's flag file`,
    `(~/.config/brave-flags.conf for the Arch brave-bin wrapper) and restart Brave;`,
    `the port only opens at startup. Check with: curl ${BASE}/json/version`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────── CDP transport

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async open() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`WebSocket open timeout: ${this.wsUrl}`)), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`WebSocket error: ${this.wsUrl}`)); }, { once: true });
      ws.addEventListener('close', () => { clearTimeout(t); reject(new Error(`WebSocket closed before open: ${this.wsUrl}`)); }, { once: true });
    });
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    LIVE.add(this);
    ws.addEventListener('close', () => {
      this.closed = true;
      LIVE.delete(this);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed')); }
      this.pending.clear();
    });
    return this;
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else resolve(msg.result);
      return;
    }
    if (this.onEvent) this.onEvent(msg);
  }

  send(method, params = {}, timeout = DEFAULT_TIMEOUT) {
    if (this.closed || !this.ws) return Promise.reject(new Error('CDP connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    LIVE.delete(this);
    try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
  }
}

async function fetchJson(url, timeout = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** Page targets only, in /json/list order (stable enough to use as indices). */
async function listTargets() {
  const list = await fetchJson(`${BASE}/json/list`);
  return list.filter((t) => t.type === 'page');
}

async function browserInfo() {
  return fetchJson(`${BASE}/json/version`);
}

// ──────────────────────────────────────────────────────────────── tab selection

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeState(patch) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }));
  } catch { /* best effort */ }
}

function shortUrl(u, n = 80) {
  const s = String(u || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Pick a tab from a selector: "2", "t2", id prefix, or url/title substring. */
function pickTarget(targets, sel) {
  const raw = String(sel).trim();
  const idxMatch = raw.match(/^t?(\d+)$/i);
  if (idxMatch) {
    const i = Number(idxMatch[1]) - 1;
    if (i < 0 || i >= targets.length) throw new Error(`no tab #${raw} (have ${targets.length})`);
    return targets[i];
  }
  const byId = targets.find((t) => t.id === raw || t.id.startsWith(raw));
  if (byId) return byId;
  const hits = targets.filter((t) => (t.url || '').includes(raw) || (t.title || '').includes(raw));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new Error(`ambiguous tab "${raw}": ${hits.map((t) => `${t.id.slice(0, 8)}=${shortUrl(t.title, 40)}`).join(' | ')}`);
  }
  throw new Error(`no tab matching "${raw}"`);
}

/** The tab the user is looking at: visibilityState is only "visible" for it. */
async function probeVisible(targets) {
  const results = await Promise.all(targets.map(async (t) => {
    let c;
    try {
      c = await new Cdp(t.webSocketDebuggerUrl).open();
      const r = await c.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, 3000);
      return { t, state: r.result && r.result.value };
    } catch {
      return { t, state: null };
    } finally {
      if (c) c.close();
    }
  }));
  const hit = results.find((r) => r.state === 'visible');
  return hit ? hit.t : null;
}

async function resolveTarget(sel) {
  const targets = await listTargets();
  if (!targets.length) throw new Error('Brave exposes no page targets');
  if (sel) {
    const t = pickTarget(targets, sel);
    writeState({ current: t.id });
    return t;
  }
  const st = readState();
  const remembered = st.current && targets.find((t) => t.id === st.current);
  if (remembered) return remembered;
  const visible = await probeVisible(targets);
  const pick = visible || targets[0];
  writeState({ current: pick.id });
  return pick;
}

async function attach(sel) {
  const target = await resolveTarget(sel);
  const page = await new Cdp(target.webSocketDebuggerUrl).open();
  await page.send('Page.enable').catch(() => {});
  await page.send('Runtime.enable').catch(() => {});
  return { page, target };
}

// ───────────────────────────────────────────────────────────── page evaluation

function describeException(details) {
  const ex = details.exception;
  if (ex && ex.description) return ex.description.split('\n')[0];
  return details.text || 'JavaScript exception';
}

async function evaluate(page, expression, opts = {}) {
  const { awaitPromise = true, userGesture = true, timeout = DEFAULT_TIMEOUT } = opts;
  const res = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture,
    includeCommandLineAPI: true,
    replMode: false,
  }, timeout);
  if (res.exceptionDetails) throw new Error(describeException(res.exceptionDetails));
  const r = res.result || {};
  if (r.type === 'undefined') return undefined;
  if (Object.prototype.hasOwnProperty.call(r, 'value')) return r.value;
  if (r.unserializableValue !== undefined) return r.unserializableValue;
  return r.description;
}

async function currentUrl(page) {
  return evaluate(page, 'location.href');
}

async function waitForLoad(page, timeout = DEFAULT_TIMEOUT, settleMs = 120) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = await evaluate(page, 'document.readyState', { timeout: 5000 });
      if (last === 'complete') { await sleep(settleMs); return; }
    } catch { /* navigation in flight tears down the context */ }
    await sleep(100);
  }
  throw new Error(`page did not finish loading within ${timeout}ms (readyState=${last || 'unknown'})`);
}

// ──────────────────────────────────────────────────────────────── DOM helpers

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
  '[role="tab"]', '[role="menuitem"]', '[role="combobox"]', '[role="searchbox"]',
  '[role="textbox"]', '[role="option"]', '[contenteditable=""]', '[contenteditable="true"]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
].join(',');

const SNAPSHOT_JS = `(() => {
  const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  for (const el of document.querySelectorAll('[data-bravecdp-ref]')) el.removeAttribute('data-bravecdp-ref');
  const items = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    seen.add(el);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1) continue;
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute('role') || '';
    if (!role) {
      if (tag === 'a') role = 'link';
      else if (tag === 'button') role = 'button';
      else if (tag === 'select') role = 'combobox';
      else if (tag === 'textarea') role = 'textbox';
      else if (tag === 'summary') role = 'button';
      else if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        role = t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio'
             : t === 'submit' || t === 'button' || t === 'reset' ? 'button'
             : t === 'search' ? 'searchbox' : 'textbox';
      } else if (el.isContentEditable) role = 'textbox';
      else role = tag;
    }
    const labelText = el.labels && el.labels.length ? norm(el.labels[0].innerText) : '';
    const isChoice = el.type === 'checkbox' || el.type === 'radio';
    let name = norm(el.getAttribute('aria-label')
      || (el.getAttribute('aria-labelledby') && norm((document.getElementById(el.getAttribute('aria-labelledby')) || {}).innerText))
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || labelText
      || (tag === 'input' && (el.type === 'submit' || el.type === 'button' || el.type === 'reset') ? el.value : '')
      || (tag === 'a' || tag === 'button' || tag === 'summary' || el.isContentEditable ? el.innerText : '')
      || (isChoice ? '' : el.value)
      || el.getAttribute('name')
      || '');
    const ref = 'e' + (items.length + 1);
    el.setAttribute('data-bravecdp-ref', ref);
    items.push({
      ref, tag, role,
      name: name.slice(0, 120),
      type: el.getAttribute('type') || undefined,
      value: (!isChoice && el.value !== undefined && el.value !== '' && String(el.value).length < 120) ? String(el.value) : undefined,
      checked: el.checked === true || el.getAttribute('aria-checked') === 'true' ? true : undefined,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' ? true : undefined,
      href: el.getAttribute('href') || undefined,
      editable: el.isContentEditable || undefined,
    });
  }
  return { url: location.href, title: document.title, count: items.length, items };
})()`;

/** Resolve a CSS selector / @ref / text to a ref-bearing element, and return a selector. */
async function resolveElement(page, spec, opts = {}) {
  const { text = null, exact = false, allowText = true } = opts;
  if (text !== null) {
    const ref = await evaluate(page, `(() => {
      const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      const want = ${JSON.stringify(String(text))};
      const exact = ${exact ? 'true' : 'false'};
      const nodes = [...document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})];
      const hits = nodes
        .map((el) => ({ el, t: norm(el.innerText || el.value || ''), r: el.getBoundingClientRect() }))
        .filter((x) => x.t && x.r.width > 0 && x.r.height > 0 && (exact ? x.t === want : x.t.includes(want)))
        .sort((a, b) => a.t.length - b.t.length);
      if (!hits.length) return null;
      const el = hits[0].el;
      el.setAttribute('data-bravecdp-ref', 'tmp');
      return 'tmp';
    })()`);
    if (!ref) throw new Error(`no visible element matching text ${JSON.stringify(String(text))}`);
    return '[data-bravecdp-ref="tmp"]';
  }
  const raw = String(spec || '');
  if (!raw) throw new Error('missing element: pass @eN, a CSS selector, or --text');
  if (raw.startsWith('@')) return `[data-bravecdp-ref="${raw.slice(1)}"]`;
  if (raw.startsWith('data-bravecdp-ref=')) return `[${raw}]`;
  void allowText;
  return raw;
}

async function elementRect(page, selector) {
  const rect = await evaluate(page, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      found: true,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      w: r.width,
      h: r.height,
      tag: el.tagName.toLowerCase(),
      disabled: el.disabled === true,
      display: cs.display,
      visibility: cs.visibility,
    };
  })()`);
  if (!rect || !rect.found) throw new Error(`element not found: ${selector}`);
  if (!rect.w || !rect.h) throw new Error(`element is not hittable (zero size): ${selector}`);
  return rect;
}

const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
};

function modifierMask(flags) {
  let m = 0;
  if (flags.alt) m |= 1;
  if (flags.ctrl) m |= 2;
  if (flags.meta) m |= 4;
  if (flags.shift) m |= 8;
  return m;
}

// ────────────────────────────────────────────────────────────────── rendering

function trunc(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function printTabHeader(target) {
  process.stderr.write(`tab: ${shortUrl(target.title || '(untitled)', 60)} — ${shortUrl(target.url, 90)}\n`);
}

function formatSnapshot(snap, { compact = false } = {}) {
  const lines = [`${snap.title || '(untitled)'} — ${shortUrl(snap.url, 120)}`, `${snap.count} interactive element(s)`];
  for (const it of snap.items) {
    const extras = [];
    if (it.value) extras.push(`value=${JSON.stringify(trunc(it.value, 40))}`);
    if (it.checked) extras.push('checked');
    if (it.disabled) extras.push('disabled');
    if (it.editable) extras.push('editable');
    if (it.href && !compact) extras.push(`href=${trunc(it.href, 70)}`);
    if (compact && !it.name && !it.value) continue;
    lines.push(`${`@${it.ref}`.padEnd(5)} ${trunc(it.role, 11).padEnd(11)} ${JSON.stringify(trunc(it.name, compact ? 50 : 80))}${extras.length ? `  ${extras.join(' ')}` : ''}`);
  }
  return lines.join('\n');
}

function printTabs(targets, currentId, { json } = {}) {
  if (json) {
    console.log(JSON.stringify(targets.map((t, i) => ({ index: i + 1, id: t.id, title: t.title, url: t.url, current: t.id === currentId })), null, 2));
    return;
  }
  const lines = [];
  targets.forEach((t, i) => {
    const mark = t.id === currentId ? '*' : ' ';
    lines.push(`${mark} ${String(i + 1).padStart(2)}  ${t.id.slice(0, 8)}  ${trunc(t.title || '(untitled)', 44).padEnd(44)}  ${shortUrl(t.url, 90)}`);
  });
  console.log(lines.join('\n'));
}

// ─────────────────────────────────────────────────────────────────── commands

async function cmdStatus(argv, flags) {
  let version;
  try {
    version = await browserInfo();
  } catch {
    const msg = `endpoint  ${BASE}  DOWN\n`;

    process.stderr.write(`${hintDown()}\n`);
    console.log(msg.trimEnd());
    process.exitCode = 1;
    return;
  }
  const targets = await listTargets();
  const st = readState();
  const cur = targets.find((t) => t.id === st.current);
  if (flags.json) {
    console.log(JSON.stringify({
      endpoint: BASE, up: true, browser: version.Browser, protocol: version['Protocol-Version'],
      webSocketDebuggerUrl: version.webSocketDebuggerUrl,
      tabs: targets.map((t, i) => ({ index: i + 1, id: t.id, title: t.title, url: t.url, current: t.id === st.current })),
    }, null, 2));
    return;
  }
  console.log(`brave-cdp ${VERSION}`);
  console.log(`endpoint   ${BASE}  UP`);
  console.log(`browser    ${version.Browser}`);
  console.log(`tabs       ${targets.length}${cur ? `  (current: #${targets.indexOf(cur) + 1} ${shortUrl(cur.title, 40)})` : ''}`);
}

async function cmdTabs(argv, flags) {
  const sub = argv[0] || 'list';
  if (sub === 'list') {
    const targets = await listTargets();
    const st = readState();
    printTabs(targets, st.current, flags);
    return;
  }
  if (sub === 'new') {
    const url = argv[1] || 'about:blank';
    const b = await browserCdp();
    let targetId;
    try { ({ targetId } = await b.send('Target.createTarget', { url })); } finally { b.close(); }
    writeState({ current: targetId });
    console.log(`opened ${url} (${targetId.slice(0, 8)})`);
    return;
  }
  if (sub === 'select') {
    const targets = await listTargets();
    const t = pickTarget(targets, argv[1]);
    writeState({ current: t.id });
    const { page } = await attach(t.id);
    await page.send('Page.bringToFront').catch(() => {});
    page.close();
    console.log(`current: ${trunc(t.title, 60)} — ${shortUrl(t.url, 90)}`);
    return;
  }
  if (sub === 'close') {
    const targets = await listTargets();
    if (targets.length < 2) throw new Error('refusing to close the last tab');
    const t = pickTarget(targets, argv[1] || flags.tab);
    const b = await browserCdp();
    let res;
    try { res = await b.send('Target.closeTarget', { targetId: t.id }); } finally { b.close(); }
    if (res && res.success === false) throw new Error(`could not close ${t.id.slice(0, 8)}`);
    const left = await listTargets();
    const state = readState();
    if (state.current === t.id) writeState({ current: left[0] ? left[0].id : null });
    console.log(`closed ${t.id.slice(0, 8)} ${shortUrl(t.title, 50)}`);
    return;
  }
  throw new Error(`unknown tabs subcommand: ${sub} (list|new|select|close)`);
}

async function browserCdp() {
  const v = await browserInfo();
  return new Cdp(v.webSocketDebuggerUrl).open();
}

async function cmdSnapshot(argv, flags) {
  const { page, target } = await attach(flags.tab);
  try {
    const scope = argv[0] && !argv[0].startsWith('-') ? argv[0] : null;
    const js = scope ? SNAPSHOT_SCOPE_JS(scope) : SNAPSHOT_JS;
    const snap = await evaluate(page, js);
    if (flags.json) console.log(JSON.stringify(snap, null, 2));
    else {
      printTabHeader(target);
      console.log(formatSnapshot(snap, { compact: Boolean(flags.compact) }));
    }
  } finally { page.close(); }
}

/** Snapshot restricted to a CSS subtree. */
function SNAPSHOT_SCOPE_JS(scope) {
  return `(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    if (!root) return { url: location.href, title: document.title, count: 0, items: [], error: 'scope not found: ' + ${JSON.stringify(scope)} };
    const SEL = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
    for (const el of document.querySelectorAll('[data-bravecdp-ref]')) el.removeAttribute('data-bravecdp-ref');
    const items = [];
    for (const el of root.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag);
      const labelText = el.labels && el.labels.length ? norm(el.labels[0].innerText) : '';
      const name = norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || labelText || el.innerText || el.value || '');
      const ref = 'e' + (items.length + 1);
      el.setAttribute('data-bravecdp-ref', ref);
      items.push({ ref, tag, role, name: name.slice(0, 120), value: el.value ? String(el.value).slice(0, 120) : undefined, href: el.getAttribute('href') || undefined });
    }
    return { url: location.href, title: document.title, count: items.length, items };
  })()`;
}

async function cmdClick(argv, flags) {
  const spec = flags.text !== undefined ? null : (argv[0] || flags.selector);
  const { page, target } = await attach(flags.tab);
  try {
    const selector = await resolveElement(page, spec, { text: flags.text !== undefined ? String(flags.text) : null, exact: Boolean(flags.exact) });
    const rect = await elementRect(page, selector);
    const base = { x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y, button: 'none' });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    if (flags.dblclick) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: 2 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, clickCount: 2 });
    }
    await sleep(Number(flags.wait || 120));
    const url = await currentUrl(page).catch(() => '(navigation started)');
    if (flags.json) console.log(JSON.stringify({ clicked: selector, tag: rect.tag, url }, null, 2));
    else {
      printTabHeader(target);
      console.log(`clicked ${rect.tag} ${selector}`);
    }
  } finally { page.close(); }
}

async function cmdFill(argv, flags) {
  const spec = argv[0];
  const text = argv.length > 1 ? argv.slice(1).join(' ') : (flags.text !== undefined ? String(flags.text) : '');
  const { page, target } = await attach(flags.tab);
  try {
    const selector = await resolveElement(page, spec);
    const append = Boolean(flags.append);
    const result = await evaluate(page, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'element not found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      const text = ${JSON.stringify(String(text))};
      if (el.isContentEditable) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        if (!${append ? 'true' : 'false'}) { sel.removeAllRanges(); sel.addRange(range); }
        return { ok: true, kind: 'contenteditable' };
      }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                  : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
      if (!proto) return { ok: false, error: 'not a text field: ' + el.tagName };
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const next = ${append ? 'true' : 'false'} ? String(el.value || '') + text : text;
      desc.set.call(el, next);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, kind: 'form', value: el.value };
    })()`);
    if (!result || !result.ok) throw new Error(`fill failed: ${(result && result.error) || 'unknown'}`);
    if (result.kind === 'contenteditable') {
      await page.send('Input.insertText', { text: String(text) });
    }
    if (flags.json) console.log(JSON.stringify({ filled: selector, ...result, url: await currentUrl(page) }, null, 2));
    else {
      printTabHeader(target);
      console.log(`filled ${selector} = ${JSON.stringify(trunc(text, 60))}`);
    }
  } finally { page.close(); }
}

async function cmdType(argv, flags) {
  const spec = argv.length > 1 && !argv[0].startsWith('--') && argv[0] !== '' ? argv[0] : null;
  // `type hello` means "type into whatever is focused"; `type @e2 hello` targets first.
  const hasTarget = spec && (spec.startsWith('@') || /^[#.[]/.test(spec));
  const text = hasTarget ? argv.slice(1).join(' ') : argv.join(' ');
  const { page, target } = await attach(flags.tab);
  try {
    if (hasTarget) {
      const selector = await resolveElement(page, spec);
      const rect = await elementRect(page, selector);
      const base = { x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 };
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      await sleep(80);
    }
    await page.send('Input.insertText', { text });
    if (flags.json) console.log(JSON.stringify({ typed: text, url: await currentUrl(page) }, null, 2));
    else {
      printTabHeader(target);
      console.log(`typed ${JSON.stringify(trunc(text, 60))}`);
    }
  } finally { page.close(); }
}

async function cmdKey(argv, flags) {
  const name = argv[0];
  if (!name) throw new Error('usage: key <Enter|Tab|Escape|ArrowDown|...> [--ctrl --shift --alt --meta]');
  const def = KEYMAP[name] || (/^[A-Za-z0-9]$/.test(name) ? { key: name, code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name } : null);
  if (!def) throw new Error(`unsupported key: ${name}`);
  const modifiers = modifierMask(flags);
  const { page, target } = await attach(flags.tab);
  try {
    const common = { key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk, modifiers };
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
    if (def.text && !modifiers) await page.send('Input.dispatchKeyEvent', { type: 'char', ...common, text: def.text, unmodifiedText: def.text });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    await sleep(Number(flags.wait || 100));
    if (!flags.json) { printTabHeader(target); console.log(`key ${name}${modifiers ? ` (mods=${modifiers})` : ''}`); }
  } finally { page.close(); }
}

async function cmdEval(argv, flags) {
  let expr = flags.file ? fs.readFileSync(String(flags.file), 'utf8') : argv.join(' ');
  if (expr === '-' || flags.stdin) expr = fs.readFileSync(0, 'utf8');
  if (!expr) throw new Error('usage: eval <javascript> | eval --file script.js | eval - < script.js');
  const { page, target } = await attach(flags.tab);
  try {
    const value = await evaluate(page, expr, { timeout: Number(flags.timeout || DEFAULT_TIMEOUT) });
    if (flags.json || typeof value !== 'string') console.log(JSON.stringify(value, null, 2));
    else console.log(value);
    if (flags.header) printTabHeader(target);
  } finally { page.close(); }
}

async function cmdHtml(argv, flags) {
  const scope = argv[0] || flags.selector || null;
  const wantText = Boolean(flags.text);
  const { page, target } = await attach(flags.tab);
  try {
    const js = `(() => {
      const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document.documentElement'};
      if (!root) return null;
      return ${wantText ? 'root.innerText' : 'root.outerHTML'};
    })()`;
    const out = await evaluate(page, js);
    if (out === null) throw new Error(`element not found: ${scope}`);
    if (flags.json) console.log(JSON.stringify({ url: await currentUrl(page), html: out }, null, 2));
    else { if (flags.header) printTabHeader(target); console.log(out); }
  } finally { page.close(); }
}

async function cmdText(argv, flags) {
  const scope = argv[0] || flags.selector || 'body';
  const { page } = await attach(flags.tab);
  try {
    const out = await evaluate(page, `(() => { const el = document.querySelector(${JSON.stringify(scope)}); return el ? el.innerText : null; })()`);
    if (out === null) throw new Error(`element not found: ${scope}`);
    console.log(out);
  } finally { page.close(); }
}

async function cmdOpen(argv, flags) {
  const url = argv[0];
  if (!url) throw new Error('usage: open <url> [--new]');
  if (flags.new) {
    const b = await browserCdp();
    let targetId;
    try { ({ targetId } = await b.send('Target.createTarget', { url, background: false })); } finally { b.close(); }
    writeState({ current: targetId });
    console.log(`opened ${url} (${targetId.slice(0, 8)})`);
    return;
  }
  const { page } = await attach(flags.tab);
  try {
    await page.send('Page.navigate', { url });
    await waitForLoad(page, Number(flags.timeout || DEFAULT_TIMEOUT));
    const finalUrl = await currentUrl(page);
    const title = await evaluate(page, 'document.title').catch(() => '');
    if (flags.json) console.log(JSON.stringify({ url: finalUrl, title }, null, 2));
    else console.log(`${title || '(untitled)'} — ${shortUrl(finalUrl, 120)}`);
  } finally { page.close(); }
}

async function cmdHistory(argv, flags) {
  const dir = argv[0];
  const delta = dir === 'back' ? -1 : dir === 'forward' ? 1 : null;
  if (delta === null) throw new Error('usage: back | forward');
  const { page } = await attach(flags.tab);
  try {
    const hist = await page.send('Page.getNavigationHistory');
    const entry = hist.entries[hist.currentIndex + delta];
    if (!entry) throw new Error(`no history entry to go ${dir}`);
    await page.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    await waitForLoad(page, Number(flags.timeout || DEFAULT_TIMEOUT));
    console.log(`${dir} -> ${shortUrl(await currentUrl(page), 120)}`);
  } finally { page.close(); }
}

async function cmdReload(argv, flags) {
  const { page } = await attach(flags.tab);
  try {
    await page.send('Page.reload', { ignoreCache: Boolean(flags.hard) });
    await waitForLoad(page, Number(flags.timeout || DEFAULT_TIMEOUT));
    console.log(`reloaded — ${shortUrl(await currentUrl(page), 120)}`);
  } finally { page.close(); }
}

async function cmdShot(argv, flags) {
  const file = argv[0] || 'screenshot.png';
  const { page, target } = await attach(flags.tab);
  try {
    const params = { format: 'png' };
    if (flags.full) {
      const m = await page.send('Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    const { data } = await page.send('Page.captureScreenshot', params, Number(flags.timeout || 60000));
    const out = path.resolve(file);
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    const size = fs.statSync(out).size;
    console.log(`${out} (${(size / 1024).toFixed(0)} KiB) — ${shortUrl(target.url, 90)}`);
  } finally { page.close(); }
}

async function cmdWait(argv, flags) {
  const { page, target } = await attach(flags.tab);
  const timeout = Number(flags.timeout || 15000);
  const deadline = Date.now() + timeout;
  const poll = async (fn, label) => {
    let lastErr = '';
    while (Date.now() < deadline) {
      try { if (await fn()) return true; } catch (e) { lastErr = e.message; }
      await sleep(150);
    }
    throw new Error(`timed out after ${timeout}ms waiting for ${label}${lastErr ? ` (last error: ${lastErr})` : ''}`);
  };
  try {
    if (argv[0] && /^\d+$/.test(argv[0])) { await sleep(Number(argv[0])); return; }
    if (argv[0] && argv[0].startsWith('@')) {
      await poll(async () => (await evaluate(page, `!!document.querySelector(${JSON.stringify(`[data-bravecdp-ref="${argv[0].slice(1)}"]`)})`)) === true, `element ${argv[0]}`);
    } else if (flags.selector) {
      await poll(async () => (await evaluate(page, `!!document.querySelector(${JSON.stringify(String(flags.selector))})`)) === true, `selector ${flags.selector}`);
    } else if (flags.text) {
      await poll(async () => String(await evaluate(page, 'document.body ? document.body.innerText : ""')).includes(String(flags.text)), `text ${JSON.stringify(String(flags.text))}`);
    } else if (flags.url) {
      const pat = String(flags.url);
      await poll(async () => String(await currentUrl(page)).includes(pat.replace(/\*/g, '')), `url ${pat}`);
    } else if (flags.load) {
      await poll(async () => (await evaluate(page, 'document.readyState')) === 'complete', 'load');
    } else {
      throw new Error('usage: wait <ms> | wait @eN | wait --selector S | wait --text T | wait --url U | wait --load');
    }
    console.log(`ok — ${shortUrl(target.url, 100)}`);
  } finally { page.close(); }
}

// ──────────────────────────────────────────────────────────────────── dispatch

const VALUE_FLAGS = new Set([
  'tab', 'port', 'timeout', 'text', 'selector', 'url', 'file', 'wait', 'depth', 'name', 'format', 'scope',
]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (/^-[A-Za-z]$/.test(a)) { flags[a.slice(1)] = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1; }
      else flags[key] = true;
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

function shellSplit(line) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const COMMANDS = {
  status: cmdStatus,
  tabs: cmdTabs,
  open: cmdOpen,
  nav: cmdOpen,
  snapshot: cmdSnapshot,
  snap: cmdSnapshot,
  click: cmdClick,
  fill: cmdFill,
  type: cmdType,
  key: cmdKey,
  eval: cmdEval,
  html: cmdHtml,
  text: cmdText,
  shot: cmdShot,
  screenshot: cmdShot,
  wait: cmdWait,
  back: cmdHistory,
  forward: cmdHistory,
  reload: cmdReload,
};

async function runOnce(argv) {
  const { positional, flags } = parseArgs(argv);
  const name = positional.shift();
  if (!name || name === 'help' || flags.help) { console.log(usage()); return; }
  if (name === 'version' || flags.version) { console.log(`brave-cdp ${VERSION}`); return; }
  if (name === 'batch') {
    for (const line of positional) {
      if (!line.trim()) continue;
      process.stderr.write(`$ ${line}\n`);
      // eslint-disable-next-line no-await-in-loop
      await runOnce(shellSplit(line));
    }
    return;
  }
  if (name === 'back' || name === 'forward') { await cmdHistory([name], flags); return; }
  const fn = COMMANDS[name];
  if (!fn) throw new Error(`unknown command: ${name}\n\n${usage()}`);
  await fn(positional, flags);
}

function usage() {
  return `brave-cdp ${VERSION} — drive the running Brave over CDP (${BASE})

  status                     endpoint, browser version, tab count
  tabs [list]                list tabs (1-based indices)
  tabs new <url>             open a new tab
  tabs select <n|id|text>    make a tab current
  tabs close <n|id|text>     close a tab
  open <url> [--new]         navigate current tab (--new: new tab)
  back | forward             session history
  reload [--hard]            reload current tab
  snapshot [-i] [--compact]  interactive elements with @eN refs
  click <@eN|css|--text T>   real mouse click
  fill <@eN|css> <text>      set an input/textarea/contenteditable
  type [@eN|css] <text>      insert text (into focused element by default)
  key <Enter|Tab|...>        press a key (--ctrl --shift --alt --meta)
  eval <js>                  evaluate JS, print JSON (--file, or - for stdin)
  html [css] [--text]        outerHTML / innerText of the page or element
  text [css]                 innerText (default body)
  shot [file] [--full]       PNG screenshot
  wait <ms>|@eN|--selector S|--text T|--url U|--load
  batch "cmd" "cmd" ...      run commands in sequence

Global flags: --tab <n|id|url-substr>  --json  --timeout <ms>  --port <n>
Env: BRAVE_CDP_PORT (default 9222), BRAVE_CDP_HOST, BRAVE_CDP_TIMEOUT`;
}

(async () => {
  try {
    const argv = process.argv.slice(2);
    const pi = argv.indexOf('--port');
    if (pi !== -1 && argv[pi + 1]) { setPort(argv[pi + 1]); argv.splice(pi, 2); }
    await runOnce(argv);
    process.exitCode = process.exitCode || 0;
  } catch (err) {
    process.stderr.write(`brave-cdp: ${err.message}\n`);
    if (/ECONNREFUSED|fetch failed|HTTP 4|WebSocket error|no page targets/i.test(err.message)) {
      process.stderr.write(`\n${hintDown()}\n`);
    }
    process.exitCode = 1;
  } finally {
    for (const c of LIVE) c.close();
  }
})();
