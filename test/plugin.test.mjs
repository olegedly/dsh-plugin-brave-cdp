import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, root), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('declares the bundle patch it ships', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(new URL('cordis.patch.yml', root)));
});

test('the bundle patch mounts a row named after the package', () => {
  assert.match(read('cordis.patch.yml'), new RegExp(`name: '${pkg.name}'`));
});

test('ships the CLI it wraps', () => {
  assert.ok(pkg.files.includes('bin'), 'bin must be in files so npm pack keeps it');
  const cli = new URL('bin/brave-cdp.mjs', root);
  assert.ok(fs.statSync(cli).mode & 0o111, 'bin/brave-cdp.mjs should be executable');
  assert.match(read('bin/brave-cdp.mjs').split('\n')[0], /^#!\/usr\/bin\/env node/);
});

test('the plugin module is syntactically valid', () => {
  execFileSync(process.execPath, ['--check', fileURLToPath(new URL('lib/index.js', root))]);
});

test('the default CLI path resolves inside this package', () => {
  assert.match(read('lib/index.js'), /new URL\('\.\.\/bin\/brave-cdp\.mjs', import\.meta\.url\)/);
});
