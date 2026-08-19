#!/usr/bin/env node
// Dependency-free tests for temp ("scratch") spaces: the pure helpers and the
// guarded delete path. Run: node scripts/test-scratch.js
const assert = require('assert');
const S = require('../src/main/scratch.js');

let pass = 0, fail = 0;
const describe = (name, fn) => { console.log('\n' + name); fn(); };
const test = (name, fn) => {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
};

describe('slug', () => {
  test('lowercases and joins words with a dash', () => {
    assert.strictEqual(S.slug('My Scratch Space'), 'my-scratch-space');
  });
  test('collapses punctuation and trims the edges', () => {
    assert.strictEqual(S.slug('  ...api spike!!  '), 'api-spike');
  });
  test('returns empty string when nothing usable is left', () => {
    assert.strictEqual(S.slug('///'), '');
    assert.strictEqual(S.slug(''), '');
    assert.strictEqual(S.slug(null), '');
  });
});

describe('defaultName', () => {
  test('is scratch-<date>-1 when nothing is taken', () => {
    assert.strictEqual(S.defaultName(new Date(2026, 7, 19), []), 'scratch-2026-08-19-1');
  });
  test('skips to the lowest free number', () => {
    const taken = ['scratch-2026-08-19-1', 'scratch-2026-08-19-2'];
    assert.strictEqual(S.defaultName(new Date(2026, 7, 19), taken), 'scratch-2026-08-19-3');
  });
});

describe('uniqueDirName', () => {
  test('returns the base when it is free', () => {
    assert.strictEqual(S.uniqueDirName('spike', () => false), 'spike');
  });
  test('suffixes -2, -3 past occupied names', () => {
    const busy = new Set(['spike', 'spike-2']);
    assert.strictEqual(S.uniqueDirName('spike', (n) => busy.has(n)), 'spike-3');
  });
});

describe('isInsideRoot', () => {
  test('accepts a folder inside the root', () => {
    assert.strictEqual(S.isInsideRoot('/home/u/tote/scratch/a', '/home/u/tote/scratch'), true);
  });
  test('rejects the root itself', () => {
    assert.strictEqual(S.isInsideRoot('/home/u/tote/scratch', '/home/u/tote/scratch'), false);
  });
  test('rejects a sibling sharing the prefix', () => {
    assert.strictEqual(S.isInsideRoot('/home/u/tote/scratch-evil', '/home/u/tote/scratch'), false);
  });
  test('rejects a traversal back out of the root', () => {
    assert.strictEqual(S.isInsideRoot('/home/u/tote/scratch/../../secrets', '/home/u/tote/scratch'), false);
  });
});

describe('isExpired', () => {
  const day = 86400000, now = 1000 * day;
  test('is true past the threshold', () => {
    assert.strictEqual(S.isExpired(now - 8 * day, 7, now), true);
  });
  test('is false exactly at the threshold', () => {
    assert.strictEqual(S.isExpired(now - 7 * day, 7, now), false);
  });
  test('is false when lastUsed is missing', () => {
    assert.strictEqual(S.isExpired(undefined, 7, now), false);
  });
  test('days <= 0 disables the sweep instead of expiring everything', () => {
    assert.strictEqual(S.isExpired(now - 900 * day, 0, now), false);
    assert.strictEqual(S.isExpired(now - 900 * day, -1, now), false);
  });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
