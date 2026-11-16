const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/shared/diagnostics');
const { Host } = require('../src/host/host');

test('reports use typed allowlists, even for malformed logs and attacker-supplied operational fields', () => {
  const secret = '/home/private/token=secret@example.com';
  const input = { capturedAt: 1, token: secret, cookies: secret, files: secret,
    viewer: { kind: secret, version: secret, platform: secret, runtime: secret },
    host: { version: secret, state: secret }, connection: { state: secret, mode: secret, pendingCalls: secret },
    sharing: { enabled: secret, listening: secret, reason: secret }, native: { tailscaleInstalled: secret },
    network: { viewer: {state:secret,reason:secret}, host: {state:secret,reason:secret} },
    terminals: [{id:secret,title:secret,data:secret,host:{cols:secret,rows:Infinity},local:{width:secret},controller:secret}],
    events: [null, [], 7, secret, { at:secret, area:secret, code:secret, message:secret }, {code:{toString: null}}],
  };
  input.unknown = input;
  const result = D.report(input), json = D.stringify(result);
  assert(!json.includes(secret)); assert(!json.includes('cookies'));
  assert.deepEqual(D.report(result), result);
  assert.equal(D.stringify(JSON.parse(json)), json, 'save exactly the reviewed bytes');
  assert.equal(result.terminals[0].label, 'Terminal 1');
  assert.equal(result.terminals[0].host.rows, null);
  assert(result.events.every(e => e.code === 'unknown'));
  for (const value of [null, undefined, 3, 'bad', [], {events:'not an array',terminals:{}}]) assert.doesNotThrow(() => D.stringify(value));
});

test('logs are bounded, classify errors on capture and discard raw messages', () => {
  const log = D.createLog();
  for (let i=0;i<100;i++) log.add('connection', new Error('heartbeat timed out /private/' + i));
  assert.equal(log.snapshot().length, 50);
  assert(log.snapshot().every(e => e.code === 'heartbeat'));
  assert(!JSON.stringify(log.snapshot()).includes('/private'));
  assert.equal(D.classify(new Error('EADDRINUSE /home/user')), 'address_in_use');
  assert.equal(D.classify({code:1234}), 'unknown');
  const events = log.snapshot(); events[0].code='private'; assert.equal(log.snapshot()[0].code, 'heartbeat');
  const report = { terminals: Array.from({length:1000}, () => ({host:{cols:1000,rows:1000},local:{cols:1000,rows:1000,width:50000,height:50000},controller:'another-viewer'})), events:Array(1000).fill({code:'unknown',at:Date.now()}) };
  assert.equal(D.report(report).terminals.length,64);
  assert(Buffer.byteLength(D.stringify(report)) <= 65536);
});

test('disconnected reports retain cached host grid, identify uncertainty, and remove association IDs', () => {
  const snapshot = {host:{version:'0.4.0'},terminals:[{id:'s',host:{cols:120,rows:40},controller:'another-viewer',alive:true}]};
  const r = D.compose({ snapshot, status:'cached', connection:{mode:'remote',state:'disconnected'},
    metrics:[{id:'s',host:{cols:1,rows:1},local:{cols:120,rows:40,width:390,height:640},controller:'this-viewer'}] });
  assert.equal(r.host.state,'cached'); assert.equal(r.terminals.length,1);
  assert.equal(r.terminals[0].host.cols,120); assert.equal(r.terminals[0].local.width,390);
  assert.equal(r.terminals[0].controller,'another-viewer'); assert(!('id' in r.terminals[0]));
  const old = D.compose({status:'unsupported',metrics:[{id:'s',local:{cols:80,rows:24}}]});
  assert.equal(old.host.state,'unsupported'); assert.equal(old.terminals[0].controller,'unknown');
});

test('host reports contain metadata only, with controller relative to the caller', async () => {
  const host = new Host({cfg:{getViews:()=>({})}, workspace:{space:()=>true,activeId:()=> 'a',watchSpaces(){}},
    ptys:{launch:()=>1,write(){},resize(){},kill(){}},
    platform:{version:'0.4.0',diagnostics:async()=>({sharing:{enabled:true,listening:false,reason:'permission'}})}});
  for(const id of ['owner','passive']) host.addViewer({id,send(){}});
  host.sessions.spawn({sid:'s',meta:{title:'secret title',cwd:'/private'},spec:{cols:120,rows:30},viewerId:'owner'});
  const session=host.sessions.map.get('s');
  await new Promise(resolve => session.mirror.write('token=supersecret',resolve));
  try {
    const owner = await host.call('device:diagnostics','owner');
    const passive = await host.call('device:diagnostics','passive');
    assert.equal(owner.terminals[0].controller,'this-viewer');
    assert.equal(passive.terminals[0].controller,'another-viewer');
    assert.equal(owner.terminals[0].host.cols,120);
    assert(!JSON.stringify(owner).includes('secret'));
    host.removeViewer('owner');
    assert.equal((await host.call('device:diagnostics','passive')).terminals[0].controller,'unclaimed');
    await assert.rejects(host.call('pty:attach','passive',['missing']));
    const errors = (await host.call('device:diagnostics','passive')).events;
    assert.equal(errors.length,1); assert.equal(errors[0].area,'terminal');
  } finally { session.mirror.dispose(); }
});

test('an older or silent peer cannot leave diagnostics waiting forever', async () => {
  await assert.rejects(D.withTimeout(new Promise(()=>{}),10), /timed out/);
  assert.equal(await D.withTimeout(Promise.resolve(1),10),1);
});
