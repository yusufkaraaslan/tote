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
const { app, BrowserWindow, ipcMain, dialog, shell, session, webContents, Menu, clipboard } = require('electron');
const { editMenu } = require('./editMenu');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const localServices = require('./localServices').createLocalServices();
const { spawn } = require('child_process');
const { ConfigStore } = require('./config');
const { PtyManager } = require('./ptyManager');
const { systemCheck, fixNpmPrefix, claudeStatus, bindClaudeToWorkspace, mcpSnippet } = require('./installer');
const { LocalHost } = require('./localHost');
const hostStartup = require('./hostStartup');
let hostLaunch;
let selfUpdater;
let installingUpdate = false;
const CH = require('../host/channels');
const Diagnostics = require('../shared/diagnostics');
const Updates = require('../shared/updates');
const checkUpdate = require('./updates').checker();
const diagnosticLog = Diagnostics.createLog();
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

const { dropInheritedAgentSession, adoptLoginShellPath } = require('./environment');

let configStore;
let ptys;
let host;
let lastFocused = null;   // viewer id of the window that last had focus
// webContents id -> { current, devices: Map(key -> device) }. A window keeps a
// connection to every machine it has opened -- their panes stay alive, hidden,
// the way another space's do -- and `current` says which one it is showing
// (null: this machine). A device is { key, name, address, port, client, up }.
const viewing = new Map();
let swept = [];   // stale temp spaces removed at launch, reported once the UI is up

const partitionFor = (providerId) => `persist:tote-${providerId}`;

// A window's viewer id. One webContents per window, and it outlives nothing.
const viewerIdOf = (wc) => 'w' + wc.id;

const winOf = (e) => BrowserWindow.fromWebContents(e.sender) || undefined;

/* ----- devices ----- */

const DEFAULT_DEVICE_PORT = 47821;
const devicePort = () => Number(configStore.getSettings().devicePort) || DEFAULT_DEVICE_PORT;
const deviceKey = (address, port) => address + ':' + port;
function deviceOf(wc) {
  const w = viewing.get(wc.id);
  return (w && w.current && w.devices.get(w.current)) || null;
}
const deviceInfo = (d) => d && { key: d.key, name: d.name, address: d.address, port: d.port, up: d.up, versionNotice: d.client?.remote?.versionNotice || '' };

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

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  let i = 1;
  while (fs.existsSync(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

// --- provider sessions ---------------------------------------------------------

function providerViewer(contents) {
  let owner = contents?.hostWebContents || contents;
  while (owner && !owner.isDestroyed()) {
    if (host?.viewers.has(viewerIdOf(owner))) return owner;
    owner = BrowserWindow.fromWebContents(owner)?.getParentWindow()?.webContents;
  }
  return null;
}

function setupProviderPopups(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 560,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          parent: BrowserWindow.fromWebContents(contents.hostWebContents || contents) || undefined,
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', win => setupProviderPopups(win.webContents));
}

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
    const owner = providerViewer(guest);
    // A window showing another machine downloads for THAT machine: stage here
    // (Chromium only writes locally), push it up when done. Which device, and
    // which of its spaces, are fixed now, when the download starts.
    const dev = owner && deviceOf(owner);
    if (dev) {
      const stage = path.join(app.getPath('userData'), 'devices', sha(dev.key), 'staging');
      fs.mkdirSync(stage, { recursive: true });
      const target = uniquePath(path.join(stage, item.getFilename() || 'download'));
      item.setSavePath(target);
      const wsIdThere = dev.client.call('workspaces:list', []).then((l) => l.active, () => null);
      item.once('done', async (e, state) => {
        let landed = target, where = dev.name, outcome = state;
        if (state === 'completed') {
          try {
            const res = await pushDownload(dev, await wsIdThere, target, provider.id);
            landed = res.path;
            where = dev.name + ' · ' + res.workspace;
            fs.rmSync(target, { force: true });
          } catch (err) {
            outcome = 'interrupted: ' + err.message + ' (kept at ' + target + ')';
          }
        }
        if (!owner.isDestroyed()) {
          owner.send('download:done', { providerId: provider.id, provider: provider.name, workspace: where,
                                        filename: path.basename(landed), path: landed, state: outcome });
        }
      });
      return;
    }
    const stage = path.join(app.getPath('userData'), 'host-downloads');
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const folder = fs.mkdtempSync(path.join(stage, 'download-'));
    const target = path.join(folder, path.basename(item.getFilename() || 'download'));
    item.setSavePath(target);
    const destination = owner
      ? host.call('local:download', viewerIdOf(owner), [])
      : host.admin('local:download');
    // Attach rejection handling immediately, even for a long-running download.
    const pinned = destination.then(value => ({ value }), error => ({ error }));
    item.once('done', async (_event, state) => {
      let landed = target, where = 'This computer', outcome = state;
      if (state === 'completed') {
        try {
          const result = await pinned;
          if (result.error) throw result.error;
          const res = await host.admin('local:ingest', [{ wsId: result.value.wsId, file: target, providerId: provider.id }]);
          landed = res.path; where = res.workspace;
          fs.rmdirSync(folder);
        } catch (error) { outcome = 'interrupted: ' + error.message + ' (staged at ' + target + ')'; }
      }
      if (owner && !owner.isDestroyed()) owner.send('download:done', {
        providerId: provider.id, provider: provider.name, workspace: where,
        filename: path.basename(landed), path: landed, state: outcome,
      });
    });
  });
}

