/* Tote renderer. Globals from preload: window.tote; from vendor: Terminal, FitAddon. */
const $ = (sel) => document.querySelector(sel);

const state = {
  providers: [],
  profiles: [],
  apps: [],
  settings: { bridgeDownloads: true },
  workspaces: { active: null, list: [] },
  treeData: [],
  views: {}, // wsId -> { tabs: [{id, providerId}], tiling: {tree, focus, zoom} }  (persisted)
  tabs: new Map(), // tabId -> { wv: <webview>|null, providerId, wsId }  (webviews created lazily)
  activeTab: null, // tabId shown in the center (belongs to the active workspace)
  terms: new Map(), // termId -> { term, fit, ptyId, localId, pane, name, wsId, alive }
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

// A pane's title bar shows loading state; there is no global tab strip.
function setTabLoading(tabId, on) {
  const p = panes.get('web:' + tabId);
  if (p) p.el.classList.toggle('loading', on);
}

// Open a provider as a new pane in the active space.
function openTab(providerId) {
  const V = wsViews();
  const tab = { id: newId('t'), providerId };
  V.tabs.push(tab);
  openPane(T.leaf(newLeafId(), 'web', tab.id));
}

function ensureWebview(tab, provider, container) {
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
    if (en) en.wv = null; // pane stays; the next applyTiles recreates the webview
    toast(provider.name + ' pane crashed - it will reload.', 'error');
  });
  (container || $('#tiles')).appendChild(wv);
  entry = { wv, providerId: provider.id, wsId: state.workspaces.active };
  state.tabs.set(tab.id, entry);
  return wv;
}

function destroyTabWebview(tabId) {
  const en = state.tabs.get(tabId);
  if (en && en.wv) en.wv.remove();
  state.tabs.delete(tabId);
}

// Forget a web instance. The pane element and the tree leaf are handled by
// closePane, which is the only caller.
function closeTabInstance(tabId) {
  const V = wsViews();
  const idx = V.tabs.findIndex((t) => t.id === tabId);
  if (idx >= 0) V.tabs.splice(idx, 1);
  destroyTabWebview(tabId);
}

