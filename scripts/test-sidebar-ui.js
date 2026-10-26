// Run with Electron: npm run test:sidebar-ui. Isolated renderer; no real host,
// shells, device connections, or user workspace/config access.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-sidebar-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
const source = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const names = [...new Set([...source.matchAll(/\btote\.(\w+)/g)].map(m => m[1]))];
const preload = path.join(scratch, 'preload.js');
fs.writeFileSync(preload, `
const { contextBridge } = require('electron');
let active = 'tote';
const calls = [], sessions = [];
const list = ['Global', 'tote', 'KnitGame', 'Genesis', ...Array.from({length: 20}, (_, i) => 'Project ' + (i + 1))].map((name, i) => ({ id: i === 0 ? 'global' : name, name, path: '/preview/' + name }));
const api = Object.fromEntries(${JSON.stringify(names)}.map(name => [name, name.startsWith('on') ? () => {} : async () => null]));
Object.assign(api, {
  ptyAvailable: async () => ({ok:true}), getProviders: async () => [{id:'preview',name:'Preview provider',url:'about:blank'}], listApps: async () => [{id:'editor',name:'Editor',path:'/preview/Editor.app'}],
  getSettings: async () => ({setupDone:true}), deviceCurrent: async () => null,
  getCliProfiles: async () => [{id:'shell',name:'Plain Shell',command:'',args:[]}], ptyList: async () => sessions,
  tree: async () => [{name:'src',path:'src',type:'dir',children:[]},{name:'notes.md',path:'notes.md',type:'file',kind:'text'}],
  deviceSettings: async () => ({keepAwake:false}), checkCommand: async () => true,
  saveSettings: async settings => { calls.push({method:'saveSettings',settings}); },
  launchApp: async id => { calls.push({method:'launchApp',id}); return {launched:'Editor',workspace:active}; },
  ptySpawn: async (id,profile,cols,rows) => { calls.push({method:'ptySpawn',id,profile,cols,rows}); sessions.push({id,wsId:active,title:'Plain Shell',alive:true}); return {cwd:'/preview/'+active,workspace:active}; },
  testCalls: async () => calls,
  listWorkspaces: async () => ({ active, list }), setActiveWorkspace: async id => { active = id; },
  reorderWorkspaces: async ids => { list.sort((a,b) => ids.indexOf(a.id) - ids.indexOf(b.id)); return {active,list}; },
  getViews: async () => ({tote:{tabs:[],docs:[],activeGroup:'build',groups:[{id:'build',name:'Build',tree:{id:'files-test',kind:'files',ref:'files'},focus:'files-test'},{id:'research',name:'Research',tree:null}]}}),
  devicesList: async () => ({devices:[],share:{}}), devicesOpen: async () => [],
});
contextBridge.exposeInMainWorld('tote', api);
`);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true } });
  const errors = [];
  win.webContents.on('console-message', (_e, _level, message) => { if (/Uncaught|TypeError|ReferenceError/.test(message)) errors.push(message); });
  const run = code => win.webContents.executeJavaScript(code);
  const settle = () => run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  try {
    await win.loadFile(path.join(root, 'src/renderer/index.html'));
    for (let i = 0; i < 50 && !(await run("document.querySelectorAll('.ws-tab').length")); i++) await new Promise(r => setTimeout(r, 100));
    await settle();
    assert.equal(await run("document.querySelectorAll('.ws-tab').length"), 24);
    assert.equal(await run("document.querySelector('#ws-bar').offsetWidth"), 230);
    assert.equal(await run("document.querySelector('#group-bar').previousElementSibling.getAttribute('aria-label')"), 'tote');
    assert.equal(await run("document.querySelector('#context-group').textContent"), 'Build');
    assert.equal(await run("document.querySelector('#tiles').getBoundingClientRect().left"), 230);
    await run(`(() => {
      const source = document.querySelector('.ws-tab[aria-label="Global"]');
      const target = document.querySelector('.ws-tab[aria-label="KnitGame"]');
      const dataTransfer = new DataTransfer(), r = target.getBoundingClientRect();
      source.dispatchEvent(new DragEvent('dragstart', {bubbles:true, dataTransfer}));
      target.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer, clientX:r.left + 1, clientY:r.bottom - 1}));
      target.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer}));
      source.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer}));
    })()`);
    await settle();
    assert.deepEqual(await run("[...document.querySelectorAll('.ws-tab')].slice(0,3).map(b => b.getAttribute('aria-label'))"), ['tote', 'KnitGame', 'Global'], 'vertical drop uses pointer Y, not X');
    await run("window.originalFiles = document.querySelector('#files-panel'); document.querySelector('#btn-sidebar').click()");
    await settle();
    assert.equal(await run("document.querySelector('#ws-bar').offsetWidth"), 62);
    assert.equal(await run("document.querySelector('#tiles').getBoundingClientRect().left"), 62);
    assert(await run("originalFiles === document.querySelector('#files-panel') && originalFiles.parentElement.id === 'tiles'"));
    assert.equal(await run("localStorage.getItem('tote.sidebarCollapsed')"), 'true');
    assert(await run("[...document.querySelectorAll('.group-chip')].every(b => b.offsetHeight > 0)"));
    await run("document.querySelector('[data-group=research]').click()");
    assert.equal(await run("document.querySelector('#context-group').textContent"), 'Research');
    await run("document.querySelector('#btn-sidebar').click(); document.querySelector('#btn-add-tab').click()");
    await settle();
    assert(await run("(() => { const r = document.querySelector('#tab-add-menu').getBoundingClientRect(); return r.left >= 230 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"));
    assert(await run("!document.querySelector('#pane-picker').classList.contains('hidden')"));
    assert.equal(await run("document.querySelector('#picker-title').textContent"), 'Open web');
    assert(await run("(() => {const r=document.querySelector('.picker-card').getBoundingClientRect();return Math.abs((r.left+r.right)/2-innerWidth/2)<2})()"));
    await run("document.querySelector('#picker-cancel').click()");
    assert(await run("document.querySelector('#pane-picker').classList.contains('hidden')"));
    await run("document.body.click(); document.querySelector('#btn-device').click()");
    await settle();
    assert(await run("(() => { const r = document.querySelector('#device-menu').getBoundingClientRect(); return r.left >= 230 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"));
    await run("document.body.click(); document.querySelector('#ws-tabs').scrollTop = 10000; document.querySelectorAll('.ws-tab')[23].click()");
    await settle();
    assert.equal(await run("document.querySelector('#context-space').textContent"), 'Project 20');
    assert.equal(await run("document.querySelector('#group-bar').previousElementSibling.getAttribute('aria-label')"), 'Project 20');
    assert(await run("(() => { const r = document.querySelector('.ws-tab.active').getBoundingClientRect(), b = document.querySelector('#ws-tabs').getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom; })()"));
    // Exercise the production handlers, checking calls at the host boundary.
    await run("document.querySelector('#btn-settings').click()");
    await settle();
    assert(await run("!document.querySelector('#settings-modal').classList.contains('hidden')"));
    assert.equal(await run("document.querySelector('#settings-card').offsetWidth"), 850);
    assert(await run("(() => {const r=document.querySelector('#settings-card').getBoundingClientRect();return r.top>0 && Math.abs((r.left+r.right)/2-innerWidth/2)<2})()"));
    fs.writeFileSync(path.join(os.tmpdir(), 'tote-settings-updated.png'), (await win.webContents.capturePage()).toPNG());
    for (const section of ['providers', 'agents', 'apps', 'devices', 'behavior', 'about', 'spaces']) {
      await run(`document.querySelector('#set-nav [data-sec="${section}"]').click()`);
      await settle();
      assert.equal(await run("document.querySelector('#set-content .sec.active').dataset.sec"), section);
    }
    await run("document.querySelector('#set-nav [data-sec=behavior]').click(); document.querySelector('#set-bridge').click()");
    await settle();
    assert(await run("tote.testCalls().then(calls => calls.some(c => c.method === 'saveSettings' && c.settings.bridgeDownloads === false))"));
    await run("document.querySelector('#btn-settings-close').click(); document.querySelector('#btn-apps').click()");
    await settle();
    await run("document.querySelector('#apps-menu .term-menu-item').click()");
    await settle();
    assert(await run("tote.testCalls().then(calls => calls.some(c => c.method === 'launchApp' && c.id === 'editor'))"));
    await run("document.querySelector('#btn-new-term').click()");
    await settle();
    assert.equal(await run("document.querySelector('#picker-title').textContent"), 'New terminal');
    fs.writeFileSync(path.join(os.tmpdir(), 'tote-picker-updated.png'), (await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('#term-menu .term-menu-item').click()");
    await settle();
    assert(await run("tote.testCalls().then(calls => calls.some(c => c.method === 'ptySpawn' && c.profile === 'shell' && c.cols > 2 && c.rows > 1))"));
    assert(await run("!!document.querySelector('#tiles .xterm')"));
    await run("document.querySelector('#btn-add-tab').click(); document.querySelector('#tab-add-menu .term-menu-item').click()");
    await settle();
    assert.equal(await run("document.querySelectorAll('#tiles webview').length"), 1);
    await run("window.originalWeb = document.querySelector('#tiles webview'); document.querySelector('#btn-sidebar').click()");
    await settle();
    assert(await run("originalWeb === document.querySelector('#tiles webview')"));
    await run("document.querySelector('#btn-sidebar').click(); document.querySelector('#btn-files').click()");
    await settle();
    assert.equal(await run("getComputedStyle(document.querySelector('#files-panel')).backgroundColor"), 'rgb(12, 12, 11)');
    assert.equal(await run("getComputedStyle(document.querySelector('.tree-row.dir .name')).color"), 'rgb(122, 158, 176)');
    assert(await run("document.querySelector('.tree-row .guide').textContent.includes('─')"));
    fs.writeFileSync(path.join(os.tmpdir(), 'tote-sidebar-expanded.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(800, 600);
    await settle();
    assert(await run("document.querySelector('#ws-tabs').clientHeight >= 50 && document.querySelector('#btn-settings').getBoundingClientRect().bottom <= innerHeight"));
    await run("document.querySelector('#btn-settings').click()");
    await settle();
    assert(await run("(() => {const r=document.querySelector('#settings-card').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()"));
    await run("document.querySelector('#btn-settings-close').click(); document.querySelector('#btn-new-term').click()");
    await settle();
    await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert(await run("document.querySelector('#pane-picker').classList.contains('hidden')"));
    await run("document.querySelector('#btn-sidebar').click()");
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await reloaded;
    for (let i = 0; i < 50 && !(await run("document.querySelectorAll('.ws-tab').length")); i++) await new Promise(r => setTimeout(r, 100));
    await settle();
    assert.equal(await run("document.querySelector('#ws-bar').offsetWidth"), 62, 'collapsed preference survives reload');
    assert.deepEqual(errors, []);
    console.log('Sidebar Electron checks passed: layout, nested groups, compact rail, pane identity, flyouts, workspace switch, short window, persisted preference, Settings saves, terminal creation, web panes, app launch routing, existing files theme.');
    app.quit();
  } catch (error) {
    console.error(error, errors);
    process.exitCode = 1;
    app.quit();
  }
});
app.on('will-quit', () => fs.rmSync(scratch, { recursive: true, force: true }));
