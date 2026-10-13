// Tailscale: which devices exist, and who is knocking.
//
// Devices never ssh into each other -- the macOS GUI build of Tailscale cannot
// be a Tailscale SSH server -- so each host listens itself, on its tailnet
// address only, and asks Tailscale who every caller is (devices design,
// section 7). No passwords, no pairing, nothing that expires: the re-auth
// timer that Tailscale SSH has does not apply here.
//
// The parsers and authorize() are pure and tested against output shaped like
// the real thing; the exec wrappers below them are thin.
const { execFile } = require('child_process');
const fs = require('fs');

/* ----- pure ----- */

const stripDot = (s) => String(s || '').replace(/\.$/, '');
const shortName = (dns, fallback) => (stripDot(dns).split('.')[0] || fallback || '');

// `tailscale status --json` → this node and its peers, reduced to what the
// Devices list needs. A peer is ours when it has the same owner and was not
// shared into the tailnet by somebody else.
function parseStatus(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  if (!d || !d.Self) throw new Error('tailscale status has no Self — is Tailscale running and logged in?');
  const owner = d.Self.UserID;
  const node = (n) => ({
    name: shortName(n.DNSName, n.HostName),
    host: n.HostName || '',
    dns: stripDot(n.DNSName),
    os: n.OS || '',
    ip4: (n.TailscaleIPs || []).find((ip) => ip.includes('.')) || null,
    online: !!n.Online,
    ours: n.UserID === owner && !n.ShareeNode,
  });
  return {
    backend: d.BackendState || '',
    owner,
    self: node(d.Self),
    peers: Object.values(d.Peer || {}).map(node),
  };
}

/* Is the node behind `whois` one of this owner's own devices?
 *
 * Both IDs, not login names: an ID is what Tailscale actually keys ownership
 * on, a login name is display text. A node shared INTO the tailnet by
 * someone else carries a Sharer, and is refused even though it is reachable --
 * sharing a machine with you must not hand over your agents. */
function authorize(owner, whois) {
  const w = typeof whois === 'string' ? JSON.parse(whois) : whois;
  if (owner == null) return { ok: false, reason: 'no owner for this node' };
  if (!w || !w.Node || !w.UserProfile) return { ok: false, reason: 'tailscale does not know this address' };
  if (w.Node.Sharer) return { ok: false, reason: 'a node shared into this tailnet, not one of yours' };
  if (w.UserProfile.ID !== owner || w.Node.User !== owner) {
    return { ok: false, reason: 'owned by ' + (w.UserProfile.LoginName || 'someone else') };
  }
  return { ok: true, name: w.Node.ComputedName || shortName(w.Node.Name) };
}

// A socket's remote address, as whois wants it: IPv4-mapped IPv6 unwrapped.
const peerIp = (addr) => String(addr || '').replace(/^::ffff:/, '');

/* ----- exec ----- */

// `tailscale` is on PATH on Linux and with the standalone macOS build; the App
// Store build only has the binary inside its bundle.
const CANDIDATES = [
  'tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

let found = null;
function run(args, timeout = 5000) {
  const tryOne = (bin) => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout));
    });
  });
  if (found) return tryOne(found);
  return (async () => {
    let last = null;
    for (const bin of CANDIDATES) {
      if (bin.startsWith('/') && !fs.existsSync(bin)) continue;
      try {
        const out = await tryOne(bin);
        found = bin;
        return out;
      } catch (e) {
        if (e.code === 'ENOENT') continue;   // not this one
        last = e;                            // it ran and failed: that is the answer
        found = bin;
        break;
      }
    }
    throw last || new Error('Tailscale is not installed (no tailscale CLI found)');
  })();
}

const status = async () => parseStatus(await run(['status', '--json']));
const whois = async (ip) => JSON.parse(await run(['whois', '--json', peerIp(ip)]));
async function ip4() {
  const s = await status();
  if (!s.self.ip4) throw new Error('this node has no Tailscale IPv4 address');
  return s.self.ip4;
}

module.exports = { parseStatus, authorize, peerIp, run, status, whois, ip4 };
