#!/usr/bin/env node
// Dependency-free tests for what the file tree walks and what the watcher binds.
//
// Both answers come out of the same predicate, and getting them wrong is not a
// cosmetic bug: chokidar 4 opens one descriptor per watched path, so a space
// carrying a generated cache runs the main process out of descriptors and the
// first thing that fails is pty allocation -- every agent terminal, while the
// file tree still looks fine. A Unity space did exactly that with 3.9k watches.
//
// Run: node scripts/test-watch.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceManager } = require('../src/main/workspace.js');   // named export

// The same describe/test pair as the other suites, except every case is
// awaited: the file ops under test are async (they dispatch on the space's
// backend), and a fire-and-forget `test()` would report a rejected assertion
// as a pass. Groups are collected first so the output stays grouped even
// though the cases run later.
let pass = 0, fail = 0;
const groups = [];
const describe = (name, fn) => { groups.push({ name, cases: [] }); fn(); };
const test = (name, fn) => groups[groups.length - 1].cases.push({ name, fn });

// A throwaway space whose folder layout each test writes itself. `files` is a
// list of relative paths; a trailing slash means "directory".
function harness(files, rootName = 'space') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-watch-test-'));
  const root = path.join(tmp, rootName);
  fs.mkdirSync(root, { recursive: true });
  for (const f of files) {
    const abs = path.join(root, f);
    if (f.endsWith('/')) fs.mkdirSync(abs, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x');
    }
  }
  let ws = { active: 's', list: [{ id: 's', name: 'Space', path: root }] };
  const cfg = {
    getWorkspaces: () => JSON.parse(JSON.stringify(ws)),
    saveWorkspaces: (d) => { ws = JSON.parse(JSON.stringify(d)); },
    getSettings: () => ({ bridgeDownloads: false }),
    saveSettings: () => {},
  };
  return {
    root, wm: new WorkspaceManager(cfg),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

// Every path the tree contains, as "a/b/c" strings -- what the files pane shows.
const paths = (nodes) =>
  nodes.flatMap((n) => [n.path].concat(n.children ? paths(n.children) : []));

const UNITY = ['Assets/game.cs', 'ProjectSettings/ProjectVersion.txt'];

describe('tree: caches ignored by name', () => {
  test('node_modules and .git never reach the pane', async () => {
    const h = harness(['src/a.js', 'node_modules/dep/index.js', '.git/HEAD']);
    try {
      const p = paths(await h.wm.tree(5));
      assert.ok(p.includes('src/a.js'));
      assert.ok(!p.some((x) => x.startsWith('node_modules')), 'node_modules leaked');
      assert.ok(!p.some((x) => x.startsWith('.git')), '.git leaked');
    } finally { h.cleanup(); }
  });
});

describe('tree: Unity caches ignored by context', () => {
  test('a Unity project loses Library, Temp, Logs and obj', async () => {
    const h = harness([...UNITY, 'Library/deep/artifact.dat', 'Temp/x', 'Logs/log.txt', 'obj/o.o']);
    try {
      const p = paths(await h.wm.tree(5));
      assert.ok(p.includes('Assets/game.cs'), 'Assets must stay');
      assert.ok(p.includes('ProjectSettings/ProjectVersion.txt'), 'ProjectSettings must stay');
      for (const gen of ['Library', 'Temp', 'Logs', 'obj']) {
        assert.ok(!p.some((x) => x.startsWith(gen)), gen + ' leaked into the tree');
      }
    } finally { h.cleanup(); }
  });

  test('the SAME names survive when the folder is not a Unity project', async () => {
    // The whole reason for the marker test: these are ordinary directory names,
    // and hiding somebody's hand-written Library/ or Logs/ would be a silent
    // data-loss-shaped bug -- the file is on disk but unreachable in the pane.
    const h = harness(['Library/src/a.cs', 'Logs/note.md', 'Temp/scratch.txt', 'obj/model.obj']);
    try {
      const p = paths(await h.wm.tree(5));
      assert.ok(p.includes('Library/src/a.cs'), 'source Library was hidden');
      assert.ok(p.includes('Logs/note.md'), 'source Logs was hidden');
      assert.ok(p.includes('Temp/scratch.txt'), 'source Temp was hidden');
      assert.ok(p.includes('obj/model.obj'), 'source obj was hidden');
    } finally { h.cleanup(); }
  });

  test('Assets alone is not a Unity project (ProjectSettings must be there too)', async () => {
    const h = harness(['Assets/img.png', 'Library/keep.txt']);
    try {
      assert.ok(paths(await h.wm.tree(5)).includes('Library/keep.txt'));
    } finally { h.cleanup(); }
  });

  test('a Unity project nested inside the space is still recognised', async () => {
    const h = harness([
      'game/Assets/a.cs', 'game/ProjectSettings/v.txt', 'game/Library/big.dat',
      'docs/Library/note.md',
    ]);
    try {
      const p = paths(await h.wm.tree(5));
      assert.ok(!p.includes('game/Library/big.dat'), "the nested project's cache leaked");
      assert.ok(p.includes('docs/Library/note.md'), 'an unrelated Library was hidden');
    } finally { h.cleanup(); }
  });
});

describe('watchPlan', () => {
  test('reports the depth the tree bottoms out at, uncapped', () => {
    const h = harness(['a/b/c.txt']);
    try {
      const plan = h.wm.watchPlan(h.root);
      assert.strictEqual(plan.capped, false);
      assert.ok(plan.depth >= 2);
    } finally { h.cleanup(); }
  });

  test('caps the depth rather than exceeding the budget', () => {
    const wide = [];
    for (let i = 0; i < 40; i++) for (let j = 0; j < 10; j++) wide.push(`d${i}/e${j}/f.txt`);
    const h = harness(wide);
    try {
      // 40 dirs fit; 40 * 10 nested ones do not.
      const plan = h.wm.watchPlan(h.root, 5, 60);
      assert.strictEqual(plan.capped, true);
      assert.strictEqual(plan.depth, 1);
    } finally { h.cleanup(); }
  });

  test("a Unity project's cache does not count against the budget", () => {
    const files = [...UNITY];
    for (let i = 0; i < 200; i++) files.push(`Library/gen${i}/f.dat`);
    const h = harness(files);
    try {
      const plan = h.wm.watchPlan(h.root, 5, 100);
      assert.strictEqual(plan.capped, false, 'Library was counted');
    } finally { h.cleanup(); }
  });
});

describe('watch', () => {
  const bound = (w) => Object.values(w.getWatched()).reduce((a, b) => a + b.length, 0);

  test('real watcher prunes Unity caches but retains ordinary source directories', async () => {
    const h = harness([
      'game/Assets/game.cs', 'game/ProjectSettings/version.txt',
      'game/Library/cache/deep.dat', 'game/Temp/cache.tmp',
      'docs/Library/keep.txt', 'node_modules/dep/index.js',
    ]);
    let entry;
    try {
      entry = h.wm.watchLocal(h.wm.active(), 100, () => {});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('watcher readiness timed out')), 5000);
        entry.watcher.once('ready', () => { clearTimeout(timer); resolve(); });
        entry.watcher.once('error', error => { clearTimeout(timer); reject(error); });
      });
      const watched = Object.keys(entry.watcher.getWatched()).map(p => path.relative(h.root, p).split(path.sep).join('/'));
      assert.ok(watched.includes('docs/Library'), 'ordinary Library source must be watched');
      assert.ok(watched.includes('game/Assets'), 'Unity source must be watched');
      assert.ok(!watched.some(p => /^(game\/(Library|Temp)|node_modules)(\/|$)/.test(p)), 'generated caches must not bind watchers');
    } finally { if (entry) await entry.close(); h.cleanup(); }
  });

  test('real watcher honors capped depth on a wide tree', async () => {
    const files = [];
    for (let i = 0; i < 20; i++) for (let j = 0; j < 10; j++) files.push(`d${i}/e${j}/deep/file.txt`);
    const h = harness(files);
    let entry;
    try {
      assert.equal(h.wm.watchPlan(h.root, 5, 30).depth, 1);
      entry = h.wm.watchLocal(h.wm.active(), 30, () => {});
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('watcher readiness timed out')), 5000);
        entry.watcher.once('ready', () => { clearTimeout(timer); resolve(); });
        entry.watcher.once('error', error => { clearTimeout(timer); reject(error); });
      });
      // Boundary directories are tracked with empty child lists, without handles.
      const directories = Object.entries(entry.watcher.getWatched()).filter(([, children]) => children.length).map(([dir]) => dir);
      assert.ok(directories.length <= 22, `depth cap bound ${directories.length} directories`);
      assert.ok(!directories.some(p => path.relative(h.root, p).split(path.sep).includes('deep')));
    } finally { if (entry) await entry.close(); h.cleanup(); }
  });

  test('binds the space even when its own folder is named like a cache', async () => {
    // chokidar hands the root itself to `ignored`, so without the p !== root
    // exemption a space living in a folder called `dist` or `out` watches
    // nothing at all and its tree silently stops refreshing.
    const h = harness(['a/f.txt'], 'dist');
    try {
      await h.wm.watchSpaces(['s'], () => {});
      const { watcher } = h.wm.watchers.get('s');
      await new Promise((r) => watcher.on('ready', r));
      assert.ok(bound(watcher) > 0, 'nothing was watched');
      await h.wm.watchSpaces([], () => {});
    } finally { h.cleanup(); }
  });

  test('re-arming a re-pointed space closes the old watcher before binding the new one', async () => {
    // Fire-and-forget held both sets of descriptors open across a space switch,
    // which is the moment the process was already closest to its limit.
    const h = harness(['a/f.txt', 'other/b.txt']);
    try {
      await h.wm.watchSpaces(['s'], () => {});
      const first = h.wm.watchers.get('s').watcher;
      h.wm.updateSpace('s', { path: path.join(h.root, 'other') });
      await h.wm.watchSpaces(['s'], () => {});
      assert.notStrictEqual(h.wm.watchers.get('s').watcher, first, 'the watcher was not replaced');
      assert.strictEqual(first.closed, true, 'the old watcher is still open');
      await h.wm.watchSpaces([], () => {});
    } finally { h.cleanup(); }
  });

  test('an unchanged space keeps its watcher across calls', async () => {
    const h = harness(['a/f.txt']);
    try {
      await h.wm.watchSpaces(['s'], () => {});
      const first = h.wm.watchers.get('s').watcher;
      await h.wm.watchSpaces(['s'], () => {});
      assert.strictEqual(h.wm.watchers.get('s').watcher, first, 'rebound for nothing');
      await h.wm.watchSpaces([], () => {});
      assert.strictEqual(first.closed, true, 'an unwanted space is still watched');
      assert.strictEqual(h.wm.watchers.size, 0);
    } finally { h.cleanup(); }
  });

  test('watcher callbacks retain the space they were created for', async () => {
    const h = harness(['one/x.txt', 'two/y.txt']);
    try {
      h.wm.cfg.saveWorkspaces({ active: 'a', list: [
        { id: 'a', name: 'A', path: path.join(h.root, 'one') },
        { id: 'b', name: 'B', path: path.join(h.root, 'two') },
      ] });
      const callbacks = new Map(), seen = [];
      h.wm.watchLocal = (space, budget, callback) => {
        callbacks.set(space.id, callback);
        return { close: async () => {} };
      };
      await h.wm.watchSpaces(['a', 'b'], id => seen.push(id));
      callbacks.get('b')(); callbacks.get('a')(); callbacks.get('b')();
      assert.deepStrictEqual(seen, ['b', 'a', 'b']);
    } finally { await h.wm.watchSpaces([], () => {}); h.cleanup(); }
  });

  test('two viewed spaces each get a watcher and report a real file change', async () => {
    // Two windows on two spaces of one host: both trees must refresh, and the
    // ping has to say whose it is, because a viewer only refreshes its own.
    const h = harness(['one/x.txt', 'two/y.txt']);
    try {
      h.wm.cfg.saveWorkspaces({ active: 'a', list: [
        { id: 'a', name: 'A', path: path.join(h.root, 'one') },
        { id: 'b', name: 'B', path: path.join(h.root, 'two') },
      ] });
      const seen = [];
      await h.wm.watchSpaces(['a', 'b'], (id) => seen.push(id));
      assert.deepStrictEqual([...h.wm.watchers.keys()].sort(), ['a', 'b']);
      await Promise.all(['a', 'b'].map((id) =>
        new Promise((r) => h.wm.watchers.get(id).watcher.on('ready', r))));
      const created = path.join(h.root, 'two', 'new.txt');
      let observed = false;
      const events = [], errors = [];
      h.wm.watchers.get('b').watcher.on('error', error => errors.push(error.code || error.message));
      h.wm.watchers.get('b').watcher.on('all', (event, file) => {
        events.push({ event, file: path.relative(h.root, file) });
        if (event === 'add' && path.resolve(file) === created) { observed = true; seen.length = 0; }
      });
      fs.writeFileSync(created, 'x');
      // macOS may deliver setup invalidations late, even after `ready`.
      // Wait for this file and its debounced callback, not the first event
      // from either watcher. Exact callback routing is tested above.
      for (let i = 0; i < 100 && !(observed && seen.includes('b')); i++)
        await new Promise((r) => setTimeout(r, 50));
      assert.ok(observed, 'the new file was not observed: ' + JSON.stringify({events, errors, watched: h.wm.watchers.get('b').watcher.getWatched()}));
      assert.ok(seen.includes('b'), 'space b did not refresh');
      assert.ok(seen.every(id => id === 'a' || id === 'b'));
    } finally { await h.wm.watchSpaces([], () => {}); h.cleanup(); }
  });
});

