import { version } from '../package.json';
const updateVersion = `${Number(version.split('.')[0])+1}.0.0`;
const calls = window.testCalls = [];
const state = window.testState = {ws:'work',activeSocket:null,speech:null,keyboards:0};
const sessions=[{id:'s1',wsId:'work',title:'Codex',alive:true,cols:100,rows:83},{id:'s2',wsId:'work',title:'Claude',alive:true,cols:80,rows:24}];
const views={work:{activeGroup:'build',groups:[{id:'build',name:'Build',tree:{type:'leaf',kind:'term',id:'l1',ref:'s1'}},{id:'review',name:'Review',tree:{type:'leaf',kind:'term',id:'l2',ref:'s2'}}]}};
views.second={activeGroup:'build',groups:[{id:'build',name:'Build',tree:{type:'leaf',kind:'term',id:'l1',ref:'previous-server-session'}}]};
window.emitOutput=(id,data,grid={})=>state.activeSocket?.onmessage({data:JSON.stringify({t:'ev',e:'pty:data',p:{id,data,...grid}})});
window.dropConnection=()=>state.activeSocket?.onclose();
export async function initNative(){}
export function socketFactory(url){
  state.lastUrl=url;
  const socket={send(raw){
    const m=JSON.parse(raw);calls.push(m);
    const emit=o=>queueMicrotask(()=>socket.onmessage({data:JSON.stringify(o)}));
    if(m.t==='hello'){emit({t:'hello',v:1,role:'host',tote:version,device:url.includes('100.64.1.3')?'Test server':'Test host'});return;}
    let r=null;
    switch(m.m){
      case 'workspaces:list':r={active:state.ws,list:[{id:'work',name:'Work'},{id:'second',name:'Second'},{id:'empty',name:'Empty'}]};break;
      case 'workspaces:setActive':state.ws=m.a[0];if(state.ws==='second'&&!sessions.some(s=>s.id==='s3'))sessions.push({id:'s3',wsId:'second',title:'Second workspace',alive:true,cols:160,rows:83});r={id:state.ws};break;
      case 'device:diagnostics':r={format:'tote-diagnostics-v1',host:{version,state:'current'},terminals:sessions.map(s=>({id:s.id,host:{cols:s.cols,rows:s.rows},alive:true,controller:'another-viewer',data:'DO_NOT_EXPORT'})),events:[{code:'timeout',message:'DO_NOT_EXPORT'}]};break;
      case 'views:get':r=views;break;
      case 'pty:list':r=sessions;break;
      case 'pty:attach':r=sessions.find(s=>s.id===m.a[0]);emit({t:'ev',e:'pty:data',p:{id:r.id,replay:true,cols:r.cols,rows:r.rows,controlsSize:false,data:'Restored '+r.title+'\r\n'+Array.from({length:r.rows-3},(_,i)=>'line '+i+'\r\n').join('')+'$ \x1b[6n\x1b[c'}});break;
      case 'pty:write':emit({t:'ev',e:'pty:data',p:{id:m.a[0].id,data:'\r\nREPLY '+m.a[0].data}});break;
      case 'workspace:tree':r=[{type:'file',name:'notes.md',path:'notes.md'}];break;
      case 'workspace:readDoc':r={kind:'text',text:'# Notes\n<script>untrusted</script>'};break;
      case 'config:getCliProfiles':r=[{id:'shell',name:'Shell'}];break;
      case 'pty:spawn':sessions.push({id:m.a[0].sid,wsId:state.ws,title:'Shell',alive:true,cols:80,rows:24});r={id:m.a[0].sid};break;
    }
    emit({t:'ret',id:m.id,ok:true,r});
  },close(){}};
  state.activeSocket=socket;setTimeout(()=>socket.onopen(),1);return socket;
}
export const Native={checkUpdates:async()=>{state.updateChecks=(state.updateChecks||0)+1;if(state.updateFail)throw Error('offline');return {tag_name:'v'+updateVersion,draft:false,prerelease:false};},openUpdates:async({version})=>{state.openedVersion=version;state.updateOpened=(state.updateOpened||0)+1;},diagnostics:async()=>({tailscaleInstalled:true,pendingFrames:0,pendingBytes:0,queuedBytes:0}),exportDiagnostics:async({text})=>{state.exported=text;return {saved:true};},showKeyboard:async()=>{state.keyboards++;}};
export const Speech={addListener:async(_,fn)=>{state.listener=fn;},start:()=>new Promise((resolve,reject)=>{state.speech={resolve,reject};queueMicrotask(()=>state.listener({listening:true}));}),stop:async()=>{state.speech?.resolve({text:'Keep the desktop layout unchanged.'});state.speech=null;},cancel:async()=>{state.speech?.reject(Error('Canceled'));state.speech=null;}};
const discoveryListeners={};
export const Discovery={
 addListener:async(name,fn)=>{discoveryListeners[name]=fn;},
 start:async({id})=>{queueMicrotask(()=>{discoveryListeners.candidate?.({scan:id,address:'100.64.1.2',port:47821,name:'Studio',peers:[{address:'100.64.1.3',port:47821}]});discoveryListeners.finished?.({scan:id});});},
 stop:async()=>{},openTailscale:async()=>{},
};
