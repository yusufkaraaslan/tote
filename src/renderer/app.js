/* Tote renderer. Globals from preload: window.tote; from vendor: Terminal, FitAddon. */
const $ = (sel) => document.querySelector(sel);

const state = {
  providers: [],
  profiles: [],
  apps: [],
  settings: { bridgeDownloads: true },
  workspaces: { active: null, list: [] },
  treeData: [],
  views: {}, // wsId -> { tabs: [{ id, providerId }], active: tabId|null }  (persisted)
  tabs: new Map(), // tabId -> { wv: <webview>|null, providerId, wsId }  (webviews created lazily)
  activeTab: null, // tabId shown in the center (belongs to the active workspace)
  terms: new Map(), // termId -> { term, fit, ptyId, el, tabEl, name, wsId, alive }
  termSeq: 0,
  activeTerm: null,
  activeTermByWs: {}, // wsId -> termId last active there
  cliAvail: new Map(), // profileId -> boolean
  expanded: new Set(['inbox']),
};

/* ---------------- toasts ---------------- */
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 7000);
}

/* ---------------- input modal (Electron lacks window.prompt) ---------------- */
function askInput(title, initial = '') {
  return new Promise((resolve) => {
    const modal = $('#input-modal');
    $('#input-title').textContent = title;
    const field = $('#input-field');
    field.value = initial;
    modal.classList.remove('hidden');
    field.focus();
    field.select();
    const done = (val) => {
      modal.classList.add('hidden');
      $('#input-ok').onclick = $('#input-cancel').onclick = field.onkeydown = null;
      resolve(val);
    };
    $('#input-ok').onclick = () => done(field.value.trim() || null);
    $('#input-cancel').onclick = () => done(null);
    field.onkeydown = (e) => {
      if (e.key === 'Enter') done(field.value.trim() || null);
      if (e.key === 'Escape') done(null);
    };
  });
}

/* ---------------- workspaces (spaces) ---------------- */
function activeWorkspace() {
  return state.workspaces.list.find((w) => w.id === state.workspaces.active);
}

// Workspace strip (top of window). Kept under the old name because the
// wizard and boot code call it.
function renderWorkspaceSwitcher() {
  const bar = $('#ws-tabs');
  bar.innerHTML = '';
  for (const w of state.workspaces.list) {
    const tab = document.createElement('div');
    tab.className = 'ws-tab' + (w.id === state.workspaces.active ? ' active' : '');
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = w.id === 'global' ? '◈' : '◇';
    tab.append(glyph, document.createTextNode(w.name));
    tab.title = w.path;
    tab.onclick = () => switchWorkspace(w.id);
    tab.oncontextmenu = (e) => {
      e.preventDefault();
      hideContextMenu();
      const menu = $('#context-menu');
      menu.innerHTML = '';
      menu.appendChild(ctxItem('open folder', () => tote.openPath('.')));
      menu.appendChild(ctxItem('copy path', () => navigator.clipboard.writeText(w.path)));
      menu.appendChild(ctxItem('rename…', () => renameWorkspace(w)));
      menu.appendChild(ctxItem('change folder…', () => changeWorkspaceFolder(w)));
      menu.appendChild(ctxItem('remove workspace (keeps files on disk)', () => removeWorkspace(w), true));
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.remove('hidden');
    };
    bar.appendChild(tab);
  }
  const ws = activeWorkspace();
  $('#workspace-root').textContent = ws ? ws.path : '';
  $('#workspace-root').title = ws ? ws.path : '';
}

