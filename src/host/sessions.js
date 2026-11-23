// Terminal sessions, owned by the host rather than by whichever window
// started them.
//
// A session is a pty plus a headless mirror of its screen. The mirror is what
// lets a viewer arrive late -- a second window, or (in the devices design)
// another machine -- and see the agent as it is now instead of an empty pane:
// attach() sends the serialized screen and scrollback, then live output. Any
// number of viewers can be subscribed to one session at once.
//
// Ids are chosen by the viewer that creates the session, not counted here. A
// term leaf is persisted in views.json before the pty exists (the pane has to
// be placed and fitted first, so the pty starts at its real size), and a
// counter restarting at 1 every run would let a stale leaf from the last run
// mount a brand-new session that happens to reuse its number.
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const SID = /^[A-Za-z0-9_-]{1,64}$/;
const SCROLLBACK = 5000;     // matches desktop and Android viewer options

class Sessions {
  // deliver(viewerId, event, payload) -- the host routes it to that viewer.
  constructor(ptys, deliver) {
    this.ptys = ptys;
    this.deliver = deliver;
    this.map = new Map();    // sid -> { meta, ptyId, mirror, ser, subs, pending }
  }

  list() {
    return [...this.map.values()].map((s) => ({ ...s.meta }));
  }

  diagnostics(viewerId) {
    return [...this.map.values()].slice(0, 64).map(s => ({
      id: s.meta.id, alive: s.meta.alive, host: { cols: s.meta.cols, rows: s.meta.rows },
      controller: this.access(s, viewerId).controller,
    }));
  }

  get(sid) {
    const s = this.map.get(sid);
    return s ? { ...s.meta } : null;
  }

  // Start a pty for `spec` ({ file, args, cwd, cols, rows }). The creating
  // viewer is subscribed before the pty exists, so its first bytes -- a
  // host-key question, a Tailscale login URL -- cannot arrive unclaimed.
  spawn({ sid, meta, spec, viewerId, onData, onExit }) {
    if (!SID.test(String(sid))) throw new Error('Bad session id: ' + sid);
    if (this.map.has(sid)) throw new Error('Session already exists: ' + sid);
    const cols = spec.cols || 80, rows = spec.rows || 24;
    const mirror = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const ser = new SerializeAddon();
    mirror.loadAddon(ser);
    // The mirror is the one terminal that answers the program's queries (DA,
    // CPR, DECRQM, colour reports): every window drops its own xterm's
    // answers, or a program shown in two windows reads each reply twice.
    // See src/renderer/termreports.js.
    mirror.onData((reply) => { if (s.ptyId !== null) this.ptys.write(s.ptyId, reply); });
    const s = {
      meta: { kind: 'agent', title: '', ...meta, id: sid, alive: true, exitCode: null, cols, rows, sizeSync: true, accessControl: true },
      ptyId: null, mirror, ser,
      subs: new Set(viewerId ? [viewerId] : []),
      pending: new Map(),    // viewerId -> token, cancels stale attach callbacks
      sizeOwner: viewerId || null,
      observers: new Set(),
      controlEpoch: 0,
    };
    this.map.set(sid, s);
    try {
      s.ptyId = this.ptys.launch({ ...spec, cols, rows }, null,
        (data) => { this.onData(sid, data); if (onData) onData(data); },
        (code) => { this.onExit(sid, code); if (onExit) onExit(code); });
    } catch (e) {
      this.forget(sid);
      throw e;
    }
    return { ...s.meta };
  }

  onData(sid, data) {
    const s = this.map.get(sid);
    if (!s) return;
    // Deliver only after parsing: writes, resize barriers and snapshots must
    // describe the same grid in every viewer, including a late attach.
    s.mirror.write(data, () => {
      if (this.map.get(sid) === s) this.sendData(s, data);
    });
  }

  sendData(s, data, viewerId, replay = false) {
    for (const v of viewerId ? [viewerId] : s.subs) {
      this.deliver(v, 'pty:data', { id: s.meta.id, data,
        cols: s.meta.cols, rows: s.meta.rows, controlsSize: s.sizeOwner === v,
        ...this.access(s, v),
        ...(replay ? { replay: true } : {}) });
    }
  }

  onExit(sid, exitCode) {
    const s = this.map.get(sid);
    if (!s) return;          // killed and forgotten already
    s.meta.alive = false;
    s.meta.exitCode = exitCode;
    s.ptyId = null;
    // A dead session stays listed, mirror and all, until a viewer closes its
    // pane: the last screen is usually the reason it died.
    s.mirror.write('', () => {
      if (this.map.get(sid) !== s) return;
      for (const v of s.subs) this.deliver(v, 'pty:exit', { id: sid, exitCode });
    });
    // A viewer mid-replay gets the exit after its snapshot (see attach).
  }

  access(s, viewerId) {
    return { readOnly: s.observers.has(viewerId),
      controller: !s.sizeOwner ? 'unclaimed' : s.sizeOwner === viewerId ? 'this-viewer' : 'another-viewer' };
  }

