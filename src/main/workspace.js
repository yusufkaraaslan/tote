// Workspace manager: two-level spaces (one Global + project workspaces).
// A space is the routing context: downloads from web tabs, bridged files from
// native apps, and new CLI terminals all land in the space that asked.
//
// Which space that is belongs to the VIEWER, not to this object: two windows
// (or another device) can look at different spaces of the same host at once.
// `scoped(id)` is how a caller says which -- every file op below resolves its
// root through `this.active()`, and a scoped view overrides exactly that. The
// registry's own `active` is only the space a fresh window opens on.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const S = require('./scratch');
const { RemoteConn, RemoteFs } = require('./remote');

// Generated caches: hidden from the tree and, more importantly, never watched.
// See WATCH_BUDGET -- a single one of these can hold more files than the whole
// rest of a project. `.godot` is why a Godot workspace broke every agent
// terminal: 5k import-cache files, none of them anything a user wants to see.
const IGNORE = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', 'out', '.cache',
  '.godot', '__pycache__', '.venv', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.gradle',
  '.terraform', 'Pods',
]);

// Unity's generated dirs: the `.godot` story again at ten times the size --
// `Library/` alone holds ~50k files, and a space with two Unity projects in it
// bound 3.9k watch descriptors and walked 17.9k tree nodes on every tick.
//
// These names are far too ordinary to put in IGNORE, which matches a basename
// anywhere: a hand-written `Library`, `Logs` or `obj` of source would silently
// vanish from the files pane. So they only count as generated when the
// directory holding them is a Unity project -- `Assets` + `ProjectSettings`
// siblings, which is the same pair Unity itself looks for.
const IGNORE_UNITY = new Set([
  'Library', 'Temp', 'Obj', 'obj', 'Logs', 'MemoryCaptures',
]);

// The one predicate every local walk and the watcher share: `(dir, name) =>
// skip?`. The Unity marker test hits the disk, so it is memoized per directory
// -- one pair of existsSync calls per project, not per entry. The memo lives as
// long as the walk (or the watcher), so a project created later is picked up on
// the next arm.
function skipper() {
  const unity = new Map();
  const isUnityProject = (dir) => {
    let v = unity.get(dir);
    if (v === undefined) {
      v = fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings'));
      unity.set(dir, v);
    }
    return v;
  };
  return (dir, name) => IGNORE.has(name) || (IGNORE_UNITY.has(name) && isUnityProject(dir));
}

