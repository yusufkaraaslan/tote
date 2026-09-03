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

/* ---- WorkspaceManager against real folders in a throwaway home ---- */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceManager } = require('../src/main/workspace.js');   // named export, not default

// The real ConfigStore reads JSON off disk on every call, so the fake hands out
// a deep copy each time -- otherwise a test would pass on shared mutation that
// the real store would have dropped.
function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-scratch-test-'));
  const home = path.join(tmp, 'home');
  const globalDir = path.join(home, 'tote', 'workspace');
  fs.mkdirSync(globalDir, { recursive: true });
  let ws = { active: 'global', list: [{ id: 'global', name: 'Global', path: globalDir }] };
  let settings = { bridgeDownloads: false, scratchRoot: path.join(home, 'tote', 'scratch'), scratchDays: 7 };
  const cfg = {
    getWorkspaces: () => JSON.parse(JSON.stringify(ws)),
    saveWorkspaces: (d) => { ws = JSON.parse(JSON.stringify(d)); },
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    saveSettings: (d) => { settings = d; },
  };
  return {
    tmp, home, cfg, wm: new WorkspaceManager(cfg), state: () => ws,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('addTemp', () => {
  test('creates the folder, its inbox, and a temp entry', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('API spike');
      const entry = h.state().list.find((w) => w.id === id);
      assert.strictEqual(entry.temp, true);
      assert.strictEqual(entry.name, 'API spike');
      assert.strictEqual(path.basename(entry.path), 'api-spike');
      assert.ok(Number.isFinite(entry.lastUsed));
      assert.ok(fs.existsSync(path.join(entry.path, 'inbox')));
    } finally { h.cleanup(); }
  });

  test('never reuses an occupied folder', () => {
    const h = harness();
    try {
      const a = h.wm.addTemp('spike');
      const b = h.wm.addTemp('spike');
      const paths = h.state().list.filter((w) => w.temp).map((w) => w.path);
      assert.notStrictEqual(a, b);
      assert.strictEqual(new Set(paths).size, 2);
      assert.ok(paths.some((p) => path.basename(p) === 'spike-2'));
    } finally { h.cleanup(); }
  });

  test('rejects a name with nothing usable in it', () => {
    const h = harness();
    try {
      assert.throws(() => h.wm.addTemp('///'), /name/i);
    } finally { h.cleanup(); }
  });
});

describe('suggestTempName', () => {
  test('skips a name already registered', () => {
    const h = harness();
    try {
      const first = h.wm.suggestTempName(new Date(2026, 7, 19));
      h.wm.addTemp(first);
      assert.strictEqual(h.wm.suggestTempName(new Date(2026, 7, 19)), 'scratch-2026-08-19-2');
    } finally { h.cleanup(); }
  });
});

describe('setActive', () => {
  test('stamps lastUsed on a temp space', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const before = h.state().list.find((w) => w.id === id).lastUsed - 60000;
      const data = h.state();
      data.list.find((w) => w.id === id).lastUsed = before;
      h.cfg.saveWorkspaces(data);
      h.wm.setActive(id);
      assert.ok(h.state().list.find((w) => w.id === id).lastUsed > before);
    } finally { h.cleanup(); }
  });

  test('leaves a normal space untouched', () => {
    const h = harness();
    try {
      h.wm.setActive('global');
      assert.strictEqual('lastUsed' in h.state().list.find((w) => w.id === 'global'), false);
    } finally { h.cleanup(); }
  });
});