async function switchWorkspace(id) {
  if (id === state.workspaces.active) return;
  try {
    await tote.setActiveWorkspace(id);
    state.workspaces = await tote.listWorkspaces();
    renderWorkspaceSwitcher();
    showWorkspaceViews();
    await refreshTree();
    toast('Workspace → ' + activeWorkspace().name + '. New terminals and downloads land here.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeWorkspace(ws) {
  if (!confirm(`Remove workspace "${ws.name}" from Tote?\nFiles on disk are NOT deleted.`)) return;
  try {
    state.workspaces = await tote.removeWorkspace(ws.id);
    // drop this space's views: kill its terminals, destroy its webviews
    for (const [id, t] of [...state.terms]) if (t.wsId === ws.id) closeTerm(id);
    for (const [tabId, en] of [...state.tabs]) if (en.wsId === ws.id) destroyTabWebview(tabId);
    delete state.views[ws.id];
    delete state.activeTermByWs[ws.id];
    saveViews();
    renderWorkspaceSwitcher();
    showWorkspaceViews();
    await refreshTree();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function renameWorkspace(ws) {
  const name = await askInput('Rename workspace', ws.name);
  if (!name || name === ws.name) return false;
  try {
    state.workspaces = await tote.renameWorkspace(ws.id, name);
    renderWorkspaceSwitcher();
    toast('Workspace renamed to "' + name + '".', 'success');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

// Re-point a space at another folder (main opens a picker). Nothing on disk
// moves; already-open terminals keep their old cwd.
async function changeWorkspaceFolder(ws) {
  try {
    const res = await tote.setWorkspacePath(ws.id);
    if (!res) return false; // canceled
    state.workspaces = res;
    renderWorkspaceSwitcher();
    if (ws.id === state.workspaces.active) await refreshTree();
    toast('Workspace "' + ws.name + '" now points at ' + activeWorkspaceById(ws.id).path, 'success');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}
const activeWorkspaceById = (id) => state.workspaces.list.find((w) => w.id === id) || {};

async function addWorkspace() {
  const name = await askInput('New workspace name (e.g. nexus-core)');
  if (!name) return false;
  const res = await tote.addWorkspace(name); // main opens a folder picker
  if (!res) return false; // canceled
  state.workspaces = res;
  renderWorkspaceSwitcher();
  showWorkspaceViews();
  await refreshTree();
  toast('Workspace "' + name + '" added and activated.', 'success');
  return true;
}

$('#btn-add-ws').onclick = addWorkspace;

/* ---------------- web tabs (per workspace) ----------------
 * A workspace owns a list of tab instances (several of the same provider are
 * fine — they share the provider's login partition). The list + active tab is
 * persisted in views.json; webviews are created lazily on first activation and
 * kept alive (hidden) when you switch workspaces so coming back is instant. */
function wsViews(wsId = state.workspaces.active) {
  if (!state.views[wsId]) state.views[wsId] = { tabs: [], active: null };
  return state.views[wsId];
}
let saveViewsTimer = null;
function saveViews() {
  clearTimeout(saveViewsTimer);
  saveViewsTimer = setTimeout(() => tote.saveViews(state.views), 200);
}
const providerOf = (id) => state.providers.find((p) => p.id === id);
const newId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  const V = wsViews();
  const counts = {};
  for (const t of V.tabs) counts[t.providerId] = (counts[t.providerId] || 0) + 1;
  const seen = {};
  for (const t of V.tabs) {
    const p = providerOf(t.providerId);
    if (!p) continue;
    seen[p.id] = (seen[p.id] || 0) + 1;
    const btn = document.createElement('div');
    btn.className = 'tab' + (state.activeTab === t.id ? ' active' : '');
    btn.dataset.tab = t.id;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = p.color || '#888';
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(p.name));
    if (counts[p.id] > 1) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = '#' + seen[p.id];
      btn.appendChild(n);
    }
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'close tab';
    close.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
    btn.appendChild(close);
    btn.title = p.url + '  (right-click: reload / duplicate / close)';
    btn.onclick = () => activateTab(t.id);
    btn.oncontextmenu = (e) => {
      e.preventDefault();
      hideContextMenu();
      const menu = $('#context-menu');
      menu.innerHTML = '';
      menu.appendChild(ctxItem('reload', () => {
        const entry = state.tabs.get(t.id);
        if (entry && entry.wv) entry.wv.reload(); else activateTab(t.id);
      }));
      menu.appendChild(ctxItem('duplicate (new ' + p.name + ' tab)', () => openTab(p.id)));
      menu.appendChild(ctxItem('close', () => closeTab(t.id), true));
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.remove('hidden');
    };
    bar.appendChild(btn);
  }
}

function setTabLoading(tabId, on) {
  const btn = document.querySelector(`[data-tab="${tabId}"]`);
  if (btn) btn.classList.toggle('loading', on);
}

function openTab(providerId) {
  const V = wsViews();
  const tab = { id: newId('t'), providerId };
  V.tabs.push(tab);
  renderTabs();
  activateTab(tab.id);
}

function ensureWebview(tab, provider) {
  let entry = state.tabs.get(tab.id);
  if (entry && entry.wv) return entry.wv;
  const wv = document.createElement('webview');
  wv.className = 'provider-view';
  wv.setAttribute('partition', `persist:tote-${provider.id}`);
  wv.setAttribute('src', provider.url);
  wv.setAttribute('allowpopups', '');
  wv.addEventListener('did-start-loading', () => setTabLoading(tab.id, true));
  wv.addEventListener('did-stop-loading', () => setTabLoading(tab.id, false));
  wv.addEventListener('page-title-updated', (e) => {
    const btn = document.querySelector(`[data-tab="${tab.id}"]`);
    if (btn) btn.title = e.title || provider.url;
  });
  wv.addEventListener('did-fail-load', (e) => {
    // -3 = ABORTED (normal during redirects); ignore subframe failures
    if (e.errorCode === -3 || !e.isMainFrame) return;
    toast(`${provider.name}: failed to load (${e.errorDescription || e.errorCode}). Right-click the tab → reload.`, 'error');
  });
  wv.addEventListener('render-process-gone', () => {
    wv.remove();
    const en = state.tabs.get(tab.id);
    if (en) en.wv = null; // tab stays; next activation recreates the webview
    toast(provider.name + ' tab crashed - click it to reload.', 'error');
    if (state.activeTab === tab.id) $('#welcome').style.display = '';
  });
  $('#webviews').appendChild(wv);
  entry = { wv, providerId: provider.id, wsId: state.workspaces.active };
  state.tabs.set(tab.id, entry);
  return wv;
}

function showOnlyWebview(tabId) {
  for (const [id, en] of state.tabs) if (en.wv) en.wv.classList.toggle('active', id === tabId);
  $('#welcome').style.display = tabId ? 'none' : '';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabId));
}

async function activateTab(tabId) {
  const V = wsViews();
  const tab = V.tabs.find((t) => t.id === tabId);
  const provider = tab && providerOf(tab.providerId);
  if (!provider) return;
  if (provider.local) {
    setTabLoading(tabId, true);
    try {
      await tote.ensureLocal(provider.id);
    } catch (e) {
      setTabLoading(tabId, false);
      toast(e.message, 'error');
      return;
    }
    setTabLoading(tabId, false);
  }
  V.active = tabId;
  state.activeTab = tabId;
  ensureWebview(tab, provider);
  showOnlyWebview(tabId);
  saveViews();
}

function destroyTabWebview(tabId) {
  const en = state.tabs.get(tabId);
  if (en && en.wv) en.wv.remove();
  state.tabs.delete(tabId);
}

function closeTab(tabId) {
  const V = wsViews();
  const idx = V.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  V.tabs.splice(idx, 1);
  destroyTabWebview(tabId);
  if (state.activeTab === tabId) {
    const next = V.tabs[idx] || V.tabs[idx - 1];
    state.activeTab = null;
    V.active = null;
    renderTabs();
    if (next) activateTab(next.id); else showOnlyWebview(null);
  } else {
    renderTabs();
  }
  saveViews();
}

// Bring the ACTIVE workspace's views to the front (tabs + terminals). Other
// workspaces' webviews/PTYs stay alive in the background.
function showWorkspaceViews() {
  const V = wsViews();
  applyLayout(); // this space's docks / sizes / panel visibility
  state.activeTab = null;
  renderTabs();
  const active = V.tabs.find((t) => t.id === V.active) || V.tabs[0];
  if (active) activateTab(active.id); else showOnlyWebview(null);
  renderTermTabs();
}

$('#btn-add-tab').onclick = (e) => {
  e.stopPropagation();
  const menu = $('#tab-add-menu');
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
  menu.innerHTML = '';
  for (const p of state.providers) {
    const item = document.createElement('div');
    item.className = 'term-menu-item';
    const dot = document.createElement('span');
    dot.className = 'avail';
    dot.style.background = p.color || '#888';
    item.appendChild(dot);
    item.appendChild(document.createTextNode(p.name));
    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    try { cmd.textContent = new URL(p.url).hostname; } catch { cmd.textContent = p.url; }
    item.appendChild(cmd);
    item.onclick = () => { menu.classList.add('hidden'); openTab(p.id); };
    menu.appendChild(item);
  }
  menu.classList.remove('hidden');
};
document.addEventListener('click', () => $('#tab-add-menu').classList.add('hidden'));

/* ---------------- workspace tree ---------------- */
async function refreshTree() {
  state.treeData = await tote.tree();
  renderTree();
}

function renderTree() {
  const host = $('#tree');
  host.innerHTML = '';
  host.appendChild(renderNodes(state.treeData));
}

function renderNodes(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    const caret = document.createElement('span');
    caret.className = 'caret';
    const icon = document.createElement('span');
    icon.className = 'icon';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = n.name;
    if (n.type === 'dir') {
      caret.textContent = state.expanded.has(n.path) ? '▼' : '▶';
      icon.textContent = state.expanded.has(n.path) ? '▾' : '▸';
      row.onclick = () => {
        state.expanded.has(n.path) ? state.expanded.delete(n.path) : state.expanded.add(n.path);
        renderTree();
      };
    } else {
      icon.textContent = n.text ? '≡' : '•';
      row.onclick = () => openFile(n);
    }
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, n);
    };
    row.append(caret, icon, name);
    frag.appendChild(row);
    if (n.type === 'dir' && state.expanded.has(n.path) && n.children) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      kids.appendChild(renderNodes(n.children));
      frag.appendChild(kids);
    }
  }
  return frag;
}

