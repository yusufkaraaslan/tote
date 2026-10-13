// The host: the half of Tote that OWNS a device -- its spaces, views.json,
// terminals, watchers and remote connections -- and serves them to viewers.
// A window is a viewer; in the devices design another machine is one too
// (docs/superpowers/specs/2026-10-12-devices-design.md).
//
// Nothing under src/host/ may require electron. The few things that need the
// OS shell (the wastebasket, the system browser) come in through `platform`,
// so a windowless host can be started later with a plain-node one. The rule is
// enforced by scripts/test-devices.js, not by good intentions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Sessions } = require('./sessions');
const { shellCommand } = require('../main/ptyManager');
const { shq } = require('../main/sshfix');
const { expandTilde } = require('../main/workspace');

// A typed folder path (from another machine, where no picker can browse this
// disk): `~` is THIS machine's home, and it must be absolute after that, or
// mkdir and rename would act relative to wherever the process happens to be.
function hostPath(p) {
  const abs = expandTilde(String(p || '').trim());
  if (!path.isAbsolute(abs)) throw new Error('Give an absolute path, or one starting with ~/');
  return abs;
}

const SEND_FILE_MAX = 15 * 1024 * 1024;
// Transfers between devices move in slices, so a 200 MB download or PDF never
// sits in one frame (the protocol caps frames at 64 MB) or one buffer.
const CHUNK_MAX = 4 * 1024 * 1024;
const UPLOAD_ID = /^[A-Za-z0-9_-]{6,64}$/;

class Host {
  constructor({ cfg, workspace, ptys, platform }) {
    this.cfg = cfg;
    this.workspace = workspace;
    this.ptys = ptys;
    this.platform = platform;
    // viewerId -> { id, wsId, send(event, payload) }
    this.viewers = new Map();
    this.sessions = new Sessions(ptys, (viewerId, ev, payload) => {
      const v = this.viewers.get(viewerId);
      if (v) v.send(ev, payload);
    });
    this.methods = methods(this);
    this.uploads = new Map();   // upload id -> { dir, file, wsId, providerId }
  }

  /* ----- viewers ----- */

  // A viewer starts on the space the registry last had active, which is where
  // a freshly opened window has always opened.
  addViewer({ id, send }) {
    const v = { id, send, wsId: this.workspace.activeId() };
    this.viewers.set(id, v);
    this.syncWatches();
    return v;
  }

  removeViewer(id) {
    this.sessions.detachAll(id);
    this.viewers.delete(id);
    this.syncWatches();
  }

