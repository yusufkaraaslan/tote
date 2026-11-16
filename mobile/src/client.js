import Updates from '../../src/shared/updates.js';
// v1 JSON protocol. Transport injection keeps the native adapter out of tests.
export class DeviceClient {
  constructor({ socketFactory, onEvent = () => {}, onClose = () => {}, timeout = 90000, helloTimeout = 8000, role = 'viewer', maxPending = 64, maxFrames = 4096, maxOutput = 72 * 1024 * 1024, outputTimeout = 30000 }) {
    Object.assign(this, { socketFactory, onEvent, onClose, timeout, helloTimeout, role });
    this.pending = new Map(); this.seq = 0; this.ready = false; this.closed = false;
    Object.assign(this, { maxPending, maxFrames, maxOutput, outputTimeout });
    this.output = new Map(); this.outputBytes = 0; this.outputSeq = 0;
  }
  connect(address, port) {
    return new Promise((resolve, reject) => {
      const socket = this.socket = this.socketFactory(address, port);
      let greeted = false;
      const fail = error => {
        clearTimeout(timer);
        if (!greeted) reject(error);
        this.finish(error);
        socket.close();
      };
      const timer = setTimeout(() => { fail(new Error('No answer. Check Tailscale and Share device on the computer.')); socket.close(); }, this.helloTimeout);
      const send = message => {
        try { Promise.resolve(socket.send(JSON.stringify(message))).catch(fail); } catch (e) { fail(e); }
      };
      socket.onopen = () => send({ t: 'hello', v: 1, role: this.role, device: 'Tote Android', flow: 1 });
      socket.onmessage = event => {
        if (this.closed) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { fail(new Error('Invalid response from host.')); socket.close(); return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { fail(new Error('Invalid response from host.')); return; }
        if (!greeted) {
          if (msg?.t !== 'hello' || msg.v !== 1 || msg.role !== 'host' || msg.error) {
            fail(new Error(msg?.error || Updates.peer(msg).message || 'Incompatible host. Update Tote on the computer.')); socket.close(); return;
          }
          greeted = true; this.ready = true; this.flow = msg.flow === 1; clearTimeout(timer);
          this.outputTimer = setInterval(() => {
            const oldest = this.output.values().next().value;
            if (oldest && Date.now() - oldest.at >= this.outputTimeout) fail(new Error('Terminal output stalled. Reconnecting for a fresh replay.'));
          }, Math.max(5, Math.min(5000, this.outputTimeout)));
          resolve(msg); return;
        }
        if (msg.t === 'ret') {
          const call = this.pending.get(msg.id);
          if (!call) return;
          clearTimeout(call.timer); this.pending.delete(msg.id);
          if (msg.ok) call.resolve(msg.r); else call.reject(new Error(msg.e || 'Host call failed.'));
        } else if (msg.t === 'ev') {
          if (msg.e !== 'pty:data') return this.onEvent(msg.e, msg.p);
          if (this.flow && (!Number.isSafeInteger(msg.seq) || msg.seq < 1)) return fail(new Error('Missing terminal output sequence.'));
          const bytes = new TextEncoder().encode(event.data).length, token = ++this.outputSeq;
          if (this.output.size >= this.maxFrames || this.outputBytes + bytes > this.maxOutput) return fail(new Error('Phone fell behind. Reconnecting for a fresh terminal replay.'));
          this.output.set(token, { bytes, at: Date.now() }); this.outputBytes += bytes;
          let parsed;
          try { parsed = this.onEvent(msg.e, msg.p); } catch (error) { fail(error); return; }
          return Promise.resolve(parsed).then(() => {
            if (this.closed) return;
            this.output.delete(token); this.outputBytes -= bytes;
            if (this.flow) send({ t: 'ack', seq: msg.seq });
          }, fail);
        }
      };
      socket.onerror = event => { fail(new Error(event.message || 'Connection failed. Check Tailscale, device sharing and the address.')); socket.close(); };
      socket.onclose = event => fail(new Error(event?.reason || 'Disconnected. Sessions continue on the computer.'));
      this.rejectConnect = reject;
      this.clearHello = () => clearTimeout(timer);
    });
  }
  call(method, args = []) {
    if (!this.ready) return Promise.reject(new Error('Device is disconnected.'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error('Too many pending device calls. This call was not sent.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out. Check the result before retrying.')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const text = JSON.stringify({ t: 'call', id, m: method, a: args });
        if (new TextEncoder().encode(text).length + (this.socket.bufferedAmount || 0) > 8 * 1024 * 1024) throw new Error('Device send buffer is full. This call was not sent.');
        Promise.resolve(this.socket.send(text)).catch(error => { this.finish(error); this.socket.close(); });
      }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  finish(error) {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.clearHello?.(); this.rejectConnect?.(error);
    clearInterval(this.outputTimer); this.output.clear(); this.outputBytes = 0;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear(); this.onClose(error);
  }
  close() { this.finish(new Error('Viewer disconnected.')); this.socket?.close(); }
}
