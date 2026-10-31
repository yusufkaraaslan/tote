#!/usr/bin/env node
// Development bridge for an already-running desktop build. Advertise only
// after its authenticated probe succeeds; stop when that host goes away.
// Updated desktop builds include this behavior directly in DeviceServer.
const TS = require('../src/host/tailscale');
const { DeviceClient } = require('../src/main/devices');
const { advertise, discoveryTargets } = require('../src/host/discovery');
let stop = null, timer, checking = false, ending = false;
const port = Number(process.argv[2] || 47821);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid device port');
function finish() { if (ending) return; ending = true; clearTimeout(timer); stop?.(); process.exit(0); }
process.on('SIGINT', finish); process.on('SIGTERM', finish);
async function monitor() {
  if (checking || ending) return;
  checking = true; let client;
  try {
    const st = await TS.status();
    client = new DeviceClient({ address:st.self.ip4, port, device:'Tote discovery bridge', role:'probe' });
    const host = await client.connect();
    if (!stop) {
      stop = advertise({ address:st.self.ip4, port, name:host.device, version:host.tote });
      console.log('Discovery enabled for the running desktop; ' + discoveryTargets(st).length + ' online Android device(s). Existing terminal sessions are untouched.');
    }
  } catch (error) { console.error('Discovery bridge stopped: ' + error.message); finish(); }
  finally { client?.close(); checking = false; if (!ending) timer = setTimeout(monitor,10000); }
}
monitor();