describe('discardTemp', () => {
  test('deletes the folder and unregisters the space', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const dir = h.state().list.find((w) => w.id === id).path;
      fs.writeFileSync(path.join(dir, 'note.txt'), 'bye');
      h.wm.discardTemp(id);
      assert.strictEqual(fs.existsSync(dir), false);
      assert.strictEqual(h.state().list.some((w) => w.id === id), false);
    } finally { h.cleanup(); }
  });

  test('falls the active space back when the discarded one was active', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      h.wm.setActive(id);
      h.wm.discardTemp(id);
      assert.strictEqual(h.state().active, 'global');
    } finally { h.cleanup(); }
  });

  test('refuses a normal space and leaves its files alone', () => {
    const h = harness();
    try {
      const dir = h.state().list.find((w) => w.id === 'global').path;
      assert.throws(() => h.wm.discardTemp('global'), /temp/i);
      assert.strictEqual(fs.existsSync(dir), true);
    } finally { h.cleanup(); }
  });

  test('refuses a temp entry whose path was edited to point outside the root', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const outside = path.join(h.tmp, 'precious');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
      const data = h.state();
      data.list.find((w) => w.id === id).path = outside;   // hand-edited JSON
      h.cfg.saveWorkspaces(data);
      assert.throws(() => h.wm.discardTemp(id), /scratch root/i);
      assert.strictEqual(fs.existsSync(path.join(outside, 'keep.txt')), true);
    } finally { h.cleanup(); }
  });

  test('refuses a symlink inside the root that points outside it', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const entry = h.state().list.find((w) => w.id === id);
      const outside = path.join(h.tmp, 'precious2');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
      fs.rmSync(entry.path, { recursive: true, force: true });
      fs.symlinkSync(outside, entry.path);
      assert.throws(() => h.wm.discardTemp(id), /scratch root/i);
      assert.strictEqual(fs.existsSync(path.join(outside, 'keep.txt')), true);
    } finally { h.cleanup(); }
  });

  test('refuses to remove the last remaining space', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const data = h.state();
      data.list = data.list.filter((w) => w.id === id);
      data.active = id;
      h.cfg.saveWorkspaces(data);
      assert.throws(() => h.wm.discardTemp(id), /at least one/i);
    } finally { h.cleanup(); }
  });

  test('unregisters cleanly when the folder is already gone', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      fs.rmSync(h.state().list.find((w) => w.id === id).path, { recursive: true, force: true });
      h.wm.discardTemp(id);
      assert.strictEqual(h.state().list.some((w) => w.id === id), false);
    } finally { h.cleanup(); }
  });
});

describe('measure', () => {
  test('counts files and bytes below a folder', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const dir = h.state().list.find((w) => w.id === id).path;
      fs.writeFileSync(path.join(dir, 'a.txt'), '12345');
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), '123');
      const { files, bytes } = h.wm.measure(dir);
      assert.strictEqual(files, 2);
      assert.strictEqual(bytes, 8);
    } finally { h.cleanup(); }
  });
});

describe('promote', () => {
  test('moves the folder, keeps the id, and clears the temp fields', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const from = h.state().list.find((w) => w.id === id).path;
      fs.writeFileSync(path.join(from, 'work.txt'), 'keep me');
      const to = path.join(h.tmp, 'projects', 'spike');
      h.wm.promote(id, to);
      const entry = h.state().list.find((w) => w.id === id);
      assert.strictEqual(entry.path, to);
      assert.strictEqual('temp' in entry, false);
      assert.strictEqual('lastUsed' in entry, false);
      assert.strictEqual(fs.readFileSync(path.join(to, 'work.txt'), 'utf8'), 'keep me');
      assert.strictEqual(fs.existsSync(from), false);
    } finally { h.cleanup(); }
  });

  test('refuses a target inside the scratch root', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const inside = path.join(h.wm.scratchRoot(), 'kept');
      assert.throws(() => h.wm.promote(id, inside), /scratch root/i);
    } finally { h.cleanup(); }
  });

  test('refuses a non-empty target', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const to = path.join(h.tmp, 'busy');
      fs.mkdirSync(to, { recursive: true });
      fs.writeFileSync(path.join(to, 'existing.txt'), 'x');
      assert.throws(() => h.wm.promote(id, to), /not empty/i);
    } finally { h.cleanup(); }
  });

  test('accepts the empty folder a picker just created', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('spike');
      const to = path.join(h.tmp, 'fresh');
      fs.mkdirSync(to, { recursive: true });
      h.wm.promote(id, to);
      assert.strictEqual(h.state().list.find((w) => w.id === id).path, to);
    } finally { h.cleanup(); }
  });

  test('refuses a normal space', () => {
    const h = harness();
    try {
      assert.throws(() => h.wm.promote('global', path.join(h.tmp, 'x')), /temp/i);
    } finally { h.cleanup(); }
  });
});