  setAccess(sid, viewerId, mode) {
    const s = this.map.get(sid);
    if (!s || !(s.subs.has(viewerId) || s.pending.has(viewerId))) throw Error('Attach to this terminal first');
    if (mode === 'observe') {
      s.observers.add(viewerId);
      if (s.sizeOwner === viewerId) s.sizeOwner = null;
    } else if (mode === 'control') {
      s.observers.delete(viewerId);
      s.sizeOwner = viewerId;
      s.controlEpoch++; // An earlier queued resize cannot undo this explicit claim.
    } else throw Error('Unknown terminal access mode');
    this.sendData(s, '');
    return this.access(s, viewerId);
  }

  // The empty write is a parser barrier. Earlier bytes are in the snapshot;
  // later writes deliver after subscribing. A detach/re-attach invalidates the
  // old callback so it cannot resurrect a disconnected viewer.
  attach(sid, viewerId, readOnly = false) {
    const s = this.map.get(sid);
    if (!s) throw new Error('No such session: ' + sid);
    const token = {};
    s.subs.delete(viewerId);
    s.pending.set(viewerId, token);
    if (readOnly) this.setAccess(sid, viewerId, 'observe');
    s.mirror.write('', () => {
      if (this.map.get(sid) !== s || s.pending.get(viewerId) !== token) return;
      this.sendData(s, s.ser.serialize(), viewerId, true);
      // Sending may synchronously disconnect an overloaded viewer.
      if (s.pending.get(viewerId) !== token) return;
      s.pending.delete(viewerId);
      s.subs.add(viewerId);
      if (!s.meta.alive) this.deliver(viewerId, 'pty:exit', { id: sid, exitCode: s.meta.exitCode });
    });
    return { ...s.meta, ...this.access(s, viewerId) };
  }

  detach(sid, viewerId) {
    const s = this.map.get(sid);
    if (!s) return;
    s.subs.delete(viewerId);
    s.pending.delete(viewerId);
    if (s.sizeOwner === viewerId) {
      s.sizeOwner = null;
      this.sendData(s, '');
    }
  }

  detachAll(viewerId) {
    for (const [sid, s] of this.map) {
      this.detach(sid, viewerId);
      s.observers.delete(viewerId);
    }
  }

  assertWritable(s, viewerId) {
    if (viewerId && s?.observers.has(viewerId)) throw Error('Terminal is read-only. Take control first.');
  }

  assertWorkspaceWritable(wsId, viewerId) {
    for (const s of this.map.values()) {
      if (s.meta.wsId === wsId) this.assertWritable(s, viewerId);
    }
  }

  write(sid, data, viewerId) {
    const s = this.map.get(sid);
    this.assertWritable(s, viewerId);
    if (!s || s.ptyId === null) return;
    // A focus resize and its first keystroke travel together. Apply the
    // queued resize before handing input to the program, or its response
    // can be drawn for the previous viewer's width.
    return new Promise((resolve, reject) => s.mirror.write('', () => {
      if (s.observers.has(viewerId)) return reject(Error('Terminal is read-only. Take control first.'));
      if (this.map.get(sid) === s && s.ptyId !== null) this.ptys.write(s.ptyId, data);
      resolve();
    }));
  }

  // Only the controlling viewer's layout changes resize the shared PTY.
  // Explicit focus (or Android's Resize terminal) transfers control. Merely
  // opening another viewer must not start a resize tug-of-war.
  resize(sid, cols, rows, viewerId, claim = true) {
    const s = this.map.get(sid);
    this.assertWritable(s, viewerId);
    if (!s || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) return;
    const epoch = s.controlEpoch;
    s.mirror.write('', () => {
      if (this.map.get(sid) !== s || epoch !== s.controlEpoch || s.observers.has(viewerId)) return;
      if (viewerId && !s.subs.has(viewerId) && !s.pending.has(viewerId)) return;
      if (viewerId && !claim && s.sizeOwner !== viewerId) return;
      const changed = s.meta.cols !== cols || s.meta.rows !== rows;
      const ownerChanged = viewerId && s.sizeOwner !== viewerId;
      if (viewerId) s.sizeOwner = viewerId;
      if (changed) {
        s.mirror.resize(cols, rows);
        s.meta.cols = cols;
        s.meta.rows = rows;
      }
      if (changed || ownerChanged) this.sendData(s, '');
      // Publish the new grid before the program can redraw into it.
      if (changed && s.ptyId !== null) this.ptys.resize(s.ptyId, cols, rows);
    });
  }

  // Closing a pane: kill the pty if it still runs, and forget the session.
  // Every other subscriber hears the exit, so its pane goes dead rather than
  // silently freezing.
  kill(sid, viewerId) {
    const s = this.map.get(sid);
    this.assertWritable(s, viewerId);
    if (!s) return;
    if (s.ptyId !== null) {
      this.ptys.kill(s.ptyId);
      for (const v of s.subs) this.deliver(v, 'pty:exit', { id: sid, exitCode: null });
    }
    this.forget(sid);
  }

  killWhere(pred) {
    for (const s of [...this.map.values()]) if (pred(s.meta)) this.kill(s.meta.id);
  }

  forget(sid) {
    const s = this.map.get(sid);
    if (!s) return;
    this.map.delete(sid);
    try { s.mirror.dispose(); } catch {}
  }
}

module.exports = { Sessions, SID };
