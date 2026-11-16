const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const U=require('../src/shared/updates'),{checker,fetchLatest}=require('../src/main/updates');
const release=require('../release.json'), releaseTag='v'+release.version;
const stable=tag=>({tag_name:tag,draft:false,prerelease:false,html_url:'https://untrusted.example'});
test('stable updates compare numerically and generate only fixed repository links',()=>{
 assert(U.latest(stable('v0.10.0'),'0.9.9').available);
 assert(!U.latest(stable('v0.4.0'),'0.5.0').available);
 assert.equal(U.latest(stable('v0.5.0'),'0.4.0').url,U.RELEASES+'/tag/v0.5.0');
 for(const v of [null,{},stable('v01.2.3'),stable('v1.2.3/../../'),{...stable('v0.6.0'),draft:true},{...stable('v0.6.0'),prerelease:true},stable('v0.6.0-rc.1'),stable('v0.6.0\n'),stable('v0.6.0\r\n')])assert.throws(()=>U.latest(v,'0.5.0'));
});
test('wire protocol rejects incompatible peers while older app versions retain compatible features',()=>{
 assert.match(U.peer({v:2,tote:'0.5.0'},'0.5.0').message,/update Tote on both/);
 assert(!U.peer({v:'1'},'0.5.0').ok);
 assert(U.peer({v:1,tote:'0.4.0'},'0.5.0').ok);
 assert.match(U.peer({v:1,tote:'0.4.0'},'0.5.0').message,/newer features/);
 assert.equal(U.peer({v:1},'0.5.0').message,'');
 assert.match(U.installAdvice(3),/3 host terminals/);
});
test('update checks share in-flight requests, cache success, and retry failures',async()=>{
 let calls=0,now=0,resolve;const check=checker(()=>{calls++;return new Promise(r=>resolve=r);},()=>now);
 const a=check('0.5.0'),b=check('0.5.0');assert.equal(calls,1);resolve(stable('v0.6.0'));await Promise.all([a,b]);
 await check('0.5.0');assert.equal(calls,1);now=900001;const c=check('0.5.0');resolve(stable('v0.7.0'));assert.equal((await c).latest,'0.7.0');
 const retry=checker(async()=>{if(++calls===3)throw Error('offline');return stable('v0.7.0');});
 await assert.rejects(retry('0.5.0'));assert((await retry('0.5.0')).available);
});
test('HTTP metadata is bounded; redirects, invalid JSON and rate limits fail safely',async()=>{
 const {EventEmitter}=require('node:events');
 function request(status,body){return (url,options,callback)=>{
  assert.equal(url,U.API);assert(!options.headers.Authorization);
  const req=new EventEmitter();req.destroy=error=>{req.emit('error',error);req.emit('close');};
  queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=status;response.resume=()=>{};callback(response);if(status===200){response.emit('data',Buffer.from(body));response.emit('end');}req.emit('close');});return req;
 };}
 assert.equal((await fetchLatest(request(200,JSON.stringify(stable('v0.6.0'))))).tag_name,'v0.6.0');
 await assert.rejects(fetchLatest(request(302,'')),/unavailable/);
 await assert.rejects(fetchLatest(request(403,'')),/rate limit/);
 await assert.rejects(fetchLatest(request(200,'not JSON')),/Invalid/);
 await assert.rejects(fetchLatest(request(200,'x'.repeat(262145))),/size limit/);
});
test('release validation rejects drift and missing signing without printing secrets',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tote-release-test-'));
 try {
  for(const name of ['release.json','package.json','package-lock.json','mobile/package.json','mobile/package-lock.json','mobile/android/app/build.gradle','mobile/android/variables.gradle','docs/releases/'+releaseTag+'.md']) {const dest=path.join(dir,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(__dirname,'..',name),dest);}
  const {check}=require('./release-version');assert.equal(check(dir,releaseTag).version,release.version);assert.throws(()=>check(dir,'v9999.9999.9999'),/Tag/);
  const p=path.join(dir,'mobile/package.json');const data=JSON.parse(fs.readFileSync(p));data.version=release.version+'.1';fs.writeFileSync(p,JSON.stringify(data));assert.throws(()=>check(dir),/mismatch/);
  // Simulate the next documented metadata bump without changing test sources.
  const next='0.6.1';
  for(const name of ['package.json','package-lock.json','mobile/package.json','mobile/package-lock.json']) {
   const file=path.join(dir,name), data=JSON.parse(fs.readFileSync(file));data.version=next;
   if(data.packages)data.packages[''].version=next;fs.writeFileSync(file,JSON.stringify(data));
  }
  fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify({...release,version:next,androidVersionCode:release.androidVersionCode+1}));
  fs.writeFileSync(path.join(dir,'docs/releases/v'+next+'.md'),'Next release');
  assert.equal(check(dir,'v'+next).version,next);
  const signing=require('./release-signing');assert.throws(()=>signing.check('darwin',{CSC_LINK:'never-print-this'}),e=>e.message.includes('APPLE_ID')&&!e.message.includes('never-print-this'));
  assert.throws(()=>signing.check('android',{}),/ANDROID_KEYSTORE_PATH/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('release manifest rejects tampering and requires every platform',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tote-assets-test-')),out=path.join(dir,'out');
 try {
  const A=require('./release-assets');
  for(const [platform,extensions] of Object.entries({linux:['AppImage','deb','pacman'],darwin:['dmg'],win32:['exe'],android:['apk']})){
   const src=path.join(dir,platform);fs.mkdirSync(src);for(const ext of extensions)fs.writeFileSync(path.join(src,`Tote-${release.version}-${platform}.${ext}`),'binary '+platform);A.collect(src,out,platform,false);
  }
  const apk=path.join(out,`Tote-${release.version}-android.apk`);fs.appendFileSync(apk,'tampered');assert.throws(()=>A.manifest(out),/Invalid/);fs.writeFileSync(apk,'binary android');
  assert.equal(A.manifest(out).length,6);assert.match(fs.readFileSync(path.join(out,'SHA256SUMS'),'utf8'),/^[a-f0-9]{64}  Tote-/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('production scope builds only selected platforms while previews keep the full matrix',()=>{
 const {platforms,desktopMatrix,productionPlatforms}=require('./release-targets');
 const candidate={...release,releasePlatforms:['linux','android']};
 assert.deepEqual(platforms(candidate,true),['linux','android']);
 assert.equal(platforms(candidate,false).length,4);
 assert.deepEqual(desktopMatrix(candidate,true),{include:[{os:'ubuntu-22.04',platform:'linux'}]});
 assert.equal(desktopMatrix(candidate,false).include.length,3);
 for(const releasePlatforms of [undefined,[],['linux','linux'],['unknown']])assert.throws(()=>productionPlatforms({...candidate,releasePlatforms}));
});
test('production manifests require selected artifacts and reject excluded platform files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tote-scoped-assets-')),out=path.join(dir,'out');
 try {
  const A=require('./release-assets'),{productionPlatforms}=require('./release-targets');
  const extensions={linux:['AppImage','deb','pacman'],darwin:['dmg'],win32:['exe'],android:['apk']};
  for(const platform of productionPlatforms(release)){
   const src=path.join(dir,platform);fs.mkdirSync(src);
   for(const ext of extensions[platform])fs.writeFileSync(path.join(src,`Tote-${release.version}-${platform}.${ext}`),'binary '+platform);
   A.collect(src,out,platform,true);
  }
  const manifest=path.join(out,'release-manifest.json');
  A.manifest(out,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest)).releasePlatforms,productionPlatforms(release));
  fs.rmSync(manifest);fs.rmSync(path.join(out,'SHA256SUMS'));
  const excluded=Object.keys(extensions).find(p=>!productionPlatforms(release).includes(p));
  if(excluded){fs.writeFileSync(path.join(out,excluded+'.json'),'{}');assert.throws(()=>A.manifest(out,true),/Unexpected/);fs.rmSync(path.join(out,excluded+'.json'));}
  fs.rmSync(path.join(out,productionPlatforms(release)[0]+'.json'));
  assert.throws(()=>A.manifest(out,true));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('download guidance is deferred if a terminal starts during an async update check',async()=>{
 const {openRelease}=require('../src/main/updates');let busy=false,opened=0;
 const options={sessions:()=>busy?[{alive:true}]:[],current:'0.5.0',check:async()=>{busy=true;return U.latest(stable('v0.6.0'),'0.5.0');},open:async()=>opened++};
 assert.equal((await openRelease(options)).deferred,true);assert.equal(opened,0);
 options.check=async()=>U.latest(stable('v0.6.0'),'0.5.0');busy=false;
 assert.equal((await openRelease(options)).opened,true);assert.equal(opened,1);
});
test('production signing accepts main history and rejects unmerged or missing refs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tote-release-ancestry-'));
 const {execFileSync}=require('node:child_process'),{check}=require('./release-ancestry');
 const git=(...args)=>execFileSync('git',['-c','user.name=Tote test','-c','user.email=test@example.invalid',...args],{cwd:dir,stdio:'pipe'});
 try {
  git('init','-b','main');fs.writeFileSync(path.join(dir,'file'),'main');git('add','.');git('commit','-m','base');
  check('HEAD','main',dir);
  git('checkout','-b','feature');fs.writeFileSync(path.join(dir,'file'),'unmerged');git('commit','-am','feature');
  assert.throws(()=>check('HEAD','main',dir),/already on main/);
  assert.throws(()=>check('missing','main',dir),/already on main/);
  git('checkout','main');git('merge','--ff-only','feature');check('feature','main',dir);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
