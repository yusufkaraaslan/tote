const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ConfigStore } = require('../main/config');
const { WorkspaceManager, originApp } = require('../main/workspace');
const { PtyManager } = require('../main/ptyManager');
const { Host } = require('./host');
const { DeviceServer, tailnetAuthorizer } = require('./server');
const { endpoint, authorize, LOCAL_METHODS } = require('./local');
const P = require('./protocol');
const TS = require('./tailscale');
const { version } = require('../../package.json');

class Runtime {
  constructor(dataDir) {
    this.endpoint = endpoint(dataDir);
    this.sharing = null;
    this.shareError = null;
    this.awake = null;
    this.awakeError = null;
    this.stopping = false;
    this.focusedSpace = null;
    this.settingsQueue = Promise.resolve();
  }

  async start() {
    const ep = this.endpoint;
    let ready = false;
    this.local = new DeviceServer({ device: 'This computer', tote: version,
      authorize: (ip, req) => ready ? authorize(ep.token, ip, req) : { ok: false, reason: 'Host starting' },
      allowedMethod: name => P.allowedRemote(name) || LOCAL_METHODS.has(name),
    });
    await this.local.start({ bind: ep.address, port: ep.port });
    try {
      this.cfg = new ConfigStore({ getPath: () => ep.dataDir });
      this.workspace = new WorkspaceManager(this.cfg);
      this.swept = this.workspace.sweepTemp(this.cfg.getSettings().scratchDays ?? 7);
      this.ptys = new PtyManager();
      this.host = new Host({ cfg: this.cfg, workspace: this.workspace, ptys: this.ptys,
        platform: { version, trash: (abs, root) => this.trash(abs, root),
          applyKeepAwake: () => this.applyAwake(), diagnostics: () => this.diagnostics() } });
      this.local.host = this.host;
      const removeViewer = this.host.removeViewer.bind(this.host);
      this.host.removeViewer = id => {
        if (id === this.focusedViewer) this.focusedSpace = this.host.viewers.get(id)?.wsId || this.focusedSpace;
        return removeViewer(id);
      };
      this.workspace.configureRemote({
        socketDir: path.join(ep.dataDir, 'ssh'), cacheDir: path.join(ep.dataDir, 'remote'),
        launchPty: (spec, owner, onData, onExit) => this.host.launchRemotePty(spec, owner, onData, onExit),
        onState: info => this.host.emit('remote:state', info),
        onAuthUrl: (url, owner) => this.host.authUrl(url, owner),
      });
      Object.assign(this.host.methods, this.localMethods());
      // Local viewers can attach as soon as device state is initialized. Optional
      // Tailscale setup may take time and must not look like an auth failure.
      ready = true;
      await this.applySettings();
      const active = this.workspace.active();
      if (this.workspace.isRemote(active)) this.workspace.conn(active).silentConnect()
        .then(() => this.host.syncWatches()).catch(() => {});
      return this;
    } catch (error) { await this.stop(); throw error; }
  }

  localMethods() {
    const W = this.workspace;
    return {
      'local:status': () => ({ running: !this.stopping, stopping: this.stopping, pid: process.pid, version,
        terminals: this.host.sessions.list().filter(s => s.alive).length,
        share: { on: !!this.sharing, address: this.sharing?.address || null, error: this.shareError },
        keepAwakeError: this.awakeError, swept: this.swept }),
      'local:stop': (_ctx, { force = false } = {}) => {
        const active = this.host.sessions.list().filter(s => s.alive).length;
        if (active && !force) throw Error(`${active} terminals are running. Stop them explicitly before stopping the host.`);
        // Return the acknowledgement before closing the caller's transport.
        this.stopping = true; this.ptys.stopping = true;
        setTimeout(() => this.stop().then(() => this.onStopped?.()), 50);
        return { stopping: true };
      },
      'local:settings': async (_ctx, settings) => {
        this.cfg.saveSettings({ ...settings, keepAwake: this.cfg.getSettings().keepAwake === true });
        await this.applySettings(); return true;
      },
      'local:focus': ctx => { this.focusedViewer = ctx.viewer.id; this.focusedSpace = ctx.wsId; return true; },
      'local:space': ctx => {
        const ws = this.host.ws(ctx);
        return { space: ws.active(), root: ws.getRoot(), cwd: ws.localCwd() };
      },
      'local:resolve': async (ctx, rel) => this.host.ws(ctx).localFileFor(rel),
      // Chromium needs a synchronous save path. The viewer stages downloads;
      // this snapshot pins the destination before the user can change space.
      'local:download': ctx => ({ wsId: ctx.wsId, name: this.host.ws(ctx).active().name }),
      'local:ingest': async (_ctx, { wsId, file, providerId }) => {
        const stage = path.join(this.endpoint.dataDir, 'host-downloads');
        const real = fs.realpathSync(file), root = fs.realpathSync(stage);
        const rel = path.relative(root, real);
        if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw Error('Download is outside staging');
        if (!W.space(wsId)) throw Error('Download workspace was removed; staged file was kept');
        const destination = W.scoped(wsId);
        const landed = await destination.ingest(real, providerId);
        fs.unlinkSync(real);
        return { path: landed, workspace: destination.active().name };
      },
    };
  }

