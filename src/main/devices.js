// The viewer side of the devices protocol: one connection to another
// machine's Tote, which a window then uses as its host.
//
// One connection per WINDOW per device, not per device: the host side makes
// each connection a viewer with its own active space, so two windows here
// looking at the same machine can still be in different spaces there, exactly
// as two windows on that machine itself can.
//
// No electron in here either: a client-only build (a phone) would be this
// file and the renderer.
const WebSocket = require('ws');
const Updates = require('../shared/updates');
const { version } = require('../../package.json');
const P = require('../host/protocol');
const TS = require('../host/tailscale');
const { Transport, LIMITS } = require('../host/transport');

const CALL_TIMEOUT = 90 * 1000;   // a remote space's file op rides ssh on the far side

class DeviceClient {
  constructor({ address, port, device, role = 'viewer', onEvent, onClose, limits = {} }) {
    this.role = role;
    this.url = `ws://${address.includes(':') ? '[' + address + ']' : address}:${port}`;
    this.device = device;
    this.onEvent = onEvent || (() => {});
    this.onClose = onClose || (() => {});
    this.limits = { ...LIMITS, ...limits };
    this.ws = null; this.seq = 0; this.pending = new Map(); this.remote = null;
  }

  connect() {
    if (this.ws) return Promise.reject(new Error('Create a new device client to reconnect'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: P.MAX_FRAME, handshakeTimeout: this.limits.helloMs });
      this.ws = ws;
      let greeted = false, transport, timer;
      const finish = (code, reason) => {
        clearTimeout(timer); this.remote = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason + '. Check results before retrying input.')); }
        this.pending.clear();
        if (greeted) this.onClose(code, reason); else reject(new Error(reason));
      };
      timer = setTimeout(() => {
        if (transport) transport.stop(4000, 'No answer from ' + this.url);
        else { ws.terminate(); reject(new Error('No answer from ' + this.url)); }
      }, this.limits.helloMs);
      ws.on('open', () => {
        transport = this.transport = new Transport(ws, { limits: this.limits, onStop: finish });
        transport.send({ ...P.hello(this.role, this.device, version), flow: 1 });
      });
      ws.on('unexpected-response', (req, res) => {
        clearTimeout(timer);
        reject(new Error(res.statusCode === 403 ? 'refused by that device (not one of your devices)' : 'HTTP ' + res.statusCode + ' from ' + this.url));
        req.destroy(); ws.terminate();
      });
      ws.on('message', raw => {
        if (!transport || transport.stopped) return;
        const { msg, error } = P.decode(raw);
        if (error) return transport.stop(4000, 'Invalid response from host');
        if (!greeted) {
          clearTimeout(timer);
          const bad = msg.error || P.checkHello(msg);
          if (bad) return transport.stop(4002, bad);
          greeted = true;
          this.remote = { device: msg.device, tote: msg.tote, flow: msg.flow === 1, versionNotice: Updates.peer(msg, version, P.VERSION).message };
          return resolve(this.remote);
        }
        if (msg.t === 'ret') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id); clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.r); else p.reject(new Error(msg.e));
        } else if (msg.t === 'ev') {
          if (msg.e === 'pty:data') {
            if (this.remote.flow && (!Number.isSafeInteger(msg.seq) || msg.seq < 1)) return transport.stop(4000, 'Missing output sequence');
            transport.consume(msg, Buffer.byteLength(raw), () => this.onEvent(msg.e, msg.p), this.remote.flow);
          } else this.onEvent(msg.e, msg.p);
        }
      });
      ws.on('error', e => { if (!transport) { clearTimeout(timer); reject(e); } });
      ws.on('close', () => { if (!transport) { clearTimeout(timer); reject(new Error('Connection closed before hello')); } });
    });
  }

  call(method, args) {
    if (!this.remote || !this.transport || this.transport.stopped || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected to ' + this.url));
    if (this.pending.size >= this.limits.calls) return Promise.reject(new Error('Too many pending device calls; this call was not sent'));
    let text;
    const id = ++this.seq;
    try { text = P.encode({ t: 'call', id, m: method, a: args || [] }); }
    catch (e) { return Promise.reject(e); }
    if (Buffer.byteLength(text) + this.ws.bufferedAmount > this.limits.streamBytes) return Promise.reject(new Error('Device send buffer is full; this call was not sent'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out on the other device. Check the result before retrying.'));
      }, CALL_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.transport.send({ t: 'call', id, m: method, a: args || [] }) && this.pending.delete(id)) {
        clearTimeout(timer); reject(new Error('Connection closed; check the result before retrying'));
      }
    });
  }

  close() {
    if (this.transport) this.transport.stop(1000, 'Viewer left');
    else if (this.ws) this.ws.terminate();
  }
}

/* Your other machines, and which of them have Tote listening.
 *
 * From `tailscale status`: online, same owner, not shared in. Each candidate
 * is probed with a real hello, so "Tote not running" and "needs an update" are
 * told apart from "offline". Probes run in parallel and give up fast -- this
 * runs when a menu opens. */
async function discover({ port, device }) {
  const st = await TS.status();
  const peers = st.peers.filter((p) => p.ours && p.ip4);
  const probe = async (p) => {
    if (!p.online) return { ...p, tote: null, state: 'offline' };
    const c = new DeviceClient({ address: p.ip4, port, device, role: 'probe' });
    try {
      const hello = await c.connect();
      return { ...p, tote: hello.tote, state: 'ready' };
    } catch (e) {
      const msg = e.message || '';
      const state = /protocol v/.test(msg) ? 'update' : /refused by/.test(msg) ? 'refused' : 'no-tote';
      return { ...p, tote: null, state, reason: msg };
    } finally {
      c.close();
    }
  };
  return { self: st.self, devices: await Promise.all(peers.map(probe)) };
}

module.exports = { DeviceClient, discover };
