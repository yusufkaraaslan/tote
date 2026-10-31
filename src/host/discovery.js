// Discovery travels over Tailscale itself, not LAN multicast. A sharing host
// already knows its owner's Android peers and can send them connection hints.
// Hints confer no access: the phone must still pass the WebSocket whois gate.
const TS = require('./tailscale');
const DEFAULT_PORT = 47821;
const DISCOVERY_PORT = 47822;
function isTailnetIPv4(address) {
  const p = String(address || '').split('.');
  return p.length === 4 && p.every(s => /^(0|[1-9][0-9]{0,2})$/.test(s) && Number(s) <= 255) &&
    Number(p[0]) === 100 && Number(p[1]) >= 64 && Number(p[1]) <= 127;
}
function peerCandidates(status, port = DEFAULT_PORT) {
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
  return (status.peers || []).filter(p => p.ours && isTailnetIPv4(p.ip4)).map(p => ({
    name: p.name || p.ip4, address: p.ip4, port: safePort, online: !!p.online,
  }));
}
function discoveryTargets(status) {
  return [...new Set((status.peers || []).filter(p => p.ours && p.online &&
    String(p.os).toLowerCase() === 'android' && isTailnetIPv4(p.ip4)).map(p => p.ip4))].slice(0, 64);
}
function announcement({ address, port, name, version }) {
  if (!isTailnetIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return Buffer.from(JSON.stringify({ t:'tote:device', v:1, address, port,
    name:String(name || 'Tote').slice(0,80), tote:String(version || '').slice(0,40) }));
}
// Carry a directory for older hosts that do not announce themselves. Every
// peer will still be probed directly by the phone before it becomes visible.
function announcements(options, status) {
  const base = announcement(options);
  if (!base) return [];
  const root = JSON.parse(base), packets = [];
  let peers = [];
  const candidates = peerCandidates({ peers:(status.peers || []).filter(p => !['android','ios'].includes(String(p.os).toLowerCase())) }, options.port).filter(p => p.online).slice(0,64);
  for (const peer of candidates) {
    const item = { address:peer.address, port:peer.port };
    const next = Buffer.from(JSON.stringify({ ...root, peers:[...peers,item] }));
    if (next.length > 1024) { packets.push(Buffer.from(JSON.stringify({ ...root, peers }))); peers = []; }
    peers.push(item);
  }
  packets.push(Buffer.from(JSON.stringify({ ...root, peers })));
  return packets;
}
function advertise({ address, port, name, version, createSocket, status = TS.status,
    interval = 5000, onError = console.warn }) {
  const packet = announcement({ address, port, name, version });
  if (!packet) return () => {};
  let socket, timer, closed = false, lastError = '';
  const report = error => {
    const message = error.message || String(error);
    if (!closed && message !== lastError) onError('[tote] discovery: ' + message);
    lastError = message;
  };
  const tick = async () => {
    try {
      const st = await status();
      if (closed) return;
      // A changed account/address must not advertise stale connection metadata.
      if (st.backend === 'Running' && st.self?.ip4 === address) {
        const packets = announcements({ address, port, name, version }, st);
        for (const target of discoveryTargets(st)) {
          for (const data of packets) socket.send(data, DISCOVERY_PORT, target, error => { if (error) report(error); });
        }
      }
    } catch (error) { report(error); }
    finally { if (!closed) { timer = setTimeout(tick, interval); timer.unref?.(); } }
  };
  try {
    socket = createSocket ? createSocket() : require('dgram').createSocket('udp4');
    socket.on('error', report);
    // Bind the source to Tailscale too: no LAN/public traffic or broadcast.
    socket.bind(0, address, () => { if (!closed) { socket.unref?.(); tick(); } });
  } catch (error) { report(error); try { socket?.close(); } catch {} return () => {}; }
  return () => {
    if (closed) return; closed = true; clearTimeout(timer);
    try { socket.close(); } catch {}
  };
}
async function discoverPeers(port) { return peerCandidates(await TS.status(), port); }
module.exports = { isTailnetIPv4, peerCandidates, discoveryTargets, announcement, announcements, advertise, discoverPeers, DISCOVERY_PORT };
