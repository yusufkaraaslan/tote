const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const { Terminal } = require('@xterm/headless');
const { Transport } = require('../src/host/transport');
const { DeviceServer } = require('../src/host/server');
const { DeviceClient } = require('../src/main/devices');
const { Sessions } = require('../src/host/sessions');
const { create: stream } = require('../src/renderer/termstream');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await pause(10); } throw Error('Timed out'); }
const flush = term => new Promise(r => term.write('', r));
const lines = term => Array.from({ length: term.buffer.active.length }, (_, i) => [term.buffer.active.getLine(i).isWrapped, term.buffer.active.getLine(i).translateToString(true)]);

class Socket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.CLOSED = 3; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(text, done) { this.sent.push(JSON.parse(text)); done?.(); }
  ping(value) { this.lastPing = value; }
  close(code, reason) { this.closed = { code, reason }; }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close', 1006, ''); }
}
const packet = (data = 'x', replay = false) => ({ t: 'ev', e: 'pty:data', p: { id: 's', data, replay, cols: 80, rows: 24 } });

test('socket pressure, unacknowledged bytes and tiny-frame floods disconnect within bounds', () => {
  for (const mode of ['socket', 'bytes', 'frames']) {
    const ws = new Socket(), stopped = [];
    const t = new Transport(ws, { limits: { streamBytes: mode === 'bytes' ? 200 : 10000, socketBytes: 10000, frames: 2 }, onStop: (...args) => stopped.push(args) });
    t.flow = true;
    if (mode === 'socket') ws.bufferedAmount = 10000;
    t.send(packet('💥'.repeat(20))); t.send(packet('💥'.repeat(20))); t.send(packet());
    assert.equal(t.stopped, true); assert.equal(stopped.length, 1); assert.equal(stopped[0][0], 1013);
    assert.equal(t.pending.size, 0); assert.equal(t.bytes, 0);
    ws.terminate();
  }
});

test('replay has bounded extra allowance; acknowledgements cannot free unrelated bytes', () => {
  const ws = new Socket(), t = new Transport(ws, { limits: { streamBytes: 300, socketBytes: 5000 } });
  t.flow = true;
  assert.ok(t.send(packet('x'.repeat(1000), true)));
  assert.ok(t.send(packet('live')));
  const [replay, live] = ws.sent;
  const before = t.bytes;
  t.ack(999); assert.equal(t.bytes, before);
  t.ack(live.seq); const after = t.bytes;
  t.ack(live.seq); assert.equal(t.bytes, after);
  t.ack(replay.seq); assert.equal(t.bytes, 0); assert.equal(t.replayBytes, 0);
  t.stop(); ws.terminate();
});

test('a throwing consumer cleanup still closes and forcibly terminates the socket', async () => {
  const ws = new Socket();
  const transport = new Transport(ws, { limits: { closeMs: 10 }, onStop: () => { throw Error('consumer failed'); } });
  assert.doesNotThrow(() => transport.stop(1013, 'overloaded'));
  assert.equal(ws.closed.code, 1013);
  await until(() => ws.terminated);
});

test('heartbeat and parser deadlines retire a viewer even after sleep or a stalled close handshake', async () => {
  for (const output of [false, true]) {
    const ws = new Socket(), t = new Transport(ws, { limits: { closeMs: 10 } });
    if (output) { t.flow = true; t.send(packet()); t.pending.values().next().value.at = 0; }
    else {
      t.lastPing = 0; t.tick(); assert.ok(ws.lastPing);
      ws.emit('pong', Buffer.from('wrong')); assert.ok(t.ping);
      ws.emit('pong', Buffer.from(ws.lastPing)); assert.equal(t.ping, null);
      t.lastPing = 0; t.tick(); t.ping.deadline = 0;
    }
    t.tick(); assert.equal(t.stopped, true);
    assert.match(ws.closed.reason, output ? /consuming/ : /heartbeat/);
    await until(() => ws.terminated);
  }
});

async function fixture(t, limits = {}) {
  const viewers = new Map(), writes = [], clients = [], held = [];
  let holdInput = false;
  const sessions = new Sessions({ launch: () => 1, resize() {}, kill() {}, write: (_, data) => writes.push(data) }, (id, e, p) => viewers.get(id)?.send(e, p));
  const host = {
    addViewer(v) { viewers.set(v.id, v); },
    removeViewer(id) { sessions.detachAll(id); viewers.delete(id); },
    async call(name, id, args) {
      if (name === 'pty:attach') return sessions.attach(args[0], id);
      if (name === 'pty:resize') return sessions.resize(args[0].id, args[0].cols, args[0].rows, id, true);
      if (name === 'pty:write') {
        await sessions.write(args[0].id, args[0].data);
        if (holdInput) await new Promise(r => held.push(r));
        return true;
      }
      if (name === 'workspaces:list') return { active: 'a', list: [] };
      if (name === 'workspace:read') return new Promise(r => held.push(r));
      throw Error('unsupported');
    },
  };
  sessions.spawn({ sid: 's', spec: { cols: 80, rows: 24 }, meta: {} });
  sessions.onData('s', 'INITIAL\r\n'); await flush(sessions.map.get('s').mirror);
  const server = new DeviceServer({ host, device: 'fixture', authorize: async () => ({ ok: true }), limits });
  await server.start({ bind: '127.0.0.1', port: 0 });
  const port = Number(server.address.split(':').pop());
  function client(options = {}) {
    const c = new DeviceClient({ address: '127.0.0.1', port, ...options }); clients.push(c); return c;
  }
  t.after(async () => { for (const c of clients) c.close(); for (const resolve of held) resolve(); await server.stop(); sessions.forget('s'); });
  return { server, sessions, viewers, writes, port, client, holdInput: () => { holdInput = true; } };
}

