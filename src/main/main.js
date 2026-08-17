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
const { WorkspaceManager } = require('./workspace');
const { PtyManager } = require('./ptyManager');
const { systemCheck, claudeStatus, bindClaudeToWorkspace, mcpSnippet } = require('./installer');

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
    const inbox = workspace.inboxDir(provider.id);
    fs.mkdirSync(inbox, { recursive: true });
    const target = uniquePath(path.join(inbox, item.getFilename() || 'download'));
    item.setSavePath(target);
    item.once('done', (e, state) => {
      if (win) {
        win.webContents.send('download:done', {
          providerId: provider.id,
          provider: provider.name,
          workspace: workspace.active().name,
          filename: path.basename(target),
          path: target,
          state,
        });
      }
    });
  });
}

function setupAllProviderSessions() {
  for (const p of configStore.getProviders()) setupProviderSession(p);
}

// --- Downloads bridge (native apps -> active workspace) -------------------------

function applyBridgeSetting() {
  const on = configStore.getSettings().bridgeDownloads !== false;
  workspace.unwatchDownloads();
  if (!on) return;
  workspace.watchDownloads((absPath) => {
    try {
      const target = workspace.ingest(absPath, '_desktop');
      if (win) {
        win.webContents.send('download:done', {
          providerId: '_desktop',
          provider: 'Desktop app',
          workspace: workspace.active().name,
          filename: path.basename(target),
          path: target,
          state: 'completed',
        });
      }
    } catch (e) {
      if (win) win.webContents.send('download:done', {
        providerId: '_desktop', provider: 'Desktop app',
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

ipcMain.handle('workspaces:list', () => ({
  active: workspace.activeId(),
  list: workspace.list(),
}));

ipcMain.handle('workspaces:add', async (e, name) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Pick or create the workspace folder for "' + name + '"',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const id = workspace.add(name, res.filePaths[0]);
  workspace.setActive(id);
  workspace.watch(() => win && win.webContents.send('workspace:changed'));
  return { active: workspace.activeId(), list: workspace.list() };
});

ipcMain.handle('workspaces:setActive', (e, id) => {
  const ws = workspace.setActive(id);
  workspace.watch(() => win && win.webContents.send('workspace:changed'));
  return ws;
});

ipcMain.handle('workspaces:remove', (e, id) => {
  const active = workspace.remove(id);
  workspace.watch(() => win && win.webContents.send('workspace:changed'));
  return { active: active.id, list: workspace.list() };
});

// --- IPC: files (active workspace) -----------------------------------------------------

ipcMain.handle('workspace:getRoot', () => workspace.getRoot());
ipcMain.handle('workspace:tree', () => workspace.tree());
ipcMain.handle('workspace:read', (e, rel) => workspace.readText(rel));
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
  await shell.trashItem(workspace.resolveSafe(rel));
  return true;
});
ipcMain.handle('workspace:openPath', (e, rel) => shell.openPath(workspace.resolveSafe(rel)));

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

ipcMain.handle('conn:claudeStatus', () => claudeStatus());

ipcMain.handle('conn:bindClaude', () => {
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
  const id = ptys.spawn({ command: cmd, args: argv }, workspace.getRoot(), 110, 28, e.sender);
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
  const abs = workspace.resolveSafe(relPath);
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

ipcMain.handle('pty:spawn', (e, { profileId, cols, rows }) => {
  const profile = configStore.getCliProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error('Unknown CLI profile: ' + profileId);
  const cwd = workspace.getRoot();
  const id = ptys.spawn(profile, cwd, cols, rows, e.sender);
  return { id, workspace: workspace.active().name, cwd };
});

ipcMain.on('pty:write', (e, { id, data }) => ptys.write(id, data));
ipcMain.on('pty:resize', (e, { id, cols, rows }) => ptys.resize(id, cols, rows));
ipcMain.on('pty:kill', (e, { id }) => ptys.kill(id));

ipcMain.handle('cli:check', (e, command) => {
  if (!command) return true; // plain shell profile always works
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
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

// --- lifecycle -----------------------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    migrateFromOmniHub();
    adoptLoginShellPath();
    configStore = new ConfigStore(app);
    workspace = new WorkspaceManager(configStore);
    ptys = new PtyManager();
    setupAllProviderSessions();
    detectApps();
    workspace.watch(() => win && win.webContents.send('workspace:changed'));
    applyBridgeSetting();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    ptys && ptys.killAll();
    if (process.platform !== 'darwin') app.quit();
  });
}
