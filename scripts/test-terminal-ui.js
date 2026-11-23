// Two real desktop renderers sharing a host mirror; no user config or real PTYs.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { Sessions } = require('../src/host/sessions');
const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-terminal-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const source = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const names = [...new Set([...source.matchAll(/\btote\.(\w+)/g)].map(m => m[1]))];
const preload = path.join(scratch, 'preload.js');
fs.writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron');
const api = Object.fromEntries(${JSON.stringify(names)}.map(name => [name,
  name.startsWith('on') ? () => {} : (...args) => ipcRenderer.invoke('fixture', name, args)]));
api.onPtyData = cb => ipcRenderer.on('pty:data', (_e,p) => cb(p.id,p.data,undefined,!!p.replay,p));
api.onPtyExit = cb => ipcRenderer.on('pty:exit', (_e,p) => cb(p.id,p.exitCode));
contextBridge.exposeInMainWorld('tote',api);
`);
const windows = new Map(), errors = [], resizes = [];
let releaseInitialSessions, initialSessionsRequested = false;
const initialSessions = new Promise(resolve => { releaseInitialSessions = resolve; });
const sessions = new Sessions({launch:()=>1,write(){},resize:(_,cols,rows)=>resizes.push([cols,rows]),kill(){}},
  (id,event,p) => windows.get(id)?.webContents.send(event,p));
sessions.spawn({sid:'shared',meta:{wsId:'work',title:'Shared terminal'},spec:{cols:100,rows:24}});
function finish(code) {
  sessions.forget('shared');
  for (const win of windows.values()) if (!win.isDestroyed()) win.destroy();
  try { fs.rmSync(scratch, { recursive: true, force: true }); }
  catch (error) { console.warn('Could not remove temporary UI fixture:', error.code); }
  app.exit(code);
}
setTimeout(() => { console.error('Terminal UI harness exceeded 60 seconds'); finish(1); }, 60000).unref();
ipcMain.handle('fixture', async (e,name,args) => {
  const id=String(e.sender.id);
  switch(name) {
    case 'getViewsSnapshot': return {protocol:1,views:{work:{tabs:[],docs:[],activeGroup:'g',groups:[{id:'g',name:'Build',tree:{type:'leaf',id:'term-leaf',kind:'term',ref:'shared'},focus:'term-leaf'}]}},revisions:{}};
    case 'patchViews': return {ok:true,snapshot:{protocol:1,views:Object.fromEntries(args[0].changes.filter(c=>c.value!==null).map(c=>[c.wsId,c.value])),revisions:{}}};
    case 'getSettings': return {setupDone:true};
    case 'getProviders': case 'getCliProfiles': case 'listApps': case 'tree': case 'devicesOpen': return [];
    case 'deviceSettings': return {keepAwake:false};
    case 'devicesList': return {devices:[],share:{}};
    case 'listWorkspaces': return {active:'work',list:[{id:'work',name:'Work',path:'/preview'}]};
    case 'getViews': return {work:{tabs:[],docs:[],activeGroup:'g',groups:[{id:'g',name:'Build',tree:{type:'leaf',id:'term-leaf',kind:'term',ref:'shared'},focus:'term-leaf'}]}};
    case 'ptyList':
      if (!initialSessionsRequested) { initialSessionsRequested = true; await initialSessions; }
      return sessions.list();
    case 'ptyAttach': return sessions.attach(args[0],id,args[1]);
    case 'ptyAccess': return sessions.setAccess(args[0],id,args[1]);
    case 'ptyResize': return sessions.resize(args[0],args[1],args[2],id,args[3]);
    case 'ptyAvailable': return {ok:true};
    default: return null;
  }
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  try {
    for(const width of [1400,800]) {
      const win=new BrowserWindow({width,height:800,show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:false,backgroundThrottling:false}});
      windows.set(String(win.webContents.id),win);
      win.webContents.on('console-message',(_e,_l,m)=>{if(/Uncaught|TypeError|ReferenceError/.test(m))errors.push(m);});
      await win.loadFile(path.join(root,'src/renderer/index.html'));
      win.showInactive();
      if (windows.size === 1) {
        const deadline = Date.now() + 15000;
        while (!initialSessionsRequested && Date.now() < deadline) await pause(25);
        assert(initialSessionsRequested, 'first viewer requests host sessions');
        // Force the resize path between the layout snapshot and session reply.
        const refs = await win.webContents.executeJavaScript("applyTiles(); TileTree.leaves(state.views.work.groups[0].tree).map(l=>l.ref)");
        assert(refs.includes('shared'), 'startup resize must preserve terminal leaves until host sessions arrive');
        releaseInitialSessions();
      }
    }
    const [a,b]=[...windows.values()];
    const run=(w,code)=>w.webContents.executeJavaScript(code);
    const size=w=>run(w,"({cols:state.terms.get('shared').term.cols,rows:state.terms.get('shared').term.rows})");
    async function settled(timeout = 5000) {
      let stable=0, last;
      const deadline=Date.now()+timeout;
      while(Date.now()<deadline) {
        await pause(50);
        const h=sessions.get('shared');let ready=true;
        last={host:{cols:h.cols,rows:h.rows},viewers:[]};
        for(const w of windows.values()) {
          const v=await run(w,"(()=>{const t=state.terms.get('shared');return t && {width:innerWidth,cols:t.term.cols,rows:t.term.rows,wants:t.alive&&t.controlsSize?t.fit.proposeDimensions():null};})()");
          last.viewers.push({bounds:w.getContentBounds(),terminal:v});
          ready &&= !!v && v.width===w.getContentBounds().width && v.cols===h.cols && v.rows===h.rows && (!v.wants || (v.wants.cols===h.cols && v.wants.rows===h.rows));
        }
        if(ready) {if(++stable===4)return;} else stable=0;
      }
      throw Error('Terminal geometry did not settle: '+JSON.stringify(last));
    }
    async function check() {
      const host=sessions.get('shared');
      assert.deepEqual(await size(a),{cols:host.cols,rows:host.rows});
      assert.deepEqual(await size(b),await size(a));
    }
    // Cold renderer/font initialization can take longer on a shared runner.
    // Subsequent resize transitions retain the five-second deadline.
    await settled(15000); await check();
    assert.equal(resizes.length,0,'opening passive windows preserves host dimensions');
    await run(a,"document.querySelector('.pane .pane-body').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");
    await settled(); await check();const wide=sessions.get('shared').cols;
    b.setSize(650,700);await settled();await check();
    assert.equal(sessions.get('shared').cols,wide,'passive resize cannot take control');
    await run(b,"document.querySelector('.pane .pane-body').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))");
    await settled();await check();assert(sessions.get('shared').cols<wide);
    const narrow=sessions.get('shared').cols;
    await run(a,'applyTiles(); focusActivePaneContent();');
    await settled();assert.equal(sessions.get('shared').cols,narrow,'background layout/focus restoration must not steal control');
    const viewportChecks = await run(a, `(async()=>{
      const style=document.createElement('style');style.textContent='.pane-body::-webkit-scrollbar{width:14px;height:14px}';document.head.append(style);
      const c=createTermPane('Geometry fixture',{sid:'geometry',place:false});
      Object.assign(c.pane.el.style,{left:'0px',top:'0px',width:'701.5px',height:'502.5px'});
      await new Promise(r=>setTimeout(r,50));
      const cases=[];
      for(let h=500;h<503;h+=.25) {
        c.pane.el.style.height=h+'px';c.term.resize(60,20);
        const samples=[];
        for(let i=0;i<8;i++) {
          sizeTermElement(c.entry);
          const body=c.pane.body,el=c.term.element;
          samples.push({bodyWidth:body.clientWidth,bodyHeight:body.clientHeight,width:el.style.width,height:el.style.height,hbar:body.offsetHeight-body.clientHeight,vbar:body.offsetWidth-body.clientWidth});
        }
        if(new Set(samples.map(s=>JSON.stringify(s))).size>1 || samples.some(s=>s.hbar || s.vbar))cases.push({h,samples});
      }
      await c.entry.stream.write({data:Array.from({length:1600},(_,i)=>'HISTORY_'+i+'\\r\\n').join(''),cols:60,rows:20});
      await new Promise(r=>setTimeout(r,50));
      sizeTermElement(c.entry);
      const retained=c.term.buffer.active.getLine(0).translateToString(true);
      const viewport=c.term.element.querySelector('.xterm-scrollable-element');
      const bottom=c.term.buffer.active.viewportY;
      const wheel=new WheelEvent('wheel',{deltaY:-400,deltaMode:0,bubbles:true,cancelable:true});
      // Chromium synthetic wheel events otherwise expose wheelDeltaY=0,
      // which xterm's normalizer prefers over deltaY. Match a real wheel.
      Object.defineProperty(wheel,'wheelDeltaY',{value:1200});
      viewport.dispatchEvent(wheel);
      await new Promise(r=>setTimeout(r,100));
      const target=c.term.buffer.active.viewportY;
      sizeTermElement(c.entry); // An output measurement must not undo wheel scrolling.
      await new Promise(r=>setTimeout(r,50));
      const scrolled=c.term.buffer.active.viewportY;
      const position=c.term.buffer.active.viewportY;
      await c.entry.stream.write({data:'LIVE_UPDATE'});
      await new Promise(r=>setTimeout(r,50));
      const afterOutput=c.term.buffer.active.viewportY;
      c.pane.el.classList.add('hidden');
      await c.entry.stream.write({data:'\\r\\nHIDDEN_UPDATE'});
      await new Promise(r=>setTimeout(r,50));
      c.pane.el.classList.remove('hidden');
      sizeTermElement(c.entry);repairViewport(c.term);
      await new Promise(r=>setTimeout(r,50));
      const afterShow=c.term.buffer.active.viewportY;
      await c.entry.stream.write({data:'',cols:180,rows:60});
      sizeTermElement(c.entry);
      const overflow={width:c.pane.body.scrollWidth>c.pane.body.clientWidth,
        height:c.pane.body.scrollHeight>c.pane.body.clientHeight,cols:c.term.cols,rows:c.term.rows};
      await new Promise(r=>setTimeout(r,50));
      c.entry.stream.dispose();c.term.dispose();state.terms.delete(c.sid);destroyPaneEl('term:'+c.sid);style.remove();
      return {cases,retained,bottom,target,scrolled,position,afterOutput,afterShow,overflow};
    })()`);
    assert.deepEqual(viewportChecks.cases,[],'fractional pane sizes must not alternate scrollbars');
    assert.equal(viewportChecks.retained,'HISTORY_0','desktop retains the host scrollback beyond 1000 lines');
    assert(viewportChecks.target>0 && viewportChecks.position>0 && viewportChecks.target<viewportChecks.bottom,'fixture has scrollable history: '+JSON.stringify(viewportChecks));
    assert.equal(viewportChecks.scrolled,viewportChecks.target,'output measurement must not undo wheel scrolling');
    assert.equal(viewportChecks.afterOutput,viewportChecks.position,'redraw preserves older-message position');
    assert.equal(viewportChecks.afterShow,viewportChecks.position,'hidden output and reveal preserve older-message position');
    assert.deepEqual(viewportChecks.overflow,{width:true,height:true,cols:180,rows:60},'passive viewers scroll an oversized host grid without reflow');
    sessions.onData('shared','\x1b[?1049h\x1b[2J\x1b[H'+ 'x'.repeat(narrow+10)+'\x1b[3;5H\x1b[31mRED\x1b[4;5H\x1b[38;2;12;180;90mRGB\x1b[0m');
    await settled();await check();
    const content=w=>run(w,"Array.from({length:state.terms.get('shared').term.rows},(_,i)=>state.terms.get('shared').term.buffer.active.getLine(i).translateToString(true))");
    assert.deepEqual(await content(a),await content(b));
    const colors=w=>run(w,"(()=>{const buf=state.terms.get('shared').term.buffer.active;return [buf.getLine(2).getCell(4).getFgColor(),buf.getLine(3).getCell(4).getFgColor()];})()");
    for (const w of windows.values()) assert.deepEqual(await colors(w),[1,0x0cb45a],'live ANSI and truecolor survive shared output');
    sessions.detach('shared',String(a.webContents.id));
    sessions.attach('shared',String(a.webContents.id));
    await settled();await check();
    assert.deepEqual(await colors(a),[1,0x0cb45a],'mirror replay preserves ANSI and truecolor');
    b.setSize(900,800);await settled();await check();assert(sessions.get('shared').cols>narrow,JSON.stringify({narrow,cols:sessions.get('shared').cols,owner:sessions.get('shared').sizeOwner,viewers:await Promise.all([...windows.values()].map(w=>run(w,"(()=>{const t=state.terms.get('shared');return {width:innerWidth,control:t.controlsSize,fit:t.fit.proposeDimensions()};})()")))}));
    await run(b, "setTermAccess(state.terms.get('shared'), 'observe')");
    await run(b, "focusPane('term-leaf');closePane('term-leaf')");
    assert(await run(b, "state.terms.has('shared') && state.terms.get('shared').accessButton.textContent.includes('Read-only')"));
    assert.equal(sessions.diagnostics(String(b.webContents.id))[0].controller, 'unclaimed');
    await run(a, "setTermAccess(state.terms.get('shared'), 'control')");
    await settled();
    assert(await run(b, "state.terms.get('shared').accessButton.textContent.includes('elsewhere')"));
    sessions.onData('shared','\x1b[?1049l\r\nFINAL_FIRST');
    sessions.onData('shared','\r\nFINAL_SECOND');
    sessions.onExit('shared',0);
    await settled();
    for (const w of windows.values()) {
      const text=(await content(w)).join('\n');
      assert(text.includes('FINAL_SECOND') && text.includes('process exited with code 0'));
      assert(text.indexOf('FINAL_SECOND') < text.indexOf('process exited with code 0'),'exit marker follows queued output');
    }
    assert.deepEqual(errors,[]);
    console.log('Shared terminal UI passed: shared sizing, fractional pane stability, scrollback retention, wheel scrolling during redraw, hidden-pane recovery and oversized passive grids.');
    finish(0);
  } catch(e) { console.error(e,errors);finish(1); }
});
