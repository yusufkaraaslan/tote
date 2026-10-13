// The host's listener: another device's viewer, over the tailnet.
//
// Every connection becomes one viewer of the Host, exactly as a local window
// is -- its own active space, its own session subscriptions -- so nothing past
// this file knows the difference between a window and a machine.
//
// Three gates, in order: the socket is bound to ONE address (the tailnet one;
// never 0.0.0.0), the caller is identified by Tailscale before the WebSocket
// upgrade completes, and only host methods are callable (protocol.allowedRemote).
const { WebSocketServer } = require('ws');
const P = require('./protocol');
const TS = require('./tailscale');

class DeviceServer {
  // authorize(ip) -> { ok, name, reason }. Injected so the tests can run the
  // whole thing over loopback; the real one asks `tailscale whois`.
  constructor({ host, device, tote, authorize }) {
    this.host = host;
    this.device = device;
    this.tote = tote;
    this.authorize = authorize;
    this.wss = null;
    this.seq = 0;
    this.address = null;
  }

  // Resolves once listening; rejects on EADDRINUSE and friends, so the caller
  // can say why sharing did not start.
  start({ bind, port }) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: bind,
        port,
        maxPayload: P.MAX_FRAME,
        verifyClient: (info, done) => {
          const ip = TS.peerIp(info.req.socket.remoteAddress);
          Promise.resolve(this.authorize(ip))
            .then((a) => {
              if (!a || !a.ok) {
                console.warn('[tote] refused device connection from ' + ip + ': ' + (a && a.reason));
                return done(false, 403, (a && a.reason) || 'refused');
              }
              info.req.toteAuth = a;
              done(true);
            })
            .catch((e) => done(false, 403, e.message));
        },
      });
      wss.once('listening', () => {
        this.wss = wss;
        this.address = bind + ':' + wss.address().port;   // port 0 means "pick one" (tests)
        wss.off('error', reject);
        wss.on('error', (e) => console.error('[tote] device server:', e.message));
        resolve(this.address);
      });
      wss.once('error', reject);
      wss.on('connection', (ws, req) => this.accept(ws, req.toteAuth || {}));
    });
  }

  accept(ws, auth) {
    let vid = null;
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(P.encode(msg)); };

    ws.on('message', (raw) => {
      const { msg, error } = P.decode(raw);
      if (error) return ws.close(4000, error);
      if (!vid) {
        // Nothing is served before a hello that speaks our version.
        const bad = P.checkHello(msg);
        if (bad) {
          send({ t: 'hello', v: P.VERSION, role: 'host', device: this.device, tote: this.tote, error: bad });
          return ws.close(4002, bad.slice(0, 120));
        }
        // A discovery probe only wants to know Tote is here and which version:
        // answered, and never made a viewer (which would arm a watcher here).
        if (msg.role === 'probe') {
          send(P.hello('host', this.device, this.tote));
          return ws.close(1000, 'probe answered');
        }
        vid = 'r' + (++this.seq) + ':' + (auth.name || 'device');
        this.host.addViewer({ id: vid, send: (e, p) => send({ t: 'ev', e, p }) });
        return send(P.hello('host', this.device, this.tote));
      }
      if (msg.t !== 'call') return;
      if (!P.allowedRemote(msg.m)) {
        return send({ t: 'ret', id: msg.id, ok: false, e: 'Not callable from another device: ' + msg.m });
      }
      this.host.call(msg.m, vid, msg.a).then(
        (r) => send({ t: 'ret', id: msg.id, ok: true, r: r === undefined ? null : r }),
        (e) => send({ t: 'ret', id: msg.id, ok: false, e: (e && e.message) || String(e) }),
      );
    });

    // A machine that drops off the tailnet leaves its viewer behind unless
    // this fires; its sessions keep running, as a closed window's do.
    ws.on('close', () => { if (vid) this.host.removeViewer(vid); vid = null; });
    ws.on('error', () => {});
  }

  stop() {
    const wss = this.wss;
    this.wss = null;
    this.address = null;
    if (!wss) return Promise.resolve();
    for (const c of wss.clients) { try { c.close(1001, 'host stopped sharing'); } catch {} }
    return new Promise((r) => wss.close(() => r()));
  }
}

// The production authorizer: whois the caller, compare owners.
function tailnetAuthorizer() {
  let owner = null;
  return async (ip) => {
    if (owner == null) owner = (await TS.status()).owner;
    return TS.authorize(owner, await TS.whois(ip));
  };
}

module.exports = { DeviceServer, tailnetAuthorizer };
