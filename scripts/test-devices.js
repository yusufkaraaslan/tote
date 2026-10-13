#!/usr/bin/env node
// Dependency-free tests for the host/viewer split (devices design, phase 2):
// the host never loads electron, every IPC channel is classified, sessions
// replay correctly to a late viewer, and each viewer keeps its own space.
//
// Run: node scripts/test-devices.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CH = require('../src/host/channels');
const { Sessions } = require('../src/host/sessions');
const { Host } = require('../src/host/host');
const { WorkspaceManager } = require('../src/main/workspace');

// Same awaited describe/test pair as test-watch.js: several cases are async.
let pass = 0, fail = 0;
const groups = [];
const describe = (name, fn) => { groups.push({ name, cases: [] }); fn(); };
const test = (name, fn) => groups[groups.length - 1].cases.push({ name, fn });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/* ----- fakes ----- */

// A PtyManager stand-in: launch() hands back an id and keeps the callbacks so a
// test can play the pty's part.
function fakePtys() {
  const procs = new Map();
  let next = 1;
  return {
    procs,
    available: () => ({ ok: true }),
    launch(spec, sender, onData, onExit) {
      const id = next++;
      procs.set(id, { spec, onData, onExit, written: [], size: [spec.cols, spec.rows], killed: false });
      return id;
    },
    write(id, d) { procs.get(id).written.push(d); },
    resize(id, c, r) { procs.get(id).size = [c, r]; },
    kill(id) { procs.get(id).killed = true; },
    out(id, d) { procs.get(id).onData(d); },
    exit(id, code) { procs.get(id).onExit(code); },
  };
}

// A viewer that records what it was sent.
function recorder() {
  const got = [];
  return { got, send: (ev, payload) => got.push([ev, payload]),
           data: (sid) => got.filter(([e, p]) => e === 'pty:data' && p.id === sid).map(([, p]) => p.data).join('') };
}

function hostHarness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-devices-test-'));
  for (const d of ['one', 'two']) {
    fs.mkdirSync(path.join(tmp, d), { recursive: true });
    fs.writeFileSync(path.join(tmp, d, 'only-in-' + d + '.txt'), 'x');
  }
  let ws = { active: 'a', list: [
    { id: 'a', name: 'A', path: path.join(tmp, 'one') },
    { id: 'b', name: 'B', path: path.join(tmp, 'two') },
  ] };
  let views = {};
  const cfg = {
    getWorkspaces: () => JSON.parse(JSON.stringify(ws)),
    saveWorkspaces: (d) => { ws = JSON.parse(JSON.stringify(d)); },
    getSettings: () => ({}),
    getViews: () => views,
    saveViews: (v) => { views = v; },
    getCliProfiles: () => [{ id: 'sh', name: 'Shell', command: '' }],
    saveCliProfiles: () => {},
  };
  const ptys = fakePtys();
  const wm = new WorkspaceManager(cfg);
  wm.watchSpaces = async () => {};          // no chokidar in these cases
  const host = new Host({ cfg, workspace: wm, ptys, platform: { trash: async () => {} } });
  return { host, ptys, wm, tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/* ----- the host never needs electron ----- */

describe('no electron in the host', () => {
  test('every src/host module loads with electron unresolvable', () => {
    // A child process, so the poisoned resolver cannot leak into this one. The
    // host is what a windowless build would start; one stray require here is
    // the difference between that being a small entry point and a rewrite.
    const files = fs.readdirSync(path.join(ROOT, 'src/host')).filter((f) => f.endsWith('.js'));
    const script = `
      const Module = require('module');
      const orig = Module._resolveFilename;
      Module._resolveFilename = function (req, ...rest) {
        if (req === 'electron') throw new Error('host required electron');
        return orig.call(this, req, ...rest);
      };
      for (const f of ${JSON.stringify(files)}) require(${JSON.stringify(path.join(ROOT, 'src/host'))} + '/' + f);
      process.stdout.write('ok');
    `;
    assert.strictEqual(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }), 'ok');
  });
});

