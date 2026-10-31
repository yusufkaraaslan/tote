import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ComputerSearch, normalizeCandidate } from '../src/discovery.js';
const require = createRequire(import.meta.url);
const { advertise, peerCandidates, discoveryTargets, announcement, announcements, DISCOVERY_PORT } = require('../../src/host/discovery');
const delay = ms => new Promise(r => setTimeout(r,ms));

test('announcements go only to online, same-owner Android peers over Tailscale', async () => {
  const sent=[],st={backend:'Running',self:{ip4:'100.64.1.2'},peers:[
    {ours:true,online:true,os:'android',ip4:'100.64.1.3'},
    {ours:false,online:true,os:'android',ip4:'100.64.1.4'},
    {ours:true,online:false,os:'android',ip4:'100.64.1.5'},
    {ours:true,online:true,os:'linux',ip4:'100.64.1.6'},
    {ours:true,online:true,os:'android',ip4:'192.168.1.3'},
  ]};
  let closed=0,bound;
  const stop=advertise({address:'100.64.1.2',port:49000,name:'Studio',version:'0.3.0',status:async()=>st,createSocket:()=>({
    on(){},bind(port,address,ready){bound=address;ready();},send(packet,port,address,done){sent.push({packet:JSON.parse(packet),port,address});done();},close(){closed++;},
  })});
  await delay(5);
  assert.equal(bound,'100.64.1.2');assert.equal(sent.length,1);
  assert.equal(sent[0].address,'100.64.1.3');assert.equal(sent[0].port,DISCOVERY_PORT);
  assert.deepEqual(sent[0].packet,{t:'tote:device',v:1,address:'100.64.1.2',port:49000,name:'Studio',tote:'0.3.0',peers:[{address:'100.64.1.6',port:49000}]});
  stop();stop();assert.equal(closed,1);
  assert.equal(announcement({address:'192.168.1.2',port:47821}),null);
  assert.deepEqual(discoveryTargets(st),['100.64.1.3']);
});
test('stopping during a status lookup cannot send a late packet', async()=>{
  let answer,sent=0;
  const stop=advertise({address:'100.64.1.2',port:47821,status:()=>new Promise(r=>answer=r),createSocket:()=>({
    on(){},bind(p,a,ready){ready();},send(){sent++;},close(){},
  })});
  stop();answer({backend:'Running',self:{ip4:'100.64.1.2'},peers:[{ours:true,online:true,os:'android',ip4:'100.64.1.3'}]});
  await delay(5);assert.equal(sent,0);
});
test('host address/account changes and status failures do not advertise stale hosts', async()=>{
  let sent=0,errors=0;
  for(const status of [async()=>({backend:'Running',self:{ip4:'100.64.2.2'},peers:[{ours:true,online:true,os:'android',ip4:'100.64.1.3'}]}),async()=>{throw Error('offline');}]){
    const stop=advertise({address:'100.64.1.2',port:47821,status,onError:()=>errors++,createSocket:()=>({on(){},bind(p,a,ready){ready();},send(){sent++;},close(){}})});
    await delay(5);stop();
  }
  assert.equal(sent,0);assert.equal(errors,1);
});
test('peer directory excludes shared and non-Tailscale nodes, keeps offline own nodes',()=>{
  const peers=peerCandidates({peers:[{ours:true,ip4:'100.64.1.1',name:'Mine',online:true},{ours:false,ip4:'100.64.1.2'},{ours:true,ip4:'127.0.0.1'},{ours:true,ip4:'100.64.1.3',online:false}]},49000);
  assert.equal(peers.length,2);assert.equal(peers[0].port,49000);assert.equal(peers[1].online,false);
});
test('candidate validation rejects LAN/public addresses before network access',()=>{
  assert.equal(normalizeCandidate({address:'100.64.1.1'}).port,47821);
  for(const address of ['localhost','192.168.1.2','8.8.8.8','100.64.1.1/evil'])assert.throws(()=>normalizeCandidate({address}));
});
test('discovery probes deduplicate, bound concurrency, verify hello and cancel stale results',async()=>{
  const sockets=[],verified=[];let active=0,maxActive=0;
  const search=new ComputerSearch({helloTimeout:500,onVerified:d=>verified.push(d),socketFactory:()=>{
    active++;maxActive=Math.max(maxActive,active);let closed=false;
    const socket={send(raw){const message=JSON.parse(raw);assert.equal(message.role,'probe');},close(){if(!closed){active--;closed=true;}}};
    sockets.push(socket);queueMicrotask(()=>socket.onopen());return socket;
  }});
  for(let i=1;i<=8;i++)search.add({address:'100.64.1.'+i});
  search.add({address:'100.64.1.1'});search.add({address:'192.168.1.1'});
  assert.equal(sockets.length,3);assert.equal(maxActive,3);
  sockets[0].onmessage({data:JSON.stringify({t:'hello',v:1,role:'host',device:'Real Tote'})});await delay(5);
  assert.equal(verified.length,1);assert.equal(verified[0].name,'Real Tote');assert.equal(sockets.length,4);
  sockets[1].onmessage({data:JSON.stringify({t:'hello',v:2,role:'host'})});await delay(5);assert.equal(verified.length,1);
  search.reset();sockets[2].onmessage({data:JSON.stringify({t:'hello',v:1,role:'host',device:'Late'})});await delay(5);
  assert.equal(verified.length,1);assert.equal(active,0);assert.equal(search.running.size,0);
});

test('directory pages fit Android packets and retain all desktop hints',()=>{
  const peers=Array.from({length:64},(_,i)=>({ours:true,online:true,os:'linux',ip4:'100.64.2.'+(i+1)}));
  const packets=announcements({address:'100.64.1.2',port:47821,name:'電'.repeat(80)}, {peers});
  assert(packets.length>1);assert(packets.every(p=>p.length<=1024));
  assert.equal(packets.flatMap(p=>JSON.parse(p).peers).length,64);
});
test('older servers are probed directly only after their directory sender verifies',async()=>{
  const sockets=[],verified=[];
  const search=new ComputerSearch({onVerified:d=>verified.push(d),socketFactory:url=>{
    const socket={url,send(){},close(){}};sockets.push(socket);queueMicrotask(()=>socket.onopen());return socket;
  }});
  const hello=i=>sockets[i].onmessage({data:JSON.stringify({t:'hello',v:1,role:'host',device:'Host '+i})});
  search.add({address:'100.64.1.2',peers:[{address:'100.64.1.3',port:47821},{address:'192.168.1.5'}]});
  assert.equal(sockets.length,1);hello(0);await delay(5);
  assert.equal(sockets.length,2);assert.match(sockets[1].url,/^100\.64\.1\.3$/);
  hello(1);await delay(5);assert.equal(verified.length,2);assert.equal('peers' in verified[0],false);
  search.add({address:'100.64.1.2',peers:[{address:'100.64.1.4',port:47821}]});
  assert.equal(sockets.length,3);search.reset();await delay(5);
  search.add({address:'100.64.1.5',peers:[{address:'100.64.1.6'}]});
  sockets[3].onmessage({data:JSON.stringify({t:'hello',v:2,role:'host'})});await delay(5);
  assert.equal(sockets.length,4);search.reset();
});
