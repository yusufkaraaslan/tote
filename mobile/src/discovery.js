import { tailnetAddress, portNumber } from './model.js';
import { DeviceClient } from './client.js';

export function normalizeCandidate(candidate) {
  const peers = [];
  for (const peer of Array.isArray(candidate.peers) ? candidate.peers.slice(0,64) : []) {
    try { peers.push({address:tailnetAddress(peer.address),port:portNumber(peer.port)}); } catch {}
  }
  return { address: tailnetAddress(candidate.address), port: portNumber(candidate.port), name: String(candidate.name || candidate.address).slice(0,80), peers };
}
// A discovery announcement is untrusted. Show/save only hosts that accept a Tailscale
// WebSocket probe and return a compatible Tote hello. No viewer is created.
export class ComputerSearch {
  constructor({ socketFactory, onVerified, onUnavailable = () => {}, onProgress = () => {}, helloTimeout = 5000 }) {
    Object.assign(this, { socketFactory, onVerified, onUnavailable, onProgress, helloTimeout });
    this.epoch = 0; this.queue = []; this.seen = new Set(); this.running = new Set(); this.candidates = new Map(); this.verified = new Set();
  }
  reset() {
    this.epoch++; for (const c of this.running) c.close(); this.running.clear(); this.queue = []; this.seen.clear(); this.candidates.clear(); this.verified.clear();
  }
  add(value) {
    let candidate; try { candidate = normalizeCandidate(value); } catch { return; }
    const key = candidate.address + ':' + candidate.port;
    const previous = this.candidates.get(key);
    if (previous) {
      const unique = new Map([...previous.peers,...candidate.peers].map(p=>[p.address+':'+p.port,p]));
      previous.peers = [...unique.values()].slice(0,64);
      if (this.verified.has(key)) for (const peer of candidate.peers) this.add(peer);
      return;
    }
    if (this.seen.size >= 64) return;
    this.seen.add(key); this.candidates.set(key,candidate); this.queue.push(candidate); this.pump();
  }
  pump() {
    while (this.running.size < 3 && this.queue.length) this.probe(this.queue.shift(), this.epoch);
    this.onProgress(this.running.size + this.queue.length);
  }
  async probe(candidate, epoch) {
    const c = new DeviceClient({ socketFactory:this.socketFactory, role:'probe', helloTimeout:this.helloTimeout });
    this.running.add(c);
    try {
      const hello = await c.connect(candidate.address, candidate.port);
      if (epoch === this.epoch) {
        this.verified.add(candidate.address+':'+candidate.port);
        const { peers, ...host } = candidate;
        this.onVerified({ ...host, name:hello.device || candidate.name, version:hello.tote });
        // Directory hints become usable only after their sender was verified.
        for (const peer of peers) this.add(peer);
      }
    } catch (error) { if (epoch === this.epoch) this.onUnavailable(candidate, error); }
    finally { c.close(); if (epoch === this.epoch) { this.running.delete(c); this.pump(); } }
  }
}