// Bring the ACTIVE space's panes to the front. Other spaces' webviews and PTYs
// stay alive in the background; applyTiles hides any pane not in this tree.
function showWorkspaceViews() {
  applyTiles();
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

// Refit every live terminal to its pane. Called on every layout change, so the
// xterm fit runs per frame while the PTY resize is debounced to the end of the
// drag -- resizing a PTY on every mousemove makes TUI agents redraw constantly.
let ptyResizeTimer = null;
function refitTerms() {
  for (const t of state.terms.values()) {
    if (!t.fit || !t.pane || t.pane.el.classList.contains('hidden')) continue;
    try { t.fit.fit(); } catch {}
  }
  clearTimeout(ptyResizeTimer);
  ptyResizeTimer = setTimeout(() => {
    for (const t of state.terms.values()) {
      if (!t.alive || !t.pane || t.pane.el.classList.contains('hidden')) continue;
      try { tote.ptyResize(t.ptyId, t.term.cols, t.term.rows); } catch {}
    }
  }, 150);
}

// Kill the PTY behind a term pane. The pane element and the leaf are closePane's
// business; this only tears down the instance.
function killTermByRef(localId) {
  const hit = [...state.terms].find(([, t]) => t.localId === localId);
  if (!hit) return;
  const [id, t] = hit;
  if (t.alive) tote.ptyKill(t.ptyId);
  state.terms.delete(id);
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
  const id = ++state.termSeq;
  const wsName = (activeWorkspace() && activeWorkspace().name) || '?';

  const pane = paneShell('term:' + id, profile.name);
  pane.el.title = wsName + ' · cwd: ' + (activeWorkspace() ? activeWorkspace().path : '');

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
  term.open(pane.body);

  const entry = { term, fit, ptyId: null, localId: id, pane, name: profile.name,
                  wsId: state.workspaces.active, alive: false };
  state.terms.set(id, entry);

  // Place the pane first so it has real dimensions, then fit synchronously: the
  // PTY must be created at the true size, not 80x24.
  openPane(T.leaf(newLeafId(), 'term', id));
  if (fit) { try { fit.fit(); } catch {} }

  try {
    const res = await tote.ptySpawn(profile.id, term.cols || 80, term.rows || 24);
    entry.ptyId = res.id;
    entry.alive = true;
    pane.el.title = res.workspace + ' · cwd: ' + res.cwd;
    term.writeln('\x1b[90m[Tote] workspace "' + res.workspace + '" · cwd ' + res.cwd + '\x1b[0m');
    if (profile.hint) term.writeln('\x1b[33m' + profile.hint + '\x1b[0m');
    term.onData((d) => tote.ptyWrite(res.id, d));
    // The pane may have been resized while spawning; push the real size now.
    if (fit) { try { fit.fit(); } catch {} }
    tote.ptyResize(res.id, term.cols, term.rows);
    term.focus();
  } catch (e) {
    term.writeln('\x1b[31mCould not start ' + profile.name + ':\x1b[0m ' + e.message);
    pane.el.classList.add('dead');
  }
}

// Close a terminal from outside the tiling UI -- e.g. its space was removed.
// When the pane is in the active space, go through closePane so the tree, the
// element and the PTY are torn down by the one code path.
function closeTerm(id) {
  const t = state.terms.get(id);
  if (!t) return;
  const V = state.views[t.wsId];
  const lf = V && V.tiling
    && T.leaves(V.tiling.tree).find((l) => l.kind === 'term' && l.ref === id);
  if (lf && t.wsId === state.workspaces.active) { closePane(lf.id); return; }
  if (lf) V.tiling.tree = T.removeLeaf(V.tiling.tree, lf.id);
  if (t.alive) tote.ptyKill(t.ptyId);
  destroyPaneEl('term:' + id);
  state.terms.delete(id);
  saveViews();
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
      if (t.pane) t.pane.el.classList.add('dead');
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


/* ---------------- tiling layout ----------------
 * One binary tree per space (TileTree, layout.js -- pure, tested by `npm test`).
 *
 * #tiles is FLAT: every pane is a DIRECT child, created once per content
 * instance (a web tab, a pty, the files tree) and never reparented. A tree edit
 * changes which RECT an element receives, never which parent it has. That is
 * load-bearing: reparenting a <webview> detaches its guest and the page reloads,
 * losing scroll position and unsent chat drafts. Measured, not assumed --
 * docs/superpowers/specs/2026-08-18-tiling-layout-design.md. */

const T = window.TileTree;
const GUTTER = 6;
const MIN_PANE = 140;

let leafSeq = 0;
const newLeafId = () => 'L' + (++leafSeq);

// Persisted ids must not be handed out again after a restart.
function adoptLeafSeq(all) {
  for (const V of Object.values(all || {})) {
    for (const lf of T.leaves(V.tiling && V.tiling.tree)) {
      const n = parseInt(String(lf.id).slice(1), 10);
      if (n > leafSeq) leafSeq = n;
    }
  }
}

// Per-space tiling state, migrated from the old dock layout on first read.
function tiles() {
  const V = wsViews();
  if (!V.tiling) {
    const m = T.migrate(
      { tabs: V.tabs || [], active: V.active, layout: V.layout || state.settings.layout || {} },
      newLeafId, { w: innerWidth || 1400, h: innerHeight || 800 });
    V.tiling = { tree: m.tree, focus: m.focus, zoom: null };
    delete V.layout;
  }
  return V.tiling;
}

function hostRect() {
  const r = $('#tiles').getBoundingClientRect();
  return { x: 0, y: 0, w: r.width, h: r.height };
}

/* ----- pane elements: one per content instance, created once, never moved ----- */

const panes = new Map();
const paneKey = (lf) => (lf.kind === 'files' ? 'files' : lf.kind + ':' + lf.ref);

function paneShell(key, titleText, dotColor) {
  let p = panes.get(key);
  if (p) return p;
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.pane = key;
  const head = document.createElement('div');
  head.className = 'pane-head';
  const dot = document.createElement('span');
  dot.className = 'pane-dot';
  if (dotColor) dot.style.background = dotColor; else dot.style.display = 'none';
  const title = document.createElement('span');
  title.className = 'pane-title';
  title.textContent = titleText;
  const x = document.createElement('span');
  x.className = 'pane-x';
  x.textContent = '✕';
  x.title = 'Close pane';
  head.append(dot, title, x);
  const body = document.createElement('div');
  body.className = 'pane-body';
  el.append(head, body);
  $('#tiles').appendChild(el);

  p = { el, head, body, title, dot, key };
  panes.set(key, p);

  el.addEventListener('mousedown', () => { if (el.dataset.leaf) focusPane(el.dataset.leaf); }, true);
  x.onclick = (e) => { e.stopPropagation(); if (el.dataset.leaf) closePane(el.dataset.leaf); };
  head.addEventListener('mousedown', (e) => {
    if (e.target === x) return;
    startPaneDrag(e, el);
  });
  return p;
}

// Give a leaf its element, creating the content if this is its first showing.
// Returns null when the instance is gone (a pty that died, a tab that was
// closed elsewhere) so the caller can prune the leaf.
function mountLeaf(lf) {
  const key = paneKey(lf);
  if (lf.kind === 'files') {
    const p = paneShell(key, 'files');
    if (!p.body.firstChild) p.body.appendChild($('#files-panel'));
    return p;
  }
  if (lf.kind === 'web') {
    const V = wsViews();
    const tab = (V.tabs || []).find((t) => t.id === lf.ref);
    const provider = tab && providerOf(tab.providerId);
    if (!provider) return null;
    const p = paneShell(key, provider.name, provider.color);
    ensureWebview(tab, provider, p.body);
    return p;
  }
  return panes.get(key) || null;   // terminals are built by spawnTerm
}

/* ----- applying the tree ----- */

function applyTiles() {
  const S = tiles();
  const host = hostRect();

  // prune leaves whose instance no longer exists
  for (const lf of T.leaves(S.tree)) {
    if (!mountLeaf(lf)) { S.tree = T.removeLeaf(S.tree, lf.id); if (S.focus === lf.id) S.focus = null; }
  }
  const live = T.leaves(S.tree);
  if (!live.some((l) => l.id === S.focus)) S.focus = live.length ? live[0].id : null;
  if (S.zoom && !live.some((l) => l.id === S.zoom)) S.zoom = null;

  const rects = T.rectsFor(S.tree, host, { gutter: GUTTER });
  for (const p of panes.values()) { p.el.classList.add('hidden'); p.el.dataset.leaf = ''; }

  for (const lf of live) {
    const p = panes.get(paneKey(lf));
    if (!p) continue;
    const r = S.zoom === lf.id ? host : rects.get(lf.id);
    p.el.dataset.leaf = lf.id;
    p.el.classList.remove('hidden');
    p.el.classList.toggle('focused', S.focus === lf.id);
    p.el.style.left = r.x + 'px';
    p.el.style.top = r.y + 'px';
    p.el.style.width = r.w + 'px';
    p.el.style.height = r.h + 'px';
    p.el.style.zIndex = S.zoom === lf.id ? 20 : 1;
  }

  renderDividers(S, host);
  $('#welcome').style.display = S.tree ? 'none' : '';
  $('#btn-files').classList.toggle('on', live.some((l) => l.kind === 'files'));
  requestAnimationFrame(refitTerms);
}

function renderDividers(S, host) {
  $('#tiles').querySelectorAll('.divider').forEach((d) => d.remove());
  if (S.zoom) return;                       // nothing to drag while zoomed
  for (const d of T.dividersFor(S.tree, host, { gutter: GUTTER })) {
    const el = document.createElement('div');
    el.className = 'divider ' + d.dir;
    el.style.left = d.rect.x + 'px';
    el.style.top = d.rect.y + 'px';
    el.style.width = d.rect.w + 'px';
    el.style.height = d.rect.h + 'px';
    el.addEventListener('mousedown', (e) => startDividerDrag(e, d));
    $('#tiles').appendChild(el);
  }
}

/* ----- interaction ----- */

function focusPane(leafId) {
  const S = tiles();
  if (!leafId || S.focus === leafId) return;
  S.focus = leafId;
  for (const p of panes.values()) p.el.classList.toggle('focused', p.el.dataset.leaf === leafId);
  const lf = T.findLeaf(S.tree, leafId);
  if (lf && lf.kind === 'term') {
    const t = [...state.terms.values()].find((x) => x.ptyId === lf.ref || x.localId === lf.ref);
    if (t) t.term.focus();
  }
  saveViews();
}

// Opening a pane splits the focused one along its longer axis (dwindle).
function openPane(node) {
  const S = tiles();
  if (!S.tree) {
    S.tree = node;
  } else {
    const rects = T.rectsFor(S.tree, hostRect(), { gutter: GUTTER });
    const target = (S.focus && T.findLeaf(S.tree, S.focus)) ? S.focus : T.leaves(S.tree)[0].id;
    S.tree = T.splitLeaf(S.tree, target, node, T.dirFor(rects.get(target) || hostRect()));
  }
  S.focus = node.id;
  S.zoom = null;
  applyTiles();
  saveViews();
  return node;
}

function closePane(leafId) {
  const S = tiles();
  const lf = T.findLeaf(S.tree, leafId);
  if (!lf) return;
  S.tree = T.removeLeaf(S.tree, leafId);
  if (S.zoom === leafId) S.zoom = null;
  // tear down the instance behind the pane
  if (lf.kind === 'web') { destroyPaneEl(paneKey(lf)); closeTabInstance(lf.ref); }
  else if (lf.kind === 'term') { killTermByRef(lf.ref); destroyPaneEl(paneKey(lf)); }
  else { const p = panes.get('files'); if (p) p.el.classList.add('hidden'); }
  applyTiles();
  saveViews();
}

function destroyPaneEl(key) {
  const p = panes.get(key);
  if (!p) return;
  p.el.remove();
  panes.delete(key);
}

function toggleZoom() {
  const S = tiles();
  if (!S.focus) return;
  S.zoom = S.zoom === S.focus ? null : S.focus;
  applyTiles();
  saveViews();
}

/* Divider drag. body.dragging puts pointer-events:none on webviews -- without
 * it the guest swallows mousemove the moment the cursor crosses it. */
function startDividerDrag(e, d) {
  e.preventDefault();
  document.body.classList.add('dragging');
  const S = tiles();
  const move = (ev) => {
    const raw = d.dir === 'row'
      ? (ev.clientX - $('#tiles').getBoundingClientRect().left - d.host.x) / d.host.w
      : (ev.clientY - $('#tiles').getBoundingClientRect().top - d.host.y) / d.host.h;
    S.tree = T.setRatio(S.tree, d.path, T.clampRatio(d.host, d.dir, raw, MIN_PANE));
    applyTiles();
  };
  const up = () => {
    document.body.classList.remove('dragging');
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    refitTerms(true);
    saveViews();
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

/* Pane drag: drop on the centre to swap, on an edge to re-split. Both are tree
 * edits -- no DOM node moves, so nothing reloads. */
function startPaneDrag(e, el) {
  e.preventDefault();
  const fromId = el.dataset.leaf;
  if (!fromId) return;
  document.body.classList.add('dragging');
  const hint = document.createElement('div');
  hint.className = 'drop-hint hidden';
  $('#tiles').appendChild(hint);

  let drop = null;
  const move = (ev) => {
    drop = dropTargetAt(ev.clientX, ev.clientY, fromId);
    if (!drop) { hint.classList.add('hidden'); return; }
    hint.classList.remove('hidden');
    const r = drop.rect, e2 = drop.edge;
    const box = e2 === 'centre' ? r
      : e2 === 'left'  ? { x: r.x, y: r.y, w: r.w / 2, h: r.h }
      : e2 === 'right' ? { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h }
      : e2 === 'top'   ? { x: r.x, y: r.y, w: r.w, h: r.h / 2 }
      :                  { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 };
    hint.style.left = box.x + 'px'; hint.style.top = box.y + 'px';
    hint.style.width = box.w + 'px'; hint.style.height = box.h + 'px';
  };
  const up = () => {
    document.body.classList.remove('dragging');
    hint.remove();
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    if (drop && drop.id !== fromId) {
      const S = tiles();
      S.tree = drop.edge === 'centre'
        ? T.swapLeaves(S.tree, fromId, drop.id)
        : T.moveLeaf(S.tree, fromId, drop.id, drop.edge);
      applyTiles();
      saveViews();
    }
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

// Which pane is under the cursor, and which quarter of it?
function dropTargetAt(clientX, clientY, fromId) {
  const S = tiles();
  const box = $('#tiles').getBoundingClientRect();
  const x = clientX - box.left, y = clientY - box.top;
  const rects = T.rectsFor(S.tree, hostRect(), { gutter: GUTTER });
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
    const fx = (x - r.x) / r.w, fy = (y - r.y) / r.h;
    let edge = 'centre';
    const m = 0.25;
    if (fx < m && fx <= fy && fx <= 1 - fy) edge = 'left';
    else if (fx > 1 - m && 1 - fx <= fy && 1 - fx <= 1 - fy) edge = 'right';
    else if (fy < m) edge = 'top';
    else if (fy > 1 - m) edge = 'bottom';
    return { id, rect: r, edge };
  }
  return null;
}

/* ----- toolbar + keyboard ----- */

$('#btn-files').onclick = () => {
  const S = tiles();
  const existing = T.leaves(S.tree).find((l) => l.kind === 'files');
  if (existing) closePane(existing.id);
  else openPane(T.leaf(newLeafId(), 'files'));
};

const MOD = (e) => (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && e.altKey;
const ARROW = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && e.key === '`') {
    e.preventDefault();
    const S = tiles();
    const term = T.leaves(S.tree).find((l) => l.kind === 'term');
    if (term) focusPane(term.id);
    else $('#btn-new-term').click();
    return;
  }
  if (!MOD(e)) return;
  const S = tiles();
  const dir = ARROW[e.key];
  if (dir) {
    e.preventDefault();
    const rects = T.rectsFor(S.tree, hostRect(), { gutter: GUTTER });
    if (e.shiftKey) {
      const target = T.neighbour(rects, S.focus, dir);
      if (target) {
        const edge = dir === 'up' ? 'top' : dir === 'down' ? 'bottom' : dir;
        S.tree = T.moveLeaf(S.tree, S.focus, target, edge);
        applyTiles();
        saveViews();
      }
    } else {
      focusPane(T.neighbour(rects, S.focus, dir));
    }
    return;
  }
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleZoom(); }
  if (e.key === 'w' || e.key === 'W') { e.preventDefault(); if (S.focus) closePane(S.focus); }
});

addEventListener('resize', () => applyTiles());
(() => {
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => applyTiles());
  }).observe($('#tiles'));
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
  adoptLeafSeq(state.views);   // never re-issue a persisted pane id
  renderWorkspaceSwitcher();
  showWorkspaceViews();
  await refreshTree();
  if (state.settings.setupDone === false) {
    wizStep = 0;
    openWizard();
  }
})();