/* ---------------- context menu ---------------- */
function hideContextMenu() {
  $('#context-menu').classList.add('hidden');
}
document.addEventListener('click', hideContextMenu);
// Any right-click elsewhere replaces (or just closes) the open menu; Esc closes it.
document.addEventListener('contextmenu', hideContextMenu, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
addEventListener('blur', hideContextMenu);

function ctxItem(label, fn, danger) {
  const el = document.createElement('div');
  el.className = 'ctx-item' + (danger ? ' danger' : '');
  el.textContent = label;
  el.onclick = async () => {
    hideContextMenu();
    await fn();
  };
  return el;
}

function showContextMenu(x, y, node) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  const parentDir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';

  if (node.type === 'file') {
    menu.appendChild(ctxItem('Open', () => openFile(node)));
    menu.appendChild(ctxItem('Open externally', () => tote.openPath(node.path)));
    menu.appendChild(ctxItem('Send to active tab (experimental)', () => sendToTab(node.path)));
    menu.appendChild(ctxItem('Copy path', () => navigator.clipboard.writeText(node.path)));
  } else {
    menu.appendChild(ctxItem('New file here', () => newFile(node.path)));
    menu.appendChild(ctxItem('New folder here', () => newFolder(node.path)));
    menu.appendChild(ctxItem('Open externally', () => tote.openPath(node.path)));
  }
  menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }));
  menu.appendChild(
    ctxItem('Rename…', async () => {
      const name = await askInput('Rename to', node.name);
      if (!name || name === node.name) return;
      const to = parentDir === '.' ? name : parentDir + '/' + name;
      try {
        await tote.rename(node.path, to);
        refreshTree();
      } catch (e) {
        toast(e.message, 'error');
      }
    }),
  );
  menu.appendChild(
    ctxItem('Delete', async () => {
      if (!confirm(`Move "${node.name}" to trash?`)) return;
      try {
        await tote.trash(node.path);
        refreshTree();
      } catch (e) {
        toast(e.message, 'error');
      }
    }, true),
  );

  menu.classList.remove('hidden');
  const mw = 200;
  menu.style.left = Math.min(x, innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - menu.offsetHeight - 8) + 'px';
}

/* ---------------- files ---------------- */
let editorPath = null;

async function openFile(node) {
  if (!node.text) {
    tote.openPath(node.path);
    return;
  }
  try {
    const content = await tote.readFile(node.path);
    editorPath = node.path;
    $('#editor-title').textContent = node.path;
    $('#editor-text').value = content;
    $('#editor-modal').classList.remove('hidden');
  } catch (e) {
    toast(e.message + ' — opening externally.', 'error');
    tote.openPath(node.path);
  }
}

