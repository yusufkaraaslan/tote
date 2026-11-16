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
module.exports={fetchLatest,checker,openRelease};
