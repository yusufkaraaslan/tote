// Execute with the PACKAGED Electron runtime, so loading the PTY exercises its ABI.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.env.TOTE_PACKAGED_ASAR) {
 const {spawnSync}=require('node:child_process');
 const dist=path.resolve('dist/release'); let bin,asar;
 if(process.platform==='linux'){bin=path.join(dist,'linux-unpacked','tote');asar=path.join(dist,'linux-unpacked/resources/app.asar');}
 else if(process.platform==='win32'){bin=path.join(dist,'win-unpacked/Tote.exe');asar=path.join(dist,'win-unpacked/resources/app.asar');}
 else { const folder=fs.readdirSync(dist).find(n=>/^mac(?:-arm64)?$/.test(n));assert(folder,'Missing macOS package');const app=path.join(dist,folder,'Tote.app/Contents');bin=path.join(app,'MacOS/Tote');asar=path.join(app,'Resources/app.asar'); }
 const r=spawnSync(bin,[__filename],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TOTE_PACKAGED_ASAR:asar},stdio:'inherit',timeout:20000});
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
 terminal.onExit(()=>{clearTimeout(timer);assert(output.includes('TOTE_PACKAGED_PTY_OK'));console.log('Packaged version, assets and real PTY passed');});
}
