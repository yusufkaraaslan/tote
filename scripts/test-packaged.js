// Execute with the PACKAGED Electron runtime, so loading the PTY exercises its ABI.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.env.TOTE_PACKAGED_ASAR) {
 const {spawnSync}=require('node:child_process');
 const dist=path.resolve('dist/release'); let bin,asar;
 if(process.platform==='linux'){bin=path.join(dist,'linux-unpacked','tote');asar=path.join(dist,'linux-unpacked/resources/app.asar');}
 else if(process.platform==='win32'){bin=path.join(dist,'win-unpacked/Tote.exe');asar=path.join(dist,'win-unpacked/resources/app.asar');}
 else { const folder=fs.readdirSync(dist).find(n=>/^mac(?:-arm64)?$/.test(n));assert(folder,'Missing macOS package');const app=path.join(dist,folder,'Tote.app/Contents');bin=path.join(app,'MacOS/Tote');asar=path.join(app,'Resources/app.asar'); }
 const r=spawnSync(bin,[__filename],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TOTE_PACKAGED_ASAR:asar},stdio:'inherit',timeout:150000});
 if(r.error)console.error(r.error.message); process.exit(r.status??1);
} else {
 const asar=process.env.TOTE_PACKAGED_ASAR, expected=require('../release.json').version;
 assert.equal(require(path.join(asar,'package.json')).version,expected);
 assert.equal(require(path.join(asar,'release.json')).version,expected);
 assert(fs.existsSync(path.join(asar,'src/renderer/vendor/xterm.js')));
 const pty=require(path.join(asar,'node_modules/node-pty'));
 const shell=process.platform==='win32'?process.env.COMSPEC||'cmd.exe':'/bin/sh';
 const args=process.platform==='win32'?['/d','/s','/c','echo TOTE_PACKAGED_PTY_OK']:['-c','printf TOTE_PACKAGED_PTY_OK'];
 const terminal=pty.spawn(shell,args,{cols:80,rows:24,cwd:require('node:os').tmpdir(),env:process.env});
 let output='';const timer=setTimeout(()=>{terminal.kill();console.error('Packaged PTY timed out');process.exit(1);},10000);
 terminal.onData(data=>output+=data);
 terminal.onExit(async ()=>{clearTimeout(timer);assert(output.includes('TOTE_PACKAGED_PTY_OK'));console.log('Packaged version, assets and real PTY passed');
  // ConPTY leaves worker handles alive in this standalone Node-mode harness.
  // The child PTY has exited and its output was checked; end the harness too.
  try { await backgroundSmoke(asar); process.exit(0); } catch (error) { console.error(error); process.exit(1); }
 });
}

async function backgroundSmoke(asar) {
 const os=require('node:os'), disk=require('original-fs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tote-packaged-host-'));
 const {installRuntime}=require(path.join(asar,'src/main/hostInstall'));
 const {LocalHost}=require(path.join(asar,'src/main/localHost'));
 const config=path.join(dir,'config');fs.mkdirSync(config);
 const write=(name,value)=>fs.writeFileSync(path.join(config,name+'.json'),JSON.stringify(value));
 write('workspaces',{active:'a',list:[{id:'a',name:'A',path:path.join(dir,'workspace')}]});
 write('settings',{shareDevice:false,keepAwake:false,bridgeDownloads:false});
 write('cli-profiles',[{id:'shell',name:'Shell',command:process.platform==='win32'?'cmd.exe':'/bin/sh',args:process.platform==='win32'?['/d']:[]}]);
 let host;
 try {
  // Rehearse replacement using a disposable installation, never the real app.
  const source=process.platform==='darwin'?path.resolve(process.execPath,'../../..'):path.dirname(process.execPath);
  const installation=path.join(dir,process.platform==='darwin'?'Installed Tote.app':'installed');
  await disk.promises.cp(source,installation,{recursive:true,dereference:false,verbatimSymlinks:true});
  const launch=await installRuntime({dataDir:dir,
   executable:path.join(installation,path.relative(source,process.execPath)),
   appPath:path.join(installation,path.relative(source,asar)),packaged:true});
  assert.notEqual(launch.executable,process.execPath);
  host=new LocalHost(dir,launch);
  const status=await host.start();assert.notEqual(status.pid,process.pid);
  let output='';
  await host.addViewer({id:'one',send(event,payload){if(event==='pty:data'){output+=payload.data;host.ack('one',payload.delivery);}}});
  await host.call('pty:spawn','one',[{sid:'packaged-host',profileId:'shell',cols:92,rows:26}]);
  const marker='state-'+require('node:crypto').randomUUID();
  await host.call('pty:write','one',[{id:'packaged-host',data:process.platform==='win32'
   ? 'set TOTE_UPGRADE_MARKER='+marker+'\r' : 'TOTE_UPGRADE_MARKER='+marker+'\r'}]);
  await host.call('pty:write','one',[{id:'packaged-host',data:'echo TOTE_BACKGROUND_READY\r'}]);
  const end=Date.now()+10000;
  while(!output.includes('TOTE_BACKGROUND_READY')&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
  assert(output.includes('TOTE_BACKGROUND_READY'));
  host.close();
  // Installers may remove every file at the old desktop path. The host's
  // private runtime must continue to execute, including its native PTY.
  await disk.promises.rm(installation,{recursive:true,force:true});
  assert(!fs.existsSync(installation));
  const nextLaunch=await installRuntime({dataDir:dir,executable:process.execPath,appPath:asar,packaged:true});
  host=new LocalHost(dir,nextLaunch);
  assert.equal((await host.start()).pid,status.pid,'replacement viewer must reuse the running host');
  output='';
  await host.addViewer({id:'two',send(event,payload){if(event==='pty:data'){output+=payload.data;host.ack('two',payload.delivery);}}});
  const replay=await host.call('pty:attach','two',['packaged-host']);assert.equal(replay.alive,true);
  assert.equal(replay.cols,92);assert.equal(replay.rows,26);
  await host.call('pty:write','two',[{id:'packaged-host',data:process.platform==='win32'
   ? 'echo PRESERVED-%TOTE_UPGRADE_MARKER%\r' : 'printf "PRESERVED-%s\\n" "$TOTE_UPGRADE_MARKER"\r'}]);
  const deadline=Date.now()+10000;
  while(!output.includes('PRESERVED-'+marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert(output.includes('PRESERVED-'+marker),'replacement keeps the live shell environment');
  await assert.rejects(host.admin('local:stop'),/terminals are running/);
  console.log('Packaged desktop replacement, copied host runtime, preserved shell state and stop protection passed');
 } finally {
  if(host){await host.admin('local:stop',[{force:true}]).catch(()=>{});host.close();}
  await new Promise(r=>setTimeout(r,700));fs.rmSync(dir,{recursive:true,force:true});
 }
}