function setupAllProviderSessions() {
  for (const p of configStore.getProviders()) setupProviderSession(p);
}

// --- local services (e.g. DeepSeek Harness Web UI) ------------------------------

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

async function launchApp(entry, context) {
  const wsName = context.space.name;
  const rootPath = context.root;
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
async function createWindow() {
  if (installingUpdate) throw Error("Wait for the update operation to finish.");
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
  // This machine's events carry no device tag; another machine's carry its key
  // as a second argument (see openDevice), and the renderer files each under
  // the right device -- including the ones whose panes are hidden right now.
  // Its terminals keep running: the sessions belong to the host, and another
  // window -- or a later one -- re-attaches with a replay.
  const wcId = wc.id;
  win.on('closed', () => {
    const w = viewing.get(wcId);
    if (w) {
      viewing.delete(wcId);
      for (const d of w.devices.values()) { clearTimeout(d.retry); d.gone = true; if (d.client) d.client.close(); }
    }
    for (const [id, owner] of wizardOwners) if (owner === wcId) { ptys.kill(id); wizardOwners.delete(id); }
    host.removeViewer(vid);
    if (lastFocused === vid) lastFocused = null;
  });

  try {
    await host.addViewer({ id: vid, send: (ev, payload) => { if (!wc.isDestroyed()) wc.send(ev, payload); } });
  } catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
  if (win.isDestroyed()) return;
  lastFocused = vid;
  host.call('local:focus', vid, []).catch(() => {});
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Re-activation is the renderer's cue to put keyboard focus back inside the
  // focused pane. The main process is the authority on window activation: the
  // renderer's own `focus` event is ambiguous once a webview guest is involved.
  win.on('focus', () => {
    lastFocused = vid;
    host.call('local:focus', vid, []).catch(() => {});
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
  contents.on('context-menu', (_event, params) => {
    const template = editMenu(contents, params, clipboard);
    if (!template.length) return;
    const owner = contents.hostWebContents || contents;
    Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(owner) || undefined });
  });
  if (contents.getType() !== 'webview') return;
  // A web page holding the keyboard swallows every keystroke, so the pane keys
  // (⌘1-9, ctrl+`, MOD arrows/F/W/E/digits) never reached the window's keydown
  // listener while you were in a web pane -- exactly where jumping out matters
  // most. Catch them before the page sees them and hand them to the window.
  // Off macOS MOD is Ctrl+Alt, which is also AltGr -- the way €, {, [ and @ are
  // typed on many layouts -- so only the plain Ctrl keys are taken there.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !contents.hostWebContents) return;
    const mac = process.platform === 'darwin';
    const cmd = mac ? input.meta : input.control;
    const pane = cmd && !input.alt && !input.shift && /^Digit[1-9]$/.test(input.code);
    const tick = input.control && !input.alt && !input.meta && input.key === '`';
    const mod = mac && input.meta && input.alt
      && /^(Arrow(Up|Down|Left|Right)|Key[FWE]|Digit[1-9])$/.test(input.code);
    if (!pane && !tick && !mod) return;
    event.preventDefault();
    contents.hostWebContents.send('win:key', {
      key: input.key, code: input.code,
      metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift,
    });
  });
  setupProviderPopups(contents);
});

