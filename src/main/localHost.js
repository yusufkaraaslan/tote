const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { endpoint } = require('../host/local');
const { DeviceClient } = require('./devices');

class LocalHost {
  constructor(dataDir, { executable = process.execPath, entry = path.join(__dirname, '../host/daemon.js') } = {}) {
    this.endpoint = endpoint(dataDir);
    this.executable = executable; this.entry = entry;
    this.viewers = new Map(); this.closed = false;
  }

  client(options = {}) {
    return new DeviceClient({ ...this.endpoint, device: 'Desktop',
      headers: { Authorization: 'Bearer ' + this.endpoint.token }, ...options });
  }

  async admin(method, args = []) {
    const client = this.client();
    try { await client.connect(); return await client.call(method, args); }
    finally { client.close(); }
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.ensureStarted().finally(() => { this.starting = null; });
    return this.starting;
  }

  async ensureStarted() {
    try { return await this.admin('local:status'); }
    catch (error) {
      // Authentication/version errors mean an occupied endpoint, not a dead
      // host. Never replace it, kill it or start a parallel owner of its files.
      if (!/ECONNREFUSED/.test(error.message)) throw error;
    }
    let failure;
    const child = spawn(this.executable, [this.entry, '--data-dir', this.endpoint.dataDir], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', error => { failure = error; });
    child.unref();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      try { return await this.admin('local:status'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Background host did not start. Check the profile permissions and local port ' + this.endpoint.port + '.');
  }

  async addViewer({ id, send }) {
    const viewer = { id, send, output: new Map(), gone: false, up: false, wsId: null };
    this.viewers.set(id, viewer);
    try { await this.connect(viewer); }
    catch (error) { this.removeViewer(id); throw error; }
    return viewer;
  }

  async connect(v) {
    const client = this.client({
      onEvent: (event, payload) => {
        if (v.gone) return;
        if (event !== 'pty:data') { v.send(event, payload); return; }
        return new Promise(resolve => {
          const delivery = crypto.randomUUID(); v.output.set(delivery, resolve);
          v.send(event, { ...payload, delivery });
        });
      },
      onClose: (_code, reason) => {
        for (const resolve of v.output.values()) resolve();
        v.output.clear(); v.up = false;
        if (v.gone || this.closed) return;
        v.send('devices:lost', { key: '', name: 'Background host', reason });
        this.retry(v);
      },
    });
    v.client = client;
    try {
      await client.connect();
      const list = await client.call('workspaces:list', []);
      if (v.wsId && list.list.some(s => s.id === v.wsId)) await client.call('workspaces:setActive', [v.wsId]);
      else v.wsId = list.active;
      if (v.gone || this.closed) { client.close(); return; }
      v.up = true;
    } catch (error) { client.close(); throw error; }
  }

  retry(v) {
    clearTimeout(v.retry);
    if (v.gone || this.closed) return;
    v.retry = setTimeout(async () => {
      if (v.gone || this.closed || v.up) return;
      try { await this.connect(v); if (v.up) v.send('devices:back', { key: '', name: 'Background host' }); }
      catch { this.retry(v); }
    }, 2000);
    v.retry.unref?.();
  }

  async call(name, id, args = []) {
    const v = this.viewers.get(id);
    if (!v?.up) throw Error('Background host is disconnected. Start it in Settings → About. Input was not sent.');
    const result = await v.client.call(name, args);
    if (name === 'workspaces:setActive') v.wsId = result.id;
    if (name === 'workspaces:list') v.wsId = result.active;
    return result;
  }

  ack(id, delivery) {
    const output = this.viewers.get(id)?.output, resolve = output?.get(delivery);
    if (resolve) { output.delete(delivery); resolve(); }
  }

  removeViewer(id) {
    const v = this.viewers.get(id);
    if (!v) return;
    v.gone = true; clearTimeout(v.retry);
    for (const resolve of v.output.values()) resolve();
    v.output.clear(); v.client?.close(); this.viewers.delete(id);
  }

  close() { this.closed = true; for (const id of this.viewers.keys()) this.removeViewer(id); }
}
module.exports = { LocalHost };