$('#editor-save').onclick = async () => {
  try {
    await tote.writeFile(editorPath, $('#editor-text').value);
    $('#editor-modal').classList.add('hidden');
    toast('Saved ' + editorPath, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#editor-cancel').onclick = () => $('#editor-modal').classList.add('hidden');

async function newFile(baseDir = '.') {
  const name = await askInput('New file name (in ' + baseDir + ')');
  if (!name) return;
  try {
    await tote.createFile(baseDir === '.' ? name : baseDir + '/' + name);
    refreshTree();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function newFolder(baseDir = '.') {
  const name = await askInput('New folder name (in ' + baseDir + ')');
  if (!name) return;
  try {
    await tote.createFolder(baseDir === '.' ? name : baseDir + '/' + name);
    refreshTree();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function sendToTab(relPath) {
  const en = state.activeTab && state.tabs.get(state.activeTab);
  if (!en || !en.wv) {
    toast('Open a web tab first, then send the file.', 'error');
    return;
  }
  const wv = en.wv;
  let wcId;
  try {
    wcId = wv.getWebContentsId();
  } catch {
    toast('Tab is still loading - try again in a second.', 'error');
    return;
  }
  try {
    const how = await tote.sendFileToTab(wcId, relPath);
    toast(relPath + ' → ' + how, 'success');
  } catch (e) {
    toast('Send failed: ' + e.message, 'error');
  }
}

/* ---------------- native apps launcher ---------------- */
async function renderAppsMenu() {
  const menu = $('#apps-menu');
  menu.innerHTML = '';
  if (state.apps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'term-menu-item';
    empty.textContent = 'No apps yet - add one below';
    menu.appendChild(empty);
  }
  for (const a of state.apps) {
    const item = document.createElement('div');
    item.className = 'term-menu-item';
    item.appendChild(document.createTextNode(a.name));
    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    cmd.textContent = a.kind === 'claude' ? 'MCP bind' : 'launch';
    item.appendChild(cmd);
    item.onclick = async () => {
      menu.classList.add('hidden');
      try {
        const res = await tote.launchApp(a.id);
        toast(`Launched ${res.launched} (workspace: ${res.workspace})` + (res.note ? ' — ' + res.note : ''), 'success');
      } catch (e) {
        toast('Launch failed: ' + e.message, 'error');
      }
    };
    menu.appendChild(item);
  }
  const sep = document.createElement('div');
  sep.className = 'ctx-sep';
  menu.appendChild(sep);
  menu.appendChild(
    (() => {
      const add = document.createElement('div');
      add.className = 'term-menu-item';
      add.textContent = '+ add app…';
      add.onclick = async () => {
        menu.classList.add('hidden');
        const name = await askInput('App name (e.g. Kimi)');
        if (!name) return;
        const list = await tote.addApp(name); // main opens a binary picker
        if (list) {
          state.apps = list;
          toast('App "' + name + '" added.', 'success');
        }
      };
      return add;
    })(),
  );
}

$('#btn-apps').onclick = async (e) => {
  e.stopPropagation();
  const menu = $('#apps-menu');
  if (menu.classList.contains('hidden')) {
    state.apps = await tote.listApps();
    await renderAppsMenu();
    menu.classList.remove('hidden');
  } else {
    menu.classList.add('hidden');
  }
};
document.addEventListener('click', (e) => {
  if (!$('#apps-wrap').contains(e.target)) $('#apps-menu').classList.add('hidden');
});

/* ---------------- terminals ---------------- */
const Fit = window.FitAddon && window.FitAddon.FitAddon;

function togglePanel(force) {
  const L = layout();
  const show = force !== undefined ? force : !L.terminal.visible;
  if (L.terminal.visible === show) return;
  L.terminal.visible = show;
  applyLayout();
  saveLayout();
}

function fitActiveTerm() {
  const t = state.terms.get(state.activeTerm);
  if (!t || !t.fit) return;
  try {
    t.fit.fit();
    if (t.alive) tote.ptyResize(t.ptyId, t.term.cols, t.term.rows);
  } catch {}
}

async function renderTermMenu() {
  const menu = $('#term-menu');
  menu.innerHTML = '';
  for (const p of state.profiles) {
    if (!state.cliAvail.has(p.id)) {
      state.cliAvail.set(p.id, await tote.checkCommand(p.command));
    }
    const item = document.createElement('div');
    item.className = 'term-menu-item';
    const dot = document.createElement('span');
    dot.className = 'avail ' + (state.cliAvail.get(p.id) ? 'ok' : 'missing');
    dot.title = state.cliAvail.get(p.id) ? 'found on PATH' : 'not found on PATH';
    item.appendChild(dot);
    item.appendChild(document.createTextNode(p.name));
    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    cmd.textContent = p.command || '$SHELL';
    item.appendChild(cmd);
    item.onclick = () => {
      menu.classList.add('hidden');
      spawnTerm(p);
    };
    menu.appendChild(item);
  }
}

async function spawnTerm(profile) {
  togglePanel(true);
  const id = ++state.termSeq;
  const wsName = (activeWorkspace() && activeWorkspace().name) || '?';

  const el = document.createElement('div');
  el.className = 'term-instance';
  $('#term-container').appendChild(el);

  const tabEl = document.createElement('div');
  tabEl.className = 'term-tab';
  const label = document.createElement('span');
  label.textContent = profile.name;
  tabEl.title = wsName + ' · cwd: ' + (activeWorkspace() ? activeWorkspace().path : '');
  tabEl.append(label);
  const close = document.createElement('span');
  close.className = 'close';
  close.textContent = '×';
  close.onclick = (e) => {
    e.stopPropagation();
    closeTerm(id);
  };
  tabEl.appendChild(close);
  tabEl.onclick = () => activateTerm(id);
  $('#term-tabs').appendChild(tabEl);

  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: '#0a0d13',
      foreground: '#dbe2f0',
      cursor: '#2b5cff',
      selectionBackground: '#2a3654',
    },
  });
  let fit = null;
  if (Fit) {
    fit = new Fit();
    term.loadAddon(fit);
  }
  term.open(el);

  const entry = { term, fit, ptyId: null, el, tabEl, name: profile.name, wsId: state.workspaces.active, alive: false };
  state.terms.set(id, entry);
  activateTerm(id);
  // Fit synchronously so the PTY is created at the real size, not 80x24 —
  // the RAF fit in activateTerm runs after ptySpawn and can't resize a PTY
  // that doesn't exist yet.
  if (fit) { try { fit.fit(); } catch {} }

  try {
    const res = await tote.ptySpawn(profile.id, term.cols || 80, term.rows || 24);
    entry.ptyId = res.id;
    entry.alive = true;
    tabEl.title = res.workspace + ' · cwd: ' + res.cwd;
    term.writeln('\x1b[90m[Tote] workspace "' + res.workspace + '" · cwd ' + res.cwd + '\x1b[0m');
    if (profile.hint) term.writeln('\x1b[33m' + profile.hint + '\x1b[0m');
    term.onData((d) => tote.ptyWrite(res.id, d));
    // Size may have changed while spawning (or the sync fit ran at 0x0); push it now.
    if (fit) { try { fit.fit(); } catch {} }
    tote.ptyResize(res.id, term.cols, term.rows);
  } catch (e) {
    term.writeln('\x1b[31mCould not start ' + profile.name + ':\x1b[0m ' + e.message);
    tabEl.classList.add('dead');
  }
}

function activateTerm(id) {
  state.activeTerm = id;
  const t = state.terms.get(id);
  if (t) state.activeTermByWs[t.wsId] = id;
  for (const [tid, tt] of state.terms) {
    tt.el.classList.toggle('active', tid === id);
    tt.tabEl.classList.toggle('active', tid === id);
  }
  requestAnimationFrame(fitActiveTerm);
  if (t) t.term.focus();
}

// Show only the active workspace's terminal tabs; others stay alive but hidden.
function renderTermTabs() {
  const ws = state.workspaces.active;
  let mine = [];
  for (const [id, t] of state.terms) {
    const isMine = t.wsId === ws;
    t.tabEl.classList.toggle('hidden', !isMine);
    if (isMine) mine.push(id);
  }
  const remembered = state.activeTermByWs[ws];
  const pick = mine.includes(remembered) ? remembered : mine[mine.length - 1];
  if (pick !== undefined) activateTerm(pick);
  else {
    state.activeTerm = null;
    for (const t of state.terms.values()) { t.el.classList.remove('active'); t.tabEl.classList.remove('active'); }
  }
}

function closeTerm(id) {
  const t = state.terms.get(id);
  if (!t) return;
  if (t.alive) tote.ptyKill(t.ptyId);
  t.el.remove();
  t.tabEl.remove();
  state.terms.delete(id);
  if (state.activeTermByWs[t.wsId] === id) delete state.activeTermByWs[t.wsId];
  if (state.activeTerm === id) {
    const same = [...state.terms].filter(([, x]) => x.wsId === t.wsId).map(([k]) => k);
    const next = same.pop();
    if (next !== undefined) activateTerm(next);
    else state.activeTerm = null;
  }
}

tote.onPtyData((ptyId, data) => {
  for (const t of state.terms.values()) {
    if (t.ptyId === ptyId) {
      t.term.write(data);
      return;
    }
  }
  if (wizTerm && ptyId === wizTermPty) wizTerm.write(data);
});

tote.onPtyExit((ptyId, code) => {
  for (const t of state.terms.values()) {
    if (t.ptyId === ptyId) {
      t.alive = false;
      t.tabEl.classList.add('dead');
      t.term.writeln('\r\n\x1b[90m[process exited with code ' + code + ']\x1b[0m');
      return;
    }
  }
  if (wizOnExit) wizOnExit(ptyId, code);
});

$('#btn-new-term').onclick = async (e) => {
  e.stopPropagation();
  const menu = $('#term-menu');
  if (menu.classList.contains('hidden')) {
    await renderTermMenu();
    menu.classList.remove('hidden');
  } else {
    menu.classList.add('hidden');
  }
};

$('#btn-terminal').onclick = () => togglePanel();

/* ---------------- layout: dockable panels ----------------
 * Two panels (files, terminal), three docks (left, bottom, right). A panel's
 * DOM node is moved into its dock; each dock has one persisted size and a
 * splitter that is shown only when the dock holds a visible panel.
 * Persisted as settings.layout. */
const PANELS = { files: '#files-panel', terminal: '#terminal-panel' };
const DOCKS = ['left', 'bottom', 'right'];

const DEFAULT_LAYOUT = {
  files: { dock: 'left', visible: true },
  terminal: { dock: 'bottom', visible: false },
  sizes: { left: 270, right: 520, bottom: 280 },
};

// Layout is PER WORKSPACE (stored in views.json next to the space's tabs), so
// hiding/docking a panel in one space never touches another. New spaces start
// from the legacy global settings.layout if present, else DEFAULT_LAYOUT.
function layout() {
  const V = wsViews();
  if (!V.layout) {
    const tpl = state.settings.layout || DEFAULT_LAYOUT;
    V.layout = JSON.parse(JSON.stringify(tpl));
    if (V.layout.terminal) V.layout.terminal.visible = false;
  }
  return V.layout;
}

function saveLayout() {
  saveViews();
}

function applyLayout() {
  const L = layout();
  for (const [name, sel] of Object.entries(PANELS)) {
    const el = $(sel);
    const dock = $('#dock-' + L[name].dock);
    if (el.parentElement !== dock) dock.appendChild(el);
    el.classList.toggle('hidden', !L[name].visible);
  }
  for (const side of DOCKS) {
    const dock = $('#dock-' + side);
    const anyVisible = [...dock.children].some((c) => !c.classList.contains('hidden'));
    dock.classList.toggle('hidden', !anyVisible);
    $('#split-' + side).classList.toggle('hidden', !anyVisible);
    if (side === 'bottom') dock.style.height = L.sizes.bottom + 'px';
    else dock.style.width = L.sizes[side] + 'px';
  }
  $('#btn-files').classList.toggle('on', L.files.visible);
  $('#btn-terminal').classList.toggle('on', L.terminal.visible);
  requestAnimationFrame(fitActiveTerm);
}

// ≡ button on each panel bar: dock left / bottom / right, or hide.
document.querySelectorAll('.dock-menu-btn').forEach((btn) => {
  btn.onclick = (e) => {
    e.stopPropagation();
    const name = btn.dataset.panel;
    hideContextMenu();
    const menu = $('#context-menu');
    menu.innerHTML = '';
    const cur = layout()[name].dock;
    for (const [dock, label] of [['left', '◂ dock left'], ['bottom', '▾ dock bottom'], ['right', '▸ dock right']]) {
      const item = ctxItem(label, () => {
        layout()[name].dock = dock;
        layout()[name].visible = true;
        applyLayout();
        saveLayout();
      });
      if (dock === cur) item.classList.add('checked');
      menu.appendChild(item);
    }
    menu.appendChild(ctxItem('hide panel', () => {
      layout()[name].visible = false;
      applyLayout();
      saveLayout();
    }));
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.min(r.left, innerWidth - 200) + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    menu.classList.remove('hidden');
  };
});

$('#btn-files').onclick = () => {
  layout().files.visible = !layout().files.visible;
  applyLayout();
  saveLayout();
};

// Splitter drag. While dragging, webviews get pointer-events:none (see
// styles.css body.dragging) — otherwise the guest view swallows mousemove as
// soon as the cursor crosses it and the drag dies.
document.querySelectorAll('.splitter').forEach((handle) => {
  const side = handle.dataset.side;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const dock = $('#dock-' + side);
    const start = side === 'bottom' ? e.clientY : e.clientX;
    const startSize = side === 'bottom' ? dock.offsetHeight : dock.offsetWidth;
    document.body.classList.add('dragging');
    const move = (ev) => {
      let size;
      if (side === 'left') size = startSize + (ev.clientX - start);
      else if (side === 'right') size = startSize + (start - ev.clientX);
      else size = startSize + (start - ev.clientY);
      const max = side === 'bottom' ? innerHeight - 220 : innerWidth - 480;
      size = Math.max(160, Math.min(max, size));
      layout().sizes[side] = size;
      if (side === 'bottom') dock.style.height = size + 'px';
      else dock.style.width = size + 'px';
    };
    const up = () => {
      document.body.classList.remove('dragging');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      fitActiveTerm();
      saveLayout();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
});

addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '`') {
    e.preventDefault();
    togglePanel();
  }
});

addEventListener('resize', fitActiveTerm);
// Refit on any container size change (dock toggle, splitter, panel show, window).
(() => {
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fitActiveTerm);
  }).observe($('#term-container'));
})();

