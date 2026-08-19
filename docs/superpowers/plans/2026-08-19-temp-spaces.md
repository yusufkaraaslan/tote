# Temporary (scratch) spaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add spaces that are created without a folder picker, deleted with one confirmed click, promoted to real spaces when the work turns out to matter, and swept when they go stale.

**Architecture:** A temp space is an ordinary space carrying `temp: true` and `lastUsed`, so every existing routing rule (downloads, inbox, terminal `cwd`, watchers, `resolveSafe`) applies unchanged. All pure decisions — slug, default name, collision suffix, containment, expiry — live in a new `src/main/scratch.js` covered by `scripts/test-scratch.js`; the filesystem work lives in `WorkspaceManager`, where a single guarded `discardTemp` is the only code in Tote that deletes user files.

**Tech Stack:** Plain CommonJS in main, vanilla browser JS in the renderer, no bundler, no framework. Tests are dependency-free `node` scripts with a hand-rolled `describe`/`test` pair.

**Spec:** `docs/superpowers/specs/2026-08-19-temp-workspaces-design.md`

## Global Constraints

- Plain JavaScript everywhere: CommonJS in `src/main/`, vanilla browser JS in `src/renderer/`. No TypeScript, no bundler, no new dependency.
- Adding a capability is three edits: `ipcMain.handle` in `src/main/main.js` → wrapper in `src/preload/preload.js` → call site in `src/renderer/app.js`. Never enable `nodeIntegration`, never weaken `contextIsolation`.
- The active workspace is resolved at call time, never captured in a closure.
- Every IPC handler that can change the active space calls `watchActive()`.
- All renderer file access goes through relative paths and `WorkspaceManager.resolveSafe`.
- `remove()` must keep its existing contract: unregisters a space, never touches files. Only `discardTemp` deletes.
- Config is data, not code: new keys go in `config/settings.json` **and** are read with a fallback, because the userData copy wins on existing installs.
- Electron has no `window.prompt`; renderer text input goes through the existing `askInput(title, initial)` modal.
- Commit after every task.

## Deviation from the spec

The spec fixes the scratch root at `~/tote/scratch`. This plan reads it from `settings.scratchRoot` with `~/tote/scratch` as the default, because otherwise `scripts/test-scratch.js` would have to create and delete folders in the developer's real home directory to test the delete guard. Task 7 records this in the spec. No other deviation.

---

### Task 1: Pure scratch helpers

**Files:**
- Create: `src/main/scratch.js`
- Create: `scripts/test-scratch.js`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces: `slug(name) -> string`, `defaultName(now: Date|number, taken: string[]) -> string`, `uniqueDirName(base: string, exists: (name: string) => boolean) -> string`, `isInsideRoot(abs: string, root: string) -> boolean`, `isExpired(lastUsed: number, days: number, now: number) -> boolean`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test-scratch.js`:

```js
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
  const day = 86400000, now = 1_000 * day;
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-scratch.js`
Expected: crash with `Cannot find module '../src/main/scratch.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/scratch.js`:

```js
// Pure decisions for temp ("scratch") spaces: naming, collision suffixes,
// containment and expiry. No fs, no electron -- the filesystem work lives in
// WorkspaceManager and the decisions live here, because this is the one
// feature in Tote that deletes user files and it has to be testable.
const path = require('path');

// Folder-safe form of a user-typed name. '' means "nothing usable left", which
// callers must treat as a rejected name rather than a fallback.
function slug(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// scratch-YYYY-MM-DD-N, N being the lowest free integer for that day. Local
// time, not UTC: the name should match the day the user thinks it is.
function defaultName(now, taken) {
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const used = new Set(taken || []);
  for (let n = 1; ; n++) {
    const candidate = 'scratch-' + day + '-' + n;
    if (!used.has(candidate)) return candidate;
  }
}

// First free folder name: base, then base-2, base-3, ...
function uniqueDirName(base, exists) {
  if (!exists(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = base + '-' + n;
    if (!exists(candidate)) return candidate;
  }
}

// Strictly inside: the root itself is not inside itself, and a sibling that
// merely shares the prefix (scratch-evil vs scratch) is not inside either.
// Callers pass realpaths -- resolving symlinks is theirs, comparing is ours.
function isInsideRoot(abs, root) {
  const a = path.resolve(abs);
  const r = path.resolve(root);
  return a !== r && a.startsWith(r + path.sep);
}

// A missing lastUsed never expires, and days <= 0 disables the sweep rather
// than expiring everything: both failure modes must fail towards keeping files.
function isExpired(lastUsed, days, now) {
  if (!Number.isFinite(days) || days <= 0) return false;
  if (!Number.isFinite(lastUsed)) return false;
  return now - lastUsed > days * 86400000;
}

module.exports = { slug, defaultName, uniqueDirName, isInsideRoot, isExpired };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/test-scratch.js`
Expected: `16 passed, 0 failed`, exit 0.

