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
const P = require('../host/protocol');
const TS = require('../host/tailscale');

const CALL_TIMEOUT = 90 * 1000;   // a remote space's file op rides ssh on the far side
const HELLO_TIMEOUT = 5000;

class DeviceClient {
  constructor({ address, port, device, role = 'viewer', onEvent, onClose }) {
    this.role = role;
    this.url = `ws://${address.includes(':') ? '[' + address + ']' : address}:${port}`;
    this.device = device;
    this.onEvent = onEvent || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.remote = null;              // the host's hello: device name, Tote version
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { maxPayload: P.MAX_FRAME, handshakeTimeout: HELLO_TIMEOUT });
      this.ws = ws;
      let greeted = false;
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('no answer from ' + this.url)); }, HELLO_TIMEOUT);
      ws.on('open', () => ws.send(P.encode(P.hello(this.role, this.device))));
      ws.on('unexpected-response', (req, res) => {
        clearTimeout(timer);
        reject(new Error(res.statusCode === 403
          ? 'refused by that device (' + (res.statusMessage || 'not one of your devices') + ')'
          : 'HTTP ' + res.statusCode + ' from ' + this.url));
      });
      ws.on('message', (raw) => {
        const { msg, error } = P.decode(raw);
        if (error) return;
        if (!greeted) {
          clearTimeout(timer);
          const bad = msg.error || P.checkHello(msg);
          if (bad) { reject(new Error(bad)); return ws.close(); }
          greeted = true;
          this.remote = { device: msg.device, tote: msg.tote };
          return resolve(this.remote);
        }
        if (msg.t === 'ret') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.r); else p.reject(new Error(msg.e));
        } else if (msg.t === 'ev') {
          this.onEvent(msg.e, msg.p);
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); if (!greeted) reject(e); });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('connection to ' + this.url + ' closed')); }
        this.pending.clear();
        if (greeted) this.onClose(code, String(reason || ''));
      });
    });
  }

  call(method, args) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected to ' + this.url));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + ' timed out on the other device'));
      }, CALL_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(P.encode({ t: 'call', id, m: method, a: args || [] }));
    });
  }

  close() {
    if (this.ws) { try { this.ws.close(1000, 'viewer left'); } catch {} }
    this.ws = null;
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
