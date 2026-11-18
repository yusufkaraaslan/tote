// Exercise the real main/preload/provider plumbing with loopback pages and
// disposable configuration. No user sessions, credentials or workspace files.
const { app, BrowserWindow, webContents, session, clipboard } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), assert = require('node:assert/strict');
const updateLogic = require('../src/main/updates');
const currentVersion = require('../release.json').version;
let advertisedVersion = currentVersion, updateFetches = 0;
const realChecker = updateLogic.checker;
// Real caching and IPC, with local release metadata instead of GitHub requests.
updateLogic.checker = () => realChecker(async () => {
  updateFetches++;
  return { tag_name: 'v' + advertisedVersion, draft: false, prerelease: false };
});
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
  if (req.url === '/login?token=fixture-secret') {
    res.writeHead(302, { 'Set-Cookie': 'localLogin=yes; HttpOnly; Path=/', Location: '/authenticated' });
    return res.end();
  }
  if (req.url.startsWith('/download/')) {
    const name = req.url.slice('/download/'.length);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${name}.txt"` });
    return res.end('download from ' + name);
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Fixture provider</title><textarea id="draft"></textarea>');
});
let finishing = false;
async function finish(code) {
  if (finishing) return; finishing = true;
  const { LocalHost } = require('../src/main/localHost');
  const control = new LocalHost(app.getPath('userData'));
  await control.admin('local:stop', [{ force: true }]).catch(() => {});
  control.close();
  await new Promise(resolve => setTimeout(resolve, 300));
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
    write('providers', [
      { id: 'fixture', name: 'Fixture', url, color: '#123456' },
      { id: 'local-fixture', name: 'Local fixture', url, local: { startCommand: 'must-not-run' } },
    ]);
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
    await popup.webContents.executeJavaScript(`window.open(${JSON.stringify(url + '/nested')});void 0`);
    const nested = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/nested')), 'nested provider popup');
    await run(a, 'tote.newWindow()');
    const b = await until(() => BrowserWindow.getAllWindows().find(w => w !== a && w !== popup && w !== nested), 'second window');
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
    b.focus();
    popup.webContents.downloadURL(url + '/download/popup');
    nested.webContents.downloadURL(url + '/download/nested');
    for (const name of ['popup', 'nested']) {
      const file = path.join(scratch, 'global/inbox/fixture', name + '.txt');
      await until(() => fs.existsSync(file), name + ' download stays with its original viewer');
      assert.equal(fs.readFileSync(file, 'utf8'), 'download from ' + name);
      assert.equal(fs.existsSync(path.join(scratch, 'second/inbox/fixture', name + '.txt')), false);
    }
    nested.destroy(); popup.destroy();
    await run(a, "switchWorkspace('second')"); await run(a, "switchWorkspace('global')");
    assert.equal((await guest(a)).id, first.id, 'switching spaces restores the original provider instance');
    assert.equal((await guest(b)).id, secondId, 'another window keeps its own active-space provider');
    assert.equal(await first.executeJavaScript("document.querySelector('#draft').value"), 'unsent provider draft');
    await run(a, "openTab('local-fixture')");
    const localId = await until(() => run(a, "(() => { try { return [...state.tabs.values()].find(t=>t.providerId==='local-fixture')?.wv.getWebContentsId(); } catch { return null; } })()"), 'local provider guest');
    const local = webContents.fromId(localId);
    await until(() => local.getURL() === url + '/', 'existing local service loaded');
    await until(() => run(a, "!document.querySelector('.local-provider-retry').disabled"), 'local startup completed');
    assert.equal(await run(a, `(() => {
      const controls = document.querySelector('.local-provider-controls');
      const guest = controls.parentElement.querySelector('webview');
      return guest.getBoundingClientRect().top >= controls.getBoundingClientRect().bottom && guest.getBoundingClientRect().height > 0;
    })()`), true, 'local service controls do not overlap its webview');
    a.focus();
    const inputPoint = await run(a, `(() => {
      const r = document.querySelector('.local-provider-controls input').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    a.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...inputPoint });
    a.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...inputPoint });
    await pause(100);
    assert.equal(await run(a, "document.activeElement === document.querySelector('.local-provider-controls input')"), true, 'clicking the startup URL field keeps keyboard focus there');
    // Copying the URL from another window reactivates Tote before pasting.
    a.webContents.send('win:focus');
    await pause(100);
    assert.equal(await run(a, "document.activeElement === document.querySelector('.local-provider-controls input')"), true, 'window activation must not steal focus from the startup URL field');
    const startupUrl = url + '/login?token=fixture-secret';
    // The CI renderer job has a disposable Xvfb clipboard. Local runs never
    // overwrite the user's clipboard; insertText still exercises actual focus.
    if (process.env.CI) {
      clipboard.writeText(startupUrl);
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
      a.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers });
      a.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers });
    } else await a.webContents.insertText(startupUrl);
    await until(() => run(a, `document.querySelector('.local-provider-controls input').value === ${JSON.stringify(startupUrl)}`), 'paste/text input reaches the startup URL field');
    const originalRead = clipboard.readText;
    try {
      // Exercise the existing clipboard IPC and its viewer authorization,
      // without reading or modifying the user's system clipboard locally.
      clipboard.readText = () => { throw Error('fixture clipboard unavailable'); };
      await run(a, "document.querySelector('.local-provider-paste').click()");
      await until(() => run(a, "document.querySelector('.local-provider-status').textContent.includes('Could not read the clipboard')"), 'clipboard failure is visible');
      clipboard.readText = () => '  ' + startupUrl + '\n';
      await run(a, "document.querySelector('.local-provider-controls input').value = '';document.querySelector('.local-provider-paste').click()");
      await until(() => run(a, `document.querySelector('.local-provider-controls input').value === ${JSON.stringify(startupUrl)}`), 'Paste URL fills the field through clipboard IPC');
      assert.equal(await run(a, "document.activeElement === document.querySelector('.local-provider-controls input')"), true);
      assert.equal(local.getURL(), url + '/', 'pasting does not submit or navigate automatically');
    } finally { clipboard.readText = originalRead; }
    await run(a, `(() => {
      const form = document.querySelector('.local-provider-controls');
      form.querySelector('input').value = 'https://example.com/?token=not-local';
      form.requestSubmit();
    })()`);
    assert.match(await run(a, "document.querySelector('.local-provider-status').textContent"), /localhost URL/);
    assert.equal(local.getURL(), url + '/');
    // Restore the valid URL using the paste button, then submit it with Enter.
    clipboard.readText = () => startupUrl;
    try {
      await run(a, "document.querySelector('.local-provider-paste').click()");
      await until(() => run(a, `document.querySelector('.local-provider-controls input').value === ${JSON.stringify(startupUrl)}`), 'ready to connect');
    } finally { clipboard.readText = originalRead; }
    a.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    a.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    a.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await until(() => local.getURL() === url + '/authenticated', 'startup URL exchanged for a session cookie');
    assert.equal((await local.session.cookies.get({ url, name: 'localLogin' }))[0].value, 'yes');
    assert.equal(await run(a, "document.querySelector('.local-provider-controls input').value"), '');
    assert.equal(await run(a, "JSON.stringify({providers:state.providers, views:state.views}).includes('fixture-secret')"), false);
    await run(a, "document.querySelector('#btn-settings').click();document.querySelector('#set-nav [data-sec=about]').click();document.querySelector('#set-update-check').click()");
    await until(() => run(a, "document.querySelector('#set-update-status').textContent.includes('No newer stable release') && !document.querySelector('#set-update-check').disabled"), 'initial update check');
    assert.equal(updateFetches, 1);
    const parts = currentVersion.split('.').map(Number); parts[2]++;
    advertisedVersion = parts.join('.');
    await run(a, "document.querySelector('#set-update-check').click()");
    await until(() => run(a, "document.querySelector('#set-update-status').textContent.includes('is available')"), 'manual check bypasses the earlier no-update result');
    assert.equal(updateFetches, 2, 'two deliberate checks fetch twice even inside the cache lifetime');
    assert.deepEqual(errors, []);
    console.log('Provider UI passed: sandboxed preload, partition cookies, OAuth, download routing, preserved drafts, local service startup, transient login URLs and fresh manual update checks.');
    finish(0);
  } catch (error) { console.error(error, errors); finish(1); }
});