- [ ] **Step 5: Wire it into `npm test`**

In `package.json`, change the `test` script to:

```json
"test": "node scripts/test-layout.js && node scripts/test-scratch.js"
```

Run: `npm test`
Expected: the layout suite's `60 passed, 0 failed`, then the scratch suite's `16 passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add src/main/scratch.js scripts/test-scratch.js package.json
git commit -m "Pure helpers for temp spaces, with tests"
```

---

### Task 2: Create a temp space

**Files:**
- Modify: `src/main/workspace.js` (require `./scratch`, add `scratchRoot`, `suggestTempName`, `addTemp`; extend `setActive`)
- Modify: `scripts/test-scratch.js` (append a `WorkspaceManager` section)
- Modify: `config/settings.json`

**Interfaces:**
- Consumes: `scratch.js` from Task 1.
- Produces: `workspace.scratchRoot() -> absolute path`, `workspace.suggestTempName(now?) -> string`, `workspace.addTemp(name) -> id`. `setActive(id)` now stamps `lastUsed` on temp spaces.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-scratch.js`, above the final `console.log`:

```js
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
  return { tmp, home, cfg, wm: new WorkspaceManager(cfg), state: () => ws, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-scratch.js`
Expected: the `addTemp`/`suggestTempName` tests fail with `h.wm.addTemp is not a function`. Note `workspace.js` exports `{ WorkspaceManager, originApp }`, so the destructured require above is required — a default-style require yields an object with no constructor and fails with `WorkspaceManager is not a constructor`.

- [ ] **Step 3: Write the implementation**

In `src/main/workspace.js`, add the require beside the existing ones at the top:

```js
const S = require('./scratch');
```

Add these methods to `WorkspaceManager`, directly after `add()`:

```js
  /* ----- temp (scratch) spaces ----- */

  // Configurable so the tests can point it at a throwaway home; users get
  // ~/tote/scratch, the sibling of the Global default.
  scratchRoot() {
    const configured = this.cfg.getSettings().scratchRoot;
    return configured ? expandTilde(configured) : path.join(os.homedir(), 'tote', 'scratch');
  }

  // The name the create modal starts with: the lowest free number for today,
  // counting both registered spaces and folders already in the scratch root.
  suggestTempName(now = new Date()) {
    const root = this.scratchRoot();
    const onDisk = fs.existsSync(root) ? fs.readdirSync(root) : [];
    const registered = this.cfg.getWorkspaces().list.map((w) => w.name);
    return S.defaultName(now, [...onDisk, ...registered]);
  }

  // A temp space is a space with two extra fields: no folder picker, and it may
  // later be discarded (files and all) or promoted into a normal space.
  addTemp(name) {
    const base = S.slug(name);
    if (!base) throw new Error('Temp space name needs a letter or a number');
    const root = this.scratchRoot();
    fs.mkdirSync(root, { recursive: true });
    const dir = S.uniqueDirName(base, (n) => fs.existsSync(path.join(root, n)));
    const abs = path.join(root, dir);
    const data = this.cfg.getWorkspaces();
    const id = base + '-' + Date.now().toString(36);
    data.list.push({ id, name: String(name).trim(), path: abs, temp: true, lastUsed: Date.now() });
    this.cfg.saveWorkspaces(data);
    fs.mkdirSync(path.join(abs, 'inbox'), { recursive: true });
    return id;
  }
```

Replace the body of `setActive` so a temp space records when it was last used:

```js
  setActive(id) {
    const data = this.cfg.getWorkspaces();
    const target = data.list.find((w) => w.id === id);
    if (!target) throw new Error('Unknown workspace: ' + id);
    data.active = id;
    if (target.temp) target.lastUsed = Date.now();   // what the sweep reads
    this.cfg.saveWorkspaces(data);
    fs.mkdirSync(this.inboxDir(), { recursive: true });
    return this.active();
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: both suites green; the scratch suite now reports `23 passed, 0 failed`.

- [ ] **Step 5: Seed the new settings keys**

In `config/settings.json`:

```json
{
  "bridgeDownloads": true,
  "setupDone": false,
  "scratchDays": 7
}
```

Leave `scratchRoot` unseeded — absent means the `~/tote/scratch` default, and only the tests set it. Remember that an existing install's userData copy wins, so every read of `scratchDays` needs `?? 7`.

- [ ] **Step 6: Commit**

```bash
git add src/main/workspace.js scripts/test-scratch.js config/settings.json
git commit -m "Create temp spaces without a folder picker"
```

---

### Task 3: Discard a temp space (the guarded delete)

**Files:**
- Modify: `src/main/workspace.js` (add `measure`, `discardTemp`)
- Modify: `scripts/test-scratch.js`

**Interfaces:**
- Consumes: `addTemp`, `scratchRoot` from Task 2.
- Produces: `workspace.measure(abs) -> {files, bytes}`, `workspace.discardTemp(id) -> active space`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-scratch.js`, above the final `console.log`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-scratch.js`
Expected: the new tests fail with `h.wm.discardTemp is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/main/workspace.js`, add both methods after `addTemp`:

```js
  // File count and byte total for the discard dialog. Symlinks are counted but
  // never followed -- a link into the home folder must not inflate the number.
  measure(absPath) {
    let files = 0, bytes = 0;
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { files++; try { bytes += fs.lstatSync(p).size; } catch {} }
      }
    };
    walk(absPath);
    return { files, bytes };
  }

  // The ONLY code in Tote that deletes user files. Three guards, all here so a
  // future caller cannot skip one: the space must be temp, its real path must
  // sit strictly inside the real scratch root, and it must not be the last
  // space. remove() keeps its own contract -- it never touches the disk.
  discardTemp(id) {
    const data = this.cfg.getWorkspaces();
    const raw = data.list.find((w) => w.id === id);
    if (!raw) throw new Error('Unknown workspace: ' + id);
    if (!raw.temp) throw new Error('Not a temp space: ' + (raw.name || id));
    if (data.list.length <= 1) throw new Error('Keep at least one workspace');

    const root = this.scratchRoot();
    fs.mkdirSync(root, { recursive: true });
    const realRoot = fs.realpathSync(root);
    // A folder deleted by hand still has to unregister, so "missing" is fine --
    // but anything that exists is resolved first, or a symlink planted in the
    // scratch root would delete whatever it points at.
    let target = path.resolve(expandTilde(raw.path));
    if (fs.existsSync(target)) target = fs.realpathSync(target);
    if (!S.isInsideRoot(target, realRoot)) {
      throw new Error('Refusing to delete outside the scratch root: ' + target);
    }

    fs.rmSync(target, { recursive: true, force: true });
    data.list = data.list.filter((w) => w.id !== id);
    if (data.active === id) data.active = data.list[0].id;
    this.cfg.saveWorkspaces(data);
    return this.active();
  }
```

Note `fs.existsSync` follows symlinks, so a link pointing at a deleted target reports `false` and skips the realpath step; the containment check then sees the link's own path, which is inside the root, and `rmSync` removes the link itself rather than any target. That is the intended outcome.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: both suites green; scratch reports `31 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/main/workspace.js scripts/test-scratch.js
git commit -m "Discard a temp space behind three guards"
```

---

### Task 4: Promote and sweep

**Files:**
- Modify: `src/main/workspace.js` (add `promote`, `sweepTemp`)
- Modify: `scripts/test-scratch.js`

**Interfaces:**
- Consumes: `discardTemp`, `scratchRoot` from Tasks 2–3.
- Produces: `workspace.promote(id, absPath) -> space`, `workspace.sweepTemp(days, now?) -> [{name, path}]`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-scratch.js`, above the final `console.log`:

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-scratch.js`
Expected: the new tests fail with `h.wm.promote is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/main/workspace.js`, after `discardTemp`:

```js
  // Keep a temp space: move its folder out of the scratch root and drop the
  // temp fields. The id never changes, so views.json -- tabs, groups, layout --
  // survives untouched. Terminals keep the cwd they were spawned with, exactly
  // as they do after workspaces:setPath.
  promote(id, absPath) {
    const data = this.cfg.getWorkspaces();
    const raw = data.list.find((w) => w.id === id);
    if (!raw) throw new Error('Unknown workspace: ' + id);
    if (!raw.temp) throw new Error('Not a temp space: ' + (raw.name || id));

    const from = path.resolve(expandTilde(raw.path));
    const to = path.resolve(absPath);
    const realRoot = fs.realpathSync(this.scratchRoot());
    if (to === realRoot || S.isInsideRoot(to, realRoot)) {
      throw new Error('Pick a folder outside the scratch root, or the sweep would take it later');
    }
    if (fs.existsSync(to) && fs.readdirSync(to).length) {
      throw new Error('Folder is not empty: ' + to);
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { recursive: true, force: true });   // the picker's empty dir
    try {
      fs.renameSync(from, to);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;             // another volume
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }

    raw.path = to;
    delete raw.temp;
    delete raw.lastUsed;
    this.cfg.saveWorkspaces(data);
    return { ...raw, path: to };
  }

  // Launch-time only: a space in use can never vanish under the user, whatever
  // the clock says. Returns what it removed so the renderer can report it.
  sweepTemp(days, now = Date.now()) {
    const removed = [];
    for (const w of this.cfg.getWorkspaces().list.filter((x) => x.temp)) {
      if (!S.isExpired(w.lastUsed, days, now)) continue;
      const abs = expandTilde(w.path);
      try {
        this.discardTemp(w.id);
        removed.push({ name: w.name, path: abs });
      } catch (err) {
        // Guard refused, folder busy, or it is the last space left: leave it
        // registered and say so rather than failing the launch.
        console.warn('[tote] sweep skipped "' + w.name + '":', err.message);
      }
    }
    return removed;
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: both suites green; scratch reports `39 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/main/workspace.js scripts/test-scratch.js
git commit -m "Promote a temp space, and sweep stale ones at launch"
```

---

### Task 5: IPC and preload wiring

**Files:**
- Modify: `src/main/main.js` (five handlers beside the existing `workspaces:*` block at ~line 351; sweep in the `app.whenReady()` block at ~line 604)
- Modify: `src/preload/preload.js` (wrappers beside the existing workspace ones at lines 7–10, listener beside `onWorkspaceChanged` at line 68)

**Interfaces:**
- Consumes: `addTemp`, `suggestTempName`, `discardTemp`, `promote`, `sweepTemp`, `measure`.
- Produces: `tote.wsTempName() -> Promise<string>`, `tote.wsAddTemp(name) -> Promise<wsState>`, `tote.wsDiscard(id, termLabels) -> Promise<wsState | {canceled: true}>`, `tote.wsPromote(id) -> Promise<wsState | null>`, `tote.onWorkspacesSwept(cb)`. `wsState` is `{active, list}` as returned by every other workspace channel.

- [ ] **Step 1: Add the handlers**

In `src/main/main.js`, after the `workspaces:setPath` handler:

```js
// --- temp (scratch) spaces -------------------------------------------------
// A temp space skips the folder picker and can be deleted, files included --
// the one exception to "removing a space never touches the disk".

ipcMain.handle('workspaces:tempName', () => workspace.suggestTempName());

ipcMain.handle('workspaces:addTemp', (e, name) => {
  const id = workspace.addTemp(name);
  workspace.setActive(id);
  watchActive();
  return wsState();
});

// termLabels comes from the renderer because only it knows which PTY belongs to
// which space. The confirm lives here: this is where the native dialog is, and
// a delete deserves one rather than the renderer's confirm().
ipcMain.handle('workspaces:discard', async (e, id, termLabels) => {
  const w = workspace.list().find((x) => x.id === id);
  if (!w) throw new Error('Unknown workspace: ' + id);
  if (!w.temp) throw new Error('Not a temp space: ' + w.name);
  const { files, bytes } = workspace.measure(w.path);
  const size = bytes < 1048576 ? Math.round(bytes / 1024) + ' KB'
    : (bytes / 1048576).toFixed(1) + ' MB';
  const kills = (termLabels || []).length
    ? '\n\nRunning terminals that will be killed: ' + termLabels.join(', ')
    : '';
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    title: 'Discard temp space',
    message: 'Delete "' + w.name + '" and everything in it?',
    detail: w.path + '\n' + files + ' file(s), ' + size + kills + '\n\nThis cannot be undone.',
  });
  if (res.response !== 1) return { canceled: true };
  workspace.discardTemp(id);
  watchActive();
  return wsState();
});

ipcMain.handle('workspaces:promote', async (e, id) => {
  const w = workspace.list().find((x) => x.id === id);
  if (!w) throw new Error('Unknown workspace: ' + id);
  const res = await dialog.showOpenDialog(win, {
    title: 'Keep "' + w.name + '" — pick its permanent folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  workspace.promote(id, res.filePaths[0]);
  if (id === workspace.activeId()) watchActive();
  return wsState();
});
```

- [ ] **Step 2: Run the sweep at launch and report it**

In `src/main/main.js`, inside `app.whenReady().then(...)`, between `workspace = new WorkspaceManager(configStore);` and `ptys = new PtyManager();`:

```js
    // Stale temp spaces go at launch and only at launch, so nothing can vanish
    // mid-session. The report is pushed once the window can show a toast.
    swept = workspace.sweepTemp(configStore.getSettings().scratchDays ?? 7);
```

Declare `let swept = [];` beside the other module-level `let` declarations (`configStore`, `workspace`, `ptys`), and in `createWindow()`, after the window's content is loaded, add:

```js
  win.webContents.once('did-finish-load', () => {
    if (swept.length) win.webContents.send('workspace:swept', swept);
  });
```

- [ ] **Step 3: Add the preload wrappers**

In `src/preload/preload.js`, beside the existing workspace wrappers:

```js
  wsTempName: () => ipcRenderer.invoke('workspaces:tempName'),
  wsAddTemp: (name) => ipcRenderer.invoke('workspaces:addTemp', name),
  wsDiscard: (id, termLabels) => ipcRenderer.invoke('workspaces:discard', id, termLabels),
  wsPromote: (id) => ipcRenderer.invoke('workspaces:promote', id),
```

and beside `onWorkspaceChanged`:

```js
  onWorkspacesSwept: (cb) => ipcRenderer.on('workspace:swept', (e, list) => cb(list)),
```

- [ ] **Step 4: Verify the wiring loads**

Run: `node --check src/main/main.js && node --check src/preload/preload.js && npm test`
Expected: no syntax errors, both suites green.

Then run `npm start` and, in DevTools' console, confirm the surface exists:

```js
typeof tote.wsAddTemp === 'function' && typeof tote.wsDiscard === 'function'
```

Expected: `true`. (Quit any running Tote first — `main.js` takes a single-instance lock, so a second `npm start` just focuses the first.)

- [ ] **Step 5: Commit**

```bash
git add src/main/main.js src/preload/preload.js
git commit -m "IPC for creating, discarding, promoting and sweeping temp spaces"
```

---

### Task 6: Renderer UI

**Files:**
- Modify: `src/renderer/index.html` (a `+ temp` button beside `#btn-add-ws`, line 16)
- Modify: `src/renderer/app.js` (`renderWorkspaceSwitcher` ~line 62, new `addTempWorkspace`/`discardWorkspace`/`promoteWorkspace`, swept listener)
- Modify: `src/renderer/styles.css` (temp chip styling)

**Interfaces:**
- Consumes: `tote.wsTempName`, `tote.wsAddTemp`, `tote.wsDiscard`, `tote.wsPromote`, `tote.onWorkspacesSwept` from Task 5; existing `askInput`, `ctxItem`, `toast`, `closeTerm`, `destroyTabWebview`, `saveViews`, `showWorkspaceViews`, `refreshTree`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the button**

In `src/renderer/index.html`, after line 16 (`#btn-add-ws`):

```html
      <button id="btn-add-temp" class="plus" title="New temp space (deletable, swept when stale)">+t</button>
```

- [ ] **Step 2: Mark temp chips in the strip**

In `src/renderer/app.js`, inside `renderWorkspaceSwitcher`'s loop, replace the two glyph/class lines with:

```js
    const tab = document.createElement('div');
    tab.className = 'ws-tab' + (w.id === state.workspaces.active ? ' active' : '') + (w.temp ? ' temp' : '');
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = w.temp ? '◌' : w.id === 'global' ? '◈' : '◇';
    tab.append(glyph, document.createTextNode(w.name));
    tab.title = (w.temp ? 'temp space — discard deletes its files\n' : '') + w.path;
```

and swap the last context-menu entry so a temp space offers keep/discard instead of the files-are-safe removal:

```js
      if (w.temp) {
        menu.appendChild(ctxItem('keep… (make permanent)', () => promoteWorkspace(w)));
        menu.appendChild(ctxItem('discard… (deletes its files)', () => discardWorkspace(w), true));
      } else {
        menu.appendChild(ctxItem('remove workspace (keeps files on disk)', () => removeWorkspace(w), true));
      }
```

- [ ] **Step 3: Add the three flows**

In `src/renderer/app.js`, after `addWorkspace()`:

```js
// A temp space asks for a name only -- never a folder -- and starts from a
// generated one, so Enter is the whole interaction.
async function addTempWorkspace() {
  const suggested = await tote.wsTempName();
  const name = await askInput('New temp space (deleted when you discard it)', suggested);
  if (!name) return false;
  try {
    state.workspaces = await tote.wsAddTemp(name);
    renderWorkspaceSwitcher();
    showWorkspaceViews();
    await refreshTree();
    toast('Temp space "' + name + '" is active. Discard it when you are done.', 'success');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

$('#btn-add-temp').onclick = addTempWorkspace;

// Main measures the folder, names the terminals it will kill, and confirms.
// Panes come down only after the delete succeeded, so a cancel leaves nothing
// half-closed.
async function discardWorkspace(ws) {
  const labels = [...state.terms.values()].filter((t) => t.wsId === ws.id).map((t) => t.name);
  try {
    const res = await tote.wsDiscard(ws.id, labels);
    if (!res || res.canceled) return;
    state.workspaces = res;
    for (const [id, t] of [...state.terms]) if (t.wsId === ws.id) closeTerm(id);
    for (const [tabId, en] of [...state.tabs]) if (en.wsId === ws.id) destroyTabWebview(tabId);
    delete state.views[ws.id];
    delete state.activeTermByWs[ws.id];
    saveViews();
    renderWorkspaceSwitcher();
    showWorkspaceViews();
    await refreshTree();
    toast('Discarded "' + ws.name + '" and deleted its files.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Keep the work: main moves the folder and the space keeps its id, so tabs,
// groups and layout come along. Running terminals keep their old cwd.
async function promoteWorkspace(ws) {
  try {
    const res = await tote.wsPromote(ws.id);
    if (!res) return; // canceled
    state.workspaces = res;
    renderWorkspaceSwitcher();
    await refreshTree();
    const kept = state.workspaces.list.find((w) => w.id === ws.id);
    toast('Kept "' + ws.name + '" at ' + kept.path + '. Open terminals still sit in the old folder.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}
```

Register the sweep report beside the other `tote.on*` listeners:

```js
tote.onWorkspacesSwept((list) => {
  // Only 'error' and 'success' are styled in styles.css; an unknown kind would
  // render as a bare toast with a stray class.
  toast('Swept ' + list.length + ' stale temp space(s): ' + list.map((w) => w.name).join(', '), 'success');
});
```

- [ ] **Step 4: Style the temp chip**

In `src/renderer/styles.css`, beside the existing `.ws-tab` rules:

```css
/* A temp space is a different kind of thing: discarding it deletes files. */
.ws-tab.temp { border: 1px dashed #6b5a2b; }
.ws-tab.temp .glyph { color: #d9a441; }
```

- [ ] **Step 5: Verify by running the app** (repo convention: everything but the pure modules is verified this way)

Quit any running Tote, then `npm start`, and walk the whole feature:

1. `+t` → the modal is prefilled `scratch-<today>-1` → Enter. The strip shows a dashed chip; `#workspace-root` shows `~/tote/scratch/scratch-<today>-1`.
2. Open a terminal in it (Ctrl+`) → it starts `cd`'d into the scratch folder.
3. Download a file from a web tab → it lands in `<scratch>/inbox/<provider>/`.
4. `+t` again with the same name → the second folder is `-2`, and both spaces work.
5. Right-click the chip → `discard…` → the dialog names the path, file count, size and the running terminal. Cancel → nothing changes, terminal still alive.
6. `discard…` → Delete → panes close, the folder is gone from disk, the strip falls back to another space.
7. On a fresh temp space, `keep…` → pick `~/Desktop/kept-spike` → the chip loses its dashes, the files are there, tabs/groups/layout survived.
8. Quit. Edit `<userData>/config/workspaces.json` to back-date a temp space's `lastUsed` by 30 days. Relaunch → a toast reports the sweep and the folder is gone.
9. Switch to a normal space and confirm `remove workspace (keeps files on disk)` still leaves its folder alone.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/index.html src/renderer/app.js src/renderer/styles.css
git commit -m "Temp spaces in the workspace strip: create, keep, discard"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (new invariant bullet)
- Modify: `AGENTS.md`, `README.md`
- Modify: `archlens.model.yaml`
- Modify: `docs/superpowers/specs/2026-08-19-temp-workspaces-design.md` (record the `scratchRoot` deviation and the fifth channel)

- [ ] **Step 1: Add the CLAUDE.md invariant**

Beside the other workspace invariants:

```markdown
- **Exactly one function deletes user files.** `WorkspaceManager.discardTemp()` is it, and it refuses unless the space carries `temp: true`, its `realpath` sits strictly inside the `realpath` of the scratch root (`settings.scratchRoot`, default `~/tote/scratch`), and it is not the last space. The guards live in that function, never at a call site — `sweepTemp` and the `workspaces:discard` handler both go through it. `remove()` keeps its own contract: it unregisters a space and never touches the disk. Pure decisions (slug, default name, collision suffix, containment, expiry) live in `src/main/scratch.js` and are covered by `scripts/test-scratch.js`; `npm test` runs it after the layout suite.
- **Temp spaces are spaces.** They differ by two fields — `temp: true` and `lastUsed` (stamped in `setActive`) — so downloads, inbox routing, terminal `cwd`, watchers and `resolveSafe` need no special cases. `promote()` moves the folder and clears both fields, keeping the id so `views.json` (tabs, groups, layout) survives. The sweep runs at launch only, never mid-session; `scratchDays` defaults to 7 and `<= 0` disables it.
```

- [ ] **Step 2: Update AGENTS.md and README.md**

`README.md`, in the spaces section: temp spaces skip the folder picker, live in `~/tote/scratch`, are discarded with their files from the chip's context menu, kept with `keep…`, and swept after a week idle.

`AGENTS.md`, beside the other space rules: one guarded delete path, `temp`/`lastUsed` fields, launch-only sweep.

- [ ] **Step 3: Update archlens.model.yaml**

Add a component entry for `src/main/scratch.js` (methods `slug`, `defaultName`, `uniqueDirName`, `isInsideRoot`, `isExpired`) and add `scratchRoot`, `suggestTempName`, `addTemp`, `measure`, `discardTemp`, `promote`, `sweepTemp` to the `src/main/workspace.js` entry. Follow the file's existing shape; the model is hand-maintained.

Run: `node -e "require('js-yaml')" 2>/dev/null || true` — no validator is required; just confirm the file still parses in whatever tooling you have, or eyeball the indentation against a neighbouring entry.

- [ ] **Step 4: Record the deviation in the spec**

In the spec's data-model section, note that the scratch root is `settings.scratchRoot` (default `~/tote/scratch`) so the delete guard can be tested against a throwaway home, and add `workspaces:tempName` to the API surface list.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md archlens.model.yaml docs/superpowers/specs/2026-08-19-temp-workspaces-design.md
git commit -m "Docs: temp spaces and the single delete path"
```

---

## Self-review

**Spec coverage:** data model → Task 2 (`addTemp`, `settings.json`) and Task 3; one guarded deletion → Task 3; promotion by move with EXDEV fallback → Task 4; launch sweep with report → Tasks 4–6; `askInput` creation flow → Task 6; discard confirm in main with file count, size and terminal names → Task 5; edge-case table → tests in Tasks 3–4 plus the manual checklist in Task 6 step 5; test list → Tasks 1–4; docs list → Task 7.

**Known gap, deliberate:** the spec's "promote across volumes" case is exercised only by the manual checklist, because `EXDEV` cannot be provoked from a dependency-free test without a second filesystem. The code path is a two-line fallback and the manual step names it.