// --- IPC: the host's channels ----------------------------------------------------------

// Everything the device owns is forwarded, by channel name, to the host's
// method of the same name, with the calling window as the viewer. The table
// of which channels those are is src/host/channels.js.
//
// A window viewing another device sends the same call to THAT device's host
// instead. The renderer cannot tell the difference, which is the point.
function route(e, name, args) {
  if (typeof args[0]?.id === 'number' && ['pty:write', 'pty:resize', 'pty:kill'].includes(name)) {
    const request = args[0];
    if (wizardOwners.get(request.id) !== e.sender.id) return Promise.reject(Error('Unknown setup terminal'));
    if (name === 'pty:write') ptys.write(request.id, request.data);
    if (name === 'pty:resize') ptys.resize(request.id, request.cols, request.rows);
    if (name === 'pty:kill') { ptys.kill(request.id); wizardOwners.delete(request.id); }
    return Promise.resolve();
  }
  let d = deviceOf(e.sender);
  // Layout requests outlive the selected device (debounce, reconnect, reply).
  // Bind them to the captured device, restricted to this window's connections.
  if (name === 'views:snapshot' || name === 'views:patch') {
    const key = args.pop();
    if (typeof key !== 'string') return Promise.reject(new Error('Layout request needs a device'));
    d = key ? viewing.get(e.sender.id)?.devices.get(key) : null;
    if (key && !d) return Promise.reject(new Error('Layout device is no longer open'));
  }
  if (!d) return host.call(name, viewerIdOf(e.sender), args);
  if (!d.up) return Promise.reject(new Error(d.name + ' is offline'));
  let call = d.client.call(name, args);
  if (name === 'views:snapshot') call = call.catch(error => {
    if (!/(?:Not a host method|Not callable from another device): views:snapshot$/.test(error.message)) throw error;
    return d.client.call('views:get', []).then(views => ({ protocol: 0, views }));
  });
  // A doc pane is handed a file:// URL for a PDF or an HTML page, and on
  // another machine that URL names a file that is not here: fetch it first.
  return name === 'workspace:readDoc' ? call.then((r) => localizeDoc(d, args[0], r)) : call;
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

// Local clipboard access is exposed only to registered Tote viewers, never
// provider guests, and never routed to the device being viewed.
ipcMain.handle('clipboard:readText', (e) => {
  if (!host?.viewers.has(viewerIdOf(e.sender))) throw new Error('Not a Tote viewer');
  return clipboard.readText();
});
ipcMain.handle('clipboard:writeText', (e, text) => {
  if (!host?.viewers.has(viewerIdOf(e.sender))) throw new Error('Not a Tote viewer');
  if (typeof text !== 'string') throw new Error('Expected clipboard text');
  return clipboard.writeText(text);
});

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
  const w = (await hostCall(e, 'workspaces:list')).list.find(w => w.id === id);
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
  const w = (await hostCall(e, 'workspaces:list')).list.find(w => w.id === id);
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

const localCall = (e, method, ...args) => host.call(method, viewerIdOf(e.sender), args);
const viewerContext = e => localCall(e, 'local:space');
ipcMain.handle('workspace:openPath', async (e, rel) => {
  localOnly(e, 'Opening with this machine’s apps');
  return shell.openPath(await localCall(e, 'local:resolve', rel));
});
ipcMain.handle('workspace:revealPath', async (e, rel) => {
  localOnly(e, 'Revealing in this machine’s file manager');
  shell.showItemInFolder(await localCall(e, 'local:resolve', rel));
});

// --- IPC: devices ------------------------------------------------------------------------

// Your other machines with Tote, probed live, plus whether this one is shared.
ipcMain.handle('devices:list', async () => {
  const share = await host.admin('local:status').then(r => r.share, e => ({ on: false, error: e.message }));
  try {
    return { ...(await discover({ port: devicePort(), device: await selfName() })), share };
  } catch (e) {
    return { self: null, devices: [], share, error: e.message };
  }
});

ipcMain.handle('devices:current', (e) => deviceInfo(deviceOf(e.sender)));

/* A PDF or HTML doc pane needs a file:// URL a <webview> can load, and the
 * one another machine hands back names a file on THAT machine. Fetch it in
 * slices into <userData>/devices/<device>/, keyed by mtime -- a changed file
 * is a different file, so staleness needs no bookkeeping, exactly like the
 * remote-space PDF cache. An HTML page whose stylesheet sits next to it
 * renders unstyled from here (only the page travels); source mode is exact. */
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
async function localizeDoc(d, rel, r) {
  if (!r || !r.fileUrl) return r;
  const dir = path.join(app.getPath('userData'), 'devices', sha(d.key), sha(rel + '\u0000' + r.mtimeMs));
  const file = path.join(dir, path.basename(String(rel)) || 'file');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.part';
    fs.writeFileSync(tmp, '');
    for (let offset = 0; ;) {
      const c = await d.client.call('workspace:readChunk', [rel, offset]);
      const buf = Buffer.from(c.b64, 'base64');
      fs.appendFileSync(tmp, buf);
      offset += buf.length;
      if (c.eof || !buf.length) break;
    }
    fs.renameSync(tmp, file);
  }
  return { ...r, fileUrl: pathToFileURL(file).href };
}