/* ---------------- settings ---------------- */
function renderSettings() {
  // workspaces (spaces)
  const wHost = $('#settings-workspaces');
  wHost.innerHTML = '';
  for (const w of state.workspaces.list) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = w.id === 'global' ? '◈' : '◇';
    row.appendChild(glyph);
    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.textContent = w.name + (w.id === state.workspaces.active ? ' (active)' : '') + '  ';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = w.path;
    grow.appendChild(sub);
    grow.title = w.path;
    row.appendChild(grow);
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = async () => { await fn(); renderSettings(); };
      row.appendChild(b);
    };
    btn('rename', () => renameWorkspace(w));
    btn('folder', () => changeWorkspaceFolder(w));
    if (state.workspaces.list.length > 1) btn('remove', () => removeWorkspace(w));
    wHost.appendChild(row);
  }

  // providers
  const pHost = $('#settings-providers');
  pHost.innerHTML = '';
  for (const p of state.providers) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    row.innerHTML =
      '<span class="dot" style="width:8px;height:8px;border-radius:50%;background:' +
      (p.color || '#888') + '"></span>';
    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.textContent = p.name + '  ';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = p.url;
    grow.appendChild(sub);
    row.appendChild(grow);
    const del = document.createElement('button');
    del.textContent = 'remove';
    del.onclick = async () => {
      if (!confirm('Remove provider "' + p.name + '"?')) return;
      // close every tab of this provider in every workspace
      for (const [tabId, en] of [...state.tabs]) if (en.providerId === p.id) destroyTabWebview(tabId);
      for (const v of Object.values(state.views)) {
        v.tabs = v.tabs.filter((t) => t.providerId !== p.id);
        if (v.active && !v.tabs.some((t) => t.id === v.active)) v.active = null;
      }
      state.providers = state.providers.filter((x) => x.id !== p.id);
      await tote.saveProviders(state.providers);
      saveViews();
      showWorkspaceViews();
      renderSettings();
    };
    row.appendChild(del);
    pHost.appendChild(row);
  }

  // apps
  const aHost = $('#settings-apps');
  aHost.innerHTML = '';
  for (const a of state.apps) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.textContent = a.name + '  ';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = a.path;
    grow.appendChild(sub);
    row.appendChild(grow);
    const del = document.createElement('button');
    del.textContent = 'remove';
    del.onclick = async () => {
      state.apps = await tote.removeApp(a.id);
      renderSettings();
    };
    row.appendChild(del);
    aHost.appendChild(row);
  }

  // behavior
  $('#set-bridge').checked = state.settings.bridgeDownloads !== false;

  // cli profiles
  const cHost = $('#settings-clis');
  cHost.innerHTML = '';
  for (const p of state.profiles) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.textContent = p.name + '  ';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = (p.command || '$SHELL') + ' ' + (p.args || []).join(' ');
    grow.appendChild(sub);
    row.appendChild(grow);
    const del = document.createElement('button');
    del.textContent = 'remove';
    del.onclick = async () => {
      if (!confirm('Remove profile "' + p.name + '"?')) return;
      state.profiles = state.profiles.filter((x) => x.id !== p.id);
      state.cliAvail.clear();
      await tote.saveCliProfiles(state.profiles);
      renderSettings();
    };
    row.appendChild(del);
    cHost.appendChild(row);
  }
}

