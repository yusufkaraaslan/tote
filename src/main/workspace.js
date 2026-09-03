// Workspace manager: two-level spaces (one Global + project workspaces).
// "Active workspace" is the routing context: downloads from web tabs,
// bridged files from native apps, and new CLI terminals all land here.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const S = require('./scratch');

const IGNORE = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'out', '.cache']);
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
// it both a rendered and an editable mode.
function docKind(name) {
  const ext = extOf(name);
  if (MD_EXT.has(ext)) return 'md';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';

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
    this.watcher = null;
    this.dlWatcher = null;
    fs.mkdirSync(this.inboxDir(), { recursive: true });
  }

  /* ----- spaces registry ----- */

  list() {
    return this.cfg.getWorkspaces().list.map((w) => ({ ...w, path: expandTilde(w.path) }));
  }

  activeId() {
    return this.cfg.getWorkspaces().active;
  }

  active() {
    const data = this.cfg.getWorkspaces();
    const found = data.list.find((w) => w.id === data.active) || data.list[0];
    return { ...found, path: expandTilde(found.path) };
  }

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
      fs.mkdirSync(path.join(absPath, 'inbox'), { recursive: true });
    }
    this.cfg.saveWorkspaces(data);
    return { ...w, path: expandTilde(w.path) };
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

  resolveSafe(rel) {
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

  tree(depth = 5) {
    const walk = (abs, rel, d) => {
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return [];
      }
      const out = [];
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
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

  readText(rel) {
    const abs = this.resolveSafe(rel);
    const stat = fs.statSync(abs);
    if (stat.size > MAX_READ_BYTES) throw new Error('File too large to edit inline (> 2 MB)');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) throw new Error('Binary file - open it externally instead');
    return buf.toString('utf8');
  }

  writeText(rel, content) {
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
  readDoc(rel) {
    const abs = this.resolveSafe(rel);
    const kind = docKind(rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error('Not a file: ' + rel);
    const base = { kind: kind, mtimeMs: stat.mtimeMs, size: stat.size };
    if (kind === 'binary') return base;
    if (kind === 'pdf') return Object.assign(base, { fileUrl: pathToFileURL(abs).href });

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

  createFile(rel) {
    const abs = this.resolveSafe(rel);
    if (fs.existsSync(abs)) throw new Error('Already exists: ' + rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '');
  }

  createFolder(rel) {
    const abs = this.resolveSafe(rel);
    if (fs.existsSync(abs)) throw new Error('Already exists: ' + rel);
    fs.mkdirSync(abs, { recursive: true });
  }

  rename(fromRel, toRel) {
    fs.renameSync(this.resolveSafe(fromRel), this.resolveSafe(toRel));
  }

  // Copy a file from anywhere on disk into the active workspace inbox.
  // Deliberately a copy, not a move: the bridge watches ~/Downloads, which is
  // the user's folder, so nothing may disappear out of it.
  ingest(absSource, providerId) {
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

  /* ----- watchers ----- */

  watch(callback) {
    const chokidar = require('chokidar');
    if (this.watcher) this.watcher.close();
    let timer = null;
    this.watcher = chokidar.watch(this.getRoot(), {
      ignoreInitial: true,
      depth: 5,
      ignored: (p) => IGNORE.has(path.basename(p)),
    });
    this.watcher.on('all', () => {
      clearTimeout(timer);
      timer = setTimeout(callback, 200);
    });
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

module.exports = { WorkspaceManager, originApp, docKind };
