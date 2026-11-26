// Exercise the real main/preload/provider plumbing with loopback pages and
// disposable configuration. No user sessions, credentials or workspace files.
const { app, BrowserWindow, webContents, session, clipboard, nativeImage } = require('electron');
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
write('workspaces', { active: 'global', list: ['global', 'second', 'third'].map(id => ({ id, name: id, path: path.join(scratch, id) })) });
write('cli-profiles', []); write('apps', { list: [] }); write('views', {});
const errors = [];
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', event => {
    if (/Uncaught|TypeError|ReferenceError/.test(event.message)) errors.push(event.message);
  });
});
const server = http.createServer((req, res) => {
  if (req.url === '/unavailable') {
    res.writeHead(503, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>Unavailable</title>Service unavailable');
  }
  if (req.url === '/login?token=fixture-secret') {
    res.writeHead(302, { 'Set-Cookie': 'localLogin=yes; HttpOnly; Path=/', Location: '/authenticated' });
    return res.end();
  }
  if (req.url.startsWith('/login?') ||
      (['/local', '/authenticated'].includes(req.url) && !/(?:^|;\s*)localLogin=yes(?:;|$)/.test(req.headers.cookie || ''))) {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    return res.end('<!doctype html><title>Sign-in required</title>Unauthorized');
  }
  if (req.url.startsWith('/download/')) {
    const name = req.url.slice('/download/'.length);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${name}.txt"` });
    return res.end('download from ' + name);
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Fixture provider</title><style>body{background:#468cc8}</style><textarea id="draft"></textarea>');
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
      { id: 'dsh-local', name: 'Local fixture', url: url + '/local', local: { startCommand: 'must-not-run' } },
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
    const { LocalHost } = require('../src/main/localHost');
    const remote = new LocalHost(app.getPath('userData')).client();
    await remote.connect();
    const tabId = await run(a, "layoutSync().flush().then(() => wsViews().tabs[0].id)");
    const request = { wsId: 'global', tabId };
    const frame = await remote.call('web:pane', [request]);
    assert(Buffer.from(frame.image, 'base64').subarray(0, 2).equals(Buffer.from([255, 216])), 'remote viewer gets a JPEG of the live guest');
    const click = await first.executeJavaScript("(() => { const r = document.querySelector('#draft').getBoundingClientRect(); return {x:(r.x+5)/innerWidth, y:(r.y+5)/innerHeight}; })()");
    await remote.call('web:pane', [{ ...request, source: frame.source, input: { type:'click', ...click } }]);
    await remote.call('web:pane', [{ ...request, source: frame.source, input: { type:'text', text:'remote editing ' } }]);
    assert.match(await first.executeJavaScript("document.querySelector('#draft').value"), /remote editing /);
    await assert.rejects(remote.call('web:pane', [{ ...request, wsId:'second' }]), /workspace/);
    await assert.rejects(remote.call('web:pane', [{ ...request, source:{}, input:{type:'text',text:'stale'} }]), /page changed/);
    await first.executeJavaScript("document.querySelector('#draft').value='unsent provider draft'");
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
    await run(a, "switchWorkspace('second')");
    const hiddenFrame = await remote.call('web:pane', [request]);
    const pixels = nativeImage.createFromBuffer(Buffer.from(hiddenFrame.image,'base64'));
    const {width,height} = pixels.getSize();
    const center = pixels.crop({x:Math.floor(width/2),y:Math.floor(height/2),width:1,height:1}).toBitmap();
    assert.ok(Math.abs(center[0]-200)<5 && Math.abs(center[1]-140)<5 && Math.abs(center[2]-70)<5,
      'the hidden guest retains its actual page pixels');
    await run(a, "switchWorkspace('global')");
    assert.equal((await guest(a)).id, first.id, 'switching spaces restores the original provider instance');
    assert.equal((await guest(b)).id, secondId, 'another window keeps its own active-space provider');
    assert.equal(await first.executeJavaScript("document.querySelector('#draft').value"), 'unsent provider draft');
    await run(a, "openTab('dsh-local')");
    const localId = await until(() => run(a, "(() => { try { return [...state.tabs.values()].find(t=>t.providerId==='dsh-local')?.wv.getWebContentsId(); } catch { return null; } })()"), 'local provider guest');
    const local = webContents.fromId(localId);
    await until(() => local.getURL() === url + '/local', 'existing local service loaded');
    await until(() => run(a, "!document.querySelector('.local-provider-retry').disabled"), 'local startup completed');
    await until(() => run(a, "document.querySelector('.local-provider-status').textContent.startsWith('Sign-in required')"), '401 response asks for the login link');
    assert.equal(await run(a, `(() => {
      const controls = document.querySelector('.local-provider-controls');
      const guest = controls.parentElement.querySelector('webview');
      return guest.getBoundingClientRect().top + 0.5 >= controls.getBoundingClientRect().bottom && guest.getBoundingClientRect().height > 0;
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
      assert.equal(local.getURL(), url + '/local', 'pasting does not submit or navigate automatically');
    } finally { clipboard.readText = originalRead; }
    await run(a, `(() => {
      const form = document.querySelector('.local-provider-controls');
      form.querySelector('input').value = 'https://example.com/?token=not-local';
      form.requestSubmit();
    })()`);
    assert.match(await run(a, "document.querySelector('.local-provider-status').textContent"), /localhost URL/);
    assert.equal(local.getURL(), url + '/local');
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
    await until(() => run(a, "document.querySelector('.local-provider-controls').getClientRects().length === 0"), 'successful login hides the connection form');
    const localTab = await run(a, "layoutSync().flush().then(() => wsViews().tabs.find(t=>t.providerId==='dsh-local').id)");
    const signedIn = await remote.call('web:pane', [{ wsId:'global', tabId:localTab }]);
    assert.ok(signedIn.image, 'remote viewer sees the signed-in loopback service');
    assert(!JSON.stringify(signedIn).includes('fixture-secret'), 'startup URL is never sent');
    const independent = async (viewport, previous = null, client = remote) => {
      const req = { wsId:'global', tabId:localTab, source:{...previous, viewport} };
      return until(async () => {
        try { return await client.call('web:pane', [req]); }
        catch (error) { if (!error.message.includes('Waiting for DSH')) throw error; }
      }, 'independent DSH page loads');
    };
    const laptop = {id:require('node:crypto').randomUUID(), width:840, height:460};
    const phone = {id:require('node:crypto').randomUUID(), width:370, height:640};
    const localSize = await local.executeJavaScript('[innerWidth,innerHeight]');
    await local.executeJavaScript("localStorage.setItem('draft','source draft')");
    const pc = await independent(laptop), small = await independent(phone);
    assert.deepEqual([pc.source.width,pc.source.height], [840,460]);
    assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(pc.image,'base64')).getSize(), {width:840,height:460});
    assert.deepEqual([small.source.width,small.source.height], [370,640]);
    assert.notEqual(pc.source.token,small.source.token);
    assert.equal(pc.source.needsLogin, false);
    const privatePages = webContents.getAllWebContents().filter(w => w.getURL() === url + '/local' && w.session !== local.session);
    assert.equal(privatePages.length, 2);
    const laptopPage = (await Promise.all(privatePages.map(async w => await w.executeJavaScript('innerWidth') === 840 ? w : null))).find(Boolean);
    const send = (source, input) => remote.call('web:pane', [{ wsId:'global', tabId:localTab, source, input }]);
    await send(pc.source, { type:'click', x:15/840, y:15/460 });
    await send(pc.source, { type:'text', text:'private draft' });
    const resized = await independent({...laptop,width:570},pc.source);
    assert.deepEqual([resized.source.width,resized.source.height], [570,460]);
    assert.equal(await laptopPage.executeJavaScript("document.querySelector('#draft').value"), 'private draft');
    assert.equal(await laptopPage.executeJavaScript("localStorage.getItem('draft')"), null);
    await laptopPage.executeJavaScript("localStorage.setItem('draft','laptop draft')");
    assert.equal(await local.executeJavaScript("localStorage.getItem('draft')"), 'source draft');
    assert.equal(await privatePages.find(w=>w!==laptopPage).executeJavaScript("localStorage.getItem('draft')"), null);
    assert.equal(await privatePages.find(w=>w!==laptopPage).executeJavaScript("document.querySelector('#draft').value"), '');
    assert.equal(await local.executeJavaScript("document.querySelector('#draft').value"), '');
    assert.deepEqual(await local.executeJavaScript('[innerWidth,innerHeight]'), localSize);
    await assert.rejects(send(pc.source, {type:'text',text:'stale'}), /page changed/);
    await assert.rejects(independent({...laptop,width:-1}), /Invalid web pane dimensions/);
    const secondViewer = new LocalHost(app.getPath('userData')).client();
    try {
      await secondViewer.connect();
      await secondViewer.call('workspaces:setActive', ['global']);
      const other = await independent(laptop, null, secondViewer);
      assert.notEqual(other.source.token, resized.source.token);
      assert.equal(await laptopPage.executeJavaScript('innerWidth'), 570);
    } finally { secondViewer.close(); }
    await until(() => !local.isLoading(), 'authenticated page loaded');
    await local.executeJavaScript("document.querySelector('#draft').value='unsent local draft'");
    await run(a, "document.querySelector('.local-provider-retry').click()");
    await pause(150);
    assert.equal(await local.executeJavaScript("document.querySelector('#draft').value"), 'unsent local draft', 'a late Retry does not reload a connected app');
    assert.equal(await run(a, "document.querySelector('.local-provider-status').textContent"), 'Connected');
    // A fresh pane shares the signed cookie, without pasting or saving a token.
    await run(b, "openTab('dsh-local')");
    await until(() => run(b, "document.querySelector('.local-provider-controls')?.getClientRects().length === 0"), 'new pane reconnects with the existing login cookie');
    // A real expired/cleared login must restore the connection controls.
    await local.session.clearStorageData({ storages: ['cookies'] });
    local.reload();
    await until(() => run(a, "document.querySelector('.local-provider-controls').getClientRects().length > 0 && document.querySelector('.local-provider-status').textContent.startsWith('Sign-in required')"), 'expired login shows the form again');
    const challenge = await remote.call('web:pane', [{ wsId:'global', tabId:localTab }]);
    assert.equal(challenge.source.needsLogin, true, 'remote pane shows startup login on an actual challenge');
    const fresh = {...phone, id:require('node:crypto').randomUUID()};
    const privateChallenge = await independent(fresh);
    assert.equal(privateChallenge.source.needsLogin, true);
    await send(privateChallenge.source, {type:'login',url:url + '/login?token=fixture-secret'});
    assert.equal((await independent(fresh)).source.needsLogin, false);
    assert.equal((await local.session.cookies.get({url,name:'localLogin'})).length, 0, 'private sign-in stays in that browser');
    const signIn = value => remote.call('web:pane', [{ wsId:'global', tabId:localTab, source:challenge.source, input:{type:'login',url:value} }]);
    await assert.rejects(signIn('https://example.invalid/?token=fixture-secret'), /startup link/);
    await signIn(url + '/login?token=fixture-secret');
    await until(() => local.getURL() === url + '/authenticated', 'remote startup link signs in on the selected computer');
    // The remote provider picker can open even when no desktop window is in that space.
    await remote.call('workspaces:setActive', ['third']);
    const newTab = await remote.call('web:open', [{ wsId:'third', providerId:'fixture' }]);
    await until(async () => {
      try { return (await remote.call('web:pane', [{ wsId:'third', tabId:newTab }])).image; } catch { return false; }
    }, 'host opens a live web pane for an unviewed workspace');
    assert.equal(await run(a, 'state.workspaces.active'), 'global');
    assert.equal(await run(b, 'state.workspaces.active'), 'second');
    const snapshot = await remote.call('views:snapshot', []);
    const third = snapshot.views.third, originalGroup = third.activeGroup;
    third.tabs.push({ id:'other-tab', providerId:'fixture' });
    third.groups.push({ id:'other', name:'Other', tree:{ type:'leaf', id:'other-leaf', kind:'web', ref:'other-tab' } });
    assert.equal((await remote.call('views:patch', [{ changes:[{ wsId:'third', revision:snapshot.revisions.third, value:third }] }])).ok, true);
    await until(async () => {
      try { return (await remote.call('web:pane', [{ wsId:'third', tabId:'other-tab' }])).image; } catch { return false; }
    }, 'a previously unopened group can supply its own live web page');
    assert.equal((await remote.call('views:get', [])).third.activeGroup, originalGroup, 'remote group selection stays local');
    remote.close();
    await run(a, `document.querySelector('.local-provider-controls input').value=${JSON.stringify(url + '/login?token=expired')};document.querySelector('.local-provider-controls').requestSubmit()`);
    await until(() => run(a, "document.querySelector('.local-provider-status').textContent.startsWith('Sign-in required')"), 'invalid login does not claim to be connected');
    await run(a, `document.querySelector('.local-provider-controls input').value=${JSON.stringify(url + '/unavailable')};document.querySelector('.local-provider-controls').requestSubmit()`);
    await until(() => run(a, "document.querySelector('.local-provider-status').textContent.includes('HTTP 503')"), 'service errors remain visible');
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