// Ceiling on how many paths the tree watcher may bind.
//
// chokidar 4 dropped its fsevents dependency, so on every platform it falls
// back to fs.watch and opens ONE DESCRIPTOR PER WATCHED PATH. A workspace with
// a big generated cache (a Godot `.godot`, a Unity `Library/`, a Rust
// `target/`) therefore drags the main process up to its RLIMIT_NOFILE, and the
// first thing that fails afterwards is pty allocation: node-pty hands back a
// child with no controlling tty, so Claude Code and every other TUI agent exits
// immediately with code 1 and prints nothing. Terminals, not the file tree, are
// what breaks -- which makes it a genuinely confusing failure to chase.
//
// IGNORE alone cannot be trusted to hold the line (the next project type brings
// a cache dir nobody listed), so the depth is chosen to fit this budget.
//
// The number is deliberately far below the ceiling rather than near it. What it
// rations is the main process's descriptors, and everything else in the app --
// every webview partition's leveldb, every pty, the download bridge -- is
// spending out of the same pool. 4000 was measured hovering at ~4.4k open fds
// with terminals already failing, so keep the watcher's share small enough that
// a space switch is never the thing that runs the process out.
const WATCH_BUDGET = 1500;
const PARTIAL_EXT = new Set(['.crdownload', '.part', '.download', '.partial', '.tmp']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.gd', '.cs', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp',
  '.html', '.htm', '.css', '.scss', '.xml', '.yml', '.yaml', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.sh', '.bat', '.ps1', '.sql', '.csv', '.svg',
  '.tscn', '.tres', '.godot', '.log', '.gitignore', '.editorconfig',
]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg']);
const MD_EXT = new Set(['.md', '.markdown']);
const HTML_EXT = new Set(['.html', '.htm']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

// A dotfile is all suffix: path.extname('.gitignore') is '', so TEXT_EXT's
// dotfile entries could never match through extname alone.
function extOf(name) {
  const base = path.basename(String(name));
  const ext = path.extname(base);
  return (ext || (base.startsWith('.') ? base : '')).toLowerCase();
}

// How a file is shown in a doc pane. SVG is deliberately an image even though
// it is also in TEXT_EXT: readDoc fills in `text` as well, which is what gives
// it both a rendered and an editable mode. HTML is the same arrangement -- it
// stays in TEXT_EXT so the tree still calls it text and it is still savable,
// but it classifies ahead of it so the pane knows it has a rendered face.
function docKind(name) {
  const ext = extOf(name);
  if (MD_EXT.has(ext)) return 'md';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (HTML_EXT.has(ext)) return 'html';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';

// Handed to RemoteFs rather than duplicated there. A remote tree node and a
// remote doc pane therefore decide a file's kind with the same functions the
// local ones use, which is what keeps them from ever disagreeing.
const FILE_META = {
  docKind, extOf, mb, MIME, MAX_READ_BYTES, MAX_IMAGE_BYTES,
  isTextFile: (name) => TEXT_EXT.has(extOf(name)),
};

// Resolve symlinks as far down as the path actually exists, then re-append the
// rest. A path that is not there yet -- a promotion target -- or not there any
// more -- a scratch folder deleted by hand -- still has to be comparable with a
// realpath'd root, and any ancestor can be a link (/var -> /private/var on
// macOS, or a ~/tote pointed at another disk).
function realpathDeepest(abs) {
  let cur = path.resolve(abs);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(abs);   // nothing above exists
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

function expandTilde(p) {
  return p === '~' ? os.homedir() : p.startsWith('~' + path.sep) || p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(2))
    : p;
}

// The path to show and to use for a space. A remote space's path belongs to the
// remote filesystem: expanding a leading ~ here would silently point it at THIS
// machine's home, which is the sort of bug that only shows up as files landing
// in the wrong place. The remote ~ is resolved by the connect probe instead.
function wsPath(w) {
  return w && w.host ? w.path : expandTilde(w.path);
}

// macOS stamps every downloaded file with a com.apple.quarantine xattr whose
// third field is the name of the app that fetched it:
//   0081;6a7c6499;Slack;E751D4CB-1F33-403A-854A-4104E7363F14
// Files that were never downloaded (echo, unzip, a manual copy) carry no such
// attribute, so a null return means "no known download origin" -- which the
// bridge treats as "leave it alone". Linux has no equivalent and Windows'
// Zone.Identifier names a security zone rather than an app, so both return
// null and the bridge stays off there (see issue #1).
function originApp(absPath) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(null);
    execFile('xattr', ['-p', 'com.apple.quarantine', absPath], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null); // no xattr, unreadable, or already gone
      const app = String(stdout).trim().split(';')[2];
      resolve(app && app.trim() ? app.trim() : null);
    });
  });
}

class WorkspaceManager {
  constructor(configStore) {
    this.cfg = configStore;
    this.watchers = new Map();       // spaceId -> { root, close } -- see watchSpaces()
    this.watchGen = 0;               // only the newest watchSpaces() call may bind
    this.dlWatcher = null;
    this.conns = new Map();          // spaceId -> RemoteConn, created lazily
    this.remoteHooks = null;         // set by configureRemote() once main.js has a PtyManager
    this.ensureInbox();
  }

  // main.js owns the userData paths and the PtyManager, so the pieces RemoteConn
  // needs are injected once both exist rather than reached for from here.
  configureRemote(hooks) {
    this.remoteHooks = hooks;
  }

