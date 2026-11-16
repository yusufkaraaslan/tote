const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { LocalHost } = require('../src/main/localHost');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-background-ui-'));
const profile = path.join(dir, 'profile'), config = path.join(profile, 'config');
fs.mkdirSync(config, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(config, name + '.json'), JSON.stringify(data));
write('workspaces', { active: 'a', list: [{ id: 'a', name: 'A', path: path.join(dir, 'workspace') }] });
write('settings', { setupDone: true, bridgeDownloads: false, shareDevice: false, keepAwake: false });
write('providers', []); write('apps', { list: [] }); write('views', {});
write('cli-profiles', [{ id: 'probe', name: 'Shell', command: '/bin/sh', args: [] }]);
const control = new LocalHost(profile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, exit;
async function launch(phase) {
  child = spawn(require('electron'), [path.join(__dirname, 'background-viewer-fixture.js'), '--ozone-platform=x11'], {
    env: { ...process.env, TOTE_HOST_UI_TEST_DIR: dir, TOTE_HOST_UI_TEST_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const error = path.join(dir, phase + '.error');
    if (fs.existsSync(error)) throw Error(fs.readFileSync(error, 'utf8'));
    const ready = path.join(dir, phase + '.ready');
    if (fs.existsSync(ready)) return JSON.parse(fs.readFileSync(ready, 'utf8'));
    if (child.exitCode !== null) throw Error('Viewer exited: ' + log);
    await pause(50);
  }
  throw Error('Viewer did not become ready: ' + log);
}
(async () => {
  try {
    const first = await launch('create');
    assert.equal(first.terminals, 1);
    fs.writeFileSync(path.join(dir, 'close'), 'close');
    assert.equal((await exit).code, 0); child = null;
    fs.unlinkSync(path.join(dir, 'close'));
    assert.equal((await control.admin('local:status')).pid, first.pid);
    const reopened = await launch('reopen');
    assert.equal(reopened.pid, first.pid);
    child.kill('SIGKILL'); await exit; child = null;
    const afterCrash = await launch('after-crash');
    assert.equal(afterCrash.pid, first.pid);
    fs.writeFileSync(path.join(dir, 'close'), 'close');
    assert.equal((await exit).code, 0); child = null;
    console.log('Background UI passed: real PTY, saved pane, normal desktop quit, crash, and replay after both relaunches.');
  } finally {
    if (child) { child.kill('SIGKILL'); await exit; }
    await control.admin('local:stop', [{ force: true }]).catch(() => {}); control.close();
    await pause(500); fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
