import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/brave-cdp.mjs', import.meta.url));

/** Run the CLI without relying on its shebang or executable bit. */
function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, BRAVE_CDP_PORT: '1' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

test('version prints a semver', async () => {
  const { code, stdout } = await run(['version']);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^brave-cdp \d+\.\d+\.\d+$/);
});

test('help lists the core commands', async () => {
  const { code, stdout } = await run(['help']);
  assert.equal(code, 0);
  for (const command of ['status', 'tabs', 'snapshot', 'click', 'fill', 'key', 'eval', 'shot', 'wait', 'batch']) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`), `help should mention ${command}`);
  }
});

test('an unknown command fails with usage', async () => {
  const { code, stderr } = await run(['definitely-not-a-command']);
  assert.equal(code, 1);
  assert.match(stderr, /unknown command/);
});

test('a closed port is reported as DOWN, with the flag to fix it', async () => {
  const { code, stdout, stderr } = await run(['status']);
  assert.equal(code, 1);
  assert.match(stdout, /DOWN/);
  assert.match(stderr, /remote-debugging-port/);
});