$('#btn-settings').onclick = () => {
  renderSettings();
  $('#settings-modal').classList.remove('hidden');
};
$('#btn-settings-close').onclick = () => $('#settings-modal').classList.add('hidden');
$('#btn-open-config').onclick = () => tote.openConfigDir();

$('#set-bridge').onchange = async (e) => {
  state.settings.bridgeDownloads = e.target.checked;
  await tote.saveSettings(state.settings);
  toast('Downloads bridge ' + (e.target.checked ? 'enabled' : 'disabled') + '.', 'success');
};

$('#nw-add').onclick = async () => {
  if (await addWorkspace()) renderSettings();
};

$('#na-add').onclick = async () => {
  const name = $('#na-name').value.trim();
  if (!name) return;
  const list = await tote.addApp(name);
  if (list) {
    state.apps = list;
    $('#na-name').value = '';
    renderSettings();
  }
};

$('#np-add').onclick = async () => {
  const name = $('#np-name').value.trim();
  const url = $('#np-url').value.trim();
  if (!name || !/^https?:\/\//.test(url)) {
    toast('Give a name and a full https:// URL.', 'error');
    return;
  }
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36);
  state.providers.push({
    id,
    name,
    url,
    color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'),
  });
  $('#np-name').value = $('#np-url').value = '';
  await tote.saveProviders(state.providers);
  renderTabs();
  renderSettings();
};

