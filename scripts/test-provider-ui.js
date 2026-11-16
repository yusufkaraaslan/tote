// Exercise the real main/preload/provider plumbing with loopback pages and
// disposable configuration. No user sessions, credentials or workspace files.
const { app, BrowserWindow, webContents, session } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), assert = require('node:assert/strict');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-provider-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
app.setPath('sessionData', path.join(scratch, 'profile'));
const configDir = path.join(scratch, 'profile/config');
fs.mkdirSync(configDir, { recursive: true });
const write = (name, value) => fs.writeFileSync(path.join(configDir, name + '.json'), JSON.stringify(value));
write('settings', { setupDone: true, bridgeDownloads: false, shareDevice: false, keepAwake: false, scratchRoot: path.join(scratch, 'scratch') });
write('workspaces', { active: 'global', list: ['global', 'second'].map(id => ({ id, name: id, path: path.join(scratch, id) })) });
write('cli-profiles', []); write('apps', { list: [] }); write('views', {});
const errors = [];
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', event => {
    if (/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message);
  });
});
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/download/')) {
    const name = req.url.slice('/download/'.length);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${name}.txt"` });
    return res.end('download from ' + name);
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Fixture provider</title><textarea id="draft"></textarea>');
});
function finish(code) {
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  server.close();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
setTimeout(() => { console.error('Provider UI exceeded 90 seconds'); finish(1); }, 90000).unref();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result; await pause(30); }
  throw Error('Timed out: ' + label);
}
const run = (win, code) => win.webContents.executeJavaScript(code, true);
async function ready(win) {
  await until(() => run(win, "typeof state !== 'undefined' && state.sliceLoaded"), 'viewer ready');
}
async function guest(win) {
  const id = await until(() => run(win, "[...state.tabs.values()].find(t=>t.wsId===state.workspaces.active && t.wv)?.wv.getWebContentsId()"), 'active workspace provider guest');
  const wc = webContents.fromId(id);
  await until(() => wc.executeJavaScript("!!document.querySelector('#draft')"), 'provider loaded');
  return wc;
}
server.listen(0, '127.0.0.1', async () => {
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    write('providers', [{ id: 'fixture', name: 'Fixture', url, color: '#123456' }]);
    require('../src/main/main');
    await app.whenReady();
    const a = await until(() => BrowserWindow.getAllWindows()[0], 'first window');
    await ready(a); await run(a, "openTab('fixture')");
    const first = await guest(a);
    assert.equal(first.getLastWebPreferences().nodeIntegration, false);
    assert.equal(await first.executeJavaScript('typeof require'), 'undefined');
    assert(!/Electron\//.test(first.getUserAgent()), 'provider UA must use the real Chromium UA without Electron');
    await first.executeJavaScript("document.cookie='fixtureLogin=retained; path=/';document.querySelector('#draft').value='unsent provider draft'");
    await first.session.cookies.flushStore();
    await first.executeJavaScript(`window.open(${JSON.stringify(url + '/popup')});void 0`);
    const popup = await until(() => BrowserWindow.getAllWindows().find(w => w !== a && w.webContents.getURL().endsWith('/popup')), 'OAuth popup');
    assert.equal(popup.webContents.session, first.session, 'popup shares the provider partition');
    assert.match(await popup.webContents.executeJavaScript('document.cookie'), /fixtureLogin=retained/);
    assert.equal(await popup.webContents.executeJavaScript('!!window.opener'), true, 'sandboxed provider popup retains its opener');
    assert.equal((await session.defaultSession.cookies.get({ url })).length, 0, 'provider cookies stay out of the viewer session');
    popup.destroy();
    await run(a, 'tote.newWindow()');
    const b = await until(() => BrowserWindow.getAllWindows().find(w => w !== a), 'second window');
    await ready(b); await run(b, "switchWorkspace('second')"); await run(b, "openTab('fixture')");
    assert.equal(await run(b, 'state.workspaces.active'), 'second');
    const second = await guest(b);
    const secondId = second.id;
    assert.match(await second.executeJavaScript('document.cookie'), /fixtureLogin=retained/);
    // Both windows share a provider session but download into different spaces.
    first.downloadURL(url + '/download/one'); second.downloadURL(url + '/download/two');
    const one = path.join(scratch, 'global/inbox/fixture/one.txt');
    const two = path.join(scratch, 'second/inbox/fixture/two.txt');
    await until(() => fs.existsSync(one) && fs.existsSync(two), 'routed downloads');
    assert.equal(fs.readFileSync(one, 'utf8'), 'download from one');
    assert.equal(fs.readFileSync(two, 'utf8'), 'download from two');
    await run(a, "switchWorkspace('second')"); await run(a, "switchWorkspace('global')");
    assert.equal((await guest(a)).id, first.id, 'switching spaces restores the original provider instance');
    assert.equal((await guest(b)).id, secondId, 'another window keeps its own active-space provider');
    assert.equal(await first.executeJavaScript("document.querySelector('#draft').value"), 'unsent provider draft');
    assert.deepEqual(errors, []);
    console.log('Provider UI passed: real sandboxed preload, partition cookies, OAuth popup/opener, two-window download routing and preserved provider draft.');
    finish(0);
  } catch (error) { console.error(error, errors); finish(1); }
});
