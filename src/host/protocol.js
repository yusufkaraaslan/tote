// The devices wire protocol: JSON messages over a WebSocket, so a phone can
// speak it with no Node underneath (devices design, section 6).
//
//   → { t: 'hello', v, role: 'viewer', device }
//   ← { t: 'hello', v, role: 'host', device, tote }
//   → { t: 'call', id, m, a: [...] }
//   ← { t: 'ret', id, ok: true, r }  |  { t: 'ret', id, ok: false, e }
//   ← { t: 'ev', e, p }
//
// Pure: framing, validation and the remote allow-list. The socket lives in
// server.js (host side) and src/main/devices.js (viewer side).
const CH = require('./channels');

const VERSION = 1;
// readDoc hands an image back as a base64 data URL inside one message, and
// images are capped at 25 MB -- so a frame must hold ~34 MB of base64.
const MAX_FRAME = 64 * 1024 * 1024;

// What a remote viewer may call: the host's channels and the second halves of
// the split ones. Nothing viewer-side (the setup wizard, native apps, the
// system browser) is reachable from another machine, by construction.
function allowedRemote(method) {
  return typeof method === 'string' && (CH.HOST.has(method) || CH.HOST_ONLY.has(method));
}

const encode = (msg) => JSON.stringify(msg);

// Parse and shape-check one frame. Anything malformed is an error, not an
// exception: a bad frame from a peer must never take the host down.
function decode(text) {
  let msg;
  try {
    msg = JSON.parse(typeof text === 'string' ? text : String(text));
  } catch {
    return { error: 'not JSON' };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { error: 'not an object' };
  switch (msg.t) {
    case 'hello':
      if (!Number.isInteger(msg.v)) return { error: 'hello without a version' };
      return { msg };
    case 'call':
      if (!Number.isInteger(msg.id) || msg.id < 0) return { error: 'call without an id' };
      if (typeof msg.m !== 'string') return { error: 'call without a method' };
      if (msg.a !== undefined && !Array.isArray(msg.a)) return { error: 'call args must be an array' };
      return { msg: { ...msg, a: msg.a || [] } };
    case 'ret':
      if (!Number.isInteger(msg.id)) return { error: 'ret without an id' };
      return { msg };
    case 'ev':
      if (typeof msg.e !== 'string') return { error: 'event without a name' };
      return { msg };
    default:
      return { error: 'unknown message type: ' + msg.t };
  }
}

// The first frame each side sends. A version mismatch is a reason, not a
// crash: the device shows as "needs a Tote update" rather than failing oddly.
function hello(role, device, tote) {
  return { t: 'hello', v: VERSION, role, device, tote };
}

function checkHello(msg) {
  if (!msg || msg.t !== 'hello') return 'expected hello';
  if (msg.v !== VERSION) {
    return `protocol v${msg.v} on the other side, v${VERSION} here — update Tote on both machines`;
  }
  return null;
}

module.exports = { VERSION, MAX_FRAME, allowedRemote, encode, decode, hello, checkHello };