/* ----- the channel table ----- */

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const preloadChannels = () =>
  new Set([...read('src/preload/preload.js').matchAll(/ipcRenderer\.(?:invoke|send|on)\('([^']+)'/g)].map((m) => m[1]));
const mainLiterals = () =>
  new Set([...read('src/main/main.js').matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map((m) => m[1]));
const EVENTS = new Set(['pty:data', 'pty:exit', 'workspace:changed', 'workspaces:changed', 'views:changed',
                        'remote:state', 'workspace:swept', 'download:done', 'win:focus']);

describe('channels', () => {
  test('every channel preload uses is classified (or is an event)', () => {
    const missing = [...preloadChannels()].filter((c) => !EVENTS.has(c) && !CH.kindOf(c));
    assert.deepStrictEqual(missing, [], 'unclassified: ' + missing.join(', '));
  });

  test('every classified channel is reachable from preload', () => {
    const pre = preloadChannels();
    const dead = [...CH.HOST, ...CH.VIEWER, ...CH.SPLIT].filter((c) => !pre.has(c));
    assert.deepStrictEqual(dead, [], 'no wrapper for: ' + dead.join(', '));
  });

  test('main.js registers exactly the viewer and split channels by hand', () => {
    const lit = mainLiterals();
    const want = new Set([...CH.VIEWER, ...CH.SPLIT]);
    assert.deepStrictEqual([...lit].filter((c) => !want.has(c)), [], 'host channel handled in main.js');
    assert.deepStrictEqual([...want].filter((c) => !lit.has(c)), [], 'viewer channel with no handler');
  });

  test('the host method table is exactly HOST + HOST_ONLY', () => {
    const h = hostHarness();
    try {
      const have = new Set(Object.keys(h.host.methods));
      const want = new Set([...CH.HOST, ...CH.HOST_ONLY]);
      assert.deepStrictEqual([...have].filter((m) => !want.has(m)), [], 'method with no classification');
      assert.deepStrictEqual([...want].filter((m) => !have.has(m)), [], 'classified but no method');
    } finally { h.cleanup(); }
  });

  test('the three kinds do not overlap', () => {
    for (const c of CH.HOST) assert.ok(!CH.VIEWER.has(c) && !CH.SPLIT.has(c), c);
    for (const c of CH.VIEWER) assert.ok(!CH.SPLIT.has(c), c);
    for (const c of CH.FIRE) assert.ok(CH.HOST.has(c), c + ' is fire-and-forget but not a host channel');
  });

  test('calling something that is not a host method is refused', async () => {
    const h = hostHarness();
    try {
      h.host.addViewer({ id: 'v', send: () => {} });
      await assert.rejects(h.host.call('settings:save', 'v', []), /Not a host method/);
      await assert.rejects(h.host.call('constructor', 'v', []), /Not a host method/);
      await assert.rejects(h.host.call('__proto__', 'v', []), /Not a host method/);
      await assert.rejects(h.host.call('toString', 'v', []), /Not a host method/);
    } finally { h.cleanup(); }
  });
});

/* ----- sessions ----- */

function sessions() {
  const ptys = fakePtys();
  const viewers = new Map();
  const S = new Sessions(ptys, (v, ev, p) => viewers.get(v) && viewers.get(v).send(ev, p));
  const add = (id) => { const r = recorder(); viewers.set(id, r); return r; };
  return { ptys, S, add };
}
const SPEC = { file: 'sh', args: [], cwd: '/', cols: 80, rows: 24 };

describe('sessions', () => {
  test('the creating viewer gets output from the first byte', () => {
    const { ptys, S, add } = sessions();
    const a = add('a');
    S.spawn({ sid: 's1', meta: { wsId: 'x' }, spec: SPEC, viewerId: 'a' });
    ptys.out(1, 'hello');
    assert.strictEqual(a.data('s1'), 'hello');
  });

  test('a late viewer gets the screen first, then live output, nothing twice', async () => {
    const { ptys, S, add } = sessions();
    add('a');
    const b = add('b');
    S.spawn({ sid: 's1', meta: {}, spec: SPEC, viewerId: 'a' });
    ptys.out(1, 'early line\r\n');
    S.attach('s1', 'b');
    ptys.out(1, 'during replay\r\n');       // arrives before the snapshot is taken
    await tick();
    ptys.out(1, 'after\r\n');
    const got = b.got.filter(([e]) => e === 'pty:data').map(([, p]) => p);
    assert.ok(got[0].replay, 'first thing sent is the replay');
    assert.ok(got[0].data.includes('early line'), 'replay misses earlier output');
    const all = got.map((p) => p.data).join('');
    assert.strictEqual(all.split('during replay').length - 1, 1, 'queued output lost or duplicated');
    assert.ok(all.indexOf('after') > all.indexOf('during replay'), 'order broken');
  });

  test('re-attaching (a reloaded window) replays again', async () => {
    const { ptys, S, add } = sessions();
    const a = add('a');
    S.spawn({ sid: 's1', meta: {}, spec: SPEC, viewerId: 'a' });
    ptys.out(1, 'kept');
    S.attach('s1', 'a');
    await tick();
    const replays = a.got.filter(([e, p]) => e === 'pty:data' && p.replay);
    assert.strictEqual(replays.length, 1);
    assert.ok(replays[0][1].data.includes('kept'));
  });

  test('a dead session stays listed and replays its last screen, then the exit', async () => {
    const { ptys, S, add } = sessions();
    add('a');
    S.spawn({ sid: 's1', meta: {}, spec: SPEC, viewerId: 'a' });
    ptys.out(1, 'why it died');
    ptys.exit(1, 3);
    assert.strictEqual(S.get('s1').alive, false);
    const b = add('b');
    S.attach('s1', 'b');
    await tick();
    const evs = b.got.map(([e]) => e);
    assert.deepStrictEqual(evs, ['pty:data', 'pty:exit']);
    assert.ok(b.got[0][1].data.includes('why it died'));
    assert.strictEqual(b.got[1][1].exitCode, 3);
  });

  test('kill tells every subscriber and forgets the session', () => {
    const { ptys, S, add } = sessions();
    const a = add('a'), b = add('b');
    S.spawn({ sid: 's1', meta: {}, spec: SPEC, viewerId: 'a' });
    S.attach('s1', 'b');
    S.kill('s1');
    assert.ok(ptys.procs.get(1).killed);
    assert.ok(a.got.some(([e]) => e === 'pty:exit'));
    assert.strictEqual(S.get('s1'), null);
    ptys.out(1, 'late');                     // a straggler after the kill goes nowhere
    assert.ok(!a.data('s1').includes('late'));
  });

  test('ids are checked: no junk, no duplicates', () => {
    const { S } = sessions();
    assert.throws(() => S.spawn({ sid: '../x', meta: {}, spec: SPEC }), /Bad session id/);
    assert.throws(() => S.spawn({ sid: '', meta: {}, spec: SPEC }), /Bad session id/);
    S.spawn({ sid: 'ok_1', meta: {}, spec: SPEC });
    assert.throws(() => S.spawn({ sid: 'ok_1', meta: {}, spec: SPEC }), /already exists/);
  });

  test('resize moves the pty and the mirror together', () => {
    const { ptys, S } = sessions();
    S.spawn({ sid: 's1', meta: {}, spec: SPEC });
    S.resize('s1', 120, 40);
    assert.deepStrictEqual(ptys.procs.get(1).size, [120, 40]);
    assert.strictEqual(S.get('s1').cols, 120);
    S.resize('s1', 0, 40);                   // nonsense is ignored
    assert.strictEqual(S.get('s1').cols, 120);
  });
});

describe('terminal reports', () => {
  const { isTermReport } = require('../src/renderer/termreports');
  test('replies to the program\'s queries are recognised', () => {
    for (const r of ['\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[12;40R', '\x1b[0n', '\x1b[?12;2$y',
                     '\x1b[2;1$y', '\x1b]11;rgb:0a0a/0d0d/1313\x07', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
                     '\x1bP1$r0m\x1b\\', '\x1b[8;24;80t']) {
      assert.ok(isTermReport(r), JSON.stringify(r));
    }
  });

  test('keystrokes are never mistaken for one', () => {
    for (const k of ['a', 'hello', '\r', '\n', '\x1b', '\x1b[A', '\x1b[1;3A', '\x1b[1;4B', '\x1b[H',
                     '\x1b[3~', '\x1b[200~pasted\x1b[201~', '\x1bOP', '\x1b[I', '\x1b[O', '\x1b[Z', 'c', '$y']) {
      assert.ok(!isTermReport(k), JSON.stringify(k));
    }
  });

  test('the host mirror answers a query once, whoever is watching', async () => {
    // Two viewers subscribed; the program asks for device attributes. Exactly
    // one reply reaches the pty, and it comes from the host.
    const { ptys, S, add } = sessions();
    add('a'); add('b');
    S.spawn({ sid: 's1', meta: {}, spec: SPEC, viewerId: 'a' });
    S.attach('s1', 'b');
    ptys.out(1, '\x1b[c');
    await tick(50);
    const replies = ptys.procs.get(1).written.filter((w) => isTermReport(w));
    assert.strictEqual(replies.length, 1, JSON.stringify(ptys.procs.get(1).written));
  });
});

/* ----- viewers ----- */

describe('viewers', () => {
  test('two viewers, two spaces: each reads its own', async () => {
    const h = hostHarness();
    try {
      h.host.addViewer({ id: 'v1', send: () => {} });
      h.host.addViewer({ id: 'v2', send: () => {} });
      await h.host.call('workspaces:setActive', 'v2', ['b']);
      const names = async (v) => (await h.host.call('workspace:tree', v, []))
        .map((n) => n.name).filter((n) => n !== 'inbox');
      assert.deepStrictEqual(await names('v1'), ['only-in-one.txt']);
      assert.deepStrictEqual(await names('v2'), ['only-in-two.txt']);
      assert.strictEqual((await h.host.call('workspaces:list', 'v1', [])).active, 'a');
      assert.strictEqual((await h.host.call('workspaces:list', 'v2', [])).active, 'b');
    } finally { h.cleanup(); }
  });

  test('a new terminal starts in the CALLING viewer\'s space', async () => {
    const h = hostHarness();
    try {
      h.host.addViewer({ id: 'v1', send: () => {} });
      h.host.addViewer({ id: 'v2', send: () => {} });
      await h.host.call('workspaces:setActive', 'v2', ['b']);
      await h.host.call('pty:spawn', 'v2', [{ sid: 's1', profileId: 'sh', cols: 80, rows: 24 }]);
      assert.strictEqual(h.ptys.procs.get(1).spec.cwd, path.join(h.tmp, 'two'));
      assert.strictEqual(h.host.sessions.get('s1').wsId, 'b');
    } finally { h.cleanup(); }
  });

  test('removing a space another viewer is in moves that viewer and tells everyone', async () => {
    const h = hostHarness();
    try {
      const r1 = recorder(), r2 = recorder();
      h.host.addViewer({ id: 'v1', send: r1.send });
      h.host.addViewer({ id: 'v2', send: r2.send });
      await h.host.call('workspaces:setActive', 'v2', ['b']);
      await h.host.call('pty:spawn', 'v2', [{ sid: 's1', profileId: 'sh', cols: 80, rows: 24 }]);
      await h.host.call('workspaces:remove', 'v1', ['b']);
      assert.strictEqual((await h.host.call('workspaces:list', 'v2', [])).active, 'a');
      assert.ok(r2.got.some(([e]) => e === 'workspaces:changed'));
      assert.ok(h.ptys.procs.get(1).killed, 'the removed space\'s terminal still runs');
    } finally { h.cleanup(); }
  });

  test('a views save reaches every OTHER viewer', async () => {
    const h = hostHarness();
    try {
      const r1 = recorder(), r2 = recorder();
      h.host.addViewer({ id: 'v1', send: r1.send });
      h.host.addViewer({ id: 'v2', send: r2.send });
      await h.host.call('views:save', 'v1', [{ a: { tabs: [] } }]);
      assert.ok(!r1.got.some(([e]) => e === 'views:changed'), 'echoed back to the saver');
      assert.deepStrictEqual(r2.got.find(([e]) => e === 'views:changed')[1], { a: { tabs: [] } });
    } finally { h.cleanup(); }
  });

  test('a closing viewer stops receiving its terminals\' output', async () => {
    const h = hostHarness();
    try {
      const r1 = recorder();
      h.host.addViewer({ id: 'v1', send: r1.send });
      await h.host.call('pty:spawn', 'v1', [{ sid: 's1', profileId: 'sh', cols: 80, rows: 24 }]);
      h.host.removeViewer('v1');
      h.ptys.out(1, 'nobody home');
      assert.ok(!r1.data('s1').includes('nobody home'));
      assert.ok(h.host.sessions.get('s1').alive, 'closing a window must not kill its agents');
    } finally { h.cleanup(); }
  });

  test('watchers follow the set of viewed spaces', async () => {
    const h = hostHarness();
    try {
      const calls = [];
      h.wm.watchSpaces = async (ids) => { calls.push([...new Set(ids)].sort()); };
      h.host.addViewer({ id: 'v1', send: () => {} });
      h.host.addViewer({ id: 'v2', send: () => {} });
      await h.host.call('workspaces:setActive', 'v2', ['b']);
      h.host.removeViewer('v2');
      assert.deepStrictEqual(calls.at(-2), ['a', 'b']);
      assert.deepStrictEqual(calls.at(-1), ['a']);
    } finally { h.cleanup(); }
  });
});

(async () => {
  for (const g of groups) {
    console.log('\n' + g.name);
    for (const c of g.cases) {
      try { await c.fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + c.name); }
      catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + c.name + '\n      ' + e.message); }
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
