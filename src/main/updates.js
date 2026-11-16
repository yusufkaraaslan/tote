const https = require('node:https');
const U = require('../shared/updates');
// A fixed public endpoint: no auth tokens, device names or workspace data sent.
function fetchLatest(request = https.get) {
  return new Promise((resolve,reject) => {
    let size=0, chunks=[];
    const req=request(U.API, {headers:{'User-Agent':'Tote-update-check','Accept':'application/vnd.github+json'}}, response => {
      if(response.statusCode!==200) { response.resume(); reject(new Error(response.statusCode===403 || response.statusCode===429 ? 'GitHub rate limit reached. Try later.' : 'Release information is unavailable. Try later.')); return; }
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>262144) { req.destroy(new Error('Release response exceeded its size limit.')); return; }
        chunks.push(chunk);
      });
      response.on('error',reject);
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('Invalid release information.'));}});
    });
    const timer=setTimeout(()=>req.destroy(new Error('Update check timed out. Check your internet connection.')),10000);
    req.on('close',()=>clearTimeout(timer)); req.on('error',reject);
  });
}
function checker(fetch = fetchLatest, now = Date.now) {
  let pending, cached, checked=0;
  return async current => {
    if(!cached || now()-checked>15*60*1000) {
      if(!pending) pending=fetch().then(data=>{ U.latest(data,current); cached=data; checked=now(); return data; }).finally(()=>pending=null);
      await pending;
    }
    return {...U.latest(cached,current),checkedAt:checked};
  };
}
async function openRelease({ sessions, check, current, open }) {
  let activeTerminals=(await sessions()).filter(s=>s.alive).length;
  if(activeTerminals) return {deferred:true,activeTerminals};
  const release=await check(current);
  activeTerminals=(await sessions()).filter(s=>s.alive).length;
  if(activeTerminals) return {deferred:true,activeTerminals};
  if(!release.available)return {available:false};
  await open(release.url); return {opened:true};
}
// Only this explicit action adopts the new viewer's already-copied host runtime.
// The host checks its live session count atomically when processing local:stop.
async function upgradeHost({host,current,confirm,now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const status = await host.admin('local:status');
  if (U.compare(current,status.version) !== 1) return {unchanged:true};
  if (status.terminals) return {deferred:true,activeTerminals:status.terminals};
  if (!await confirm()) return {canceled:true};
  await host.admin('local:stop',[{force:false}]);
  const deadline = now()+20000;
  while (now()<deadline) {
    await pause(100);
    let stopped = false;
    try {
      const next = await host.admin('local:status');
      if (!next.stopping) throw Error('The host changed while upgrading. Check its status before trying again.');
    } catch (error) {
      if (!/ECONNREFUSED/.test(error.message)) throw error;
      stopped = true;
    }
    if (stopped) {
      const started = await host.start();
      if (started.version !== current) throw Error('A different host runtime started. Refresh host status before trying again.');
      return {upgraded:true,...started};
    }
  }
  throw Error('The host has not finished stopping. Check its status before starting it again.');
}
module.exports={fetchLatest,checker,openRelease,upgradeHost};
