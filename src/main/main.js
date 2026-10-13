// Tote main process.
// Model: two-level spaces (Global + project workspaces). A space is the routing
// context for everything: web-tab downloads, files bridged from native apps,
// and the cwd of every new CLI terminal.
//
// Split in two since the devices design (docs/superpowers/specs/
// 2026-10-12-devices-design.md): src/host/ owns the device -- spaces, files,
// views, terminals -- and serves VIEWERS. Every window is a viewer with its own
// active space. This file is the viewer side: windows, web sessions, native
// apps, the wizard, and the IPC routing in front of the host.
const { app, BrowserWindow, ipcMain, dialog, shell, session, webContents, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execSync, execFileSync } = require('child_process');
const { ConfigStore } = require('./config');
const { WorkspaceManager, originApp } = require('./workspace');
const { PtyManager } = require('./ptyManager');
const { systemCheck, fixNpmPrefix, claudeStatus, bindClaudeToWorkspace, mcpSnippet } = require('./installer');
const { Host } = require('../host/host');
const CH = require('../host/channels');
const { DeviceServer, tailnetAuthorizer } = require('../host/server');
const TS = require('../host/tailscale');
const { DeviceClient, discover } = require('./devices');

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

let configStore;
let workspace;
let ptys;
let host;
let lastFocused = null;   // viewer id of the window that last had focus
let deviceServer = null;  // this machine's listener, while sharing is on
let shareError = null;    // why sharing is not on, when it should be
// webContents id -> { client, name, address, port }: the windows looking at
// ANOTHER machine's Tote. A window not in here talks to the local host.
const viewing = new Map();
let swept = [];   // stale temp spaces removed at launch, reported once the UI is up

const partitionFor = (providerId) => `persist:tote-${providerId}`;

// A window's viewer id. One webContents per window, and it outlives nothing.
const viewerIdOf = (wc) => 'w' + wc.id;

// The space a window is looking at; the most recently focused window's for
// events that come from no window at all (a native app's download).
function spaceOfWindow(wc) {
  const v = wc && host.viewers.get(viewerIdOf(wc));
  if (v) return v.wsId;
  const last = lastFocused && host.viewers.get(lastFocused);
  return last ? last.wsId : workspace.activeId();
}

const winOf = (e) => BrowserWindow.fromWebContents(e.sender) || undefined;

/* ----- devices ----- */

const DEFAULT_DEVICE_PORT = 47821;
const devicePort = () => Number(configStore.getSettings().devicePort) || DEFAULT_DEVICE_PORT;
const deviceOf = (wc) => viewing.get(wc.id) || null;

let selfNameCache = null;
async function selfName() {
  if (selfNameCache) return selfNameCache;
  try { selfNameCache = (await TS.status()).self.name; } catch { selfNameCache = os.hostname(); }
  return selfNameCache;
}

// Things that only make sense against THIS machine's disk refuse while the
// window is looking at another one, rather than acting on the wrong machine.
function localOnly(e, what) {
  const d = deviceOf(e.sender);
  if (d) throw new Error(what + ' is not available while viewing ' + d.name);
}

/* Share this machine: listen on its tailnet address, and only there. Opt-in
 * (settings.shareDevice) -- a machine nobody meant to expose must not become
 * reachable because Tote updated. Re-applied on every settings save. */
