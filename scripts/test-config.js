const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { ConfigStore } = require('../src/main/config');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root };
  const events = [];
  const open = (options = {}) => new ConfigStore(app, { onRecovery: e => events.push(e), ...options });
  const store = open();
  const file = path.join(store.getDir(), 'settings.json');
  const read = (p = file) => JSON.parse(fs.readFileSync(p, 'utf8'));
  return { root, open, store, file, read, events };
}

test('first run seeds valid defaults and backups; saves retain the preceding version', t => {
  const f = fixture(t);
  for (const name of fs.readdirSync(f.store.getDir()).filter(n => n.endsWith('.json'))) {
    assert.deepEqual(f.read(path.join(f.store.getDir(), name)), f.read(path.join(f.store.getDir(), name + '.bak')));
  }
  f.store.saveSettings({ revision: 1 });
  f.store.saveSettings({ revision: 2 });
  assert.deepEqual(f.read(), { revision: 2 });
  assert.deepEqual(f.read(f.file + '.bak'), { revision: 1 });
  assert.equal(fs.readdirSync(f.store.getDir()).some(n => n.endsWith('.tmp')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test('replacement never exposes partial JSON and flushes before committing', t => {
  const f = fixture(t);
  f.store.saveSettings({ revision: 1 });
  let flushed = false, observed = false;
  const io = Object.create(fs);
  io.fsyncSync = fd => { flushed = true; fs.fsyncSync(fd); };
  io.renameSync = (from, to) => {
    assert.ok(flushed);
    flushed = false;
    if (to === f.file) {
      observed = true;
      assert.deepEqual(f.read(), { revision: 1 });
      assert.deepEqual(f.read(from), { revision: 2 });
    }
    fs.renameSync(from, to);
  };
  f.open({ io }).saveSettings({ revision: 2 });
  assert.ok(observed);
});

test('damaged primary restores backup, preserves evidence and reports recovery once', t => {
  const f = fixture(t);
  f.store.saveSettings({ revision: 1 });
  f.store.saveSettings({ revision: 2 });
  fs.writeFileSync(f.file, '{broken');
  assert.deepEqual(f.open().getSettings(), { revision: 1 });
  assert.deepEqual(f.read(f.file + '.bak'), { revision: 1 });
  assert.equal(f.events.length, 1);
  assert.equal(fs.readFileSync(f.events[0].preserved, 'utf8'), '{broken');
  f.open();
  assert.equal(f.events.length, 1);
});

test('missing primary restores backup instead of seeding defaults', t => {
  const f = fixture(t);
  f.store.saveSettings({ revision: 1 });
  f.store.saveSettings({ revision: 2 });
  fs.unlinkSync(f.file);
  assert.deepEqual(f.open().getSettings(), { revision: 1 });
  assert.equal(f.events[0].preserved, null);
});

test('valid primary repairs damaged backup and keeps the damaged bytes', t => {
  const f = fixture(t);
  f.store.saveSettings({ revision: 1 });
  fs.writeFileSync(f.file + '.bak', 'broken backup');
  f.open();
  assert.deepEqual(f.read(f.file + '.bak'), { revision: 1 });
  const evidence = fs.readdirSync(f.store.getDir()).find(n => n.startsWith('settings.json.bak.corrupt-'));
  assert.equal(fs.readFileSync(path.join(f.store.getDir(), evidence), 'utf8'), 'broken backup');
});

test('unrecoverable configuration refuses reads and saves without resetting either file', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'broken primary');
  fs.writeFileSync(f.file + '.bak', 'broken backup');
  assert.throws(() => f.open(), /no valid backup/);
  assert.throws(() => f.store.saveSettings({}), /no valid backup/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'broken primary');
  assert.equal(fs.readFileSync(f.file + '.bak', 'utf8'), 'broken backup');
});

test('saving after damage recovers before rotating the backup', t => {
  const f = fixture(t);
  f.store.saveSettings({ revision: 1 });
  f.store.saveSettings({ revision: 2 });
  fs.writeFileSync(f.file, 'broken');
  f.store.saveSettings({ revision: 3 });
  assert.deepEqual(f.read(), { revision: 3 });
  assert.deepEqual(f.read(f.file + '.bak'), { revision: 1 });
});

for (const failure of ['write', 'flush', 'backup-rename', 'primary-rename', 'read']) {
  test(`${failure} failure propagates and leaves the primary intact with no abandoned temp file`, t => {
    const f = fixture(t);
    f.store.saveSettings({ revision: 1 });
    const io = Object.create(fs);
    const broken = f.open({ io });
    const fail = () => { throw Object.assign(new Error('injected disk failure'), { code: failure === 'write' ? 'ENOSPC' : 'EACCES' }); };
    if (failure === 'write') io.writeFileSync = fail;
    if (failure === 'flush') io.fsyncSync = fail;
    if (failure === 'read') io.readFileSync = fail;
    if (failure.endsWith('rename')) io.renameSync = (from, to) => {
      if (to === f.file + (failure === 'backup-rename' ? '.bak' : '')) fail();
      fs.renameSync(from, to);
    };
    assert.throws(() => broken.saveSettings({ revision: 2 }), /injected disk failure/);
    assert.deepEqual(f.read(), { revision: 1 });
    assert.equal(fs.readdirSync(f.store.getDir()).some(n => n.endsWith('.tmp')), false);
  });
}

test('serialization errors leave configuration and backup untouched', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  const backup = fs.readFileSync(f.file + '.bak', 'utf8');
  const circular = {}; circular.self = circular;
  for (const value of [undefined, circular, 1n]) assert.throws(() => f.store.saveSettings(value));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(fs.readFileSync(f.file + '.bak', 'utf8'), backup);
});

test('unchanged saves retain the previous distinct version, including after reopening', t => {
  const f = fixture(t);
  f.store.saveSettings({ revision: 1 });
  f.store.saveSettings({ revision: 2, enabled: true });
  f.open().saveSettings({ enabled: true, revision: 2 });
  assert.deepEqual(f.read(f.file + '.bak'), { revision: 1 });
});

test('structurally invalid JSON recovers and invalid writes leave both copies untouched', t => {
  const f = fixture(t);
  for (const [name, bad] of [['settings.json', null], ['providers.json', {}],
    ['cli-profiles.json', {}], ['workspaces.json', { list: null }],
    ['apps.json', { list: {} }], ['views.json', { global: null }]]) {
    const file = path.join(f.store.getDir(), name);
    const expected = f.read(file + '.bak');
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.deepEqual(f.store.read(name), expected);
    assert.throws(() => f.store.write(name, bad), /Invalid configuration structure/);
    assert.deepEqual(f.read(file), expected);
    assert.deepEqual(f.read(file + '.bak'), expected);
  }
  assert.equal(f.events.length, 6);
});

for (const after of [false, true]) {
  test(`process death ${after ? 'after' : 'before'} primary rename reopens a complete version`, t => {
    const f = fixture(t);
    f.store.saveSettings({ revision: 1 });
    const result = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { ConfigStore } = require(process.argv[1]);
      const target = process.argv[3], io = Object.create(fs);
      const store = new ConfigStore({ getPath: () => process.argv[2] }, { io });
      io.renameSync = (from, to) => {
        if (to === target && process.argv[4] === 'false') process.exit(23);
        fs.renameSync(from, to);
        if (to === target) process.exit(23);
      };
      store.saveSettings({ revision: 2 });
    `, require.resolve('../src/main/config'), f.root, f.file, String(after)], { encoding: 'utf8' });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(f.open().getSettings(), { revision: after ? 2 : 1 });
    assert.deepEqual(f.read(f.file + '.bak'), { revision: 1 });
  });
}
