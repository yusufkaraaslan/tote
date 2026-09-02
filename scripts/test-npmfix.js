#!/usr/bin/env node
// Dependency-free tests for the wizard's self-healing installs: the pure npm
// output detectors and the prefix-fix decision. Run: node scripts/test-npmfix.js
const assert = require('assert');
const N = require('../src/renderer/npmfix.js');

let pass = 0, fail = 0;
const describe = (name, fn) => { console.log('\n' + name); fn(); };
const test = (name, fn) => {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
};

// Real npm 12 output, captured on Manjaro 2026-09-01 (gemini install).
const BLOCKED_GLOBAL = [
  'added 4 packages in 2s',
  'npm warn install-scripts 2 packages had install scripts blocked because they are not covered by allowScripts:',
  'npm warn install-scripts   @github/keytar@7.10.6 (install: node script/install.js || npm run build)',
  'npm warn install-scripts   node-pty@1.0.0 (install: node-gyp rebuild; postinstall: node scripts/post-install.js)',
  'npm warn install-scripts',
  'npm warn install-scripts Run `npm install -g --allow-scripts=@github/keytar,node-pty` to allow these scripts once, or `npm config set allow-scripts=@github/keytar,node-pty --location=user` to allow them for all global installs.',
].join('\r\n');

// Real npm 12 EACCES output, captured on Manjaro 2026-09-01 (codex install).
const EACCES = [
  "npm error   errno: -13,",
  "npm error   code: 'EACCES',",
  "npm error   syscall: 'mkdir',",
  "npm error   path: '/usr/lib/node_modules/@openai'",
  'npm error }',
  'npm error The operation was rejected by your operating system.',
].join('\r\n');

const CLEAN = 'added 2 packages in 3s\r\n';

describe('stripAnsi', () => {
  test('removes SGR color sequences', () => {
    assert.strictEqual(N.stripAnsi('\x1b[33mnpm warn\x1b[0m hi'), 'npm warn hi');
  });
  test('leaves plain text alone', () => {
    assert.strictEqual(N.stripAnsi('plain'), 'plain');
  });
});

describe('blockedScripts', () => {
  test("reads the package list from npm's suggested --allow-scripts flag", () => {
    assert.strictEqual(N.blockedScripts(BLOCKED_GLOBAL), '@github/keytar,node-pty');
  });
  test('falls back to the per-package warning lines when no flag is suggested', () => {
    const noSuggestion = BLOCKED_GLOBAL.split('\r\n').slice(0, 4).join('\r\n');
    assert.strictEqual(N.blockedScripts(noSuggestion), '@github/keytar,node-pty');
  });
  test('per-package fallback dedupes and keeps scoped names whole', () => {
    const twice = [
      'npm warn install-scripts   @scope/pkg@1.0.0 (install: x)',
      'npm warn install-scripts   @scope/pkg@1.0.0 (postinstall: y)',
    ].join('\n');
    assert.strictEqual(N.blockedScripts(twice), '@scope/pkg');
  });
  test('sees through ANSI colouring', () => {
    const coloured = BLOCKED_GLOBAL.replace(/npm warn/g, '\x1b[33mnpm warn\x1b[0m');
    assert.strictEqual(N.blockedScripts(coloured), '@github/keytar,node-pty');
  });
  test('clean output yields null', () => {
    assert.strictEqual(N.blockedScripts(CLEAN), null);
  });
  test('EACCES output yields null', () => {
    assert.strictEqual(N.blockedScripts(EACCES), null);
  });
});

describe('eacces', () => {
  test("matches npm's EACCES error block", () => {
    assert.strictEqual(N.eacces(EACCES), true);
  });
  test('needs the npm error prefix, not just the word EACCES', () => {
    assert.strictEqual(N.eacces('the docs mention EACCES sometimes'), false);
  });
  test('clean output is false', () => {
    assert.strictEqual(N.eacces(CLEAN), false);
  });
  test('blocked-scripts output is false', () => {
    assert.strictEqual(N.eacces(BLOCKED_GLOBAL), false);
  });
});

describe('prefixPlan', () => {
  const base = {
    platform: 'linux',
    writable: false,
    npmrc: 'registry=https://registry.npmjs.org/\n',
    pathEnv: '/home/u/.local/bin:/usr/bin:/bin',
    home: '/home/u',
  };
  test('fixes when unwritable, no custom prefix, ~/.local/bin on PATH', () => {
    assert.deepStrictEqual(N.prefixPlan(base), { fix: true, prefix: '/home/u/.local' });
  });
  test('a missing npmrc reads as no custom prefix', () => {
    assert.strictEqual(N.prefixPlan({ ...base, npmrc: null }).fix, true);
  });
  test('never touches Windows', () => {
    assert.strictEqual(N.prefixPlan({ ...base, platform: 'win32' }).fix, false);
  });
  test('a writable prefix needs no fix', () => {
    assert.strictEqual(N.prefixPlan({ ...base, writable: true }).fix, false);
  });
  test('an existing prefix= line in npmrc is left alone', () => {
    const r = N.prefixPlan({ ...base, npmrc: 'prefix=/opt/custom\n' });
    assert.strictEqual(r.fix, false);
    assert.ok(/npmrc/.test(r.reason));
  });
  test('spaces around = still count as a custom prefix', () => {
    assert.strictEqual(N.prefixPlan({ ...base, npmrc: 'prefix = /opt/custom\n' }).fix, false);
  });
  test('a commented prefix line does not count', () => {
    assert.strictEqual(N.prefixPlan({ ...base, npmrc: '; prefix=/opt/custom\n' }).fix, true);
  });
  test('refuses when ~/.local/bin is not on PATH, and says why', () => {
    const r = N.prefixPlan({ ...base, pathEnv: '/usr/bin:/bin' });
    assert.strictEqual(r.fix, false);
    assert.ok(/PATH/.test(r.reason));
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
