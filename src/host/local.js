// Private loopback transport, independent of Tailscale sharing. The fixed
// per-profile port is also the singleton lock: bind BEFORE opening config or
// starting a PTY. A collision fails closed; never kill an unknown process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function endpoint(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  dataDir = fs.realpathSync(dataDir);
  const dir = path.join(dataDir, 'host');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'token');
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw Error('Host token must be a private regular file');
  const token = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid local host token; restore the profile before starting');
  const id = crypto.createHash('sha256').update(dataDir).digest('hex');
  return { dataDir, dir, token, port: 20000 + (parseInt(id.slice(0, 8), 16) % 40000), address: '127.0.0.1' };
}

function authorize(token, ip, req) {
  const supplied = req.headers.authorization;
  // Browser pages must never reach the local control plane, including pages
  // loaded in provider guests. The bearer never reaches a renderer or URL.
  if (ip !== '127.0.0.1' || Object.hasOwn(req.headers, 'origin') || typeof supplied !== 'string') return { ok: false, reason: 'Local host authentication required' };
  const want = Buffer.from('Bearer ' + token), got = Buffer.from(supplied);
  return { ok: want.length === got.length && crypto.timingSafeEqual(want, got), name: 'local' };
}

const LOCAL_METHODS = new Set([
  'local:status', 'local:stop', 'local:settings', 'local:resolve',
  'local:space', 'local:download', 'local:ingest', 'local:focus',
]);
module.exports = { endpoint, authorize, LOCAL_METHODS };
