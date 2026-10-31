import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DeviceClient } from '../src/client.js';
const require = createRequire(import.meta.url);
const { WebSocket } = require('../../node_modules/ws');
const { DeviceServer } = require('../../src/host/server');
const { Sessions } = require('../../src/host/sessions');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function fixture(t) {
  const viewers = new Map(), writes = [];
  const sessions = new Sessions({launch:()=>1,write:(_,data)=>writes.push(data),resize(){},kill(){}}, (id,e,p)=>viewers.get(id)?.send(e,p));
  const host = {
    addViewer(v) { viewers.set(v.id,v); }, removeViewer(id) { sessions.detachAll(id); viewers.delete(id); },
    async call(name,id,args) {
      if (name==='pty:attach') return sessions.attach(args[0],id);
      if (name==='pty:detach') return sessions.detach(args[0].id,id);
      if (name==='pty:list') return sessions.list();
      if (name==='pty:write') { sessions.write(args[0].id,args[0].data); return null; }
      if (name==='workspaces:list') return {active:'w',list:[{id:'w',name:'Work'}]};
      throw Error('unsupported');
    },
  };
  sessions.spawn({sid:'session',meta:{wsId:'w',title:'Codex'},spec:{cols:100,rows:35},viewerId:null});
  sessions.onData('session','already running\r\n'); await delay(20);
  const server = new DeviceServer({host,device:'test',tote:'0.3.0',authorize:async()=>({ok:true,name:'phone'})});
  await server.start({bind:'127.0.0.1',port:0});
  const port = Number(server.address.split(':').pop());
  const clients = [];
  function client(events=[], options={}) {
    const c = new DeviceClient({socketFactory:(address,p)=>new WebSocket(`ws://${address}:${p}`),onEvent:(e,p)=>events.push([e,p]),timeout:1000,...options});
    clients.push(c); return c;
  }
  t.after(async()=>{for(const c of clients)c.close();await server.stop();sessions.forget('session');});
  return {client,port,sessions,writes,viewers};
}

test('Android framing works against the real host server and replays on reconnect', async t => {
  const f = await fixture(t), events = [], c = f.client(events);
  const hello = await c.connect('127.0.0.1',f.port); assert.equal(hello.device,'test');
  assert.equal((await c.call('workspaces:list')).active,'w');
  const meta = await c.call('pty:attach',['session']); assert.equal(meta.cols,100);
  await delay(30); assert(events.some(([e,p])=>e==='pty:data'&&p.replay&&p.data.includes('already running')));
  await c.call('pty:write',[{id:'session',data:'hello\r'}]); assert(f.writes.includes('hello\r'));
  await assert.rejects(c.call('settings:get'),/Not callable/);
  c.close(); await delay(30); assert.equal(f.sessions.get('session').alive,true);
  f.sessions.onData('session','while phone was away\r\n'); await delay(20);
  const after = [], second = f.client(after); await second.connect('127.0.0.1',f.port); await second.call('pty:attach',['session']); await delay(30);
  assert(after.some(([,p])=>p.replay&&p.data.includes('while phone was away')));
  assert.equal(f.sessions.get('session').cols,100,'attaching never resizes the shared PTY');
});

test('close before hello rejects promptly and pending writes are never replayed', async () => {
  let socket;
  const client = new DeviceClient({socketFactory:()=>socket={send(){},close(){}},helloTimeout:1000});
  const connected = client.connect('unused',1); socket.onclose(); await assert.rejects(connected,/Disconnected/);
  const sent = [];
  const c = new DeviceClient({socketFactory:()=>socket={send:s=>sent.push(JSON.parse(s)),close(){}},timeout:1000});
  const p = c.connect('unused',1); socket.onopen(); socket.onmessage({data:JSON.stringify({t:'hello',v:1,role:'host'})}); await p;
  const write = c.call('pty:write',[{id:'s',data:'dangerous\r'}]); socket.onclose();
  await assert.rejects(write,/Disconnected/); assert.equal(sent.filter(m=>m.t==='call').length,1); assert.equal(c.pending.size,0);
});

test('protocol mismatch, malformed frame, and silent hosts fail clearly', async () => {
  for (const message of ['bad json',JSON.stringify({t:'hello',v:2,role:'host'})]) {
    let s;const c=new DeviceClient({socketFactory:()=>s={send(){},close(){}},helloTimeout:100});
    const p=c.connect('unused',1);s.onmessage({data:message});await assert.rejects(p);c.close();
  }
  const c=new DeviceClient({socketFactory:()=>({send(){},close(){}}),helloTimeout:20});
  await assert.rejects(c.connect('unused',1),/No answer/);
});


test('discovery probe receives host identity without creating a viewer', async t => {
  const f = await fixture(t);
  const probe = f.client([], {role:'probe'});
  const hello = await probe.connect('127.0.0.1',f.port);
  assert.equal(hello.device,'test');
  await delay(20);
  assert.equal(f.viewers.size,0);
  assert.equal(f.sessions.get('session').alive,true);
});

test('live terminal events follow detach and attach without mixing sessions', async t => {
  const f = await fixture(t), events=[], c=f.client(events);
  f.sessions.spawn({sid:'second',meta:{wsId:'second-space'},spec:{cols:160,rows:83},viewerId:null});
  t.after(()=>f.sessions.forget('second'));
  await c.connect('127.0.0.1',f.port);await c.call('pty:attach',['session']);await delay(20);
  f.sessions.onData('session','LIVE_FIRST');await delay(20);
  assert(events.some(([,p])=>!p.replay&&p.data==='LIVE_FIRST'));
  await c.call('pty:detach',[{id:'session'}]);await c.call('pty:attach',['second']);await delay(20);
  events.length=0;f.sessions.onData('session','OLD_SESSION');f.sessions.onData('second','LIVE_SECOND');await delay(20);
  assert.equal(events.length,1);assert.equal(events[0][1].id,'second');assert.equal(events[0][1].data,'LIVE_SECOND');
});