  /* ----- remote spaces -----
   *
   * A space is remote iff it carries a host. Everything below dispatches on
   * that one field, and the local paths above must never be applied to one:
   * a remote `~/proj` is not this machine's home, and a remote inbox is not a
   * directory this machine may create.
   */

  isRemote(space) {
    return !!(space && space.host);
  }

  // One connection per remote space, created on first use and kept afterwards:
  // its control socket outlives Tote, so a restart usually reconnects silently.
  conn(space) {
    if (!this.isRemote(space)) return null;
    let c = this.conns.get(space.id);
    if (!c) {
      if (!this.remoteHooks) throw new Error('Remote support is not wired up yet');
      c = new RemoteConn({ id: space.id, host: space.host, root: space.path, ...this.remoteHooks });
      this.conns.set(space.id, c);
    }
    c.host = space.host;             // the space may have been edited since
    return c;
  }

  // A space's file backend, or null when it is a local folder. Resolved per
  // call, never cached, for the same reason getRoot() is.
  backendFor(space) {
    if (!this.isRemote(space)) return null;
    return new RemoteFs(this.conn(space), { ignore: [...IGNORE], meta: FILE_META });
  }

  backend() {
    return this.backendFor(this.active());
  }

  // Land a local file in a named space's inbox. A download is routed to a space
  // when it starts, so it must finish in that one even if the user has switched
  // in the meantime -- which is the one place the active space is deliberately
  // not what decides.
  async ingestInto(spaceId, absSource, providerId) {
    const space = this.cfg.getWorkspaces().list.find((w) => w.id === spaceId);
    if (!space) throw new Error('Unknown workspace: ' + spaceId);
    const R = this.backendFor(space);
    if (R) return R.ingest(absSource, providerId);
    const inbox = path.join(wsPath(space), 'inbox', providerId || '_desktop');
    fs.mkdirSync(inbox, { recursive: true });
    const target = path.join(inbox, path.basename(absSource));
    fs.copyFileSync(absSource, target);
    return target;
  }

  remoteState(id) {
    const space = this.list().find((w) => w.id === id) || this.active();
    if (!this.isRemote(space)) return null;
    return this.conn(space).info();
  }

  // Registry entry for a remote space: the same shape as a local one plus a
  // host. The path stays exactly as typed (it may be `~/proj`); the connect
  // probe resolves it on the remote and the absolute result lives on the
  // connection, not in the registry.
  addRemote(name, host, remotePath) {
    const h = String(host || '').trim();
    const p = String(remotePath || '').trim();
    if (!h) throw new Error('Remote space needs a host');
    if (!p) throw new Error('Remote space needs a path on that host');
    const data = this.cfg.getWorkspaces();
    const base = S.slug(name) || 'remote';
    const taken = new Set(data.list.map((w) => w.id));
    const id = S.uniqueDirName(base + '-' + Date.now().toString(36), (n) => taken.has(n));
    data.list.push({ id, name: String(name).trim() || h, path: p, host: h });
    this.cfg.saveWorkspaces(data);
    return id;
  }

  // Only ever the active space's inbox, and only when it is local. A remote
  // space's inbox is created on the remote, by RemoteFs.ingest.
  ensureInbox() {
    if (this.isRemote(this.active())) return;
    fs.mkdirSync(this.inboxDir(), { recursive: true });
  }

  /* ----- spaces registry ----- */

  list() {
    return this.cfg.getWorkspaces().list.map((w) => ({ ...w, path: wsPath(w) }));
  }

  activeId() {
    return this.cfg.getWorkspaces().active;
  }

  // One registered space with its display path, or null.
  space(id) {
    const w = this.cfg.getWorkspaces().list.find((x) => x.id === id);
    return w ? { ...w, path: wsPath(w) } : null;
  }

