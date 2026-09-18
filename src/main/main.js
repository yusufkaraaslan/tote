// Tote main process.
// Model: two-level spaces (Global + project workspaces). The ACTIVE workspace
// is the routing context for everything: web-tab downloads, files bridged
// from native apps, and the cwd of every new CLI terminal.
const { app, BrowserWindow, ipcMain, dialog, shell, session, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execSync, execFileSync } = require('child_process');
const { ConfigStore } = require('./config');
const { WorkspaceManager, originApp } = require('./workspace');
const { PtyManager } = require('./ptyManager');
const { systemCheck, fixNpmPrefix, claudeStatus, bindClaudeToWorkspace, mcpSnippet } = require('./installer');
const { shq } = require('./sshfix');

// LLM sites (Cloudflare-fronted ones especially) reject UAs that don't match
// the real engine. Use Electron's own UA with the Electron/Tote tokens
// stripped, so platform + Chrome version stay truthful.
function chromeUA(ses) {
  return ses
    .getUserAgent()
    .replace(/\s?Electron\/[\d.]+/, '')
    .replace(new RegExp('\\s?' + app.getName().replace(/[^a-z0-9]/gi, '.') + '\\/[\\d.]+', 'i'), '');
}

// --- one-time migration from the old "OmniHub" name ------------------------------
// userData folder (config + session partitions) and partition dir names move to
// the new name so nobody loses settings or logins. Runs before any session exists.
function migrateFromOmniHub() {
  try {
    const newUD = app.getPath('userData');
    const oldUD = path.join(path.dirname(newUD), 'OmniHub');
    if (fs.existsSync(oldUD) && !fs.existsSync(path.join(newUD, 'config'))) {
      fs.mkdirSync(newUD, { recursive: true });
      for (const name of fs.readdirSync(oldUD)) {
        const from = path.join(oldUD, name);
        const to = path.join(newUD, name);
        if (!fs.existsSync(to)) fs.renameSync(from, to);
      }
      fs.writeFileSync(path.join(oldUD, 'MOVED-TO-Tote.txt'), 'Migrated to ' + newUD + '\n');
    }
    const parts = path.join(newUD, 'Partitions');
    if (fs.existsSync(parts)) {
      for (const name of fs.readdirSync(parts)) {
        if (name.startsWith('omnihub-')) {
          const to = path.join(parts, 'tote-' + name.slice('omnihub-'.length));
          if (!fs.existsSync(to)) fs.renameSync(path.join(parts, name), to);
        }
      }
    }
  } catch (e) {
    console.error('migration from OmniHub failed:', e.message);
  }
}

// --- inherited agent session ------------------------------------------------
// The environment that opened Tote is not the environment Tote should hand to
// its children, and it hands process.env to all of them: every pty, the
// wizard's installs, `cli:check`, local services.
//
// That matters when the thing that opened it was itself a CLI agent session.
// `npm run install:mac` is normally run from a docked terminal, its watcher
// reopens the app with `open`, and macOS passes that shell's environment
// straight through (the app comes up with ppid 1 and the agent's full marker
// set). Every terminal spawned afterwards then looks to Claude Code like a
// nested child of a session that has long since ended, so it turns transcript
// saving off and prints `inherited CLAUDE_CODE_CHILD_SESSION marker` -- for the
// entire life of that app instance, in every space.
//
// A terminal in Tote is a fresh top-level session, so the markers are dropped
// once, here, rather than at each spawn site.
//
// The list is explicit rather than a `CLAUDE_*` / `CLAUDE_CODE_*` wildcard on
// purpose: real user configuration lives under the same prefixes
// (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX`,
// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, an api-key helper's TTL), and silently
// deleting somebody's Bedrock or config-dir setting would be a worse bug than
// the one this fixes. A marker that is not on the list costs a warning; a
// config var that is costs a broken install.
const AGENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];
function dropInheritedAgentSession() {
  const found = AGENT_SESSION_VARS.filter((k) => process.env[k] !== undefined);
  for (const k of found) delete process.env[k];
  if (found.length) {
    console.log('[tote] dropped inherited agent-session vars: ' + found.join(', '));
  }
}

