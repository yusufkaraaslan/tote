const {app,BrowserWindow,ipcMain}=require('electron');
const {WebSocket}=require('../../node_modules/ws');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const address=process.env.TOTE_SIM_ADDRESS,dir=process.env.TOTE_UI_DIR;
app.setPath('userData',path.join(dir,'profile'));
// Finish awaited remote cleanup even after the simulation window closes.
app.on('window-all-closed',()=>{});
const sockets=new Map(),created=[];let control,initial,baseline,win;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  const {DeviceClient}=await import('../src/client.js');
  control=new DeviceClient({socketFactory:(a,p)=>new WebSocket(`ws://${a}:${p}`),timeout:15000});
  win=new BrowserWindow({show:true,width:412,height:900,title:'Tote mobile — live server simulation',webPreferences:{preload:path.join(__dirname,'simulator-preload.cjs'),nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',(_e,_level,message)=>{if(/Uncaught|TypeError|ReferenceError/.test(message))errors.push(message);});
  const event=(name,payload)=>{if(!win.isDestroyed())win.webContents.send('sim:'+name,payload);};
  ipcMain.handle('sim:connect',(_,args)=>{
    assert.equal(args.address,address);assert.equal(args.port,47821);
    const ws=new WebSocket(`ws://${address}:47821`);sockets.set(args.id,ws);
    ws.on('open',()=>event('socket',{id:args.id,type:'open'}));
    ws.on('message',data=>event('socket',{id:args.id,type:'message',data:data.toString()}));
    ws.on('error',e=>event('socket',{id:args.id,type:'error',message:e.message}));
    ws.on('close',()=>{sockets.delete(args.id);event('socket',{id:args.id,type:'close'});});
  });
  ipcMain.handle('sim:send',(_,args)=>{const ws=sockets.get(args.id);if(ws?.readyState!==WebSocket.OPEN)throw Error('Disconnected');ws.send(args.data);});
  ipcMain.handle('sim:disconnect',(_,args)=>{sockets.get(args.id)?.close();});
  ipcMain.handle('sim:discover',(_,args)=>{event('candidate',{scan:args.id,address,port:47821,name:'Server'});event('finished',{scan:args.id});});
  const run=code=>win.webContents.executeJavaScript(code,true);
  async function until(code){for(let i=0;i<300;i++){if(await run(code))return;await delay(50);}throw Error('Timed out: '+code);}
  const select=async(id,value)=>{
    const kind={spaces:'space',groups:'group',panes:'pane'}[id];
    await run("document.querySelector('#nav-toggle').click()");
    await run(`document.querySelector('button[data-${kind}="${value}"]').click()`);
    await until("document.querySelector('#workspace').dataset.ready==='true'");
    await run("document.querySelector('#nav-close').click()");
  };
  async function send(command){await run(`document.querySelector('#draft').value=${JSON.stringify(command)};document.querySelector('#draft').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit()`);await until("document.querySelector('#draft').value===''");}
  async function choose(ws,sid){
    await until("document.querySelector('#workspace').dataset.ready==='true'");await select('spaces',ws);
    await until("document.querySelector('#workspace').dataset.ready==='true'");
    // Match the user's action: changing the workspace alone must reveal its
    // running terminal, without the test selecting a group and pane for it.
    await until(`simulation.session()===${JSON.stringify(sid)} && !document.querySelector('#fit').disabled`);
  }
  let passed=false;
  try{
    await control.connect(address,47821);
    initial=await control.call('workspaces:list');baseline=await control.call('views:get');
    const spaces=initial.list.filter(w=>!w.host);assert(spaces.length>=2,'need two local spaces');
    const profiles=await control.call('config:getCliProfiles');const shell=profiles.find(p=>!p.command);assert(shell,'plain shell profile required');
    for(const space of spaces.slice(0,2)){
      const sid='mobiletest_'+crypto.randomBytes(8).toString('hex');
      await control.call('workspaces:setActive',[space.id]);
      created.push(sid);console.log('Created simulation session '+sid+' in '+space.id);await control.call('pty:spawn',[{sid,profileId:shell.id,cols:160,rows:83}]);
    }
    await control.call('workspaces:setActive',[initial.active]);
    await win.loadFile(path.join(dir,'index.html'));
    await until("document.querySelector('#devices .connect')!==null");await run("document.querySelector('#devices .connect').click()");
    await choose(spaces[0].id,created[0]);
    const nonce=crypto.randomBytes(5).toString('hex'),a='TOTE_LIVE_A_'+nonce,b='TOTE_LIVE_B_'+nonce;
    await send(`i=0; while [ "$i" -lt 90 ]; do printf 'test row %s\\n' "$i"; i=$((i+1)); done; printf '%s%s\\n' 'TOTE_' 'LIVE_A_${nonce}'`);
    await until(`simulation.text().includes(${JSON.stringify(a)})`);
    await until("document.querySelector('#terminal-scroll').scrollTop>300");
    console.log('PASS: server received composer input, streamed 90 lines, latest output visible at desktop 160×83 size.');
    await send(`i=0; while [ "$i" -lt 6 ]; do printf '%s%s%s\\n' 'STREAM_' '${nonce}_' "$i"; i=$((i+1)); sleep 1; done`);
    await until(`simulation.text().includes('STREAM_${nonce}_1')`);
    await choose(spaces[1].id,created[1]);
    await send(`printf '%s%s\\n' 'TOTE_' 'LIVE_B_${nonce}'`);
    await until(`simulation.text().includes(${JSON.stringify(b)})`);
    assert.equal(await run(`simulation.text().includes(${JSON.stringify(a)})`),false);
    await delay(1800);assert.equal(await run(`simulation.text().includes('STREAM_${nonce}_')`),false);
    console.log('PASS: switching workspaces replaced terminal contents and excluded live output from the previous session.');
    await choose(spaces[0].id,created[0]);
    await until(`simulation.text().includes('STREAM_${nonce}_5')`);
    console.log('PASS: returning restored output produced while viewing another workspace.');
    // Drop the real transport, retaining the client so its ordinary onClose reconnects.
    for(const ws of sockets.values())ws.close();
    await until("!document.querySelector('#connection-banner').hidden");
    await until(`document.querySelector('#connection-banner').hidden && simulation.text().includes('STREAM_${nonce}_5')`);
    await send(`printf '%s%s\\n' 'RECONNECTED_' '${nonce}'`);
    await until(`simulation.text().includes('RECONNECTED_${nonce}')`);
    console.log('PASS: real socket disconnect automatically reconnected and replayed the terminal.');
    await run("document.querySelector('#files').click()");await until("!document.querySelector('#file-view').hidden && document.querySelector('#file-content').textContent!=='Loading files…'");
    assert.equal(await run("document.querySelector('#file-view').hidden"),false);
    await choose(spaces[1].id,created[1]);await until(`simulation.text().includes(${JSON.stringify(b)})`);
    assert.deepEqual(await control.call('views:get'),baseline,'desktop groups/layout unchanged');assert.deepEqual(errors,[]);
    const out=path.resolve('../dist/mobile/server-simulation.png');fs.mkdirSync(path.dirname(out),{recursive:true});
    fs.writeFileSync(out,(await win.webContents.capturePage()).toPNG());
    console.log('PASS: file listing, groups/layout preservation, no renderer exceptions. Screenshot: '+out);passed=true;
  }catch(e){console.error(e);if(!win.isDestroyed())console.error(await run("({notice:document.querySelector('#notice').textContent,banner:document.querySelector('#connection-banner').textContent,navigation:document.querySelector('#workspace').dataset})"));}
  finally{
    if(!win.isDestroyed())win.destroy();
    for(const ws of sockets.values())ws.close();
    for(const sid of created)try{await control.call('pty:kill',[{id:sid}]);}catch(e){console.error('Cleanup failed for '+sid+': '+e.message);passed=false;}
    if(initial)try{await control.call('workspaces:setActive',[initial.active]);}catch(e){console.error(e);passed=false;}
    control.close();console.log('Removed only the simulation terminals.');app.exit(passed?0:1);
  }
}).catch(e=>{console.error(e);app.exit(1);});
