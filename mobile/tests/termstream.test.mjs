import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Terminal } = require('../../node_modules/@xterm/headless');
const { Sessions } = require('../../src/host/sessions');
const { create } = require('../../src/renderer/termstream');
const delay = ms => new Promise(r => setTimeout(r, ms));
const flush = term => new Promise(r => term.write('', r));
const lines = term => Array.from({length:term.buffer.active.length},(_,i) => {
  const line=term.buffer.active.getLine(i);
  return [line.isWrapped,line.translateToString(true)];
});

test('two viewers parse output at the host size through replay and competing resizes', async t => {
  const viewers = new Map(), received = new Map(), resized = [];
  const host = new Sessions({launch:()=>1,write(){},resize:(_,c,r)=>resized.push([c,r]),kill(){}}, (id,event,p) => {
    if(event==='pty:data') { received.get(id)?.push(p); viewers.get(id)?.stream.write(p); }
  });
  t.after(()=>{host.forget('s');for(const v of viewers.values()){v.stream.dispose();v.term.dispose();}});
  function viewer(id, cols) {
    const term=new Terminal({cols,rows:8,allowProposedApi:true});
    const v={term,stream:create(term)};viewers.set(id,v);received.set(id,[]);return v;
  }
  const local=viewer('local',80), remote=viewer('remote',26);
  host.spawn({sid:'s',spec:{cols:80,rows:8},meta:{},viewerId:'local'});
  host.onData('s','A'.repeat(110)+'\r\n');
  host.attach('s','remote');
  host.resize('s',26,8,'remote',true);
  host.onData('s','\x1b[?1049h\x1b[2J\x1b[H'+ 'B'.repeat(50)+'\x1b[3;4H\x1b[31mRED');
  host.resize('s',80,8,'local',false); // stale background layout must not win
  host.onData('s','\x1b[4;20HEND');
  await delay(60);await flush(local.term);await flush(remote.term);
  assert.equal(host.get('s').cols,26);
  assert.deepEqual(resized,[[26,8]]);
  assert.equal(received.get('remote')[0].cols,80,'replay carries the old grid before resize');
  for(const v of [local,remote]) {
    assert.equal(v.term.cols,26);
    assert.deepEqual(lines(v.term),lines(host.map.get('s').mirror));
    assert.equal(v.term.buffer.active.cursorX,host.map.get('s').mirror.buffer.active.cursorX);
    assert.equal(v.term.buffer.active.getLine(2).getCell(3).getFgColor(),1);
  }
  assert.equal(received.get('local').at(-1).controlsSize,false);
  host.resize('s',80,8,'local',true);
  host.resize('s',26,8,'remote',false);
  host.onData('s','\x1b[?1049l\r\n'+ 'C'.repeat(110));
  await delay(60);await flush(local.term);await flush(remote.term);
  assert.equal(host.get('s').cols,80);
  assert.deepEqual(lines(local.term),lines(remote.term));
  assert.deepEqual(lines(local.term),lines(host.map.get('s').mirror));
  assert.equal(received.get('remote').at(-1).controlsSize,false);
});

test('detach while replay is queued cannot resurrect the subscriber', async () => {
  const events=[];
  const s=new Sessions({launch:()=>1,write(){},resize(){},kill(){}},(...args)=>events.push(args));
  try {
    s.spawn({sid:'s',spec:{cols:80,rows:24},meta:{}});
    s.onData('s','before');s.attach('s','phone');s.detach('s','phone');
    s.onData('s','after');await delay(30);
    assert.equal(events.length,0);
    assert.equal(s.map.get('s').subs.has('phone'),false);
  } finally {s.forget('s');}
});

test('viewer waits for prior parsing before a resize, reset or replay', () => {
  const events=[], callbacks=[];
  const term={cols:80,rows:24,reset:()=>events.push('reset'),resize(c,r){this.cols=c;this.rows=r;events.push(['resize',c,r]);},write(data,cb){events.push(['write',data,this.cols]);callbacks.push(cb);}};
  const stream=create(term);
  stream.write({data:'old',cols:80,rows:24});
  stream.write({data:'new',cols:40,rows:24,replay:true});
  assert.deepEqual(events,[['write','old',80]]);
  callbacks.shift()();
  assert.deepEqual(events,[['write','old',80],'reset',['resize',40,24],['write','new',40]]);
  stream.dispose();callbacks.shift()();
});

test('a focus resize reaches the program before the first keystroke', async () => {
  const actions=[];
  const s=new Sessions({launch:()=>1,write:(_,data)=>actions.push(['write',data]),resize:(_,c,r)=>actions.push(['resize',c,r]),kill(){}},()=>{});
  try {
    s.spawn({sid:'s',spec:{cols:80,rows:24},meta:{},viewerId:'viewer'});
    s.resize('s',40,24,'viewer',true);
    await s.write('s','hello\r');
    assert.deepEqual(actions,[['resize',40,24],['write','hello\r']]);
  } finally {s.forget('s');}
});