  // Everything a host method needs to know about who is asking. The space is
  // the VIEWER's, read when the call arrives and never cached -- the old rule
  // "the active workspace is resolved at call time", now per viewer.
  ctx(viewerId) {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) throw new Error('Unknown viewer: ' + viewerId);
    return { viewer, wsId: viewer.wsId };
  }

  // The workspace manager scoped to the caller's space.
  ws(ctx) {
    return this.workspace.scoped(ctx.wsId);
  }

  // Own properties only: `methods` is a plain object, and a name like
  // 'constructor' or '__proto__' would otherwise resolve to Object.prototype's.
  // That matters most once a method name arrives over the network.
  async call(name, viewerId, args) {
    const fn = Object.hasOwn(this.methods, name) ? this.methods[name] : null;
    if (typeof fn !== 'function') throw new Error('Not a host method: ' + name);
    return fn(this.ctx(viewerId), ...(args || []));
  }

  emit(event, payload, filter = () => true) {
    for (const v of this.viewers.values()) {
      if (filter(v)) { try { v.send(event, payload); } catch {} }
    }
  }

  /* ----- spaces ----- */

  // Watch exactly the spaces somebody is looking at. A change pings only the
  // viewers in that space; the ping still carries no path.
  syncWatches() {
    const ids = [...this.viewers.values()].map((v) => v.wsId);
    this.workspace.watchSpaces(ids, (wsId) =>
      this.emit('workspace:changed', wsId, (v) => v.wsId === wsId));
  }

  setViewerSpace(ctx, id) {
    const space = this.workspace.setActive(id);   // stamps lastUsed, makes the inbox
    ctx.viewer.wsId = id;
    ctx.wsId = id;
    this.syncWatches();
    return space;
  }

  wsState(ctx) {
    return { active: ctx.viewer.wsId, list: this.workspace.list() };
  }

  // After any change to the registry. A viewer whose space just went away
  // (removed or discarded from another window) is moved to the registry's
  // active one, every viewer is told, and the watchers follow -- a re-pointed
  // folder re-arms here because its watch key changed.
  spacesChanged() {
    const fallback = this.workspace.activeId();
    for (const v of this.viewers.values()) {
      if (!this.workspace.space(v.wsId)) v.wsId = fallback;
    }
    this.emit('workspaces:changed', null);
    this.syncWatches();
  }

  // The terminals that die with a space, by title -- for the discard dialog.
  termTitles(wsId) {
    return this.sessions.list().filter((s) => s.wsId === wsId && s.alive).map((s) => s.title);
  }

  async dropSpace(id) {
    const space = this.workspace.space(id);
    if (space && this.workspace.isRemote(space)) {
      try { await this.workspace.conn(space).disconnect(); } catch {}
      this.workspace.conns.delete(id);
    }
    this.sessions.killWhere((s) => s.wsId === id);
  }

  /* A remote space's login page belongs on the machine of whoever clicked
   * "connect" -- which, with devices, need not be this one. So the URL goes as
   * an event to that one viewer, whose renderer opens it in ITS browser. With
   * no owner (a silent reconnect) nothing opens; the banner offers the link. */
  authUrl(url, owner) {
    const v = owner && this.viewers.get(owner.viewerId);
    if (v) { try { v.send('remote:auth', { id: owner.wsId, url }); } catch {} }
  }

  /* ----- remote connect sessions -----
   * RemoteConn calls this through the launchPty hook. Its pty is an ordinary
   * session, so a second viewer can watch -- and answer -- the host-key
   * question or the login URL like any other terminal. */
  launchRemotePty(spec, owner, onData, onExit) {
    const o = owner || {};
    this.sessions.spawn({
      sid: o.sid,
      meta: { kind: 'connect', wsId: o.wsId, title: o.title || 'connect' },
      spec: { ...spec, cwd: process.env.HOME || '/' },
      viewerId: o.viewerId, onData, onExit,
    });
    return o.sid;
  }
}