$('#nc-add').onclick = async () => {
  const name = $('#nc-name').value.trim();
  const cmd = $('#nc-cmd').value.trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36);
  state.profiles.push({ id, name, command: cmd, args: [] });
  state.cliAvail.clear();
  $('#nc-name').value = $('#nc-cmd').value = '';
  await tote.saveCliProfiles(state.profiles);
  renderSettings();
};

/* ---------------- sidebar buttons ---------------- */
$('#btn-new-file').onclick = () => newFile('.');
$('#btn-new-folder').onclick = () => newFolder('.');
$('#btn-refresh').onclick = refreshTree;

/* ---------------- setup wizard ---------------- */
let wizStep = 0;
let wizTerm = null; // xterm instance used for installs
let wizTermPty = null; // pty id currently attached to wizTerm
let wizOnExit = null; // callback for the running install

function openWizard() {
  renderWizardStep();
  $('#wizard-modal').classList.remove('hidden');
}
function closeWizard() {
  $('#wizard-modal').classList.add('hidden');
}

function renderWizardStep() {
  document.querySelectorAll('.wz-dot').forEach((d) => d.classList.toggle('active', +d.dataset.step === wizStep));
  document.querySelectorAll('.wz-page').forEach((p) => p.classList.toggle('hidden', +p.dataset.page !== wizStep));
  $('#wz-back').style.visibility = wizStep === 0 ? 'hidden' : 'visible';
  $('#wz-next').textContent = wizStep === 4 ? 'finish' : 'next';
  if (wizStep === 0) renderWzSystem();
  if (wizStep === 1) renderWzClis();
  if (wizStep === 2) renderWzConnections();
  if (wizStep === 3) renderWzSpaces();
}

function wzRow(host, label, status, sub, action) {
  const row = document.createElement('div');
  row.className = 'wz-row';
  const dot = document.createElement('span');
  dot.className = 'wz-status ' + status;
  const grow = document.createElement('span');
  grow.className = 'grow';
  grow.textContent = label;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    grow.appendChild(s);
  }
  row.append(dot, grow);
  if (action) row.appendChild(action);
  host.appendChild(row);
}

async function renderWzSystem() {
  const host = $('#wz-system');
  host.innerHTML = '';
  const s = await tote.systemCheck();
  const rows = [
    ['Node.js', s.node ? 'v' + s.node : null, 'install Node 20+ from nodejs.org'],
    ['npm', s.npm ? 'v' + s.npm : null, 'ships with Node.js'],
    ['git', s.git, 'needed for project spaces and many agents'],
    ['terminal layer (node-pty)', s.pty.ok ? 'ok' : null, 'run: npm rebuild node-pty (needs build tools)'],
    ['home folder writable', s.homeWritable ? 'ok' : null, 'check permissions on your home directory'],
  ];
  for (const [label, val, hint] of rows) {
    wzRow(host, label, val ? 'ok' : 'bad', val || 'missing — ' + hint, null);
  }
}

async function renderWzClis() {
  const host = $('#wz-clis');
  host.innerHTML = '';
  for (const p of state.profiles) {
    if (p.id === 'shell') continue;
    const installed = await tote.checkCommand(p.command);
    const btn = document.createElement('button');
    if (installed) {
      btn.textContent = 'installed';
      btn.disabled = true;
    } else if (!p.install) {
      btn.textContent = 'runs via npx';
      btn.disabled = true;
    } else {
      btn.textContent = 'install';
      btn.onclick = () => runWizardInstall(p, btn);
    }
    wzRow(host, p.name, installed ? 'ok' : 'unknown', p.install || (p.command + ' ' + (p.args || []).join(' ')), btn);
  }
}