// --- login-shell PATH ------------------------------------------------------
// A GUI launch (Finder, Dock, .desktop entry) hands the app a minimal PATH —
// /usr/bin:/bin:/usr/sbin:/sbin on macOS — so npm, git and any CLI behind a
// version manager are invisible to everything we exec from here: the wizard's
// system check reports them missing, `cli:check` marks every profile
// uninstalled, and local services fail to start. Read the real PATH from the
// user's login shell once and adopt it. Agent terminals don't rely on this —
// ptyManager gives each one its own login shell so per-shell setups stay live.
function adoptLoginShellPath() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || '/bin/bash';
  const mark = '__TOTE_PATH__';
  try {
    // -i so the interactive rc file (where fnm/nvm/asdf hook in) is sourced;
    // markers because rc files are free to print banners around our output.
    const out = execFileSync(shell, ['-l', '-i', '-c', `printf '${mark}%s${mark}' "$PATH"`], {
      stdio: ['ignore', 'pipe', 'ignore'], // stdin closed: an rc file that reads gets EOF, not a hang
      timeout: 5000,
      encoding: 'utf8',
    });
    const found = out.split(mark)[1];
    if (!found) return;
    // Login shell wins on order, but keep anything it didn't mention.
    const seen = new Set();
    const merged = [];
    for (const dir of [...found.split(':'), ...(process.env.PATH || '').split(':')]) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        merged.push(dir);
      }
    }
    process.env.PATH = merged.join(':');
  } catch (e) {
    console.error('could not read PATH from login shell:', e.message);
  }
}

let win = null;
let configStore;
let workspace;
let ptys;
let swept = [];   // stale temp spaces removed at launch, reported once the UI is up