  /* A view of this manager in which `id` is the active space. Every file op --
   * tree, readDoc, ingest, resolveSafe, localCwd, stagingDir -- resolves its
   * root through active()/activeId(), so overriding those two is the whole
   * scoping, and the path-escape guard comes along unchanged.
   *
   * Only for file ops: they read `this` but never assign to it. Anything that
   * stores state on the manager (watchers, the registry) must be called on the
   * manager itself, or the assignment would land on the throwaway view. An id
   * that no longer exists (removed by another viewer) falls back to the
   * registry's active space rather than throwing mid-operation. */
  scoped(id) {
    const space = this.space(id) || this.active();
    const view = Object.create(this);
    view.active = () => ({ ...space });
    view.activeId = () => space.id;
    return view;
  }

  active() {
    const data = this.cfg.getWorkspaces();
    const found = data.list.find((w) => w.id === data.active) || data.list[0];
    return { ...found, path: wsPath(found) };
  }

  setActive(id) {
    const data = this.cfg.getWorkspaces();
    const target = data.list.find((w) => w.id === id);
    if (!target) throw new Error('Unknown workspace: ' + id);
    data.active = id;
    if (target.temp) target.lastUsed = Date.now();   // what the sweep reads
    this.cfg.saveWorkspaces(data);
    this.ensureInbox();
    return this.active();
  }

