// v1 JSON protocol. Transport injection keeps the native adapter out of tests.
export class DeviceClient {
  constructor({ socketFactory, onEvent = () => {}, onClose = () => {}, timeout = 90000, helloTimeout = 8000, role = 'viewer' }) {
    Object.assign(this, { socketFactory, onEvent, onClose, timeout, helloTimeout, role });
    this.pending = new Map(); this.seq = 0; this.ready = false; this.closed = false;
  }
  connect(address, port) {
    return new Promise((resolve, reject) => {
      const socket = this.socket = this.socketFactory(address, port);
      let greeted = false;
      const fail = error => {
        clearTimeout(timer);
        if (!greeted) reject(error);
        this.finish(error);
      };
      const timer = setTimeout(() => { fail(new Error('No answer. Check Tailscale and Share device on the computer.')); socket.close(); }, this.helloTimeout);
      socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', v: 1, role: this.role, device: 'Tote Android' }));
      socket.onmessage = event => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { fail(new Error('Invalid response from host.')); socket.close(); return; }
        if (!greeted) {
          if (msg?.t !== 'hello' || msg.v !== 1 || msg.role !== 'host' || msg.error) {
            fail(new Error(msg?.error || 'Incompatible host. Update Tote on the computer.')); socket.close(); return;
          }
          greeted = true; this.ready = true; clearTimeout(timer); resolve(msg); return;
        }
        if (msg.t === 'ret') {
          const call = this.pending.get(msg.id);
          if (!call) return;
          clearTimeout(call.timer); this.pending.delete(msg.id);
          if (msg.ok) call.resolve(msg.r); else call.reject(new Error(msg.e || 'Host call failed.'));
        } else if (msg.t === 'ev') this.onEvent(msg.e, msg.p);
      };
      socket.onerror = event => { fail(new Error(event.message || 'Connection failed. Check Tailscale, device sharing and the address.')); socket.close(); };
      socket.onclose = () => fail(new Error('Disconnected. Sessions continue on the computer.'));
      this.rejectConnect = reject;
      this.clearHello = () => clearTimeout(timer);
    });
  }
  call(method, args = []) {
    if (!this.ready) return Promise.reject(new Error('Device is disconnected.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out. Check the result before retrying.')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ t: 'call', id, m: method, a: args })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  finish(error) {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.clearHello?.(); this.rejectConnect?.(error);
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear(); this.onClose(error);
  }
  close() { this.finish(new Error('Viewer disconnected.')); this.socket?.close(); }
}