test('a slow viewer disconnects while a healthy viewer preserves output and grid; reconnect replays without retrying input', async t => {
  const f = await fixture(t, { frames: 4, streamBytes: 32768 });
  let closed; const delayed = [];
  const slow = f.client({ onEvent: () => new Promise(r => delayed.push(r)), onClose: (code, reason) => { closed = { code, reason }; } });
  const healthyTerm = new Terminal({ cols: 30, rows: 10, scrollback: 5000, allowProposedApi: true }), healthyStream = stream(healthyTerm);
  t.after(() => { healthyStream.dispose(); healthyTerm.dispose(); });
  const healthy = f.client({ onEvent: (e, p) => e === 'pty:data' ? healthyStream.write(p) : undefined });
  await slow.connect(); const slowTransport = [...f.server.transports][0];
  await healthy.connect(); const fastTransport = [...f.server.transports][1];
  await slow.call('pty:attach', ['s']); await healthy.call('pty:attach', ['s']);
  f.holdInput(); const input = slow.call('pty:write', [{ id: 's', data: 'one command\r' }]);
  const rejected = assert.rejects(input, /retrying|closed|behind/);
  await until(() => f.writes.length === 1);
  for (let i = 0; i < 40; i++) {
    f.sessions.onData('s', '\x1b[31m' + String(i).padStart(3, '0') + 'x'.repeat(8192) + '\r\n');
    await flush(f.sessions.map.get('s').mirror);
    await until(() => fastTransport.pending.size === 0);
  }
  await until(() => closed); await rejected;
  assert.equal(closed.code, 1013); assert.match(closed.reason, /fell behind/);
  assert.equal(slowTransport.pending.size, 0); assert.equal(f.viewers.size, 1);
  assert.deepEqual(lines(healthyTerm), lines(f.sessions.map.get('s').mirror), 'healthy viewer keeps the complete streamed history');
  await healthy.call('pty:resize', [{ id: 's', cols: 51, rows: 17 }]);
  f.sessions.onData('s', '\x1b[?1049h\x1b[2J\x1b[3;7HCURSOR');
  await flush(f.sessions.map.get('s').mirror); await until(() => fastTransport.pending.size === 0);
  assert.equal(healthyTerm.cols, 51); assert.deepEqual(lines(healthyTerm), lines(f.sessions.map.get('s').mirror));
  const replayTerm = new Terminal({ cols: 12, rows: 8, scrollback: 5000, allowProposedApi: true }), replayStream = stream(replayTerm);
  t.after(() => { replayStream.dispose(); replayTerm.dispose(); });
  replayTerm.write('STALE CONTENT'); await flush(replayTerm);
  const reconnected = f.client({ onEvent: (e, p) => e === 'pty:data' ? replayStream.write(p) : undefined });
  await reconnected.connect(); await reconnected.call('pty:attach', ['s']);
  await until(() => replayTerm.cols === 51 && replayTerm.buffer.active.getLine(2)?.translateToString(true).includes('CURSOR'));
  assert.deepEqual(lines(replayTerm), lines(f.sessions.map.get('s').mirror));
  for (const resolve of delayed) resolve(); await pause(20);
  assert.deepEqual(f.writes, ['one command\r']); assert.equal(f.sessions.get('s').alive, true);
});

