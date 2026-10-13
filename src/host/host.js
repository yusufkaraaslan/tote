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
const path = require('path');
const { execSync } = require('child_process');
const { Sessions } = require('./sessions');
const { shellCommand } = require('../main/ptyManager');
const { shq } = require('../main/sshfix');

const SEND_FILE_MAX = 15 * 1024 * 1024;

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
      const id = W.add(name, absPath);
      host.setViewerSpace(ctx, id);
      host.spacesChanged();
      return host.wsState(ctx);
    },
    // Nothing on disk moves; open terminals keep their old cwd.
    'workspaces:setPathTo': (ctx, id, absPath) => {
      W.updateSpace(id, { path: absPath });
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
      W.promote(id, absPath);
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
