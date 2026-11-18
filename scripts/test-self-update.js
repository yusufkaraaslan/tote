const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const U = require('../src/shared/updates');
const { SelfUpdater, allowedURL, download, replaceAppImage } = require('../src/main/selfUpdate');
const { createGuard } = require('../src/main/updateGuard');
const payload = Buffer.from('fixture executable — never launched');
const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
const manifest = () => ({ updateSchema:1, signed:true, version:'0.6.0', protocol:1, releasePlatforms:['linux','android'], androidVersionCode:12, androidMinSdkVersion:33,
  files:[{name:'Tote-0.6.0-linux-x86_64.AppImage',platform:'linux',size:payload.length,sha256}] });
const policy = { current:'0.5.0',latest:'0.6.0',platform:'linux',arch:'x64',protocol:1 };
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'tote-updater-'))), target = path.join(root,'Tote.AppImage');
  fs.writeFileSync(target,'old executable', {mode:0o700});
  const fetch = async (url, options) => download(url, {...options,get:async()=>Readable.from([url.endsWith('.json') ? Buffer.from(JSON.stringify(manifest())) : payload])});
  const updater = new SelfUpdater({dir:path.join(root,'cache'),target,...policy,check:async()=>({available:true,latest:'0.6.0'}),fetch});
  return { root,target,updater,close:()=>fs.rmSync(root,{recursive:true,force:true}) };
}
test('manifest pins exact version, protocol, production status, architecture, size and digest', () => {
  assert.equal(U.artifact(manifest(),policy).url,U.RELEASES+'/download/v0.6.0/Tote-0.6.0-linux-x86_64.AppImage');
  for (const change of [{signed:false},{signed:'true'},{updateSchema:0},{protocol:2},{version:'0.7.0'},{releasePlatforms:[]},{files:[]},{files:[...manifest().files,...manifest().files]}])
    assert.throws(()=>U.artifact({...manifest(),...change},policy));
  for (const change of [{size:0},{size:2**31},{size:'42'},{sha256:'g'.repeat(64)},{name:'../../evil.AppImage'}])
    assert.throws(()=>U.artifact({...manifest(),files:[{...manifest().files[0],...change}]},policy));
  for (const change of [{current:'0.6.0'},{current:'0.7.0'},{arch:'arm64'},{platform:'win32'}]) assert.throws(()=>U.artifact(manifest(),{...policy,...change}));
});
test('downloads allow only fixed publisher HTTPS redirects and stop at the declared size', async () => {
  for (const url of ['http://github.com/yusufkaraaslan/tote/releases/download/x','https://github.com/other/repo/releases/download/x','https://evil.invalid/file','https://release-assets.githubusercontent.com.evil.invalid/f','https://u:p@release-assets.githubusercontent.com/f','https://release-assets.githubusercontent.com:444/f']) assert.throws(()=>allowedURL(url));
  allowedURL('https://release-assets.githubusercontent.com/f?token=temporary');
  await assert.rejects(download(U.assetURL('0.6.0','file'),{limit:2,get:async()=>Readable.from([payload])}),/size/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(download(U.assetURL('0.6.0','file'),{limit:100,signal:controller.signal,get:async()=>Readable.from([payload])}),/abort/i);
});
test('download refreshes an earlier cached no-update result', async () => {
  const f = fixture();
  try {
    let latest = '0.5.0';
    f.updater.check = require('../src/main/updates').checker(async () => ({tag_name:'v'+latest,draft:false,prerelease:false}), () => 100);
    assert.equal((await f.updater.check('0.5.0')).available, false);
    latest = '0.6.0';
    assert.equal((await f.updater.start()).phase, 'ready');
  } finally { f.close(); }
});
test('verified download survives restart; install atomically replaces and retains an executable recovery copy', {skip:process.platform!=='linux'}, async () => {
  const f = fixture();
  try {
    assert.equal((await f.updater.start()).phase,'ready');
    f.updater.state = {phase:'idle'};
    assert.equal((await f.updater.restore()).phase,'ready');
    let released = false, launched = false;
    const result = await f.updater.install(async()=>()=>{released=true;},async target=>{assert.equal(target,f.target);launched=true;});
    assert.equal(result.phase,'installed');assert(released && launched);
    assert.deepEqual(fs.readFileSync(f.target),payload); assert.equal(fs.readFileSync(result.backup,'utf8'),'old executable');
    assert(fs.statSync(f.target).mode & 0o100);
  } finally { f.close(); }
});
test('tampering, denied guard, and cancellation never replace the installed app', async () => {
  const f = fixture();
  try {
    await f.updater.start();
    assert.deepEqual(await f.updater.install(async()=>null,()=>assert.fail('must not launch')),{canceled:true});
    fs.writeFileSync(path.join(f.updater.dir,'artifact'),'tampered');
    await assert.rejects(f.updater.install(()=>assert.fail('verify first'),()=>assert.fail()),/size|checksum/);
    assert.equal(fs.readFileSync(f.target,'utf8'),'old executable');
    f.updater.fetch = async (_url,{signal}) => new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('abort')),{once:true}));
    const pending = f.updater.start(); await new Promise(resolve=>setImmediate(resolve));f.updater.cancel();
    await assert.rejects(pending,/canceled/); assert(!fs.existsSync(path.join(f.updater.dir,'partial')));
    assert.equal(fs.readFileSync(f.target,'utf8'),'old executable');
  } finally { f.close(); }
});
test('failed final guard or destination race retains original executable', {skip:process.platform!=='linux'}, async () => {
  const f = fixture();
  try {
    await f.updater.start();
    await assert.rejects(replaceAppImage(f.target,path.join(f.updater.dir,'artifact'),manifest().files[0],()=>{throw Error('window navigated');}),/navigated/);
    assert.equal(fs.readFileSync(f.target,'utf8'),'old executable');
    assert.deepEqual(fs.readdirSync(f.root).sort(),['Tote.AppImage','cache']);
    fs.symlinkSync(f.target,path.join(f.root,'linked.AppImage'));
    await assert.rejects(replaceAppImage(path.join(f.root,'linked.AppImage'),path.join(f.updater.dir,'artifact'),manifest().files[0]),/regular/);
  } finally { f.close(); }
});
function guardFixture(clean = true, timeout = 100) {
  const ipcMain = new EventEmitter(), events = [];
  const windows = [1,2].map(id=>{
    const wc = new EventEmitter();wc.id=id;
    wc.send=(name,data)=>{events.push({id,...data}); if (!data.release && clean !== null) queueMicrotask(()=>ipcMain.emit('updates:guardReply',{sender:wc},data.token,clean || id===1));};
    return {webContents:wc,isDestroyed:()=>false};
  });
  const guard = createGuard({onReply:callback=>ipcMain.on('updates:guardReply',callback),windows:()=>windows,confirm:async()=>true,timeout});
  return {guard,windows,events,ipcMain};
}
test('all viewers must acknowledge clean state; dirty or unresponsive viewers unlock and refuse', async () => {
  for (const clean of [false,null]) {
    const f = guardFixture(clean,10);
    await assert.rejects(f.guard(),/Save documents|did not respond/);
    assert.equal(f.events.filter(e=>e.release).length,2);
  }
  const f = guardFixture(), release = await f.guard();
  release.assert();f.windows[1].webContents.emit('did-start-navigation');assert.throws(release.assert,/windows changed/);release();
  assert.equal(f.events.filter(e=>e.release).length,2);
});
test('explicit host upgrade defers live agents, refuses a late agent and adopts only an idle runtime', async () => {
  const {upgradeHost}=require('../src/main/updates');
  let stops=0, starts=0, confirmations=0;
  const confirm=async()=>{confirmations++;return true;};
  const host={admin:async()=>({version:'0.4.0',terminals:2}),start:async()=>{starts++;return {version:'0.5.0'};}};
  assert.deepEqual(await upgradeHost({host,current:'0.5.0',confirm}),{deferred:true,activeTerminals:2});
  assert.equal(confirmations,0);
  host.admin=async(name,args)=>{
    if(name==='local:status')return {version:'0.4.0',terminals:0};
    assert.equal(args[0].force,false);stops++;throw Error('1 terminals are running');
  };
  await assert.rejects(upgradeHost({host,current:'0.5.0',confirm}),/terminals/);assert.equal(starts,0);
  let status=0;
  host.admin=async(name,args)=>{
    if(name==='local:stop'){assert.equal(args[0].force,false);stops++;return {stopping:true};}
    if(status++===0)return {version:'0.4.0',terminals:0};
    if(status===2)return {stopping:true};
    throw Error('connect ECONNREFUSED');
  };
  assert((await upgradeHost({host,current:'0.5.0',confirm,pause:async()=>{}})).upgraded);
  assert.equal(starts,1);assert.equal(stops,2);
  host.admin=async()=>({version:'0.6.0',terminals:0});
  assert((await upgradeHost({host,current:'0.5.0',confirm})).unchanged);
  assert.equal(starts,1);
});
test('relaunch failure retains installed executable and tells the user where recovery was kept', {skip:process.platform!=='linux'}, async () => {
  const f=fixture();
  try {
    await f.updater.start();
    await assert.rejects(f.updater.install(async()=>()=>{},()=>{throw Error('launcher unavailable');}),/update is installed.*Recovery copy/);
    assert.deepEqual(fs.readFileSync(f.target),payload);
    assert.equal(fs.readFileSync(f.updater.state.backup,'utf8'),'old executable');
  } finally { f.close(); }
});
test('updater selects the exact AppImage architecture names produced by electron-builder', () => {
  const {Arch,getArtifactArchName}=require('builder-util');
  for(const arch of ['x64','arm64']) {
    const name=`Tote-0.6.0-linux-${getArtifactArchName(Arch[arch],'AppImage')}.AppImage`;
    const m=manifest();m.files[0].name=name;
    assert.equal(U.artifact(m,{...policy,arch}).name,name);
  }
});