async function applyShareSetting() {
  const want = configStore.getSettings().shareDevice === true;
  const port = devicePort();
  if (deviceServer && (!want || !deviceServer.address.endsWith(':' + port))) {
    await deviceServer.stop();
    deviceServer = null;
  }
  shareError = null;
  if (!want || deviceServer) return;
  try {
    const bind = await TS.ip4();
    const server = new DeviceServer({
      host, device: await selfName(), tote: app.getVersion(), authorize: tailnetAuthorizer(),
    });
    await server.start({ bind, port });
    deviceServer = server;
    console.log('[tote] sharing this device on ' + server.address);
  } catch (e) {
    shareError = e.code === 'EADDRINUSE' ? 'port ' + port + ' is already in use' : e.message;
    console.error('[tote] could not share this device:', shareError);
  }
}

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

  ses.on('will-download', (event, item, guest) => {
    // Chromium can only write to local disk, so a remote space downloads into a
    // staging folder and the finished file is pushed up afterwards. The space is
    // the one the webview's WINDOW is looking at, read when the event fires.
    const owner = guest && (guest.hostWebContents || guest);
    const W = workspace.scoped(spaceOfWindow(owner));
    const space = W.active();
    const remote = workspace.isRemote(space);
    const inbox = remote ? W.stagingDir(provider.id) : W.inboxDir(provider.id);
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
      if (owner && !owner.isDestroyed()) {
        owner.send('download:done', {
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

// Keep awake: hold a power-save blocker while the setting is on, so a device
// left running agents stays reachable instead of idling to sleep. It stops
// IDLE sleep only -- closing a lid still sleeps the Mac unless it is in
// clamshell mode, and nothing an app can ask for changes that.
let awakeBlocker = null;
function applyKeepAwake() {
  const on = configStore.getSettings().keepAwake === true;
  if (on && awakeBlocker === null) {
    awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && awakeBlocker !== null) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = null;
  }
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
    // No window started it, so it goes to the space of the window you were
    // last in -- the closest thing to "where you are" a native app has.
    const W = workspace.scoped(spaceOfWindow(null));
    try {
      const target = await W.ingest(absPath, '_desktop');
      host.emit('download:done', {
        providerId: '_desktop',
        provider: app,
        workspace: W.active().name,
        filename: path.basename(target),
        path: target,
        state: 'completed',
      });
    } catch (e) {
      host.emit('download:done', {
        providerId: '_desktop', provider: app,
        workspace: W.active().name,
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

async function launchApp(entry, W) {
  const wsName = W.active().name;
  const rootPath = W.getRoot();
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

// Every window is a viewer of the local host, with its own active space. More
// than one is allowed (app:newWindow) -- which is also how the host/viewer
// split is exercised on one machine before any network exists.
function createWindow() {
  const win = new BrowserWindow({
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
  const wc = win.webContents;
  const vid = viewerIdOf(wc);
  // Registered before the page loads, so its first IPC call finds a viewer.
  // `send` guards on isDestroyed: a closing window can still be handed an
  // event, and every call on a destroyed webContents throws.
  // While the window looks at another machine, this machine's host has
  // nothing to tell it: those events would land in a renderer showing a
  // different device's spaces and terminals.
  host.addViewer({ id: vid, send: (ev, payload) => {
    if (!wc.isDestroyed() && !viewing.has(wc.id)) wc.send(ev, payload);
  } });
  lastFocused = vid;
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Its terminals keep running: the sessions belong to the host, and another
  // window -- or a later one -- re-attaches with a replay.
  const wcId = wc.id;
  win.on('closed', () => {
    const d = viewing.get(wcId);
    if (d) { viewing.delete(wcId); d.client.close(); }
    host.removeViewer(vid);
    if (lastFocused === vid) lastFocused = null;
  });

  // Re-activation is the renderer's cue to put keyboard focus back inside the
  // focused pane. The main process is the authority on window activation: the
  // renderer's own `focus` event is ambiguous once a webview guest is involved.
  win.on('focus', () => {
    lastFocused = vid;
    if (!wc.isDestroyed()) wc.send('win:focus');
  });

  // The sweep already ran at startup; the renderer can only be told once it has
  // a toast area to show it in.
  wc.once('did-finish-load', () => {
    if (swept.length) wc.send('workspace:swept', swept);
  });

  // The shell page never navigates. Anything that tries is a file dropped onto
  // a spot that did not handle it -- Chromium's default is to open it in place,
  // which would replace the whole UI with the dropped image.
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) e.preventDefault();
  });
  return win;
}

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
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
          parent: BrowserWindow.fromWebContents(contents.hostWebContents) || undefined,
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

// --- IPC: the host's channels ----------------------------------------------------------

// Everything the device owns is forwarded, by channel name, to the host's
// method of the same name, with the calling window as the viewer. The table
// of which channels those are is src/host/channels.js.
//
// A window viewing another device sends the same call to THAT device's host
// instead. The renderer cannot tell the difference, which is the point.
function route(e, name, args) {
  const d = deviceOf(e.sender);
  return d ? d.client.call(name, args) : host.call(name, viewerIdOf(e.sender), args);
}

function registerHostChannels() {
  for (const ch of CH.HOST) {
    if (CH.FIRE.has(ch)) {
      ipcMain.on(ch, (e, ...args) => { route(e, ch, args).catch(() => {}); });
    } else {
      ipcMain.handle(ch, (e, ...args) => route(e, ch, args));
    }
  }
}

const hostCall = (e, name, ...args) => route(e, name, args);

// --- IPC: split channels (a picker here, the operation on the host) ------------------

ipcMain.handle('workspaces:add', async (e, name) => {
  localOnly(e, 'Adding a folder space');
  const res = await dialog.showOpenDialog(winOf(e), {
    title: 'Pick or create the workspace folder for "' + name + '"',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return hostCall(e, 'workspaces:addLocal', name, res.filePaths[0]);
});

// Point an existing space at a different folder (folder picker). Nothing on
// disk moves; open terminals keep their old cwd.
ipcMain.handle('workspaces:setPath', async (e, id) => {
  localOnly(e, 'Picking a folder');
  const w = workspace.space(id);
  if (!w) throw new Error('Unknown workspace: ' + id);
  const res = await dialog.showOpenDialog(winOf(e), {
    title: 'Pick the folder for workspace "' + w.name + '"',
    defaultPath: w.path,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return hostCall(e, 'workspaces:setPathTo', id, res.filePaths[0]);
});

// A temp space skips the folder picker and can be deleted, files included --
// the one exception to "removing a space never touches the disk". The confirm
// lives here because this is where the native dialog is, and deleting files
// deserves one rather than the renderer's confirm(). Which terminals die comes
// from the host, which is what knows; the renderer's list is no longer needed.
ipcMain.handle('workspaces:discard', async (e, id) => {
  const m = await hostCall(e, 'workspaces:measure', id);
  const size = m.bytes < 1048576 ? Math.round(m.bytes / 1024) + ' KB'
    : (m.bytes / 1048576).toFixed(1) + ' MB';
  const kills = m.terms.length
    ? '\n\nRunning terminals that will be killed: ' + m.terms.join(', ')
    : '';
  const res = await dialog.showMessageBox(winOf(e), {
    type: 'warning',
    buttons: ['Cancel', 'Delete'],
    defaultId: 0,
    cancelId: 0,
    title: 'Discard temp space',
    message: 'Delete "' + m.name + '" and everything in it?',
    detail: m.path + '\n' + m.files + ' file(s), ' + size + kills + '\n\nThis cannot be undone.',
  });
  if (res.response !== 1) return { canceled: true };
  return hostCall(e, 'workspaces:discardConfirmed', id);
});

ipcMain.handle('workspaces:promote', async (e, id) => {
  localOnly(e, 'Picking a folder');
  const w = workspace.space(id);
  if (!w) throw new Error('Unknown workspace: ' + id);
  const res = await dialog.showOpenDialog(winOf(e), {
    title: 'Keep "' + w.name + '" -- pick its permanent folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return hostCall(e, 'workspaces:promoteTo', id, res.filePaths[0]);
});

// --- IPC: files that need THIS machine's shell --------------------------------------
// Reveal selects the item in the OS file manager; openPath hands it to its
// default application instead. Both stay inside resolveSafe.

const viewerWs = (e) => workspace.scoped(spaceOfWindow(e.sender));
ipcMain.handle('workspace:openPath', (e, rel) => {
  localOnly(e, 'Opening with this machine\'s apps');
  return shell.openPath(viewerWs(e).resolveSafe(rel));
});
ipcMain.handle('workspace:revealPath', (e, rel) => {
  localOnly(e, 'Revealing in this machine\'s file manager');
  shell.showItemInFolder(viewerWs(e).resolveSafe(rel));
});

// --- IPC: devices ------------------------------------------------------------------------

// Your other machines with Tote, probed live, plus whether this one is shared.
ipcMain.handle('devices:list', async () => {
  const share = { on: !!deviceServer, address: deviceServer && deviceServer.address, error: shareError };
  try {
    return { ...(await discover({ port: devicePort(), device: await selfName() })), share };
  } catch (e) {
    return { self: null, devices: [], share, error: e.message };
  }
});

ipcMain.handle('devices:current', (e) => {
  const d = deviceOf(e.sender);
  return d ? { name: d.name, address: d.address, port: d.port } : null;
});

/* Point this window at another machine's Tote (or back home with null).
 * The renderer reloads itself afterwards and simply comes up against the new
 * host: every host channel is routed by route(), so nothing in it changes. */
ipcMain.handle('devices:view', async (e, target) => {
  const wc = e.sender;
  const old = viewing.get(wc.id);
  if (old) { viewing.delete(wc.id); old.client.close(); }
  if (!target) { host.syncWatches(); return null; }
  const port = Number(target.port) || devicePort();
  const entry = { client: null, name: target.name || target.address, address: target.address, port };
  entry.client = new DeviceClient({
    address: target.address, port, device: await selfName(),
    onEvent: (ev, payload) => { if (viewing.get(wc.id) === entry && !wc.isDestroyed()) wc.send(ev, payload); },
    onClose: (code, reason) => {
      if (viewing.get(wc.id) !== entry) return;
      viewing.delete(wc.id);
      if (!wc.isDestroyed()) wc.send('devices:lost', { name: entry.name, reason });
    },
  });
  const hello = await entry.client.connect();
  if (!target.name && hello.device) entry.name = hello.device;
  // This machine's terminals stop streaming into a window that no longer shows them.
  host.sessions.detachAll(viewerIdOf(wc));
  viewing.set(wc.id, entry);
  return { name: entry.name, address: entry.address, port };
});

// --- IPC: config ------------------------------------------------------------------------

ipcMain.handle('config:getProviders', () => configStore.getProviders());
ipcMain.handle('config:saveProviders', (e, list) => {
  configStore.saveProviders(list);
  setupAllProviderSessions();
  return true;
});
ipcMain.handle('config:openDir', () => shell.openPath(configStore.getDir()));

ipcMain.handle('settings:get', () => configStore.getSettings());
ipcMain.handle('settings:save', (e, s) => {
  configStore.saveSettings(s);
  applyBridgeSetting();
  applyKeepAwake();
  applyShareSetting();
  return true;
});

// --- IPC: apps -----------------------------------------------------------------------------

ipcMain.handle('apps:list', () => configStore.getApps().list);

ipcMain.handle('apps:add', async (e, name) => {
  const res = await dialog.showOpenDialog(winOf(e), {
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
  localOnly(e, 'Launching a native app into a space');
  return launchApp(entry, viewerWs(e));
});

// --- IPC: setup wizard / connections -------------------------------------------------------------

ipcMain.handle('setup:systemCheck', () => systemCheck(ptys));

// Wizard self-heal: after an `npm i -g` fails with EACCES, point npm's global
// prefix at ~/.local when that is safe (guards live in installer/npmfix).
ipcMain.handle('setup:fixNpmPrefix', () => fixNpmPrefix());

ipcMain.handle('conn:claudeStatus', () => claudeStatus());

ipcMain.handle('conn:bindClaude', (e) => {
  localOnly(e, 'Binding Claude Desktop');
  const W = viewerWs(e);
  if (workspace.isRemote(W.active())) {
    throw new Error('Claude Desktop runs on this machine and cannot be bound to a remote space');
  }
  const cfgPath = bindClaudeToWorkspace(W.getRoot());
  return { cfgPath, workspace: W.active().name, root: W.getRoot() };
});

ipcMain.handle('conn:mcpSnippet', (e) => {
  localOnly(e, 'An MCP snippet for this machine');
  return mcpSnippet(viewerWs(e).getRoot());
});

// Run an arbitrary install/setup command in a PTY rooted at the window's
// space, so the wizard can stream real output into a mini terminal. Not a host
// session: the wizard installs on THIS machine, and nobody else watches it.
ipcMain.handle('pty:run', (e, { command, args }) => {
  let cmd = command;
  let argv = args || [];
  if (argv.length === 0 && command.includes(' ')) {
    const parts = command.split(' ').filter(Boolean);
    cmd = parts[0];
    argv = parts.slice(1);
  }
  const id = ptys.spawn({ command: cmd, args: argv }, viewerWs(e).localCwd(), 110, 28, e.sender);
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
// Split: the bytes come from the host, the injection happens here, where the
// webview is.
ipcMain.handle('tab:sendFile', async (e, { wcId, relPath }) => {
  const wc = webContents.fromId(wcId);
  if (!wc) throw new Error('Tab is not ready yet - click it first, then retry.');
  const { name, b64 } = await hostCall(e, 'workspace:fileBytes', relPath);
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

// --- IPC: misc ---------------------------------------------------------------------------------------

ipcMain.handle('app:newWindow', () => { createWindow(); });

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
    const win = focusedWindow();
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
    host = new Host({
      cfg: configStore, workspace, ptys,
      platform: { trash: (abs) => shell.trashItem(abs), openExternal: (url) => shell.openExternal(url) },
    });
    registerHostChannels();
    // RemoteConn needs a pty it can both stream to a pane and read itself, plus
    // the userData paths; main.js is the only layer that has all three. Its pty
    // is a host session, so every viewer can see the connect pane.
    workspace.configureRemote({
      socketDir: path.join(app.getPath('userData'), 'ssh'),
      cacheDir: path.join(app.getPath('userData'), 'remote'),
      launchPty: (spec, owner, onData, onExit) => host.launchRemotePty(spec, owner, onData, onExit),
      onState: (info) => host.emit('remote:state', info),
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
      workspace.conn(active).silentConnect().then(() => host.syncWatches()).catch(() => {});
    }
    applyBridgeSetting();
    applyKeepAwake();
    applyShareSetting();
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
    // The ssh masters are deliberately left running: ControlPersist=yes outlives
    // Tote, so the next launch reconnects to a still-authenticated connection
    // instead of sending the user back to a browser login.
    //
    // On macOS the app outlives its windows, and so do its terminals now: they
    // belong to the host, and the next window re-attaches to them with a
    // replay. Elsewhere the last window closing is a quit.
    if (process.platform !== 'darwin') {
      ptys && ptys.killAll();
      app.quit();
    }
  });
}
