// Per-connection limits. Never pause a shared PTY for one slow viewer: close
// that viewer and let the normal reconnect/attach path replay the host mirror.
const P = require('./protocol');
const LIMITS = Object.freeze({ heartbeatMs: 15000, pongMs: 15000, outputMs: 30000,
  streamBytes: 8 * 1024 * 1024, socketBytes: P.MAX_FRAME + 8 * 1024 * 1024,
  frames: 4096, calls: 64, closeMs: 1000, helloMs: 5000 });

class Transport {
  constructor(ws, { limits = {}, onStop = () => {} } = {}) {
    this.ws = ws; this.limits = { ...LIMITS, ...limits }; this.onStop = onStop;
    this.stopped = false; this.flow = false; this.seq = 0;
    this.pending = new Map(); this.bytes = 0; this.replayBytes = 0;
    this.lastPing = Date.now(); this.ping = null;
    ws.on('pong', data => { if (String(data) === this.ping?.value) this.ping = null; });
    ws.on('close', (code, reason) => this.stop(code, String(reason || 'Connection closed'), true));
    ws.on('error', error => this.stop(1006, error.message || 'Connection failed', true));
    this.timer = setInterval(() => this.tick(), Math.max(5, Math.min(5000, this.limits.heartbeatMs, this.limits.pongMs, this.limits.outputMs)));
    this.timer.unref?.();
  }
  tick() {
    if (this.stopped) return;
    const now = Date.now(), oldest = this.pending.values().next().value;
    if (oldest && now - oldest.at >= this.limits.outputMs) return this.stop(1013, 'Viewer stopped consuming output; reconnect for a fresh terminal replay');
    if (this.ping && now >= this.ping.deadline) return this.stop(4000, 'Connection heartbeat timed out; reconnecting');
    if (!this.ping && now - this.lastPing >= this.limits.heartbeatMs && this.ws.readyState === this.ws.OPEN) {
      this.lastPing = now;
      this.ping = { value: String(now), deadline: now + this.limits.pongMs };
      try { this.ws.ping(this.ping.value); } catch (e) { this.stop(1006, e.message, true); }
    }
  }
  send(message) {
    if (this.stopped || this.ws.readyState !== this.ws.OPEN) return false;
    const tracked = this.flow && message.t === 'ev' && message.e === 'pty:data';
    const msg = tracked ? { ...message, seq: ++this.seq } : message;
    let text;
    try { text = P.encode(msg); } catch { this.stop(1011, 'Cannot encode device response'); return false; }
    const bytes = Buffer.byteLength(text), replay = tracked && !!msg.p?.replay;
    if (bytes > P.MAX_FRAME || this.ws.bufferedAmount + bytes > this.limits.socketBytes) {
      this.stop(1013, 'Viewer fell behind; reconnect for a fresh terminal replay'); return false;
    }
    if (tracked && !this.track(msg.seq, bytes, replay)) return false;
    try { this.ws.send(text, error => { if (error) this.stop(1006, error.message, true); }); }
    catch (e) { this.stop(1006, e.message, true); return false; }
    return true;
  }
  track(seq, bytes, replay) {
    const replayBytes = this.replayBytes + (replay ? bytes : 0);
    if (this.pending.size >= this.limits.frames || this.bytes + bytes > this.limits.socketBytes ||
        this.bytes + bytes - replayBytes > this.limits.streamBytes) {
      this.stop(1013, 'Viewer fell behind; reconnect for a fresh terminal replay'); return false;
    }
    this.pending.set(seq, { bytes, replay, at: Date.now() });
    this.bytes += bytes; this.replayBytes = replayBytes;
    return true;
  }
  consume(msg, bytes, callback, acknowledge) {
    const token = ++this.seq;
    if (!this.track(token, bytes, !!msg.p?.replay)) return;
    let result;
    try { result = callback(); } catch (e) { this.stop(1011, 'Cannot consume terminal output'); return; }
    Promise.resolve(result).then(() => {
      this.ack(token);
      if (!this.stopped && acknowledge) this.send({ t: 'ack', seq: msg.seq });
    }, () => this.stop(1011, 'Cannot consume terminal output'));
  }
  ack(seq) {
    const frame = this.pending.get(seq);
    if (!frame) return;
    this.pending.delete(seq); this.bytes -= frame.bytes;
    if (frame.replay) this.replayBytes -= frame.bytes;
  }
  stop(code = 1000, reason = 'Viewer left', immediate = false) {
    if (this.stopped) { if (this.ws.readyState === this.ws.CLOSED) clearTimeout(this.force); return; }
    this.stopped = true; clearInterval(this.timer);
    this.pending.clear(); this.bytes = this.replayBytes = 0;
    this.onStop(code, reason);
    if (this.ws.readyState === this.ws.CLOSED) return;
    if (immediate) { this.ws.terminate(); return; }
    try { this.ws.close(code, reason.slice(0, 120)); } catch { this.ws.terminate(); }
    this.force = setTimeout(() => this.ws.terminate(), this.limits.closeMs);
    this.force.unref?.();
  }
}
module.exports = { Transport, LIMITS };