function methods(host) {
  const W = host.workspace;
  const cfg = host.cfg;

  return {
    /* ----- spaces ----- */
    'workspaces:list': (ctx) => host.wsState(ctx),
    'workspaces:setActive': (ctx, id) => {
      const space = host.setViewerSpace(ctx, id);
      return space;
    },
    'workspaces:remove': async (ctx, id) => {
      await host.dropSpace(id);
      W.remove(id);
      host.spacesChanged();
      return host.wsState(ctx);
    },
    // Strip order only -- every viewer's space and every watcher stay as they are.
    'workspaces:reorder': (ctx, ids) => {
      W.reorder(ids);
      host.emit('workspaces:changed', null);
      return host.wsState(ctx);
    },
    'workspaces:rename': (ctx, id, name) => {
      W.updateSpace(id, { name });
      host.emit('workspaces:changed', null);
      return host.wsState(ctx);
    },
    'workspaces:addLocal': (ctx, name, absPath) => {
      const id = W.add(name, hostPath(absPath));
      host.setViewerSpace(ctx, id);
      host.spacesChanged();
      return host.wsState(ctx);
    },
    // Nothing on disk moves; open terminals keep their old cwd.
    'workspaces:setPathTo': (ctx, id, absPath) => {
      W.updateSpace(id, { path: hostPath(absPath) });
      host.spacesChanged();
      return host.wsState(ctx);
    },
    // Registering and connecting are deliberately separate. The space exists
    // the moment it is named, so the connect pane -- and every later reconnect,
    // of which there will be many, because Tailscale's check expires on a
    // timer -- runs against a real space through exactly one code path.
    'workspaces:addRemote': (ctx, { name, host: h, path: remotePath }) => {
      const id = W.addRemote(name, h, remotePath);
      host.setViewerSpace(ctx, id);
      host.spacesChanged();
      return host.wsState(ctx);
    },
    'workspaces:tempName': () => W.suggestTempName(),
    'workspaces:addTemp': (ctx, name) => {
      const id = W.addTemp(name);
      host.setViewerSpace(ctx, id);
      host.spacesChanged();
      return host.wsState(ctx);
    },
    // What the discard confirm shows. The terminal list comes from here now:
    // the host is what knows which sessions belong to which space.
    'workspaces:measure': (ctx, id) => {
      const w = W.space(id);
      if (!w) throw new Error('Unknown workspace: ' + id);
      if (!w.temp) throw new Error('Not a temp space: ' + w.name);
      return { name: w.name, path: w.path, ...W.measure(w.path), terms: host.termTitles(id) };
    },
    'workspaces:discardConfirmed': async (ctx, id) => {
      const w = W.space(id);
      if (!w || !w.temp) throw new Error('Not a temp space: ' + id);
      await host.dropSpace(id);
      W.discardTemp(id);
      host.spacesChanged();
      return host.wsState(ctx);
    },
    'workspaces:promoteTo': (ctx, id, absPath) => {
      W.promote(id, hostPath(absPath));
      host.spacesChanged();
      return host.wsState(ctx);
    },

    /* ----- remote spaces ----- */
    // Opens the one interactive ssh session that may authenticate. The viewer
    // picked the session id, so its pane exists before the first byte does.
    'remote:connect': (ctx, { id, cols, rows, mkdir, sid }) => {
      const space = W.space(id) || W.scoped(ctx.wsId).active();
      if (!W.isRemote(space)) throw new Error('Not a remote space: ' + space.name);
      const conn = W.conn(space);
      const owner = { sid, viewerId: ctx.viewer.id, wsId: space.id, title: 'connect ' + space.host };
      conn.connect({ cols, rows, owner, mkdir }).then(() => host.syncWatches());  // poll once up
      return conn.info();
    },
    'remote:state': (ctx, id) => host.ws(ctx).remoteState(id),
    'remote:disconnect': async (ctx, id) => {
      const space = W.space(id);
      if (space && W.isRemote(space)) await W.conn(space).disconnect();
      return host.ws(ctx).remoteState(id);
    },

    /* ----- files (the caller's space) ----- */
    'workspace:getRoot': (ctx) => host.ws(ctx).getRoot(),
    'workspace:tree': (ctx) => host.ws(ctx).tree(),
    'workspace:read': (ctx, rel) => host.ws(ctx).readText(rel),
    'workspace:readDoc': (ctx, rel) => host.ws(ctx).readDoc(rel),
    'workspace:write': async (ctx, rel, content) => { await host.ws(ctx).writeText(rel, content); return true; },
    'workspace:createFile': async (ctx, rel) => { await host.ws(ctx).createFile(rel); return true; },
    'workspace:createFolder': async (ctx, rel) => { await host.ws(ctx).createFolder(rel); return true; },
    'workspace:rename': async (ctx, from, to) => { await host.ws(ctx).rename(from, to); return true; },
    'workspace:trash': async (ctx, rel) => {
      const V = host.ws(ctx);
      const R = V.backend();
      if (R) await R.trash(rel);                 // moves into the space's .tote-trash/
      else await host.platform.trash(V.resolveSafe(rel));
      return true;
    },
    // A file's bytes for the in-page attach, which runs on the viewer: the
    // webview is there even when the file is not.
    'workspace:fileBytes': async (ctx, rel) => {
      const abs = await host.ws(ctx).localFileFor(rel);
      const stat = fs.statSync(abs);
      if (stat.size > SEND_FILE_MAX) throw new Error('File too large for in-page attach (> 15 MB)');
      return { name: path.basename(abs), b64: fs.readFileSync(abs).toString('base64') };
    },

    // One slice of a file, for a viewer on another machine that needs a real
    // local copy (a PDF or an HTML page for a <webview>). localFileFor makes a
    // remote space's file local HERE first, so this works for those too.
    'workspace:readChunk': async (ctx, rel, offset, length) => {
      const abs = await host.ws(ctx).localFileFor(rel);
      const size = fs.statSync(abs).size;
      const start = Math.max(0, Number(offset) || 0);
      const len = Math.min(CHUNK_MAX, Math.max(0, Number(length) || CHUNK_MAX), Math.max(0, size - start));
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(abs, 'r');
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      return { b64: buf.toString('base64'), size, eof: start + len >= size };
    },
    /* A file arriving from another machine -- a download made in a web tab
     * there while it was showing this machine. Chunks append to a staging file
     * named like the download; the last one files it into the inbox of the
     * space given (fixed when the download STARTED, like any download) and the
     * staging copy goes. The id is the viewer's, so two transfers never mix. */
    'workspace:upload': async (ctx, { id, wsId, name, providerId, b64, final }) => {
      if (!UPLOAD_ID.test(String(id))) throw new Error('Bad upload id');
      let up = host.uploads.get(id);
      if (!up) {
        const base = path.basename(String(name || 'download'));
        if (!base || base === '.' || base === '..') throw new Error('Bad file name');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-upload-'));
        up = { dir, file: path.join(dir, base), wsId: wsId || ctx.wsId, providerId: providerId || '_desktop' };
        host.uploads.set(id, up);
      }
      try {
        if (b64) fs.appendFileSync(up.file, Buffer.from(b64, 'base64'));
        else if (!fs.existsSync(up.file)) fs.writeFileSync(up.file, '');
        if (!final) return { ok: true };
        const W = host.workspace.scoped(up.wsId);
        const landed = await W.ingest(up.file, up.providerId);
        host.uploads.delete(id);
        fs.rmSync(up.dir, { recursive: true, force: true });
        return { path: landed, workspace: W.active().name };
      } catch (e) {
        host.uploads.delete(id);
        fs.rmSync(up.dir, { recursive: true, force: true });
        throw e;
      }
    },

    /* ----- settings that belong to the device ----- */
    // Keep-awake is about the machine that stays awake, so it is set THERE --
    // including from another machine that is looking at it. Sharing is not
    // here on purpose: exposing a machine is decided at that machine.
    'device:settings': () => ({ keepAwake: cfg.getSettings().keepAwake === true }),
    'device:setKeepAwake': (ctx, on) => {
      cfg.saveSettings({ ...cfg.getSettings(), keepAwake: !!on });
      if (host.platform.applyKeepAwake) host.platform.applyKeepAwake();
      return { keepAwake: !!on };
    },

    /* ----- config that belongs to the device ----- */
    // CLI profiles live where the agents run.
    'config:getCliProfiles': () => cfg.getCliProfiles(),
    'config:saveCliProfiles': (ctx, list) => { cfg.saveCliProfiles(list); return true; },
    'views:get': () => cfg.getViews(),
    // Last edit wins, and everyone else sees it live.
    'views:save': (ctx, data) => {
      cfg.saveViews(data);
      host.emit('views:changed', data, (v) => v !== ctx.viewer);
      return true;
    },

    /* ----- terminals ----- */
    'pty:available': () => host.ptys.available(),
    'pty:spawn': async (ctx, { sid, profileId, cols, rows }) => {
      const profile = cfg.getCliProfiles().find((p) => p.id === profileId);
      if (!profile) throw new Error('Unknown CLI profile: ' + profileId);
      const V = host.ws(ctx);
      const space = V.active();
      const conn = W.isRemote(space) ? W.conn(space) : null;
      // Try to heal silently first: after a sleep the master is usually just
      // gone, and rebuilding it needs no human at all. Only send the user to
      // the connect pane when it genuinely needs one.
      if (conn && conn.state !== 'up' && !(await conn.silentConnect())) {
        throw new Error(`${conn.host}: ${conn.message} — use the connect button in the files pane`);
      }
      const cwd = V.localCwd();
      const { file, args } = shellCommand(profile, conn);
      host.sessions.spawn({
        sid,
        meta: { kind: 'agent', wsId: space.id, title: profile.name, profileId: profile.id,
                cwd: conn ? conn.root : cwd, host: conn ? conn.host : null },
        spec: { file, args, cwd, cols, rows },
        viewerId: ctx.viewer.id,
      });
      return { id: sid, workspace: space.name, cwd: conn ? conn.root : cwd, host: conn ? conn.host : null };
    },
    'pty:list': () => host.sessions.list(),
    'pty:attach': (ctx, sid) => host.sessions.attach(sid, ctx.viewer.id),
    'pty:detach': (ctx, { id }) => host.sessions.detach(id, ctx.viewer.id),
    'pty:write': (ctx, { id, data }) => host.sessions.write(id, data),
    'pty:resize': (ctx, { id, cols, rows }) => host.sessions.resize(id, cols, rows),
    'pty:kill': (ctx, { id }) => host.sessions.kill(id),
    'cli:check': async (ctx, command) => {
      if (!command) return true; // plain shell profile always works
      // A remote space runs the agent on the remote, so that is where it has to
      // exist -- checking this machine would report the opposite of the truth.
      const R = host.ws(ctx).backend();
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
    },
  };
}

module.exports = { Host };
