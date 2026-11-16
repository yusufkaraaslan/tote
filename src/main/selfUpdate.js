// Viewer-only updater. Never stops or replaces the independently copied host.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const U = require('../shared/updates');
const { checker } = require('./updates');

function allowedURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash ||
      !(u.hostname === 'release-assets.githubusercontent.com' ||
        (u.hostname === 'github.com' && u.pathname.startsWith('/yusufkaraaslan/tote/releases/download/'))))
    throw Error('Update redirect left the release publisher.');
  return u;
}
async function response(url, signal, redirects = 0, request = https.get) {
  allowedURL(url);
  return new Promise((resolve, reject) => {
    const req = request(url, { signal, headers: { 'User-Agent':'Tote-updater', 'Accept-Encoding':'identity' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 3 || !res.headers.location) return reject(Error('Too many update redirects.'));
        try { resolve(response(new URL(res.headers.location, url).href, signal, redirects + 1, request)); }
        catch (error) { reject(error); }
      } else if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.resume(); reject(Error('Update download is unavailable. Try again later.'));
      } else resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(Error('Update download stalled.')));
    req.on('error', reject);
  });
}
async function download(url, { file, limit, signal, progress = () => {}, get = response }) {
  const res = await get(url, signal);
  let size = 0;
  const hash = crypto.createHash('sha256'), chunks = [];
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > limit) return callback(Error('Update exceeds its declared size.'));
    hash.update(chunk); progress(size); callback(null, chunk);
  } });
  if (file) await pipeline(res, meter, fs.createWriteStream(file, { flags:'wx', mode:0o600 }), { signal });
  else {
    await pipeline(res, meter, async source => { for await (const chunk of source) chunks.push(chunk); }, { signal });
  }
  return { size, sha256:hash.digest('hex'), text:file ? undefined : Buffer.concat(chunks).toString('utf8') };
}
async function verify(file, artifact) {
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.size !== artifact.size) throw Error('Update size changed. Download again.');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== artifact.sha256) throw Error('Update checksum failed. Download again.');
}
function appImageTarget(file) {
  if (!file || !path.isAbsolute(file)) throw Error('In-app installation currently supports Linux AppImage. Use the release page or your Linux package manager for this installation.');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || fs.realpathSync(file) !== path.resolve(file) || stat.nlink !== 1) throw Error('The AppImage must be a regular file, without links.');
  fs.accessSync(file, fs.constants.W_OK);
  fs.accessSync(path.dirname(file), fs.constants.W_OK);
  return stat;
}
// Atomic replacement on the destination filesystem. The prior executable is
// retained in an exclusive recovery directory; no old backup is overwritten.
async function replaceAppImage(target, staged, artifact, assertGuard = () => {}) {
  const original = appImageTarget(target);
  await verify(staged, artifact);
  const dir = fs.mkdtempSync(path.join(path.dirname(target), '.tote-update-'));
  fs.chmodSync(dir, 0o700);
  const next = path.join(dir, 'next.AppImage'), backup = path.join(dir, 'previous.AppImage');
  let replaced = false;
  try {
    await fs.promises.copyFile(staged, next, fs.constants.COPYFILE_EXCL);
    await verify(next, artifact);
    fs.chmodSync(next, original.mode & 0o777 | 0o100);
    const fd = fs.openSync(next, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    await fs.promises.copyFile(target, backup, fs.constants.COPYFILE_EXCL);
    const old = fs.openSync(backup, 'r'); try { fs.fsyncSync(old); } finally { fs.closeSync(old); }
    const current = appImageTarget(target);
    if (current.ino !== original.ino || current.dev !== original.dev || current.size !== original.size || current.mtimeMs !== original.mtimeMs)
      throw Error('The installed AppImage changed. Restart Tote and check again.');
    assertGuard();
    fs.renameSync(next, target); replaced = true;
    const parent = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    return { backup };
  } finally {
    // Once replaced, keep recovery even if directory fsync failed.
    if (!replaced) fs.rmSync(dir, { recursive:true, force:true });
  }
}
class SelfUpdater {
  constructor({ dir, current, protocol, arch = process.arch, target, check = checker(), fetch = download }) {
    Object.assign(this, { dir, current, protocol, arch, target, check, fetch });
    this.state = { phase:'idle' }; this.busy = false;
  }
  support() {
    try { appImageTarget(this.target); return { supported:true }; }
    catch (error) { return { supported:false, reason:error.message }; }
  }
  status() { return { ...this.state, ...this.support() }; }
  async prepared() {
    const metadata = path.join(this.dir,'manifest.json');
    if ((await fs.promises.lstat(metadata)).size > 65536) throw Error('Invalid saved update metadata.');
    const m = JSON.parse(await fs.promises.readFile(metadata, 'utf8'));
    const a = U.artifact(m, { current:this.current, latest:m.version, platform:'linux', arch:this.arch, protocol:this.protocol });
    await verify(path.join(this.dir,'artifact'), a);
    return { manifest:m, artifact:a };
  }
  async restore() {
    if (this.busy) return this.status();
    const previous = this.state;
    try { const p = await this.prepared(); if (!this.busy && this.state === previous) this.state = { phase:'ready', version:p.manifest.version }; }
    catch { if (!this.busy && this.state === previous && this.state.phase === 'ready') this.state = { phase:'idle' }; }
    return this.status();
  }
  async start() {
    if (this.busy) throw Error('An update operation is already running.');
    if (!this.support().supported) throw Error(this.support().reason);
    this.busy = true; this.abort = new AbortController();
    const signal = this.abort.signal;
    const timer = setTimeout(() => this.abort.abort(), 15*60*1000);
    this.state = { phase:'downloading', received:0, total:0 };
    const partial = path.join(this.dir,'partial');
    try {
      fs.mkdirSync(this.dir, { recursive:true, mode:0o700 });
      for (const name of ['partial','manifest.json','manifest.tmp','artifact']) fs.rmSync(path.join(this.dir,name), { force:true });
      const r = await this.check(this.current);
      if (!r.available) throw Error('No newer stable release is available.');
      const raw = await this.fetch(U.assetURL(r.latest,'release-manifest.json'), { limit:65536, signal });
      const m = JSON.parse(raw.text);
      const a = U.artifact(m, { current:this.current, latest:r.latest, platform:'linux', arch:this.arch, protocol:this.protocol });
      this.state.version = m.version; this.state.total = a.size;
      const actual = await this.fetch(a.url, { file:partial, limit:a.size, signal, progress:received => { this.state.received = received; } });
      if (actual.size !== a.size || actual.sha256 !== a.sha256) throw Error('Update checksum or size failed. Download again.');
      signal.throwIfAborted();
      fs.renameSync(partial, path.join(this.dir,'artifact'));
      fs.writeFileSync(path.join(this.dir,'manifest.tmp'), JSON.stringify(m), { mode:0o600 });
      fs.renameSync(path.join(this.dir,'manifest.tmp'), path.join(this.dir,'manifest.json'));
      this.state = { phase:'ready', version:m.version };
      return this.status();
    } catch (error) {
      this.state = { phase:'error', message:signal.aborted ? 'Download canceled. You can try again.' : error.message };
      throw Error(this.state.message);
    } finally { clearTimeout(timer); fs.rmSync(partial,{force:true}); this.busy = false; this.abort = null; }
  }
  cancel() { this.abort?.abort(); }
  async install(guard, relaunch) {
    if (this.busy) throw Error('An update operation is already running.');
    this.busy = true;
    let unlock;
    try {
      const { manifest, artifact } = await this.prepared();
      unlock = await guard(manifest);
      if (!unlock) return { canceled:true };
      const result = await replaceAppImage(this.target, path.join(this.dir,'artifact'), artifact, unlock.assert);
      this.state = { phase:'installed', version:manifest.version, backup:result.backup };
      await relaunch(this.target);
      return this.status();
    } finally { unlock?.(); this.busy = false; }
  }
}
module.exports = { allowedURL, response, download, verify, appImageTarget, replaceAppImage, SelfUpdater };