describe('sweepTemp', () => {
  const day = 86400000;
  test('removes only the spaces past the threshold', () => {
    const h = harness();
    try {
      const stale = h.wm.addTemp('old');
      const fresh = h.wm.addTemp('new');
      const data = h.state();
      data.list.find((w) => w.id === stale).lastUsed = Date.now() - 30 * day;
      h.cfg.saveWorkspaces(data);
      const removed = h.wm.sweepTemp(7, Date.now());
      assert.strictEqual(removed.length, 1);
      assert.strictEqual(removed[0].name, 'old');
      assert.strictEqual(h.state().list.some((w) => w.id === stale), false);
      assert.strictEqual(h.state().list.some((w) => w.id === fresh), true);
    } finally { h.cleanup(); }
  });

  test('never touches a normal space, however old', () => {
    const h = harness();
    try {
      const removed = h.wm.sweepTemp(1, Date.now() + 900 * day);
      assert.deepStrictEqual(removed, []);
      assert.strictEqual(h.state().list.some((w) => w.id === 'global'), true);
    } finally { h.cleanup(); }
  });

  test('days <= 0 disables it', () => {
    const h = harness();
    try {
      const id = h.wm.addTemp('old');
      const data = h.state();
      data.list.find((w) => w.id === id).lastUsed = Date.now() - 900 * day;
      h.cfg.saveWorkspaces(data);
      assert.deepStrictEqual(h.wm.sweepTemp(0, Date.now()), []);
      assert.strictEqual(h.state().list.some((w) => w.id === id), true);
    } finally { h.cleanup(); }
  });
});

describe('reorder', () => {
  const three = (h) => {
    const a = h.wm.addTemp('a'), b = h.wm.addTemp('b');
    return ['global', a, b];
  };

  test('applies the given order', () => {
    const h = harness();
    try {
      const [g, a, b] = three(h);
      h.wm.reorder([b, g, a]);
      assert.deepStrictEqual(h.state().list.map((w) => w.id), [b, g, a]);
    } finally { h.cleanup(); }
  });

  test('keeps a space the caller did not name, at the end', () => {
    const h = harness();
    try {
      const [g, a, b] = three(h);
      h.wm.reorder([b, g]);
      assert.deepStrictEqual(h.state().list.map((w) => w.id), [b, g, a]);
    } finally { h.cleanup(); }
  });

  test('ignores unknown and duplicate ids', () => {
    const h = harness();
    try {
      const [g, a, b] = three(h);
      h.wm.reorder([b, 'gone', b, a, g]);
      assert.deepStrictEqual(h.state().list.map((w) => w.id), [b, a, g]);
    } finally { h.cleanup(); }
  });

  test('leaves the active space and every entry field alone', () => {
    const h = harness();
    try {
      const [g, a, b] = three(h);
      const before = h.state().list.find((w) => w.id === a);
      h.wm.reorder([b, a, g]);
      assert.strictEqual(h.state().active, g);
      assert.deepStrictEqual(h.state().list.find((w) => w.id === a), before);
    } finally { h.cleanup(); }
  });

  test('a missing or empty list is a no-op', () => {
    const h = harness();
    try {
      const ids = three(h);
      h.wm.reorder();
      h.wm.reorder([]);
      assert.deepStrictEqual(h.state().list.map((w) => w.id), ids);
    } finally { h.cleanup(); }
  });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
