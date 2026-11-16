const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { LocalHost } = require('../src/main/localHost');
const { Runtime } = require('../src/host/runtime');
const { authorize, endpoint } = require('../src/host/local');
const { plan, setEnabled, enabled } = require('../src/main/hostStartup');
const { installRuntime } = require('../src/main/hostInstall');
const ROOT = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await pause(25); }
  throw Error('Timed out: ' + label);
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-background-'));
  fs.mkdirSync(path.join(dir, 'config'));
  const write = (name, data) => fs.writeFileSync(path.join(dir, 'config', name + '.json'), JSON.stringify(data));
  write('workspaces', { active: 'a', list: ['a', 'b'].map(id => ({ id, name: id, path: path.join(dir, id) })) });
  write('settings', { bridgeDownloads: false, shareDevice: false, keepAwake: false });
  write('cli-profiles', [{ id: 'probe', name: 'Shell', command: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', args: process.platform === 'win32' ? ['-NoProfile'] : [] }]);
  return dir;
}

test('local host rejects missing credentials, browsers, wrong tokens and public addresses', () => {
  const token = 'f'.repeat(64), headers = { authorization: 'Bearer ' + token };
  assert.equal(authorize(token, '127.0.0.1', { headers }).ok, true);
  for (const [ip, h] of [['127.0.0.1', {}], ['127.0.0.1', { ...headers, origin: 'http://localhost' }], ['127.0.0.1', { authorization: 'Bearer bad' }], ['100.1.2.3', headers]])
    assert.equal(authorize(token, ip, { headers: h }).ok, false);
});

test('host owns a singleton endpoint and refuses unauthenticated or remote administrative methods', { timeout: 15000 }, async () => {
  const dir = fixture(), runtime = new Runtime(dir), host = new LocalHost(dir);
  try {
    await runtime.start();
    await assert.rejects(new Runtime(dir).start(), /EADDRINUSE/);
    const bad = host.client({ headers: {} });
    try { await assert.rejects(bad.connect(), /refused/); } finally { bad.close(); }
    const browser = host.client({ headers: { Authorization: 'Bearer ' + host.endpoint.token, Origin: 'http://localhost' } });
    try { await assert.rejects(browser.connect(), /refused/); } finally { browser.close(); }
    const { DeviceServer } = require('../src/host/server');
    const { DeviceClient } = require('../src/main/devices');
    const server = new DeviceServer({ host: runtime.host, device: 'remote', tote: '0.5.0', authorize: async () => ({ ok: true, name: 'local' }) });
    await server.start({ bind: '127.0.0.1', port: 0 });
    const remote = new DeviceClient({ address: '127.0.0.1', port: Number(server.address.split(':').pop()), device: 'test' });
    try {
      await remote.connect(); await host.addViewer({ id: 'local', send() {} });
      assert.equal(runtime.host.viewers.size, 2, 'local and tailnet viewer IDs must never collide');
      await assert.rejects(remote.call('local:stop', [{ force: true }]), /Not callable/);
      await assert.rejects(remote.call('local:settings', [{}]), /Not callable/);
    } finally { remote.close(); await server.stop(); }
  } finally { host.close(); await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a real PTY survives its starting process exiting and reconnect preserves shell state without replaying input', { timeout: 45000 }, async () => {
  const dir = fixture(), host = new LocalHost(dir);
  let child;
  const marker = 'm' + Date.now();
  try {
    const script = `const {LocalHost}=require(${JSON.stringify(path.join(ROOT, 'src/main/localHost'))});
      (async()=>{const h=new LocalHost(${JSON.stringify(dir)}); await h.start();
      await h.addViewer({id:'first',send(){}}); await h.call('pty:spawn','first',[{sid:'survivor',profileId:'probe',cols:91,rows:27}]);
      await h.call('pty:write','first',[{id:'survivor',data:${JSON.stringify(process.platform === 'win32' ? `$env:TOTE_MARKER='${marker}'\r` : `TOTE_MARKER='${marker}'\r`)}}]);
      process.stdout.write('started\\n'); setInterval(()=>{},1000);})().catch(e=>{console.error(e);process.exit(1);});`;
    child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
    await until(() => { if (child.exitCode !== null) throw Error(errors); return output.includes('started'); }, 'starting process');
    const status = await host.admin('local:status');
    child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); child = null;
    assert.equal((await host.start()).pid, status.pid, 'reopen attaches to the same host');
    let received = '';
    await host.addViewer({ id: 'reopened', send(event, payload) {
      if (event === 'pty:data') { received += payload.data; host.ack('reopened', payload.delivery); }
    } });
    const attached = await host.call('pty:attach', 'reopened', ['survivor']);
    assert.equal(attached.alive, true); assert.equal(attached.cols, 91); assert.equal(attached.rows, 27);
    const query = process.platform === 'win32' ? "[Console]::WriteLine('ALIVE-'+$env:TOTE_MARKER)\r" : "printf '\\nALIVE-%s\\n' \"$TOTE_MARKER\"\r";
    await host.call('pty:write', 'reopened', [{ id: 'survivor', data: query }]);
    await until(() => received.includes('ALIVE-' + marker), 'preserved environment');
    await assert.rejects(host.admin('local:stop'), /terminals are running/);
    await host.call('workspaces:setActive', 'reopened', ['b']);
    await host.addViewer({ id: 'second', send() {} });
    await host.call('workspaces:setActive', 'second', ['a']);
    assert.equal((await host.call('workspaces:list', 'reopened')).active, 'b');
    assert.equal((await host.call('workspaces:list', 'second')).active, 'a');
    // Drop a transport; the host process stays alive and the viewer returns to
    // its space. Input attempted while disconnected is refused, not queued.
    host.viewers.get('reopened').client.close();
    await assert.rejects(host.call('pty:write', 'reopened', [{ id: 'survivor', data: 'must not be sent' }]), /disconnected/);
    await until(() => host.viewers.get('reopened').up, 'automatic viewer reconnect');
    assert.equal((await host.call('workspaces:list', 'reopened')).active, 'b');
    assert.equal((await host.admin('local:status')).pid, status.pid);
    await host.admin('local:stop', [{ force: true }]);
    await until(async () => { try { await host.admin('local:status'); return false; } catch { return true; } }, 'explicit host stop');
  } finally {
    child?.kill('SIGKILL');
    await host.admin('local:stop', [{ force: true }]).catch(() => {});
    host.close(); await pause(300); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup registration is opt-in and quotes platform paths without shell expansion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-startup-'));
  const options = { executable: '/apps/Tote $name', entry: '/app/a&b.js', dataDir: '/home/a%test', home: dir, platform: 'linux', configHome: path.join(dir, 'config') };
  try {
    assert.equal(enabled(options), false);
    assert.equal(setEnabled(true, options), true);
    assert.match(fs.readFileSync(plan(options).file, 'utf8'), /\\\$name/);
    assert.equal(setEnabled(false, options), false);
    assert.match(plan({ ...options, platform: 'darwin' }).content, /a&amp;b.js/);
    const win = plan({ ...options, platform: 'win32' });
    assert(path.win32.isAbsolute(win.shell), 'login shortcut must target the actual PowerShell executable');
    assert.match(Buffer.from(win.command.split(' ').pop(), 'base64').toString('utf16le'), /& '\/apps\/Tote \$name'/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows startup shortcut round-trips its target and arguments', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-shortcut-'));
  const options = { executable: process.execPath, entry: path.join(dir, 'host entry.js'), dataDir: path.join(dir, 'profile'), appData: dir };
  try {
    assert.equal(setEnabled(true, options), true);
    const p = plan(options), literal = value => "'" + value.replace(/'/g, "''") + "'";
    const script = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + literal(p.file) + '); @{target=$s.TargetPath;args=$s.Arguments}|ConvertTo-Json -Compress';
    const result = JSON.parse(require('node:child_process').execFileSync(p.shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }));
    assert.equal(result.target.toLowerCase(), p.shell.toLowerCase());
    assert.equal(result.args, p.args);
    assert.equal(setEnabled(false, options), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloads stay pinned across workspace changes and missing destinations keep staged files', { timeout: 10000 }, async () => {
  const dir = fixture(), runtime = new Runtime(dir), host = new LocalHost(dir);
  try {
    await runtime.start(); await host.addViewer({ id: 'viewer', send() {} });
    await host.call('local:focus', 'viewer');
    const destination = await host.call('local:download', 'viewer');
    await host.call('workspaces:setActive', 'viewer', ['b']);
    assert.equal(runtime.host.viewers.get(runtime.focusedViewer).wsId, 'b');
    const stage = path.join(dir, 'host-downloads'); fs.mkdirSync(stage);
    const file = path.join(stage, 'result.txt'); fs.writeFileSync(file, 'result');
    const landed = await host.admin('local:ingest', [{ wsId: destination.wsId, file, providerId: 'fixture' }]);
    assert.equal(landed.workspace, 'a');
    assert.equal(fs.readFileSync(path.join(dir, 'a/inbox/fixture/result.txt'), 'utf8'), 'result');
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, 'second download');
    const duplicate = await host.admin('local:ingest', [{ wsId: 'a', file, providerId: 'fixture' }]);
    assert.match(duplicate.path, /result \(1\)\.txt$/);
    assert.equal(fs.readFileSync(landed.path, 'utf8'), 'result', 'downloads must not overwrite an earlier result');
    const outside = path.join(dir, 'outside.txt'); fs.writeFileSync(outside, 'untouched');
    await assert.rejects(host.admin('local:ingest', [{ wsId: 'a', file: outside, providerId: 'fixture' }]), /outside staging/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
    fs.writeFileSync(file, 'keep this');
    await host.call('workspaces:remove', 'viewer', ['a']);
    await assert.rejects(host.admin('local:ingest', [{ wsId: 'a', file, providerId: 'fixture' }]), /workspace was removed/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep this');
    await host.call('workspace:createFile', 'viewer', ['trash-me.txt']);
    await host.call('workspace:trash', 'viewer', ['trash-me.txt']);
    assert(fs.readdirSync(path.join(dir, 'b/.tote-trash')).some(name => name.endsWith('-trash-me.txt')));
    await assert.rejects(host.call('workspace:trash', 'viewer', ['']), /workspace root/);
    host.removeViewer('viewer');
    await until(() => !runtime.host.viewers.has(runtime.focusedViewer), 'viewer detach');
    assert.equal(runtime.focusedSpace, 'b', 'native downloads retain the last focused space after a window closes');
  } finally { host.close(); await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('packaged runtime is copied once and remains available after replacing desktop files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-runtime-copy-'));
  const source = path.join(dir, 'desktop'), dataDir = path.join(dir, 'profile');
  fs.mkdirSync(path.join(source, 'resources'), { recursive: true });
  const executable = path.join(source, 'tote'), appPath = path.join(source, 'resources/app.asar');
  fs.writeFileSync(executable, 'runtime'); fs.writeFileSync(appPath, 'old code');
  try {
    const options = { executable, appPath, dataDir, packaged: true, platform: 'linux' };
    const first = await installRuntime(options);
    assert.equal(fs.readFileSync(first.executable, 'utf8'), 'runtime');
    assert.deepEqual(await installRuntime(options), first);
    fs.writeFileSync(appPath, 'new code');
    const second = await installRuntime(options);
    assert.notEqual(second.entry, first.entry);
    fs.rmSync(source, { recursive: true });
    assert.equal(fs.readFileSync(first.entry.split(path.sep + 'src' + path.sep)[0], 'utf8'), 'old code');
    assert.equal(fs.readFileSync(second.entry.split(path.sep + 'src' + path.sep)[0], 'utf8'), 'new code');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