function ensureWizTerm() {
  if (wizTerm) {
    requestAnimationFrame(() => { try { wizTermFit && wizTermFit.fit(); } catch {} });
    return wizTerm;
  }
  wizTerm = new Terminal({
    fontSize: 12,
    fontFamily: '"SF Mono", Menlo, Consolas, monospace',
    theme: { background: '#0a0d13', foreground: '#dbe2f0', cursor: '#2b5cff' },
  });
  if (Fit) {
    wizTermFit = new Fit();
    wizTerm.loadAddon(wizTermFit);
  }
  wizTerm.open($('#wz-term'));
  setTimeout(() => { try { wizTermFit && wizTermFit.fit(); } catch {} }, 60);
  wizTerm.onData((d) => {
    if (wizTermPty) tote.ptyWrite(wizTermPty, d);
  });
  return wizTerm;
}
let wizTermFit = null;

async function runWizardInstall(profile, btn) {
  const term = ensureWizTerm();
  btn.disabled = true;
  btn.textContent = 'installing…';
  term.writeln('\x1b[36m$ ' + profile.install + '\x1b[0m');
  try {
    const { id } = await tote.ptyRun(profile.install);
    wizTermPty = id;
    wizOnExit = async (ptyId) => {
      if (ptyId !== id) return;
      wizOnExit = null;
      wizTermPty = null;
      term.writeln('\x1b[90m[install process finished]\x1b[0m');
      const ok = await tote.checkCommand(profile.command);
      btn.textContent = ok ? 'installed' : 'install';
      btn.disabled = ok;
      if (!ok) term.writeln('\x1b[33m"' + profile.command + '" still not on PATH — check output above.\x1b[0m');
    };
  } catch (e) {
    term.writeln('\x1b[31m' + e.message + '\x1b[0m');
    btn.disabled = false;
    btn.textContent = 'install';
  }
}

async function renderWzConnections() {
  const host = $('#wz-connections');
  host.innerHTML = '';

  const st = await tote.claudeStatus();
  const bindBtn = document.createElement('button');
  bindBtn.textContent = st.bound ? 're-bind to active workspace' : 'bind to active workspace';
  bindBtn.onclick = async () => {
    try {
      const r = await tote.bindClaude();
      toast(`Claude Desktop bound to "${r.workspace}" — restart Claude Desktop to apply.`, 'success');
      renderWzConnections();
      renderWzSnippet();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  wzRow(
    host,
    'Claude Desktop (MCP filesystem)',
    st.bound ? 'ok' : 'unknown',
    st.bound
      ? 'bound to ' + st.boundTo
      : st.configExists
        ? 'config found, workspace not bound yet'
        : 'no config yet — binding creates it',
    bindBtn,
  );

  renderWzSnippet();
}

async function renderWzSnippet() {
  $('#wz-snippet').value = await tote.mcpSnippet();
}

function renderWzSpaces() {
  const host = $('#wz-spaces');
  host.innerHTML = '';
  for (const w of state.workspaces.list) {
    const isActive = w.id === state.workspaces.active;
    wzRow(host, w.name, isActive ? 'ok' : 'unknown', w.path + (isActive ? ' (active)' : ''), null);
  }
}

$('#wz-copy-snippet').onclick = () => {
  navigator.clipboard.writeText($('#wz-snippet').value);
  toast('MCP snippet copied.', 'success');
};

$('#wz-add-space').onclick = async () => {
  const name = await askInput('New workspace name (e.g. nexus-core)');
  if (!name) return;
  const res = await tote.addWorkspace(name);
  if (res) {
    state.workspaces = res;
    renderWorkspaceSwitcher();
    refreshTree();
    renderWzSpaces();
  }
};

$('#wz-recheck').onclick = renderWzSystem;

$('#wz-next').onclick = async () => {
  if (wizStep < 4) {
    wizStep++;
    renderWizardStep();
    return;
  }
  state.settings.setupDone = $('#wz-dont-show').checked;
  await tote.saveSettings(state.settings);
  closeWizard();
};
$('#wz-back').onclick = () => {
  if (wizStep > 0) {
    wizStep--;
    renderWizardStep();
  }
};
document.querySelectorAll('.wz-dot').forEach((d) => {
  d.onclick = () => {
    wizStep = +d.dataset.step;
    renderWizardStep();
  };
});
$('#btn-run-wizard').onclick = () => {
  $('#settings-modal').classList.add('hidden');
  wizStep = 0;
  openWizard();
};

/* ---------------- events from main ---------------- */
tote.onWorkspaceChanged(() => refreshTree());

tote.onDownloadDone((m) => {
  if (m.state === 'completed') {
    toast(`${m.provider} → ${m.filename} saved to ${m.workspace}/inbox/${m.providerId}/`, 'success');
  } else {
    toast(`${m.provider}: ${m.filename} — ${m.state}`, 'error');
  }
  refreshTree();
});

/* ---------------- boot ---------------- */
(async function init() {
  const avail = await tote.ptyAvailable();
  if (!avail.ok) {
    toast('node-pty unavailable - terminals disabled. Rebuild with: npm rebuild node-pty', 'error');
  }
  state.providers = await tote.getProviders();
  state.profiles = await tote.getCliProfiles();
  state.apps = await tote.listApps();
  state.settings = await tote.getSettings();
  state.workspaces = await tote.listWorkspaces();
  state.views = (await tote.getViews()) || {};
  renderWorkspaceSwitcher();
  applyLayout();
  showWorkspaceViews();
  await refreshTree();
  if (state.settings.setupDone === false) {
    wizStep = 0;
    openWizard();
  }
})();