/* A finished download, made in a web tab while its window showed another
 * machine, goes to THAT machine's inbox: streamed up in slices, into the space
 * the window was in when the download started. Resolves to where it landed. */
async function pushDownload(d, wsId, absFile, providerId) {
  const id = 'u' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const name = path.basename(absFile);
  const fd = fs.openSync(absFile, 'r');
  try {
    const CHUNK = 2 * 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      const final = n < CHUNK;
      const res = await d.client.call('workspace:upload',
        [{ id, wsId, name, providerId, b64: buf.subarray(0, n).toString('base64'), final }]);
      if (final) return res;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* Connect a window to another machine (once), and keep it connected: a drop
 * is retried with backoff for as long as the window lives, so a laptop that
 * slept comes back by itself. The renderer hears devices:lost / devices:back
 * and keeps the device's panes in between, under a banner. */
function connectDevice(wc, d) {
  const output = d.output = new Map();
  d.client = new DeviceClient({
    address: d.address, port: d.port, device: selfNameCache || os.hostname(),
    onEvent: (ev, payload) => {
      if (wc.isDestroyed()) return;
      if (ev !== 'pty:data') { wc.send(ev, payload, d.key); return; }
      return new Promise(resolve => {
        const delivery = crypto.randomUUID();
        output.set(delivery, resolve);
        wc.send(ev, { ...payload, delivery }, d.key);
      });
    },
    onClose: (code, reason) => {
      for (const resolve of output.values()) resolve();
      output.clear();
      if (d.connectedAt && Date.now() - d.connectedAt >= 30000) d.backoff = 0;
      if (d.gone) return;
      diagnosticLog.add('connection', reason);
      d.up = false;
      if (!wc.isDestroyed()) wc.send('devices:lost', { key: d.key, name: d.name, reason });
      scheduleRetry(wc, d);
    },
  });
  return d.client.connect().then((hello) => {
    d.up = true;
    d.lastVersion = hello.tote;
    d.connectedAt = Date.now();
    if (!d.named && hello.device) d.name = hello.device;
    return hello;
  });
}

ipcMain.on('devices:outputAck', (e, key, id) => {
  if (!key) { host.ack(viewerIdOf(e.sender), id); return; }
  const output = viewing.get(e.sender.id)?.devices.get(key)?.output;
  const resolve = output?.get(id);
  if (resolve) { output.delete(id); resolve(); }
});

function scheduleRetry(wc, d) {
  clearTimeout(d.retry);
  if (d.gone || wc.isDestroyed()) return;
  d.backoff = Math.min((d.backoff || 2000) * 2, 30000);
  d.retry = setTimeout(async () => {
    if (d.gone || wc.isDestroyed() || d.up) return;
    try {
      await connectDevice(wc, d);
      if (!wc.isDestroyed()) wc.send('devices:back', deviceInfo(d));
    } catch {
      scheduleRetry(wc, d);
    }
  }, d.backoff);
}

/* Show another machine's Tote in this window (or this machine's, with null).
 * Nothing is torn down: the device you leave keeps its connection and its
 * panes keep streaming, hidden, so coming back is instant. A device that is
 * down can still be switched to -- its panes come up under the offline banner
 * while the retry loop works. */
ipcMain.handle('devices:view', async (e, target) => {
  const wc = e.sender;
  let w = viewing.get(wc.id);
  if (!w) { w = { current: null, devices: new Map() }; viewing.set(wc.id, w); }
  if (!target) { w.current = null; return null; }
  await selfName();
  const port = Number(target.port) || devicePort();
  const key = deviceKey(target.address, port);
  let d = w.devices.get(key);
  if (!d) {
    d = { key, name: target.name || target.address, named: !!target.name, address: target.address, port,
          client: null, up: false, backoff: 0, retry: null, gone: false };
    await connectDevice(wc, d);          // a first connect that fails is just an error
    w.devices.set(key, d);
  } else if (!d.up) {
    clearTimeout(d.retry);
    try { await connectDevice(wc, d); } catch { scheduleRetry(wc, d); }
  }
  w.current = key;
  return deviceInfo(d);
});

// Every machine this window holds a connection to, for the chip menu.
ipcMain.handle('devices:open', (e) => {
  const w = viewing.get(e.sender.id);
  return w ? [...w.devices.values()].map(deviceInfo) : [];
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
ipcMain.handle('settings:save', (e, s) => localCall(e, 'local:settings', s));

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

ipcMain.handle('apps:launch', async (e, id) => {
  const entry = configStore.getApps().list.find((a) => a.id === id);
  if (!entry) throw new Error('Unknown app: ' + id);
  localOnly(e, 'Launching a native app into a space');
  return launchApp(entry, await viewerContext(e));
});

// --- IPC: setup wizard / connections -------------------------------------------------------------

ipcMain.handle('setup:systemCheck', () => systemCheck(ptys));

// Wizard self-heal: after an `npm i -g` fails with EACCES, point npm's global
// prefix at ~/.local when that is safe (guards live in installer/npmfix).
ipcMain.handle('setup:fixNpmPrefix', () => fixNpmPrefix());

ipcMain.handle('conn:claudeStatus', () => claudeStatus());

ipcMain.handle('conn:bindClaude', async (e) => {
  localOnly(e, 'Binding Claude Desktop');
  const W = await viewerContext(e);
  if (W.space.host) {
    throw new Error('Claude Desktop runs on this machine and cannot be bound to a remote space');
  }
  const cfgPath = bindClaudeToWorkspace(W.root);
  return { cfgPath, workspace: W.space.name, root: W.root };
});

ipcMain.handle('conn:mcpSnippet', async (e) => {
  localOnly(e, 'An MCP snippet for this machine');
  return mcpSnippet((await viewerContext(e)).root);
});

// Run an arbitrary install/setup command in a PTY rooted at the window's
// space, so the wizard can stream real output into a mini terminal. Not a host
// session: the wizard installs on THIS machine, and nobody else watches it.
const wizardOwners = new Map();
ipcMain.handle('pty:run', async (e, { command, args }) => {
  let cmd = command;
  let argv = args || [];
  if (argv.length === 0 && command.includes(' ')) {
    const parts = command.split(' ').filter(Boolean);
    cmd = parts[0];
    argv = parts.slice(1);
  }
  const id = ptys.spawn({ command: cmd, args: argv }, (await viewerContext(e)).cwd, 110, 28, e.sender);
  wizardOwners.set(id, e.sender.id);
  return { id };
});

// --- IPC: providers / tabs -------------------------------------------------------------------

ipcMain.handle('provider:ensureLocal', async (e, providerId) => {
  localOnly(e, 'Starting a local web service');
  const provider = configStore.getProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error('Unknown provider: ' + providerId);
  if (!provider.local) return { started: true, alreadyRunning: true };
  return localServices.ensure(provider);
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

ipcMain.handle('app:newWindow', async () => { await createWindow(); return true; });

async function localDiagnostics() {
  let network;
  try {
    const status = await TS.status();
    network = { state: ({ Running: 'running', Stopped: 'stopped', NeedsLogin: 'needs-login' })[status.backend] || 'unknown' };
  } catch (error) {
    diagnosticLog.add('tailscale', error);
    network = { state: 'unavailable', reason: Diagnostics.classify(error) };
  }
  const share = await host.admin('local:status').then(r => r.share, () => ({ on: false }));
  return { events: diagnosticLog.snapshot(), network: { host: network }, sharing: { enabled: configStore.getSettings().shareDevice === true, listening: share.on } };
}

ipcMain.handle('diagnostics:get', async (e, metrics = {}) => {
  const d = deviceOf(e.sender), key = d?.key || '';
  if (metrics.deviceKey !== key) throw new Error('Device changed. Refresh diagnostics.');
  const local = d ? await localDiagnostics() : null;
  let snapshot, status = 'current';
  try {
    if (d && !d.up) throw new Error('Device disconnected');
    snapshot = d ? await Diagnostics.withTimeout(d.client.call('device:diagnostics', []))
      : await host.call('device:diagnostics', viewerIdOf(e.sender), []);
    if (!snapshot || snapshot.format !== 'tote-diagnostics-v1') throw new Error('Incompatible host diagnostics');
    if (d) {
      const safe = Diagnostics.report(snapshot);
      snapshot = { ...safe, terminals: safe.terminals.map((t, i) => ({ ...t, id: snapshot.terminals[i]?.id })) };
      d.diagnosticSnapshot = snapshot;
    }
  } catch (error) {
    diagnosticLog.add('diagnostics', error);
    snapshot = d?.diagnosticSnapshot;
    status = snapshot ? 'cached' : /Not a host method|incompatible/i.test(error.message) ? 'unsupported' : 'unavailable';
  }
  return Diagnostics.compose({ snapshot, status, metrics: metrics.terminals,
    viewer: { kind: 'desktop', version: app.getVersion(), platform: process.platform, runtime: process.versions.electron },
    hostVersion: d?.lastVersion, network: local?.network.host || snapshot?.network?.host,
    connection: { mode: d ? 'remote' : 'local', state: d ? d.up ? 'connected' : 'disconnected' : 'local',
      flow: d?.client.remote?.flow, pendingCalls: d?.client.pending.size || 0,
      queuedBytes: d?.client.ws?.bufferedAmount || 0, pendingFrames: d?.output?.size || 0 },
    events: d ? diagnosticLog.snapshot() : [],
  });
});
ipcMain.handle('diagnostics:export', async (e, report) => {
  const text = Diagnostics.stringify(report);
  const result = await dialog.showSaveDialog(winOf(e), { title: 'Save reviewed diagnostics',
    defaultPath: 'tote-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return false;
  await fs.promises.writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 });
  return true;
});

ipcMain.handle('updates:check', async () => ({ ...await checkUpdate(app.getVersion()),
  ...selfUpdater.status(),
  activeTerminals: (await host.admin('local:status').catch(() => null))?.terminals ?? null,
}));
ipcMain.handle('updates:open', () => require('./updates').openRelease({
  sessions: () => host.admin('pty:list'), check: checkUpdate, current: app.getVersion(), open: url => shell.openExternal(url),
}));
const updateGuard = require('./updateGuard').createGuard({
  onReply: callback => ipcMain.on('updates:guardReply', callback),
  validate: () => { if (wizardOwners.size) throw Error('Finish the running setup commands before updating the desktop.'); },
  windows: () => BrowserWindow.getAllWindows().filter(w => host.viewers.has(viewerIdOf(w.webContents))),
  confirm: async () => {
    if (wizardOwners.size) throw Error('Finish the running setup commands before updating the desktop.');
    const result = await dialog.showMessageBox(focusedWindow(), { type:'question',
      buttons:['Cancel', 'Install and reopen Tote'], defaultId:0, cancelId:0,
      message:'Install the downloaded desktop update?',
      detail:'Save any drafts in provider web tabs first. All desktop windows will close. Your background host and its agents will keep running. The host can be upgraded separately after you finish its sessions.' });
    return result.response === 1;
  },
});
ipcMain.handle('updates:status', () => selfUpdater.restore());
ipcMain.handle('updates:download', () => selfUpdater.start());
ipcMain.handle('updates:cancel', () => { selfUpdater.cancel(); return true; });
ipcMain.handle('updates:install', async () => {
  if (installingUpdate || upgradingHost) throw Error('Another update operation is running.');
  installingUpdate = true;
  try {
    return await selfUpdater.install(updateGuard, target => {
      app.relaunch({ execPath:target, args:process.argv.slice(1) });
      // Guards and explicit confirmation have completed. A provider's unload
      // handler must not strand an old viewer after its binary was replaced.
      // These are viewer connections/setup PTYs, never the detached host.
      ptys.killAll(); host.close(); app.exit(0);
    });
  } finally { installingUpdate = false; }
});
const startupOptions = () => ({ ...hostLaunch, dataDir: app.getPath('userData') });
ipcMain.handle('host:status', async () => {
  const status = await host.admin('local:status').catch(error => ({ running: false, error: error.message }));
  return { ...status, viewerVersion:app.getVersion(), startAtLogin: hostStartup.enabled(startupOptions()) };
});
ipcMain.handle('host:start', async () => {
  if (upgradingHost || installingUpdate) throw Error('Another update operation is running.');
  return host.start();
});
ipcMain.handle('host:stop', async e => {
  if (upgradingHost || installingUpdate) throw Error('Another update operation is running.');
  const status = await host.admin('local:status');
  if (status.terminals) {
    const result = await dialog.showMessageBox(winOf(e), { type: 'warning',
      buttons: ['Cancel', 'Stop host and terminals'], defaultId: 0, cancelId: 0,
      message: `Stop the background host and its ${status.terminals} running terminal(s)?`,
      detail: 'Agents on this computer will stop, including sessions viewed from other devices. Reopening Tote cannot restore a stopped process.' });
    if (result.response !== 1) return { canceled: true };
  }
  return host.admin('local:stop', [{ force: status.terminals > 0 }]);
});
let upgradingHost = false;
ipcMain.handle('host:upgrade', async e => {
  if (upgradingHost || installingUpdate) throw Error('Another update operation is running.');
  upgradingHost = true;
  try {
    const result = await require('./updates').upgradeHost({host,current:app.getVersion(),confirm:async()=>
      (await dialog.showMessageBox(winOf(e), {type:'question',buttons:['Cancel','Upgrade idle host'],defaultId:0,cancelId:0,
        message:'Upgrade the idle background host?',detail:'Connected viewers will briefly reconnect. This action refuses if any host terminal is running.'})).response === 1});
    if (result.upgraded && hostStartup.enabled(startupOptions())) hostStartup.setEnabled(true,startupOptions());
    return result;
  } finally { upgradingHost = false; }
});
ipcMain.handle('host:startup', (_e, on) => hostStartup.setEnabled(on === true, startupOptions()));
ipcMain.handle('app:version', () => app.getVersion());

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
      if (app.isReady() && host) createWindow().catch(error => dialog.showErrorBox('Tote could not open a viewer', error.message));
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    migrateFromOmniHub();
    dropInheritedAgentSession();     // before anything can spawn a child
    adoptLoginShellPath();
    try {
      configStore = new ConfigStore(app, { onRecovery: ({ file, backup, preserved }) => {
        console.warn('Recovered Tote configuration:', file, 'from', backup);
        void dialog.showMessageBox({
          type: 'warning',
          message: 'Tote recovered saved configuration',
          detail: `${file}\n\nRestored from ${backup}. Your most recent changes may be missing.` +
            (preserved ? `\n\nThe damaged file was kept at ${preserved}.` : ''),
        });
      } });
    } catch (error) {
      dialog.showErrorBox('Tote could not load its configuration', error.message);
      app.quit();
      return;
    }
    selfUpdater = new (require('./selfUpdate').SelfUpdater)({ dir:path.join(app.getPath('userData'),'updates'), current:app.getVersion(), protocol:require('../../release.json').protocol, target:app.isPackaged && process.platform === 'linux' ? process.env.APPIMAGE : null, check:checkUpdate });
    ptys = new PtyManager(); // only short-lived setup/wizard PTYs belong to the UI
    hostLaunch = await require('./hostInstall').installRuntime({ dataDir: app.getPath('userData'), executable: process.execPath, appPath: app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '../..'), packaged: app.isPackaged });
    host = new LocalHost(app.getPath('userData'), hostLaunch);
    const status = await host.start();
    swept = status.swept || [];
    registerHostChannels();
    setupAllProviderSessions();
    detectApps();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(error => dialog.showErrorBox('Tote could not open a viewer', error.message));
    });
  }).catch(error => { dialog.showErrorBox('Tote could not connect to its background host', error.message); app.quit(); });

  // Quit ends the viewer and its setup jobs. Host sessions, sharing and
  // watchers belong to the detached process and keep running.
  app.on('before-quit', () => { ptys?.killAll(); host?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
