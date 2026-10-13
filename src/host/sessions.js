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
const SCROLLBACK = 5000;     // matches the viewer's xterm default

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
      meta: { kind: 'agent', title: '', ...meta, id: sid, alive: true, exitCode: null, cols, rows },
      ptyId: null, mirror, ser,
      subs: new Set(viewerId ? [viewerId] : []),
      pending: new Map(),    // viewerId -> [[event, payload]] queued during a replay
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
    s.mirror.write(data);
    const payload = { id: sid, data };
    for (const v of s.subs) this.deliver(v, 'pty:data', payload);
    for (const q of s.pending.values()) q.push(['pty:data', payload]);
  }

  onExit(sid, exitCode) {
    const s = this.map.get(sid);
    if (!s) return;          // killed and forgotten already
    s.meta.alive = false;
    s.meta.exitCode = exitCode;
    s.ptyId = null;
    // A dead session stays listed, mirror and all, until a viewer closes its
    // pane: the last screen is usually the reason it died.
    for (const v of s.subs) this.deliver(v, 'pty:exit', { id: sid, exitCode });
    // A viewer mid-replay gets the exit after its snapshot (see attach).
  }

  /* Subscribe a viewer and send it the session as it is now.
   *
   * The mirror parses asynchronously, so a snapshot taken right away could
   * miss bytes that were written but not yet parsed. Writing an empty chunk
   * and snapshotting in its callback gives the state as of that point; output
   * that arrives in the meantime is queued for this viewer (not lost, not
   * duplicated) and flushed right after the snapshot. Re-attaching an already
   * subscribed viewer -- a reloaded window -- replays again, which is what a
   * fresh xterm needs. */
  attach(sid, viewerId) {
    const s = this.map.get(sid);
    if (!s) throw new Error('No such session: ' + sid);
    s.subs.delete(viewerId);
    s.pending.set(viewerId, []);
    s.mirror.write('', () => {
      if (this.map.get(sid) !== s) return;
      const queued = s.pending.get(viewerId) || [];
      s.pending.delete(viewerId);
      this.deliver(viewerId, 'pty:data', { id: sid, data: s.ser.serialize(), replay: true });
      for (const [ev, payload] of queued) this.deliver(viewerId, ev, payload);
      s.subs.add(viewerId);
      if (!s.meta.alive) this.deliver(viewerId, 'pty:exit', { id: sid, exitCode: s.meta.exitCode });
    });
    return { ...s.meta };
  }

  detach(sid, viewerId) {
    const s = this.map.get(sid);
    if (!s) return;
    s.subs.delete(viewerId);
    s.pending.delete(viewerId);
  }

  detachAll(viewerId) {
    for (const sid of this.map.keys()) this.detach(sid, viewerId);
  }

  write(sid, data) {
    const s = this.map.get(sid);
    if (s && s.ptyId !== null) this.ptys.write(s.ptyId, data);
  }

  // One size per pty, so the last viewer to resize wins -- tmux's
  // `window-size latest`. The mirror follows, so a replay reflows correctly.
  resize(sid, cols, rows) {
    const s = this.map.get(sid);
    if (!s || !(cols > 0 && rows > 0)) return;
    if (s.ptyId !== null) this.ptys.resize(s.ptyId, cols, rows);
    try { s.mirror.resize(cols, rows); } catch {}
    s.meta.cols = cols;
    s.meta.rows = rows;
  }

  // Closing a pane: kill the pty if it still runs, and forget the session.
  // Every other subscriber hears the exit, so its pane goes dead rather than
  // silently freezing.
  kill(sid) {
    const s = this.map.get(sid);
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
