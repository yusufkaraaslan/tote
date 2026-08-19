// Workspace manager: two-level spaces (one Global + project workspaces).
// "Active workspace" is the routing context: downloads from web tabs,
// bridged files from native apps, and new CLI terminals all land here.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
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
    return TEXT_EXT.has(path.extname(name).toLowerCase());
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
          out.push({ name: e.name, path: childRel, type: 'file', text: this.isTextFile(e.name) });
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
    fs.writeFileSync(this.resolveSafe(rel), content, 'utf8');
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

module.exports = { WorkspaceManager, originApp };
