// Real renderers with isolated hosts; no workspace files, PTYs or network.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { Views } = require('../src/host/views');
const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-layout-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const source = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const names = [...new Set([...source.matchAll(/\btote\.(\w+)/g)].map(m => m[1]))];
const preload = path.join(scratch, 'preload.js');
fs.writeFileSync(preload, `
const {contextBridge,ipcRenderer}=require('electron');
const api=Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,name.startsWith('on')?()=>{}:(...args)=>ipcRenderer.invoke('fixture',name,args)]));
api.onUpdateGuard=cb=>ipcRenderer.on('updates:guard',(_e,request)=>cb(request));
api.updateGuardReply=(token,clean)=>ipcRenderer.send('updates:guardReply',token,clean);
api.onViewsChanged=cb=>ipcRenderer.on('views:changed',(_e,views,key)=>cb(views,key));
contextBridge.exposeInMainWorld('tote',api);
`);
const initial = () => ({ a: { tabs: [], docs: [{ id: 'doc', path: 'note.txt', mode: 'src' }],
  activeGroup: 'g', groups: [{ id: 'g', name: 'Build', tree: { type: 'leaf', id: 'doc-leaf', kind: 'doc', ref: 'doc' }, focus: 'doc-leaf' }] } });
const stores = new Map(['', 'remote'].map(key => {
  let data = initial();
  return [key, new Views({ getViews: () => data, saveViews: v => { data = v; } }, id => id === 'a')];
}));
const windows = [], selected = new Map(), errors = [], writes = [];
function finish(code) {
  // These are disposable fixture windows. Avoid Chromium's graceful shutdown
  // keeping the runner alive after all assertions have already completed.
  for (const w of windows) if (!w.isDestroyed()) w.destroy();
  try { fs.rmSync(scratch, { recursive: true, force: true }); }
  catch (error) { console.warn('Could not remove temporary UI fixture:', error.code); }
  app.exit(code);
}
setTimeout(() => { console.error('Layout sync UI harness exceeded 60 seconds'); finish(1); }, 60000).unref();
const pause = ms => new Promise(r => setTimeout(r, ms));
ipcMain.handle('fixture', async (e, name, args) => {
  const current = selected.get(e.sender.id) || '';
  switch (name) {
    case 'getViewsSnapshot': return stores.get(args[0]).snapshot();
    case 'patchViews': {
      const [patch, key] = args;
      writes.push({ key, selected: current });
      await pause(30);
      const result = stores.get(key).patch(patch);
      if (result.ok) for (const w of windows) if (w.webContents.id !== e.sender.id) w.webContents.send('views:changed', result.snapshot.views, key);
      return result;
    }
    case 'getSettings': return { setupDone: true };
    case 'getProviders': case 'getCliProfiles': case 'listApps': case 'tree': case 'ptyList': case 'devicesOpen': return [];
    case 'ptyAvailable': return { ok: true };
    case 'devicesList': return { devices: [], share: {} };
    case 'deviceSettings': return { keepAwake: false };
    case 'listWorkspaces': return { active: 'a', list: [{ id: 'a', name: current || 'Local', path: '/fixture' }] };
    case 'deviceView': {
      await pause(20);
      const key = args[0] ? 'remote' : '';
      selected.set(e.sender.id, key);
      return key ? { key, name: 'Remote', up: true } : null;
    }
    case 'readDoc': await pause(50); return { kind: 'text', text: (current ? current + ' ' : '') + 'saved text', size: 10, mtimeMs: 1 };
    case 'writeFile': return true;
    default: return null;
  }
});
const run = (w, code) => w.webContents.executeJavaScript(code, true);
async function until(w, code) {
  for (let i = 0; i < 200; i++) { if (await run(w, code)) return; await pause(30); }
  throw new Error('Timed out: ' + code);
}
app.whenReady().then(async () => {
  try {
    for (let i = 0; i < 2; i++) {
      const w = new BrowserWindow({ width: 1100, height: 700, show: false,
        webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
      windows.push(w);
      w.webContents.on('console-message', (_e, _level, message) => { if (/Uncaught|TypeError|ReferenceError/.test(message)) errors.push(message); });
      await w.loadFile(path.join(root, 'src/renderer/index.html'));
      await until(w, "state.sliceLoaded && document.querySelector('.doc-src') && !layoutSync().status().busy");
    }
    const [a, b] = windows;
    const guard = require('../src/main/updateGuard').createGuard({onReply:cb=>ipcMain.on('updates:guardReply',cb),windows:()=>windows,confirm:async()=>true});
    const unlock = await guard();
    assert.equal(await run(a,'document.body.inert'),true);assert.equal(await run(b,'document.body.inert'),true);
    unlock();await until(a,'!document.body.inert');
    await run(b, "window.originalPane=document.querySelector('.pane');window.originalEditor=document.querySelector('.doc-src');window.pendingRead=loadDoc('doc');originalEditor.value='unsaved text';originalEditor.dispatchEvent(new Event('input',{bubbles:true}));pendingRead");
    assert.equal(await run(b, "state.docs.get('doc').text"), 'unsaved text', 'typing during a disk refresh must win');
    await assert.rejects(guard(),/Save documents/);
    await until(b,'!document.body.inert');
    await run(b,"switchDevice({key:'remote'})");await until(b,"state.deviceKey==='remote' && state.sliceLoaded");
    await assert.rejects(guard(),/Save documents/);await until(b,'!document.body.inert');
    await run(b,"switchDevice(null)");await until(b,"state.deviceKey==='' && state.sliceLoaded");
    await run(a, "state.views.a.groups[0].name='Changed elsewhere';saveViews();layoutSync().flush()");
    await until(b, "state.views.a.groups[0].name==='Changed elsewhere' && !layoutSync().status().busy");
    assert.equal(await run(b, "document.querySelector('.pane')===originalPane && document.querySelector('.doc-src')===originalEditor && originalEditor.value==='unsaved text'"), true);
    await run(a, "state.views.a.docs=[];state.views.a.groups[0].tree={type:'leaf',id:'files',kind:'files',ref:'files'};saveViews();layoutSync().flush()");
    await until(b, "layoutSync().status().conflicts.includes('a') && !layoutSync().status().busy");
    await run(b, "document.querySelector('#layout-status button').click()");
    assert.equal(await run(b, "state.docs.get('doc').text==='unsaved text' && document.querySelector('.doc-src')===originalEditor"), true);
    assert.match(await run(b, "document.querySelector('#layout-status').textContent"), /Your local layout is kept/);
    await run(b, "saveDoc('doc')");
    await run(b, "document.querySelector('#layout-status button').click()");
    await until(b, "!state.docs.has('doc') && !layoutSync().status().conflicts.length");

    // A debounce expires while the other device is already on screen.
    await run(a, "state.views.a.groups[0].name='Local pending';saveViews();switchDevice({key:'remote'})");
    await until(a, "state.deviceKey==='remote' && state.sliceLoaded");
    await pause(350);
    assert.equal(stores.get('').snapshot().views.a.groups[0].name, 'Local pending');
    assert.equal(stores.get('remote').snapshot().views.a.groups[0].name, 'Build');
    assert(writes.some(w => w.key === '' && w.selected === 'remote'), 'save was not exercised after the device switch');
    await run(a, "state.views.a.groups[0].name='Remote pending';saveViews();Promise.all([switchDevice(null),switchDevice({key:'remote'})])");
    await pause(350);
    await until(a, "state.deviceKey==='remote' && state.views.a.groups[0].name==='Remote pending'");
    assert.equal(stores.get('remote').snapshot().views.a.groups[0].name, 'Remote pending');
    assert.equal(stores.get('').snapshot().views.a.groups[0].name, 'Local pending');
    assert.deepEqual(errors, []);
    console.log('Layout sync UI passed: live pane identity, dirty buffers, conflict choice, saves captured before device switches, and rapid switching.');
    finish(0);
  } catch (e) { console.error(e, errors); finish(1); }
});