test('pending automatic pong floods disconnect only the affected peer in both directions', async t => {
  for (const direction of ['host', 'viewer']) {
    const f = await fixture(t);
    const flooding = f.client();
    await flooding.connect(); await flooding.call('pty:attach', ['s']);
    const hostSocket = [...f.server.wss.clients][0];
    let received = '';
    const healthy = f.client({ onEvent: (event, payload) => { if (event === 'pty:data') received += payload.data; } });
    await healthy.connect(); await healthy.call('pty:attach', ['s']);
    const target = direction === 'host' ? hostSocket : flooding.ws;
    const source = direction === 'host' ? flooding.ws : hostSocket;
    // Hold socket writes to model a non-reading peer without relying on OS
    // buffer sizes or allocating an unbounded flood. The library's default
    // limit must apply through Tote's actual server and client constructors.
    target._socket.cork();
    t.after(() => target.terminate());
    for (let i = 0; i < 61; i++) source.ping('probe');
    await until(() => target.readyState === WebSocket.CLOSED && f.viewers.size === 1);
    assert.equal(f.sessions.map.get('s').subs.size, 1);
    assert.equal(f.sessions.get('s').alive, true);
    f.sessions.onData('s', 'AFTER-PING-FLOOD\r\n');
    await until(() => received.includes('AFTER-PING-FLOOD'));
    await healthy.call('pty:write', [{ id: 's', data: 'still usable\r' }]);
    assert.deepEqual(f.writes, ['still usable\r']);
  }
});

test('overload during replay cannot resurrect a detached subscription', async t => {
  const f = await fixture(t, { frames: 0 }); let closed = false;
  const c = f.client({ onClose: () => { closed = true; } });
  await c.connect(); await c.call('pty:attach', ['s']).catch(() => {});
  await until(() => closed);
  assert.equal(f.viewers.size, 0); assert.equal(f.sessions.map.get('s').subs.size, 0);
  assert.equal(f.sessions.map.get('s').pending.size, 0);
});

test('reconnect churn releases viewers, acknowledgements and subscriptions while the PTY survives', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) {
    const term = new Terminal({ cols: 12, rows: 8, scrollback: 5000, allowProposedApi: true });
    const parsed = stream(term);
    const c = f.client({ onEvent: (e, p) => e === 'pty:data' ? parsed.write(p) : undefined });
    try {
      await c.connect(); await c.call('pty:attach', ['s']);
      await until(() => term.cols === 80 && c.transport.pending.size === 0);
      assert.deepEqual(lines(term), lines(f.sessions.map.get('s').mirror));
      c.close();
      await until(() => f.viewers.size === 0 && f.server.transports.size === 0);
      assert.equal(c.pending.size, 0); assert.equal(c.transport.pending.size, 0);
      assert.equal(f.sessions.map.get('s').subs.size, 0); assert.equal(f.sessions.map.get('s').pending.size, 0);
      f.sessions.onData('s', `while disconnected ${i}\r\n`); await flush(f.sessions.map.get('s').mirror);
    } finally { c.close(); parsed.dispose(); term.dispose(); }
  }
  assert.equal(f.sessions.get('s').alive, true); assert.deepEqual(f.writes, []);
});

test('client and server bound outstanding calls; rejected calls are not executed', async t => {
  for (const serverLimit of [false, true]) {
    const f = await fixture(t, { calls: serverLimit ? 2 : 64 });
    const c = f.client({ limits: { calls: serverLimit ? 64 : 2 } }); await c.connect();
    const first = c.call('workspace:read', ['one']).catch(e => e);
    const second = c.call('workspace:read', ['two']).catch(e => e);
    await assert.rejects(c.call('workspace:read', ['three']), serverLimit ? /pending device calls/ : /not sent/);
    if (!serverLimit) { assert.equal(c.pending.size, 2); c.close(); }
    await Promise.all([first, second]); assert.equal(c.pending.size, 0);
  }
});

test('ungreeted or unresponsive sockets cannot hold server shutdown open', async t => {
  const f = await fixture(t, { helloMs: 50, closeMs: 20 });
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}`);
  t.after(() => ws.terminate());
  await new Promise(resolve => ws.on('open', resolve));
  ws._socket.pause(); // simulate a peer that will not read/respond to close
  await pause(80);
  await Promise.race([f.server.stop(), pause(1000).then(() => { throw Error('shutdown hung'); })]);
  assert.equal(f.viewers.size, 0);
});

test('older clients need no application acknowledgements and new clients accept older hosts', async t => {
  const f = await fixture(t);
  const raw = new WebSocket(`ws://127.0.0.1:${f.port}`); t.after(() => raw.terminate());
  const messages = []; raw.on('message', m => messages.push(JSON.parse(m)));
  await new Promise(r => raw.on('open', r)); raw.send(JSON.stringify({ t: 'hello', v: 1, role: 'viewer' }));
  await until(() => messages.length);
  raw.send(JSON.stringify({ t: 'call', id: 1, m: 'pty:attach', a: ['s'] }));
  await until(() => messages.some(m => m.t === 'ev'));
  assert.equal(messages.find(m => m.t === 'ev').seq, undefined);
  assert.equal([...f.server.transports][0].pending.size, 0);

  const old = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => old.on('listening', r));
  old.on('connection', ws => ws.on('message', () => ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'host', device: 'old' }))));
  const c = new DeviceClient({ address: '127.0.0.1', port: old.address().port });
  t.after(async () => { c.close(); for (const ws of old.clients) ws.terminate(); await new Promise(r => old.close(r)); });
  const hello = await c.connect(); assert.equal(hello.flow, false);
});