const partitionFor = (providerId) => `persist:tote-${providerId}`;

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  let i = 1;
  while (fs.existsSync(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

// --- provider sessions ---------------------------------------------------------

// Per-provider persistent session: keeps the login alive across restarts,
// spoofs a desktop Chrome UA, and routes downloads into the ACTIVE workspace's
// inbox/<provider>/ (resolved at download time, so switching spaces re-routes).
function setupProviderSession(provider) {
  const ses = session.fromPartition(partitionFor(provider.id));
  if (ses.__toteReady) return;
  ses.__toteReady = true;
  ses.setUserAgent(chromeUA(ses));

  ses.on('will-download', (event, item) => {
    // Chromium can only write to local disk, so a remote space downloads into a
    // staging folder and the finished file is pushed up afterwards. Which space
    // is active is read here, when the event fires, exactly as before.
    const space = workspace.active();
    const remote = workspace.isRemote(space);
    const inbox = remote ? workspace.stagingDir(provider.id) : workspace.inboxDir(provider.id);
    fs.mkdirSync(inbox, { recursive: true });
    const target = uniquePath(path.join(inbox, item.getFilename() || 'download'));
    item.setSavePath(target);
    item.once('done', async (e, state) => {
      let landed = target;
      let outcome = state;
      if (remote && state === 'completed') {
        try {
          landed = await workspace.ingestInto(space.id, target, provider.id);
          fs.rmSync(target, { force: true });        // the staged copy has served its purpose
        } catch (err) {
          outcome = 'interrupted: ' + err.message;   // the file is still in staging
        }
      }
      if (win) {
        win.webContents.send('download:done', {
          providerId: provider.id,
          provider: provider.name,
          workspace: space.name,
          filename: path.basename(landed),
          path: landed,
          state: outcome,
        });
      }
    });
  });
}

function setupAllProviderSessions() {
  for (const p of configStore.getProviders()) setupProviderSession(p);
}

// --- Downloads bridge (native apps -> active workspace) -------------------------

// Web tabs never come through here -- their downloads are intercepted by
// setupProviderSession() and written straight into inbox/<provider>/. This
// bridge exists only for NATIVE apps (Claude Desktop, ChatGPT.app, ...), which
// save wherever the OS tells them to, i.e. ~/Downloads.

// Names the quarantine stamp may carry for an app we consider ours. macOS
// records the app's bundle name ("Claude"), which is not always the label we
// show ("Claude Desktop"), so accept both -- for the built-in list and for
// anything the user added to apps.json themselves. Rebuilt per event so a
// newly added app works without a restart.
function bridgeAllowlist() {
  const names = new Set();
  const add = (n) => { const v = String(n || '').trim().toLowerCase(); if (v) names.add(v); };
  const bundleName = (p) => path.basename(String(p || ''), '.app');
  for (const ka of KNOWN_APPS) {
    add(ka.name);
    for (const cand of ka.candidates.darwin || []) add(bundleName(cand));
  }
  for (const entry of configStore.getApps().list) {
    add(entry.name);
    add(bundleName(entry.path));
  }
  return names;
}

function applyBridgeSetting() {
  const on = configStore.getSettings().bridgeDownloads !== false;
  workspace.unwatchDownloads();
  // macOS is the only platform that records WHICH app downloaded a file, and
  // without that the bridge cannot tell a Claude Desktop export from a bank
  // statement -- so it stays off everywhere else rather than guess (issue #1).
  if (!on || process.platform !== 'darwin') return;
  workspace.watchDownloads(async (absPath) => {
    const app = await originApp(absPath);
    // No origin (hand-made file) or an app we don't own (a browser, Slack,
    // AirDrop): not ours to touch.
    if (!app || !bridgeAllowlist().has(app.toLowerCase())) return;
    try {
      const target = await workspace.ingest(absPath, '_desktop');
      if (win) {
        win.webContents.send('download:done', {
          providerId: '_desktop',
          provider: app,
          workspace: workspace.active().name,
          filename: path.basename(target),
          path: target,
          state: 'completed',
        });
      }
    } catch (e) {
      if (win) win.webContents.send('download:done', {
        providerId: '_desktop', provider: app,
        workspace: workspace.active().name,
        filename: path.basename(absPath), path: absPath, state: 'interrupted: ' + e.message,
      });
    }
  });
}

// --- local services (e.g. DeepSeek Harness Web UI) ------------------------------

function ping(urlStr) {
  return new Promise((resolve) => {
    const req = http.get(urlStr, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureLocalService(provider) {
  if (await ping(provider.url)) return { started: true, alreadyRunning: true };
  const child = spawn(provider.local.startCommand, { shell: true, detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await sleep(1200);
    if (await ping(provider.url)) return { started: true, alreadyRunning: false };
  }
  throw new Error(`${provider.name} did not come up at ${provider.url} within 90s`);
}

// --- native app launcher ----------------------------------------------------------

// Best-effort detection of installed native LLM apps. Users can add any app
// manually via Settings; detection just seeds the list.
const KNOWN_APPS = [
  { id: 'claude-desktop', name: 'Claude Desktop', kind: 'claude', candidates: {
    darwin: ['/Applications/Claude.app'],
    win32: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Claude', 'Claude.exe')],
    linux: ['/usr/bin/claude-desktop', '/usr/local/bin/claude-desktop'],
  } },
  { id: 'chatgpt-desktop', name: 'ChatGPT', candidates: {
    darwin: ['/Applications/ChatGPT.app'],
    win32: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ChatGPT', 'ChatGPT.exe')],
    linux: [],
  } },
  { id: 'kimi-desktop', name: 'Kimi', candidates: {
    darwin: ['/Applications/Kimi.app'],
    win32: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Kimi', 'Kimi.exe')],
    linux: [],
  } },
  { id: 'cherry-studio', name: 'Cherry Studio', kind: 'mcp', candidates: {
    darwin: ['/Applications/Cherry Studio.app'],
    win32: [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cherry Studio', 'Cherry Studio.exe')],
    linux: [],
  } },
];

function detectApps() {
  const data = configStore.getApps();
  if (data.list.length > 0) return; // user already has a list; don't re-seed
  const plat = process.platform;
  for (const ka of KNOWN_APPS) {
    for (const cand of ka.candidates[plat] || []) {
      if (cand && fs.existsSync(cand)) {
        data.list.push({ id: ka.id, name: ka.name, path: cand, kind: ka.kind || 'generic' });
        break;
      }
    }
  }
  configStore.saveApps(data);
}

async function launchApp(entry) {
  const wsName = workspace.active().name;
  const rootPath = workspace.getRoot();
  let note = null;
  if (entry.kind === 'claude') {
    try {
      const cfgPath = bindClaudeToWorkspace(rootPath);
      note = `bound to workspace "${wsName}" via MCP (${cfgPath}). Restart Claude Desktop if it was open.`;
    } catch (e) {
      note = 'MCP bind failed: ' + e.message;
    }
  }
  if (process.platform === 'darwin' && entry.path.endsWith('.app')) {
    spawn('open', [entry.path], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(entry.path, [], { detached: true, stdio: 'ignore' }).unref();
  }
  return { launched: entry.name, workspace: wsName, note };
}

// --- window ------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 660,
    backgroundColor: '#0b0e14',
    title: 'Tote',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // On macOS the app outlives its window (`window-all-closed` only quits
  // elsewhere) and every call on a destroyed BrowserWindow throws "Object has
  // been destroyed". Drop the reference so the `if (win)` guards on the
  // download pushes, the watcher and `second-instance` mean "a live window".
  win.on('closed', () => {
    win = null;
  });

  // Re-activation is the renderer's cue to put keyboard focus back inside the
  // focused pane. The main process is the authority on window activation: the
  // renderer's own `focus` event is ambiguous once a webview guest is involved.
  win.on('focus', () => {
    if (win) win.webContents.send('win:focus');
  });

  // The sweep already ran at startup; the renderer can only be told once it has
  // a toast area to show it in.
  win.webContents.once('did-finish-load', () => {
    if (swept.length) win.webContents.send('workspace:swept', swept);
  });

  // The shell page never navigates. Anything that tries is a file dropped onto
  // a spot that did not handle it -- Chromium's default is to open it in place,
  // which would replace the whole UI with the dropped image.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
}

// Popups from embedded webviews (OAuth windows, "open in new tab" links).
// They MUST open in-app so they share the provider's session partition —
// otherwise a Google/GitHub login completes in the system browser and the
// webview never sees the cookies. Only non-web schemes go external.
app.on('web-contents-created', (event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          parent: win || undefined,
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

// --- IPC: workspaces -----------------------------------------------------------------

// The tree watcher is bound to the active root; re-arm it after anything that
// can change which folder is active.
const watchActive = () => workspace.watch(() => win && win.webContents.send('workspace:changed'));
const wsState = () => ({ active: workspace.activeId(), list: workspace.list() });

ipcMain.handle('workspaces:list', () => wsState());

ipcMain.handle('workspaces:add', async (e, name) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Pick or create the workspace folder for "' + name + '"',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const id = workspace.add(name, res.filePaths[0]);
  workspace.setActive(id);
  watchActive();
  return wsState();
});

ipcMain.handle('workspaces:setActive', (e, id) => {
  const ws = workspace.setActive(id);
  watchActive();
  return ws;
});

ipcMain.handle('workspaces:remove', async (e, id) => {
  const space = workspace.list().find((w) => w.id === id);
  if (space && workspace.isRemote(space)) {
    try { await workspace.conn(space).disconnect(); } catch {}
    workspace.conns.delete(id);
  }
  workspace.remove(id);
  watchActive();
  return wsState();
});

// Strip order only -- the active space and every watcher stay as they are.
ipcMain.handle('workspaces:reorder', (e, ids) => {
  workspace.reorder(ids);
  return wsState();
});

ipcMain.handle('workspaces:rename', (e, id, name) => {
  workspace.updateSpace(id, { name });
  return wsState();
});

// Point an existing space at a different folder (folder picker). Nothing on
// disk moves; open terminals keep their old cwd.
ipcMain.handle('workspaces:setPath', async (e, id) => {
  const w = workspace.list().find((x) => x.id === id);
  if (!w) throw new Error('Unknown workspace: ' + id);
  const res = await dialog.showOpenDialog(win, {
    title: 'Pick the folder for workspace "' + w.name + '"',
    defaultPath: w.path,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  workspace.updateSpace(id, { path: res.filePaths[0] });
  if (id === workspace.activeId()) watchActive();
  return wsState();
});

// --- IPC: temp (scratch) spaces --------------------------------------------
// A temp space skips the folder picker and can be deleted, files included --
// the one exception to "removing a space never touches the disk".

// --- IPC: remote spaces --------------------------------------------------------------------

// Registering and connecting are deliberately separate. The space exists the
// moment it is named, so the connect pane -- and every later reconnect, of which
// there will be many, because Tailscale's check expires on a timer -- runs
// against a real space through exactly one code path.
ipcMain.handle('workspaces:addRemote', (e, { name, host, path: remotePath }) => {
  const id = workspace.addRemote(name, host, remotePath);
  workspace.setActive(id);
  watchActive();
  return wsState();
});

// Opens the one interactive ssh session that may authenticate, and hands the
// renderer its pty id so it can mount it as an ordinary terminal pane.
ipcMain.handle('remote:connect', (e, { id, cols, rows, mkdir }) => {
  const space = workspace.list().find((w) => w.id === id) || workspace.active();
  if (!workspace.isRemote(space)) throw new Error('Not a remote space: ' + space.name);
  const conn = workspace.conn(space);
  conn.connect({ cols, rows, sender: e.sender, mkdir }).then(() => {
    if (workspace.activeId() === space.id) watchActive();   // start polling once up
  });
  return conn.info();
});

ipcMain.handle('remote:state', (e, id) => workspace.remoteState(id));

ipcMain.handle('remote:disconnect', async (e, id) => {
  const space = workspace.list().find((w) => w.id === id);
  if (space && workspace.isRemote(space)) await workspace.conn(space).disconnect();
  return workspace.remoteState(id);
});

ipcMain.handle('workspaces:tempName', () => workspace.suggestTempName());

ipcMain.handle('workspaces:addTemp', (e, name) => {
  const id = workspace.addTemp(name);
  workspace.setActive(id);
  watchActive();
  return wsState();
});

// termLabels comes from the renderer because only it knows which PTY belongs to
// which space. The confirm lives here: this is where the native dialog is, and
// deleting files deserves one rather than the renderer's confirm().
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
    title: 'Keep "' + w.name + '" -- pick its permanent folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  workspace.promote(id, res.filePaths[0]);
  if (id === workspace.activeId()) watchActive();
  return wsState();
});

// --- IPC: files (active workspace) -----------------------------------------------------

ipcMain.handle('workspace:getRoot', () => workspace.getRoot());
ipcMain.handle('workspace:tree', () => workspace.tree());
ipcMain.handle('workspace:read', (e, rel) => workspace.readText(rel));
ipcMain.handle('workspace:readDoc', (e, rel) => workspace.readDoc(rel));
ipcMain.handle('workspace:write', (e, rel, content) => {
  workspace.writeText(rel, content);
  return true;
});
ipcMain.handle('workspace:createFile', (e, rel) => {
  workspace.createFile(rel);
  return true;
});
ipcMain.handle('workspace:createFolder', (e, rel) => {
  workspace.createFolder(rel);
  return true;
});
ipcMain.handle('workspace:rename', (e, from, to) => {
  workspace.rename(from, to);
  return true;
});
ipcMain.handle('workspace:trash', async (e, rel) => {
  const R = workspace.backend();
  if (R) await R.trash(rel);                 // moves into the space's .tote-trash/
  else await shell.trashItem(workspace.resolveSafe(rel));
  return true;
});
ipcMain.handle('workspace:openPath', (e, rel) => shell.openPath(workspace.resolveSafe(rel)));
// Reveal selects the item in the OS file manager; openPath hands it to its
// default application instead. Both stay inside resolveSafe.
ipcMain.handle('workspace:revealPath', (e, rel) => {
  shell.showItemInFolder(workspace.resolveSafe(rel));
});

// --- IPC: config ------------------------------------------------------------------------

ipcMain.handle('config:getProviders', () => configStore.getProviders());
ipcMain.handle('config:saveProviders', (e, list) => {
  configStore.saveProviders(list);
  setupAllProviderSessions();
  return true;
});
ipcMain.handle('config:getCliProfiles', () => configStore.getCliProfiles());
ipcMain.handle('config:saveCliProfiles', (e, list) => {
  configStore.saveCliProfiles(list);
  return true;
});
ipcMain.handle('config:openDir', () => shell.openPath(configStore.getDir()));

ipcMain.handle('views:get', () => configStore.getViews());
ipcMain.handle('views:save', (e, data) => {
  configStore.saveViews(data);
  return true;
});

ipcMain.handle('settings:get', () => configStore.getSettings());
ipcMain.handle('settings:save', (e, s) => {
  configStore.saveSettings(s);
  applyBridgeSetting();
  return true;
});

// --- IPC: apps -----------------------------------------------------------------------------

ipcMain.handle('apps:list', () => configStore.getApps().list);

ipcMain.handle('apps:add', async (e, name) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Pick the app binary for "' + name + '"',
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const data = configStore.getApps();
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36);
  data.list.push({ id, name, path: res.filePaths[0], kind: 'generic' });
  configStore.saveApps(data);
  return data.list;
});

ipcMain.handle('apps:remove', (e, id) => {
  const data = configStore.getApps();
  data.list = data.list.filter((a) => a.id !== id);
  configStore.saveApps(data);
  return data.list;
});

ipcMain.handle('apps:launch', (e, id) => {
  const entry = configStore.getApps().list.find((a) => a.id === id);
  if (!entry) throw new Error('Unknown app: ' + id);
  return launchApp(entry);
});

// --- IPC: setup wizard / connections -------------------------------------------------------------

ipcMain.handle('setup:systemCheck', () => systemCheck(ptys));

// Wizard self-heal: after an `npm i -g` fails with EACCES, point npm's global
// prefix at ~/.local when that is safe (guards live in installer/npmfix).
ipcMain.handle('setup:fixNpmPrefix', () => fixNpmPrefix());

ipcMain.handle('conn:claudeStatus', () => claudeStatus());

ipcMain.handle('conn:bindClaude', () => {
  if (workspace.isRemote(workspace.active())) {
    throw new Error('Claude Desktop runs on this machine and cannot be bound to a remote space');
  }
  const cfgPath = bindClaudeToWorkspace(workspace.getRoot());
  return { cfgPath, workspace: workspace.active().name, root: workspace.getRoot() };
});

ipcMain.handle('conn:mcpSnippet', () => mcpSnippet(workspace.getRoot()));

// Run an arbitrary install/setup command in a PTY rooted at the active
// workspace, so the wizard can stream real output into a mini terminal.
ipcMain.handle('pty:run', (e, { command, args }) => {
  let cmd = command;
  let argv = args || [];
  if (argv.length === 0 && command.includes(' ')) {
    const parts = command.split(' ').filter(Boolean);
    cmd = parts[0];
    argv = parts.slice(1);
  }
  const id = ptys.spawn({ command: cmd, args: argv }, workspace.localCwd(), 110, 28, e.sender);
  return { id };
});

// --- IPC: providers / tabs -------------------------------------------------------------------

ipcMain.handle('provider:ensureLocal', async (e, providerId) => {
  const provider = configStore.getProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error('Unknown provider: ' + providerId);
  if (!provider.local) return { started: true, alreadyRunning: true };
  return ensureLocalService(provider);
});

// Experimental: attach a workspace file into a web tab by injecting a File
// into the page's file input (or firing a synthetic drop event).
const SEND_FILE_MAX = 15 * 1024 * 1024;
ipcMain.handle('tab:sendFile', async (e, { wcId, relPath }) => {
  const abs = await workspace.localFileFor(relPath);
  const stat = fs.statSync(abs);
  if (stat.size > SEND_FILE_MAX) throw new Error('File too large for in-page attach (> 15 MB)');
  const wc = webContents.fromId(wcId);
  if (!wc) throw new Error('Tab is not ready yet - click it first, then retry.');
  const b64 = fs.readFileSync(abs).toString('base64');
  const name = path.basename(abs);
  const script = `(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(name)});
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[type="file"]');
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'attached via file input';
    }
    const zone = document.querySelector('[class*="drop"], [data-testid*="drop"], body');
    for (const type of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return 'dropped onto page';
  })()`;
  return wc.executeJavaScript(script);
});

// --- IPC: terminals ------------------------------------------------------------------------------

ipcMain.handle('pty:available', () => ptys.available());

ipcMain.handle('pty:spawn', async (e, { profileId, cols, rows }) => {
  const profile = configStore.getCliProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error('Unknown CLI profile: ' + profileId);
  const space = workspace.active();
  const conn = workspace.isRemote(space) ? workspace.conn(space) : null;
  // Try to heal silently first: after a sleep the master is usually just gone,
  // and rebuilding it needs no human at all. Only send the user to the connect
  // pane when it genuinely needs one.
  if (conn && conn.state !== 'up' && !(await conn.silentConnect())) {
    throw new Error(`${conn.host}: ${conn.message} — use the connect button in the files pane`);
  }
  const cwd = workspace.localCwd();
  const id = ptys.spawn(profile, cwd, cols, rows, e.sender, conn);
  return { id, workspace: space.name, cwd: conn ? conn.root : cwd, host: conn ? conn.host : null };
});

ipcMain.on('pty:write', (e, { id, data }) => ptys.write(id, data));
ipcMain.on('pty:resize', (e, { id, cols, rows }) => ptys.resize(id, cols, rows));
ipcMain.on('pty:kill', (e, { id }) => ptys.kill(id));

ipcMain.handle('cli:check', async (e, command) => {
  if (!command) return true; // plain shell profile always works
  // A remote space runs the agent on the remote, so that is where it has to
  // exist -- checking this machine would report the opposite of the truth.
  const R = workspace.backend();
  if (R) {
    try {
      await R.conn.run(`command -v ${shq(command)} >/dev/null`);
      return true;
    } catch { return false; }
  }
  try {
    const cmd =
      process.platform === 'win32' ? `where "${command}"` : `command -v "${command}"`;
    execSync(cmd, { stdio: 'ignore', shell: process.platform === 'win32' ? undefined : '/bin/sh' });
    return true;
  } catch {
    return false;
  }
});

// --- IPC: misc ---------------------------------------------------------------------------------------

ipcMain.on('app:openExternal', (e, url) => {
  // mailto: is here for links in a rendered doc -- the markdown parser allows
  // that scheme, so dropping it here would make those links silently dead.
  if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url);
});

// --- lifecycle -----------------------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // No window means it was closed with the app still alive (macOS): open one,
    // as `activate` does. Before ready there is nothing to do -- `whenReady`
    // is about to create it.
    if (!win) {
      if (app.isReady()) createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    migrateFromOmniHub();
    dropInheritedAgentSession();     // before anything can spawn a child
    adoptLoginShellPath();
    configStore = new ConfigStore(app);
    workspace = new WorkspaceManager(configStore);
    // Stale temp spaces go at launch and only at launch, so nothing can vanish
    // mid-session. The report is pushed once the window can show a toast.
    swept = workspace.sweepTemp(configStore.getSettings().scratchDays ?? 7);
    ptys = new PtyManager();
    // RemoteConn needs a pty it can both stream to a pane and read itself, plus
    // the userData paths; main.js is the only layer that has all three.
    workspace.configureRemote({
      socketDir: path.join(app.getPath('userData'), 'ssh'),
      cacheDir: path.join(app.getPath('userData'), 'remote'),
      launchPty: (spec, sender, onData, onExit) => ptys.launch(spec, sender, onData, onExit),
      onState: (info) => { if (win) win.webContents.send('remote:state', info); },
      // Tailscale's check blocks the ssh session until this page is visited, so
      // opening it is what unblocks the connect -- and it goes to the system
      // browser, where the user's Tailscale login already lives.
      onAuthUrl: (url) => shell.openExternal(url),
    });
    setupAllProviderSessions();
    detectApps();
    // If the active space is remote, its master is very likely still up from
    // the last run. Try it silently before the window appears, so the usual case
    // is a tree that is simply there.
    const active = workspace.active();
    if (workspace.isRemote(active)) {
      workspace.conn(active).silentConnect().then(() => watchActive()).catch(() => {});
    }
    watchActive();
    applyBridgeSetting();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // The normal macOS quit never reaches `window-all-closed`. Cmd+Q (and any
  // `app.quit()`) closes the windows itself and then goes straight to
  // `will-quit` -- measured: `before-quit -> will-quit`, no `window-all-closed`
  // -- so this is the only hook that sees it. Without it the ptys are still
  // alive when Node tears the environment down, node-pty's exit-callback thread
  // fires its ThreadSafeFunction into a dying env, and napi throws a C++
  // exception with no JS left to throw it into: `abort()`, a SIGABRT crash
  // report on every single quit, and a `will-quit` that never finishes.
  app.on('before-quit', () => {
    ptys && ptys.killAll();
  });

  app.on('window-all-closed', () => {
    ptys && ptys.killAll();
    // The ssh masters are deliberately left running: ControlPersist=yes outlives
    // Tote, so the next launch reconnects to a still-authenticated connection
    // instead of sending the user back to a browser login.
    if (process.platform !== 'darwin') app.quit();
  });
}
