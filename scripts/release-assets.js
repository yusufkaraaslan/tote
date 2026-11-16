const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {check}=require('./release-version');
const {platforms}=require('./release-targets');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const extensions={linux:['AppImage','deb','pacman'],darwin:['dmg'],win32:['exe'],android:['apk']};
function checkKinds(files,platform) {
 if(!extensions[platform] || files.length!==extensions[platform].length || !extensions[platform].every(ext=>files.filter(n=>n.endsWith('.'+ext)).length===1))throw Error('Missing or duplicate '+platform+' package formats');
}
const allowed=/^[A-Za-z0-9_.-]+\.(?:AppImage|deb|pacman|dmg|exe|apk)$/;
function collect(source,out,platform,signed=false) {
 const r=check();if(!platforms(r,signed).includes(platform))throw Error('Platform is outside the release scope');fs.mkdirSync(out,{recursive:true});
 const files=fs.readdirSync(source).filter(n=>allowed.test(n)&&n.startsWith('Tote-'+r.version+'-'));
 checkKinds(files,platform);
 const entries=files.map(name=>{const from=path.join(source,name);if(!fs.lstatSync(from).isFile())throw Error('Artifact must be a regular file');fs.copyFileSync(from,path.join(out,name));return {name,sha256:hash(from),size:fs.statSync(from).size};});
 fs.writeFileSync(path.join(out,platform+'.json'),JSON.stringify({version:r.version,platform,signed,files:entries},null,2)+'\n');
}
function manifest(out,signed=false) {
 const r=check(), files=[], seen=new Set();
 for(const platform of platforms(r,signed)) {
  const m=JSON.parse(fs.readFileSync(path.join(out,platform+'.json'),'utf8'));
  if(m.version!==r.version || m.platform!==platform || m.signed!==signed || !Array.isArray(m.files)||!m.files.length)throw Error('Incomplete or inconsistent '+platform+' artifacts');
  checkKinds(m.files.map(f=>f.name),platform);
  for(const f of m.files) {
   if(!allowed.test(f.name)||!f.name.startsWith('Tote-'+r.version+'-')||seen.has(f.name)||!fs.lstatSync(path.join(out,f.name)).isFile()||hash(path.join(out,f.name))!==f.sha256||fs.statSync(path.join(out,f.name)).size!==f.size)throw Error('Invalid release artifact');
   seen.add(f.name);files.push({...f,platform});
  }
 }
 for(const n of fs.readdirSync(out))if(!seen.has(n)&&!platforms(r,signed).map(p=>p+'.json').includes(n))throw Error('Unexpected release file '+n);
 files.sort((a,b)=>a.name.localeCompare(b.name));
 fs.writeFileSync(path.join(out,'SHA256SUMS'),files.map(f=>`${f.sha256}  ${f.name}`).join('\n')+'\n');
 fs.writeFileSync(path.join(out,'release-manifest.json'),JSON.stringify({...r,updateSchema:1,releasePlatforms:platforms(r,signed),signed,files},null,2)+'\n');
 return files;
}
if(require.main===module){const [mode,source,out,platform]=process.argv.slice(2);const signed=process.env.TOTE_SIGNED_RELEASE==='true';if(mode==='collect')collect(source,out,platform,signed);else if(mode==='manifest')manifest(source,signed);else throw Error('Unknown asset operation');}
module.exports={collect,manifest};