  add(name, absPath) {
    const data = this.cfg.getWorkspaces();
    const id =
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') +
      '-' + Date.now().toString(36);
    data.list.push({ id, name, path: absPath });
    this.cfg.saveWorkspaces(data);
    fs.mkdirSync(path.join(absPath, 'inbox'), { recursive: true });
    return id;
  }

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
    // Two temp spaces can be created inside one millisecond -- a folder pick
    // cannot -- so the timestamp alone is not a unique id here, and a duplicate
    // id would have views.json and discardTemp addressing two spaces at once.
    const taken = new Set(data.list.map((w) => w.id));
    const id = S.uniqueDirName(dir + '-' + Date.now().toString(36), (n) => taken.has(n));
    data.list.push({ id, name: String(name).trim(), path: abs, temp: true, lastUsed: Date.now() });
    this.cfg.saveWorkspaces(data);
    fs.mkdirSync(path.join(abs, 'inbox'), { recursive: true });
    return id;
  }

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
    // Every guard below compares local realpaths, which mean nothing for a path
    // on another machine -- so a remote space is refused before they can run.
    if (this.isRemote(raw)) throw new Error('Refusing to delete a remote space');
    if (data.list.length <= 1) throw new Error('Keep at least one workspace');

    const root = this.scratchRoot();
    fs.mkdirSync(root, { recursive: true });
    const realRoot = fs.realpathSync(root);
    // A folder deleted by hand still has to unregister, so "missing" is fine --
    // but anything that exists is resolved first, or a symlink planted in the
    // scratch root would delete whatever it points at.
    // A folder deleted by hand still has to unregister, and a symlink planted in
    // the scratch root must not take its target down with it -- both are why
    // this is resolved before it is compared.
    const target = realpathDeepest(expandTilde(raw.path));
    if (!S.isInsideRoot(target, realRoot)) {
      throw new Error('Refusing to delete outside the scratch root: ' + target);
    }

    fs.rmSync(target, { recursive: true, force: true });
    data.list = data.list.filter((w) => w.id !== id);
    if (data.active === id) data.active = data.list[0].id;
    this.cfg.saveWorkspaces(data);
    return this.active();
  }

  // Keep a temp space: move its folder out of the scratch root and drop the
  // temp fields. The id never changes, so views.json -- tabs, groups, layout --
  // survives untouched. Terminals keep the cwd they were spawned with, exactly
  // as they do after workspaces:setPath.
  promote(id, absPath) {
    const data = this.cfg.getWorkspaces();
    const raw = data.list.find((w) => w.id === id);
    if (!raw) throw new Error('Unknown workspace: ' + id);
    if (!raw.temp) throw new Error('Not a temp space: ' + (raw.name || id));
    if (this.isRemote(raw)) throw new Error('Remote spaces cannot be promoted');

    const from = path.resolve(expandTilde(raw.path));
    const to = path.resolve(absPath);
    // Guard on the resolved form, store what the user picked -- add() and
    // updateSpace() both keep the picker's path verbatim and the strip shows it.
    const toReal = realpathDeepest(absPath);
    const realRoot = fs.realpathSync(this.scratchRoot());
    if (toReal === realRoot || S.isInsideRoot(toReal, realRoot)) {
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

  // Rename a space and/or point it at another folder. Files are never moved.
  updateSpace(id, { name, path: absPath } = {}) {
    const data = this.cfg.getWorkspaces();
    const w = data.list.find((x) => x.id === id);
    if (!w) throw new Error('Unknown workspace: ' + id);
    if (name !== undefined) {
      const n = String(name).trim();
      if (!n) throw new Error('Workspace name cannot be empty');
      w.name = n;
    }
    if (absPath !== undefined) {
      w.path = absPath;
      if (!this.isRemote(w)) fs.mkdirSync(path.join(absPath, 'inbox'), { recursive: true });
    }
    this.cfg.saveWorkspaces(data);
    return { ...w, path: wsPath(w) };
  }

  // New strip order. `ids` is the order the renderer just dragged into; any
  // space it does not name (registered or swept since it read the list) keeps
  // its relative position at the end, so a stale list can never drop a space.
  reorder(ids) {
    const data = this.cfg.getWorkspaces();
    const pending = new Map(data.list.map((w) => [w.id, w]));
    const next = [];
    for (const id of ids || []) {
      const w = pending.get(id);
      if (!w) continue;
      pending.delete(id);
      next.push(w);
    }
    for (const w of data.list) if (pending.has(w.id)) next.push(w);
    data.list = next;
    this.cfg.saveWorkspaces(data);
    return this.list();
  }

  // Unregisters the space. Files on disk are never touched.
  remove(id) {
    const data = this.cfg.getWorkspaces();
    if (data.list.length <= 1) throw new Error('Keep at least one workspace');
    data.list = data.list.filter((w) => w.id !== id);
    if (data.active === id) data.active = data.list[0].id;
    this.cfg.saveWorkspaces(data);
    return this.active();
  }

  getRoot() {
    return this.active().path;
  }

  inboxDir(providerId) {
    return providerId
      ? path.join(this.getRoot(), 'inbox', providerId)
      : path.join(this.getRoot(), 'inbox');
  }

  /* ----- file ops (active workspace) ----- */

  // Local-only, and deliberately still synchronous: the callers that need a real
  // path on this machine (shell.trashItem, openPath, revealPath) cannot be given
  // a remote one at all. localFileFor() is the remote-aware alternative.
  resolveSafe(rel) {
    if (this.isRemote(this.active())) {
      throw new Error('That is only available for local spaces');
    }
    const abs = path.resolve(this.getRoot(), rel);
    const rootAbs = path.resolve(this.getRoot());
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new Error('Path escapes workspace root');
    }
    return abs;
  }

  isTextFile(name) {
    return TEXT_EXT.has(extOf(name));
  }

  async tree(depth = 5) {
    const R = this.backend();
    if (R) return R.tree(depth);
    const skip = skipper();
    const walk = (abs, rel, d) => {
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const e of entries) {
        if (skip(abs, e.name)) continue;
        const childAbs = path.join(abs, e.name);
        const childRel = rel === '.' ? e.name : rel + '/' + e.name;
        if (e.isDirectory()) {
          out.push({
            name: e.name,
            path: childRel,
            type: 'dir',
            children: d > 0 ? walk(childAbs, childRel, d - 1) : [],
          });
        } else if (e.isFile()) {
          out.push({ name: e.name, path: childRel, type: 'file',
            text: this.isTextFile(e.name), kind: docKind(e.name) });
        }
      }
      out.sort((a, b) =>
        a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
      );
      return out;
    };
    return walk(this.getRoot(), '.', depth);
  }

  async readText(rel) {
    const R = this.backend();
    if (R) return R.readText(rel);
    const abs = this.resolveSafe(rel);
    const stat = fs.statSync(abs);
    if (stat.size > MAX_READ_BYTES) throw new Error('File too large to edit inline (> 2 MB)');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) throw new Error('Binary file - open it externally instead');
    return buf.toString('utf8');
  }

  async writeText(rel, content) {
    const R = this.backend();
    if (R) return R.writeText(rel, content);
    const abs = this.resolveSafe(rel);
    // A doc pane can be asked to write its buffer back after the file -- or the
    // folder holding it -- was deleted underneath it, so recreate the parent
    // the way createFile does rather than failing with ENOENT.
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }

  // Everything a doc pane needs to show one file, in one shape. One channel
  // rather than four keeps resolveSafe and the size caps in a single place,
  // and gives the pane's reload path one thing to compare against.
  // `error` means "cannot be shown"; `kind` is still set, so the pane can say
  // what it would have shown and offer to open it externally.
  async readDoc(rel) {
    const R = this.backend();
    if (R) return R.readDoc(rel);
    const abs = this.resolveSafe(rel);
    const kind = docKind(rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error('Not a file: ' + rel);
    const base = { kind: kind, mtimeMs: stat.mtimeMs, size: stat.size };
    if (kind === 'binary') return base;
    if (kind === 'pdf') return Object.assign(base, { fileUrl: pathToFileURL(abs).href });

    // HTML is handed over twice: a file:// URL for the rendered face and the
    // source for the editable one. The URL is what makes the page's own
    // stylesheets, scripts and images resolve against the folder it lives in --
    // inlining the markup would render a downloaded page unstyled. Over the
    // read cap it keeps the rendered face and simply has no source, which is a
    // better answer for a generated page than the size error text gets.
    if (kind === 'html') {
      const out = Object.assign(base, { fileUrl: pathToFileURL(abs).href });
      if (stat.size <= MAX_READ_BYTES) {
        const buf = fs.readFileSync(abs);
        if (!buf.includes(0)) out.text = buf.toString('utf8');
      }
      return out;
    }

    if (kind === 'image') {
      if (stat.size > MAX_IMAGE_BYTES) {
        return Object.assign(base, { error: mb(stat.size) + ', larger than the 25 MB view limit' });
      }
      const buf = fs.readFileSync(abs);
      const ext = extOf(rel);
      const out = Object.assign(base, {
        dataUrl: 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + buf.toString('base64'),
      });
      // SVG is text too, which is what gives it an editable source mode.
      if (ext === '.svg' && !buf.includes(0)) out.text = buf.toString('utf8');
      return out;
    }

    if (stat.size > MAX_READ_BYTES) {
      return Object.assign(base, { error: mb(stat.size) + ', larger than the 2 MB view limit' });
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return Object.assign(base, { error: 'Binary file — open it externally instead' });
    return Object.assign(base, { text: buf.toString('utf8') });
  }

  async createFile(rel) {
    const R = this.backend();
    if (R) return R.createFile(rel);
    const abs = this.resolveSafe(rel);
    if (fs.existsSync(abs)) throw new Error('Already exists: ' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }

  async createFolder(rel) {
    const R = this.backend();
    if (R) return R.createFolder(rel);
    const abs = this.resolveSafe(rel);
    if (fs.existsSync(abs)) throw new Error('Already exists: ' + rel);
    fs.mkdirSync(abs, { recursive: true });
  }

  async rename(fromRel, toRel) {
    const R = this.backend();
    if (R) return R.rename(fromRel, toRel);
    fs.renameSync(this.resolveSafe(fromRel), this.resolveSafe(toRel));
  }

  // Copy a file from anywhere on disk into the active workspace inbox.
  // Deliberately a copy, not a move: the bridge watches ~/Downloads, which is
  // the user's folder, so nothing may disappear out of it.
  async ingest(absSource, providerId) {
    const R = this.backend();
    if (R) return R.ingest(absSource, providerId);
    const inbox = this.inboxDir(providerId);
    fs.mkdirSync(inbox, { recursive: true });
    const base = path.basename(absSource);
    let target = path.join(inbox, base);
    const ext = path.extname(base);
    let i = 1;
    while (fs.existsSync(target)) {
      target = path.join(inbox, base.slice(0, base.length - ext.length) + ` (${i})` + ext);
      i++;
    }
    fs.copyFileSync(absSource, target);
    return target;
  }

  /* ----- local-path bridges -----
   *
   * The handful of features that can only be handed a real path on this
   * machine: a <webview> showing a PDF, and the in-page file attach. For a
   * remote space they get a cached copy instead of a refusal.
   */

  async localFileFor(rel) {
    const R = this.backend();
    return R ? R.cache(rel) : this.resolveSafe(rel);
  }

  // A pty needs a directory that exists on THIS machine. For a remote space the
  // real working directory is set by the `cd` inside the ssh command, so the
  // local cwd only has to be somewhere valid.
  localCwd() {
    return this.isRemote(this.active()) ? os.homedir() : this.getRoot();
  }

  // Chromium can only download to local disk, so a remote space's downloads
  // land here first and are pushed up by ingest() once they finish.
  stagingDir(providerId) {
    if (!this.remoteHooks) throw new Error('Remote support is not wired up yet');
    const dir = path.join(this.remoteHooks.cacheDir, 'staging', this.activeId(),
                          providerId || '_desktop');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async disconnectAll() {
    for (const c of this.conns.values()) {
      try { await c.disconnect(); } catch {}
    }
  }

  /* ----- watchers ----- */

  // Deepest level (0..maxDepth) whose cumulative path count still fits
  // WATCH_BUDGET. Counting level by level and stopping early keeps this to the
  // same readdir work `tree()` already does, and a workspace too big to watch
  // fully degrades to a shallower watch -- deep changes stop auto-refreshing,
  // which is a far better failure than every terminal losing its tty.
  // `capped` separates "the tree simply ends here" from "the budget stopped
  // us"; only the second is worth warning about, and most projects are the
  // first.
  watchPlan(root, maxDepth = 5, budget = WATCH_BUDGET) {
    const skip = skipper();
    let level = [root];
    let total = 1;
    let fits = 0;
    for (let d = 1; d <= maxDepth; d++) {
      const next = [];
      for (const dir of level) {
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (skip(dir, e.name)) continue;
          total++;
          if (e.isDirectory()) next.push(path.join(dir, e.name));
        }
      }
      if (total > budget) return { depth: fits, capped: true }; // deeper only grows
      fits = d;
      if (!next.length) return { depth: d, capped: false }; // tree bottoms out
      level = next;
    }
    return { depth: fits, capped: false };
  }

  /* One watcher per space that some viewer is looking at. Called again on every
   * change to that set -- a space switch in any window, a space added, removed
   * or re-pointed -- with the full list of wanted ids.
   *
   * Closes finish before anything new binds. Fire-and-forget held both sets of
   * descriptors open across a switch, and a switch is precisely when the
   * process ran out of them. The generation guard is for a user clicking
   * through spaces faster than a close resolves: only the newest call may
   * install watchers. A space whose folder (or host) changed is closed and
   * re-armed, which is what setPath and promote used to re-arm by hand.
   *
   * WATCH_BUDGET is shared, not multiplied: n watched spaces get budget/n each,
   * because every descriptor comes out of the same process-wide pool. Usually
   * n is 1 or 2. */
  async watchSpaces(ids, onChange) {
    const gen = ++this.watchGen;
    const want = [...new Set(ids)].map((id) => this.space(id)).filter(Boolean);
    const keyOf = (w) => (w.host || '') + '\u0000' + w.path;
    const drop = [];
    for (const [id, entry] of this.watchers) {
      const w = want.find((x) => x.id === id);
      if (!w || entry.key !== keyOf(w)) drop.push(id);
    }
    for (const id of drop) {
      const entry = this.watchers.get(id);
      this.watchers.delete(id);
      try { await entry.close(); } catch {}
    }
    if (gen !== this.watchGen) return;      // a newer call owns the watchers now
    const share = Math.max(1, Math.floor(WATCH_BUDGET / Math.max(1, want.length)));
    for (const w of want) {
      if (this.watchers.has(w.id)) continue;
      const entry = this.isRemote(w)
        ? this.watchRemote(w, () => onChange(w.id))
        : this.watchLocal(w, share, () => onChange(w.id));
      entry.key = keyOf(w);
      this.watchers.set(w.id, entry);
    }
  }

  watchLocal(space, budget, callback) {
    const chokidar = require('chokidar');
    let timer = null;
    const root = space.path;
    const { depth, capped } = this.watchPlan(root, 5, budget);
    if (capped) {
      console.warn(
        `[tote] ${root}: over ${budget} watchable paths, ` +
          `watching to depth ${depth} only; deeper changes will not auto-refresh. ` +
          `Add the generated cache dir to IGNORE (or IGNORE_UNITY) in workspace.js to watch fully.`,
      );
    }
    const skip = skipper();
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      depth,
      // The root is handed to this predicate too, and pruning it would watch
      // nothing at all -- a space whose own folder happens to be called `out`,
      // `dist` or `Logs`.
      ignored: (p) => p !== root && skip(path.dirname(p), path.basename(p)),
    });
    watcher.on('all', () => {
      clearTimeout(timer);
      timer = setTimeout(callback, 200);
    });
    return { root, watcher, close: () => { clearTimeout(timer); return watcher.close(); } };
  }

  // A remote space has no inotify to bind and no descriptors to blow: it polls
  // a fingerprint that the remote hashes for us, so the reply is one line
  // whatever the project's size. Only a viewed space polls, and only while its
  // connection is up -- a space whose host is asleep costs nothing.
  //
  // The fingerprint covers mtimes as well as names on purpose. The whole point
  // of a remote space is an agent editing files in a terminal, and an open doc
  // pane learns about that edit only through this tick.
  watchRemote(space, callback) {
    const every = Number(this.cfg.getSettings().remotePollMs) || 4000;
    let last = null;
    let busy = false;
    let stopped = false;
    const tick = async () => {
      if (busy || stopped) return;            // a slow link must not stack polls
      const R = this.backendFor(space);
      if (!R || this.conn(space).state !== 'up') return;
      busy = true;
      try {
        const now = await R.fingerprint();
        if (!stopped && last !== null && now !== last) callback();
        last = now;
      } catch {
        // A dropped connection is the RemoteConn's problem to report, not a
        // reason to spam the tree with refreshes.
      } finally {
        busy = false;
      }
    };
    tick();
    const poller = setInterval(tick, every);
    return { root: space.path, close: async () => { stopped = true; clearInterval(poller); } };
  }

  // Watches the OS Downloads folder to catch files saved by native apps, so
  // they can be bridged into the active workspace. The watcher itself cannot
  // tell who wrote a file -- the caller must filter on originApp() before
  // ingesting, or unrelated browser/AirDrop/hand-made files get swept up too.
  watchDownloads(callback) {
    const chokidar = require('chokidar');
    if (this.dlWatcher) this.dlWatcher.close();
    const dlDir = path.join(os.homedir(), 'Downloads');
    if (!fs.existsSync(dlDir)) return;
    this.dlWatcher = chokidar.watch(dlDir, {
      ignoreInitial: true,
      depth: 0,
      ignored: (p) => PARTIAL_EXT.has(path.extname(p).toLowerCase()),
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
    });
    this.dlWatcher.on('add', (p) => callback(p));
  }

  unwatchDownloads() {
    if (this.dlWatcher) this.dlWatcher.close();
    this.dlWatcher = null;
  }
}

module.exports = { WorkspaceManager, originApp, docKind, expandTilde };
