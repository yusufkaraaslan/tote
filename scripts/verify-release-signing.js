const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const dist=path.resolve('dist/release');
if(process.platform==='darwin'){
 const dir=fs.readdirSync(dist).find(n=>/^mac(?:-arm64)?$/.test(n));if(!dir)throw Error('Missing app');
 const app=path.join(dist,dir,'Tote.app');
 execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
 execFileSync('xcrun',['stapler','validate',app],{stdio:'inherit'});
}else if(process.platform==='win32'){
 const files=[path.join(dist,'win-unpacked/Tote.exe'),...fs.readdirSync(dist).filter(n=>n.endsWith('.exe')).map(n=>path.join(dist,n))];
 for(const file of files)execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"if ((Get-AuthenticodeSignature -LiteralPath $env:TOTE_VERIFY_FILE).Status -ne 'Valid') { throw 'Invalid Authenticode signature' }"],{env:{...process.env,TOTE_VERIFY_FILE:file},stdio:'inherit'});
}else console.log('Linux artifacts are covered by SHA256SUMS; no platform code-signing identity is claimed.');