describe('scoped', () => {
  test('a scoped view reads its own space, not the registry active one', async () => {
    const h = harness(['one/only-in-a.txt', 'two/only-in-b.txt']);
    try {
      h.wm.cfg.saveWorkspaces({ active: 'a', list: [
        { id: 'a', name: 'A', path: path.join(h.root, 'one') },
        { id: 'b', name: 'B', path: path.join(h.root, 'two') },
      ] });
      assert.deepStrictEqual(paths(await h.wm.scoped('b').tree(2)), ['only-in-b.txt']);
      assert.deepStrictEqual(paths(await h.wm.tree(2)), ['only-in-a.txt']);
      assert.strictEqual(h.wm.scoped('b').localCwd(), path.join(h.root, 'two'));
    } finally { h.cleanup(); }
  });

  test('the path-escape guard still holds inside a scoped view', async () => {
    const h = harness(['f.txt']);
    try {
      assert.throws(() => h.wm.scoped('s').resolveSafe('../../etc/passwd'), /escapes/);
    } finally { h.cleanup(); }
  });

  test('a scoped view never writes state back onto the manager', async () => {
    const h = harness(['f.txt']);
    try {
      const v = h.wm.scoped('s');
      v.active = () => null;                       // shadowing on the view only
      assert.strictEqual(h.wm.active().id, 's');
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