  applySettings() {
    this.settingsQueue = this.settingsQueue.catch(() => {}).then(async () => {
      if (this.stopping) return;
      this.applyAwake();
      this.applyBridge();
      const settings = this.cfg.getSettings(), port = Number(settings.devicePort) || 47821;
      if (this.sharing && (!settings.shareDevice || !this.sharing.address.endsWith(':' + port))) {
        await this.sharing.stop(); this.sharing = null;
      }
      this.shareError = null;
      if (settings.shareDevice === true && !this.sharing) {
        try {
          const bind = await TS.ip4();
          const server = new DeviceServer({ host: this.host, device: os.hostname(), tote: version,
            authorize: tailnetAuthorizer(), advertise: true });
          await server.start({ bind, port }); this.sharing = server;
        } catch (e) { this.shareError = e.message; this.host.diagnostics.add('sharing', e); }
      }
    });
    return this.settingsQueue;
  }

  applyAwake() {
    const want = this.cfg.getSettings().keepAwake === true;
    if (!want && this.awake) { this.awake.kill(); this.awake = null; }
    if (!want || this.awake) return;
    this.awakeError = null;
    let file, args;
    if (process.platform === 'darwin') { file = '/usr/bin/caffeinate'; args = ['-i', '-w', String(process.pid)]; }
    else if (process.platform === 'win32') {
      file = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -Namespace Tote -Name Power -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'; [Tote.Power]::SetThreadExecutionState(2147483649); $null = [Console]::In.ReadToEnd()`];
    } else { file = 'systemd-inhibit'; args = ['--what=idle:sleep', '--who=Tote', '--why=Background agents', '--mode=block', 'cat']; }

    const child = this.awake = spawn(file, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const failed = () => { if (this.awake === child) { this.awake = null; this.awakeError = 'Keep awake is unavailable on this system'; } };
    child.stdin.on('error', () => {});
    child.once('error', failed); child.once('exit', failed);
  }

  applyBridge() {
    this.workspace.unwatchDownloads();
    if (process.platform !== 'darwin' || this.cfg.getSettings().bridgeDownloads === false) return;
    this.workspace.watchDownloads(async file => {
      const app = await originApp(file);
      const names = new Set(['claude', 'claude desktop', 'chatgpt', 'kimi', 'cherry studio']);
      for (const entry of this.cfg.getApps().list) {
        names.add(String(entry.name).trim().toLowerCase());
        names.add(path.basename(String(entry.path), '.app').toLowerCase());
      }
      if (!app || !names.has(app.toLowerCase())) return;
      const W = this.workspace.scoped(this.host.viewers.get(this.focusedViewer)?.wsId || this.focusedSpace || this.workspace.activeId());
      try {
        const target = await W.ingest(file, '_desktop');
        this.host.emit('download:done', { providerId: '_desktop', provider: app, workspace: W.active().name,
          filename: path.basename(target), path: target, state: 'completed' });
      } catch (error) { this.host.diagnostics.add('download', error); }
    });
  }

  async trash(abs, root) {
    // A windowless host cannot use Electron's shell. Preserve deleted files
    // beside the workspace, just as remote spaces do, rather than unlinking.
    const dir = path.join(root, '.tote-trash');
    if (path.resolve(abs) === path.resolve(root)) throw Error('Cannot trash the workspace root');
    fs.mkdirSync(dir, { recursive: true });
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Trash folder escapes workspace');
    fs.renameSync(abs, path.join(dir, crypto.randomUUID() + '-' + path.basename(abs)));
  }

  async diagnostics() {
    let network;
    try { const status = await TS.status(); network = { state: ({ Running: 'running', Stopped: 'stopped', NeedsLogin: 'needs-login' })[status.backend] || 'unknown' }; }
    catch { network = { state: 'unavailable' }; }
    return { network: { host: network }, sharing: { enabled: this.cfg.getSettings().shareDevice === true, listening: !!this.sharing } };
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.ptys) this.ptys.stopping = true;
    this.stopPromise = (async () => {
      await this.settingsQueue.catch(() => {});
      await this.sharing?.stop();
      await this.local?.stop();
      this.workspace?.unwatchDownloads();
      await this.workspace?.watchSpaces([], () => {});
      this.ptys?.killAll();
      if (this.awake) { const child = this.awake; this.awake = null; child.kill(); }
      // node-pty exit callbacks must drain before a Node/Electron environment
      // is torn down. SSH control masters intentionally outlive this process.
      await new Promise(resolve => setTimeout(resolve, 150));
    })();
    return this.stopPromise;
  }
}
module.exports = { Runtime };
