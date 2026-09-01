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
  docs: new Map(), // docId -> { path, kind, text, savedText, dataUrl, fileUrl, mtimeMs, size, error, stale }
  docOrder: [], // doc leaf ids, least recently focused first -- which pane a click retargets
  wsDrag: null, // id of the workspace tab being dragged along the strip
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
    tab.className = 'ws-tab' + (w.id === state.workspaces.active ? ' active' : '')
      + (w.temp ? ' temp' : '');
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = w.temp ? '◌' : w.id === 'global' ? '◈' : '◇';
    tab.append(glyph, document.createTextNode(w.name));
    tab.title = (w.temp ? 'temp space — discarding deletes its files\n' : '') + w.path;
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
      if (w.temp) {
        menu.appendChild(ctxItem('keep… (make permanent)', () => promoteWorkspace(w)));
        menu.appendChild(ctxItem('discard… (deletes its files)', () => discardWorkspace(w), true));
      } else {
        menu.appendChild(ctxItem('remove workspace (keeps files on disk)', () => removeWorkspace(w), true));
      }
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.remove('hidden');
    };
    tab.draggable = true;
    tab.ondragstart = (e) => {
      state.wsDrag = w.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', w.id); // Chromium refuses a payload-less drag
      tab.classList.add('dragging-tab');
      document.body.classList.add('dragging'); // else a webview swallows the drag
    };
    tab.ondragend = () => {
      tab.classList.remove('dragging-tab');
      document.body.classList.remove('dragging');
      clearWsDropMark();
      state.wsDrag = null;
    };
    tab.ondragover = (e) => {
      if (!state.wsDrag || state.wsDrag === w.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = tab.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      clearWsDropMark();
      tab.classList.add(after ? 'drop-after' : 'drop-before');
    };
    tab.ondragleave = () => tab.classList.remove('drop-before', 'drop-after');
    tab.ondrop = (e) => {
      if (!state.wsDrag) return;
      e.preventDefault();
      const after = tab.classList.contains('drop-after');
      const src = state.wsDrag;
      clearWsDropMark();
      if (src !== w.id) moveWorkspace(src, w.id, after);
    };
    bar.appendChild(tab);
  }
  // Empty strip space past the last tab: drop there means "move to the end".
  bar.ondragover = (e) => {
    if (!state.wsDrag || e.target !== bar) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearWsDropMark();
  };
  bar.ondrop = (e) => {
    if (!state.wsDrag || e.target !== bar) return;
    e.preventDefault();
    moveWorkspace(state.wsDrag, null, true);
  };
  const ws = activeWorkspace();
  $('#workspace-root').textContent = ws ? ws.path : '';
  $('#workspace-root').title = ws ? ws.path : '';
}

function clearWsDropMark() {
  for (const el of document.querySelectorAll('.ws-tab.drop-before, .ws-tab.drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

// Reorder the strip. targetId null means "to the end"; `after` picks the side
// of the target the dragged tab lands on. The order is persisted in
// workspaces.json, so it survives a restart; nothing else about a space moves.
async function moveWorkspace(srcId, targetId, after) {
  const current = state.workspaces.list.map((w) => w.id);
  const ids = current.filter((id) => id !== srcId);
  const at = targetId == null ? ids.length : ids.indexOf(targetId) + (after ? 1 : 0);
  ids.splice(at < 0 ? ids.length : at, 0, srcId);
  if (ids.join('\u0000') === current.join('\u0000')) return;
  try {
    state.workspaces = await tote.reorderWorkspaces(ids);
    renderWorkspaceSwitcher();
  } catch (err) {
    toast(err.message, 'error');
  }
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

// A temp space asks for a name only -- never a folder -- and starts from a
// generated one, so Enter is the whole interaction.
async function addTempWorkspace() {
  const suggested = await tote.wsTempName();
  const name = await askInput('New temp space (its files go when you discard it)', suggested);
  if (!name) return false;
  try {
    state.workspaces = await tote.wsAddTemp(name);
    renderWorkspaceSwitcher();
    showWorkspaceViews();
    await refreshTree();
    toast('Temp space "' + name + '" is active. Discard it when you are done.', 'success');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

$('#btn-add-temp').onclick = addTempWorkspace;

// Main measures the folder, names the terminals it will kill, and confirms.
// Panes come down only after the delete succeeded, so a cancel leaves nothing
// half-closed.
async function discardWorkspace(ws) {
  const labels = [...state.terms.values()].filter((t) => t.wsId === ws.id).map((t) => t.name);
  try {
    const res = await tote.wsDiscard(ws.id, labels);
    if (!res || res.canceled) return;
    state.workspaces = res;
    for (const [id, t] of [...state.terms]) if (t.wsId === ws.id) closeTerm(id);
    for (const [tabId, en] of [...state.tabs]) if (en.wsId === ws.id) destroyTabWebview(tabId);
    delete state.views[ws.id];
    delete state.activeTermByWs[ws.id];
    saveViews();
    renderWorkspaceSwitcher();
    showWorkspaceViews();
    await refreshTree();
    toast('Discarded "' + ws.name + '" and deleted its files.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Keep the work: main moves the folder and the space keeps its id, so tabs,
// groups and layout come along. Running terminals keep their old cwd.
async function promoteWorkspace(ws) {
  try {
    const res = await tote.wsPromote(ws.id);
    if (!res) return; // canceled
    state.workspaces = res;
    renderWorkspaceSwitcher();
    await refreshTree();
    const kept = activeWorkspaceById(ws.id);
    toast('Kept "' + ws.name + '" at ' + kept.path + '. Open terminals still sit in the old folder.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Only 'error' and 'success' are styled, so an unknown toast kind would render
// as a bare box with a stray class.
tote.onWorkspacesSwept((list) => {
  toast('Swept ' + list.length + ' stale temp space(s): ' + list.map((w) => w.name).join(', '), 'success');
});

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
  renderGroupBar();
  // The watcher only ever binds the ACTIVE space's root, so doc panes in a
  // space that was in the background catch up the moment it comes forward.
  recheckDocs();
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
      icon.textContent = n.kind === 'image' ? '▣' : n.kind === 'pdf' ? '❐'
        : n.kind === 'binary' ? '•' : '≡';
      row.onclick = (e) => openFile(n, e);
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

const REVEAL_LABEL = navigator.platform.startsWith('Mac') ? 'Reveal in Finder'
  : navigator.platform.startsWith('Win') ? 'Show in Explorer'
  : 'Show in file manager';

function showContextMenu(x, y, node) {
  const menu = $('#context-menu');
  menu.innerHTML = '';
  const parentDir = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '.';

  if (node.type === 'file') {
    menu.appendChild(ctxItem('Open', () => openFile(node)));
    if (node.kind !== 'binary') {
      menu.appendChild(ctxItem('Open in new pane', () => openDoc(node.path, { newPane: true })));
    }
    menu.appendChild(ctxItem('Open externally', () => tote.openPath(node.path)));
    menu.appendChild(ctxItem(REVEAL_LABEL, () => tote.revealPath(node.path)));
    menu.appendChild(ctxItem('Send to active tab (experimental)', () => sendToTab(node.path)));
    menu.appendChild(ctxItem('Copy path', () => navigator.clipboard.writeText(node.path)));
  } else {
    menu.appendChild(ctxItem('New file here', () => newFile(node.path)));
    menu.appendChild(ctxItem('New folder here', () => newFolder(node.path)));
    menu.appendChild(ctxItem('Open externally', () => tote.openPath(node.path)));
    menu.appendChild(ctxItem(REVEAL_LABEL, () => tote.revealPath(node.path)));
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

/* ---------------- doc panes ---------------- */
/* A file is a pane, not a modal. The leaf kind is 'doc' and its ref is an
 * INSTANCE id, never a path: clicking another file retargets the pane you are
 * already looking at, so the tree is never edited, focus does not churn and the
 * split ratio you dragged survives. Instances live per space in views.json
 * beside `tabs`; only { id, path, mode } is persisted -- an unsaved buffer
 * never reaches disk.
 *
 * Which kind a file is (text, md, image, pdf, binary) is decided in main, so
 * the tree node and readDoc can never disagree about it. */

function wsDocs(wsId = state.workspaces.active) {
  const V = wsViews(wsId);
  if (!V.docs) V.docs = [];
  return V.docs;
}
const docOf = (id) => wsDocs().find((d) => d.id === id);
const docPane = (id) => panes.get('doc:' + id);
const docState = (id) => state.docs.get(id);
// Only a doc that carries text can be dirty; an image or a PDF never is.
function isDirty(id) {
  const st = state.docs.get(id);
  return !!(st && st.savedText != null && st.text !== st.savedText);
}

// A file the pane cannot show goes to the system app, as it always has.
async function openFile(node, e) {
  if (!node || node.type !== 'file') return;
  if (node.kind === 'binary') { tote.openPath(node.path); return; }
  await openDoc(node.path, { newPane: !!(e && (e.metaKey || e.ctrlKey)) });
}

// The single entry point for showing a file in a pane.
async function openDoc(rel, { newPane = false } = {}) {
  const S = tiles();
  const open = T.leaves(S.tree).filter((l) => l.kind === 'doc');
  const same = open.find((l) => (docOf(l.ref) || {}).path === rel);
  if (same) { focusPane(same.id); return; }

  const target = newPane ? null : (open.find((l) => l.id === S.focus) || lastDocLeaf(open));
  if (target) return retargetDoc(target, rel);

  const doc = { id: newId('d'), path: rel, mode: 'view' };
  wsDocs().push(doc);
  const leaf = openPane(T.leaf(newLeafId(), 'doc', doc.id));  // -> mountLeaf -> loadDoc
  noteDocFocus(leaf.id);
}

// The most recently focused doc pane still in this tree: the one a plain click
// retargets when focus is somewhere else entirely, like a terminal.
function lastDocLeaf(open) {
  for (let i = state.docOrder.length - 1; i >= 0; i--) {
    const hit = open.find((l) => l.id === state.docOrder[i]);
    if (hit) return hit;
  }
  return open[0] || null;
}

function noteDocFocus(leafId) {
  state.docOrder = state.docOrder.filter((x) => x !== leafId);
  state.docOrder.push(leafId);
}

// Point an existing pane at another file. The pane element stays exactly where
// it is -- this is the whole reason a doc ref is an instance and not a path.
async function retargetDoc(leaf, rel) {
  const doc = docOf(leaf.ref);
  if (!doc) return;
  if (isDirty(doc.id) && !confirm('"' + doc.path + '" has unsaved changes.\nDiscard them?')) return;
  doc.path = rel;
  doc.mode = 'view';
  state.docs.delete(doc.id);
  focusPane(leaf.id);
  noteDocFocus(leaf.id);
  await loadDoc(doc.id);
  saveViews();
}

async function loadDoc(id) {
  const doc = docOf(id);
  const p = docPane(id);
  if (!doc || !p) return;
  p.title.textContent = doc.path;
  p.el.title = doc.path;

  const wanted = doc.path;
  let res;
  try {
    res = await tote.readDoc(wanted);
  } catch (err) {
    res = { kind: 'text', error: err.message || String(err) };
  }
  // Two fast clicks start two reads. Whichever returns second must not win if
  // the pane has already been pointed somewhere else.
  if (!docOf(id) || docOf(id).path !== wanted) return;
  state.docs.set(id, {
    path: doc.path,
    kind: res.kind,
    text: res.text == null ? '' : res.text,
    savedText: res.text == null ? null : res.text,
    dataUrl: res.dataUrl || null,
    fileUrl: res.fileUrl || null,
    mtimeMs: res.mtimeMs,
    size: res.size,
    error: res.error || null,
    stale: false,
  });
  renderDocBody(id);
}

// Rebuild the pane's BODY. The pane element itself is never touched, never
// replaced and never reparented.
function renderDocBody(id) {
  const doc = docOf(id), st = docState(id), p = docPane(id);
  if (!doc || !st || !p) return;
  p.body.textContent = '';
  p.body.classList.remove('has-stale');   // the bar's element went with textContent
  renderDocControls(id);
  updateDocHead(id);
  if (st.error) { p.body.appendChild(docErrorEl(doc.path, st.error)); return; }
  if (st.kind === 'md' && doc.mode !== 'src') {
    p.body.appendChild(docMarkdownEl(id));
    return;
  }
  if (st.kind === 'image' && doc.mode !== 'src') {
    p.body.appendChild(docImageEl(id));
    return;
  }
  if (st.kind === 'pdf') {
    p.body.appendChild(docPdfEl(id));
    return;
  }
  p.body.appendChild(docSourceEl(id));
}

function docImageEl(id) {
  const wrap = document.createElement('div');
  wrap.className = 'doc-image';
  const img = document.createElement('img');
  img.src = docState(id).dataUrl || '';
  img.alt = docOf(id).path;
  wrap.appendChild(img);
  return wrap;
}

// Electron renders a PDF with Chromium's own viewer. A webview is out of
// process, so the host CSP does not apply to it and the file needs no copy --
// readDoc hands over a file:// URL rather than 25 MB of base64.
function docPdfEl(id) {
  const wv = document.createElement('webview');
  wv.className = 'doc-pdf';
  wv.setAttribute('plugins', '');          // the PDF viewer is one
  wv.setAttribute('src', docState(id).fileUrl || '');
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || !e.isMainFrame) return;   // -3 = ABORTED, normal
    const p = docPane(id), doc = docOf(id);
    if (!p || !doc) return;
    p.body.textContent = '';
    p.body.appendChild(docErrorEl(doc.path, 'This PDF could not be shown in a pane.'));
  });
  return wv;
}

// Two kinds have both a rendered and an editable face: markdown, and SVG --
// which readDoc hands back as an image that also carries its own source.
const docHasModes = (id) => {
  const st = docState(id);
  return !!st && (st.kind === 'md' || (st.kind === 'image' && st.savedText != null));
};

function renderDocControls(id) {
  const p = docPane(id), doc = docOf(id);
  if (!p) return;
  p.ctrls.textContent = '';
  if (!doc || !docHasModes(id) || docState(id).error) return;
  for (const m of ['src', 'view']) {
    const b = document.createElement('span');
    b.className = 'pane-mode' + (doc.mode === m ? ' on' : '');
    b.textContent = m;
    b.onclick = (e) => { e.stopPropagation(); setDocMode(id, m); };
    p.ctrls.appendChild(b);
  }
}

function setDocMode(id, mode) {
  const doc = docOf(id);
  if (!doc || !docHasModes(id) || doc.mode === mode) return;
  doc.mode = mode;
  renderDocBody(id);
  saveViews();
}

function docMarkdownEl(id) {
  const box = document.createElement('div');
  box.className = 'doc-view';
  box.appendChild(renderBlocks(Markdown.parse(docState(id).text), docOf(id).path));
  return box;
}

/* ----- markdown tokens -> DOM -----
 * createElement only. Nothing here ever assigns innerHTML, which is what makes
 * the parser's "raw HTML stays literal text" rule actually hold in the page. */

function renderBlocks(blocks, rel) {
  const frag = document.createDocumentFragment();
  for (const b of blocks) frag.appendChild(blockEl(b, rel));
  return frag;
}

function blockEl(b, rel) {
  if (b.type === 'heading') {
    const h = document.createElement('h' + b.level);
    h.appendChild(renderSpans(b.spans, rel));
    return h;
  }
  if (b.type === 'paragraph') {
    const p = document.createElement('p');
    p.appendChild(renderSpans(b.spans, rel));
    return p;
  }
  if (b.type === 'hr') return document.createElement('hr');
  if (b.type === 'code') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (b.lang) code.dataset.lang = b.lang;
    code.textContent = b.text;
    pre.appendChild(code);
    return pre;
  }
  if (b.type === 'quote') {
    const q = document.createElement('blockquote');
    q.appendChild(renderBlocks(b.blocks, rel));
    return q;
  }
  if (b.type === 'list') {
    const list = document.createElement(b.ordered ? 'ol' : 'ul');
    if (b.ordered && b.start !== 1) list.start = b.start;
    for (const item of b.items) {
      const li = document.createElement('li');
      if (item.checked !== null) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = item.checked;
        box.disabled = true;               // a rendered doc is not a form
        li.className = 'task';
        li.appendChild(box);
      }
      li.appendChild(renderSpans(item.spans, rel));
      if (item.blocks) li.appendChild(renderBlocks(item.blocks, rel));
      list.appendChild(li);
    }
    return list;
  }
  if (b.type === 'table') {
    const wrap = document.createElement('div');
    wrap.className = 'doc-table';         // its own scroller: the pane must not scroll sideways
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    b.head.forEach((cell, i) => hrow.appendChild(cellEl('th', cell, b.align[i], rel)));
    thead.appendChild(hrow);
    const tbody = document.createElement('tbody');
    for (const row of b.rows) {
      const tr = document.createElement('tr');
      row.forEach((cell, i) => tr.appendChild(cellEl('td', cell, b.align[i], rel)));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    return wrap;
  }
  return document.createTextNode('');
}

function cellEl(tag, spans, align, rel) {
  const el = document.createElement(tag);
  if (align) el.style.textAlign = align;
  el.appendChild(renderSpans(spans, rel));
  return el;
}

function renderSpans(spans, rel) {
  const frag = document.createDocumentFragment();
  for (const sp of spans || []) {
    if (sp.type === 'text') { frag.appendChild(document.createTextNode(sp.text)); continue; }
    if (sp.type === 'code') {
      const c = document.createElement('code');
      c.textContent = sp.text;
      frag.appendChild(c);
      continue;
    }
    if (sp.type === 'image') { frag.appendChild(mdImageEl(sp, rel)); continue; }
    if (sp.type === 'link') { frag.appendChild(mdLinkEl(sp, rel)); continue; }
    const el = document.createElement(sp.type === 'strong' ? 'strong' : sp.type === 'em' ? 'em' : 's');
    el.appendChild(renderSpans(sp.spans, rel));
    frag.appendChild(el);
  }
  return frag;
}

// The parser already rejected every scheme but http(s) and mailto, so a link is
// either external or a path inside this space -- which opens in a pane.
function mdLinkEl(sp, rel) {
  const a = document.createElement('a');
  a.href = '#';
  a.title = sp.href;
  a.appendChild(renderSpans(sp.spans, rel));
  a.onclick = (e) => {
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(sp.href)) { tote.openExternal(sp.href); return; }
    const target = resolveRel(rel, sp.href.split('#')[0]);
    if (target) openDoc(target);
  };
  return a;
}

// A relative image is fetched through readDoc, so resolveSafe still guards it
// and the CSP needs no file: relaxation. http(s) sources load directly.
function mdImageEl(sp, rel) {
  const img = document.createElement('img');
  img.className = 'doc-md-img';
  img.alt = sp.alt || '';
  if (/^https?:/i.test(sp.src)) { img.src = sp.src; return img; }
  const target = resolveRel(rel, sp.src);
  if (target) {
    tote.readDoc(target)
      .then((d) => { if (d && d.dataUrl) img.src = d.dataUrl; })
      .catch(() => {});
  }
  return img;
}

// Join a link against the doc's own folder, keeping the result relative to the
// space root. resolveSafe in main is still the guard; this only builds the
// string it will check, and returns null rather than asking about an escape.
function resolveRel(fromRel, href) {
  if (!href) return null;
  const out = href.startsWith('/') ? [] : String(fromRel).split('/').slice(0, -1);
  for (const seg of href.replace(/^\//, '').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!out.length) return null; out.pop(); }
    else out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

function docSourceEl(id) {
  const st = docState(id);
  const ta = document.createElement('textarea');
  ta.className = 'doc-src';
  ta.spellcheck = false;
  ta.value = st.text;
  ta.addEventListener('input', () => { st.text = ta.value; updateDocHead(id); });
  return ta;
}

function docErrorEl(rel, message) {
  const box = document.createElement('div');
  box.className = 'doc-error';
  const msg = document.createElement('div');
  msg.textContent = message;
  const btn = document.createElement('button');
  btn.textContent = 'open externally';
  btn.onclick = () => tote.openPath(rel);
  box.append(msg, btn);
  return box;
}

// The dot in the pane head is the unsaved marker; the title stays the path.
function updateDocHead(id) {
  const p = docPane(id);
  if (!p) return;
  const dirty = isDirty(id);
  p.dot.style.display = dirty ? '' : 'none';
  p.dot.style.background = '#e0a33e';
  p.dot.title = dirty ? 'unsaved changes' : '';
  p.el.classList.toggle('doc-dirty', dirty);
}

async function saveDoc(id) {
  const doc = docOf(id), st = docState(id);
  if (!doc || !st || st.savedText == null) return;
  try {
    await tote.writeFile(doc.path, st.text);
    const wasGone = st.gone;
    st.savedText = st.text;
    st.stale = false;
    st.gone = false;
    updateDocHead(id);
    hideStale(id);
    if (wasGone) renderDocBody(id);
    else if (docHasModes(id) && doc.mode === 'src') setDocMode(id, 'view');
    toast('Saved ' + doc.path, 'success');
  } catch (e) {
    toast(e.message, 'error');   // the pane stays dirty
  }
}

/* ----- external change -----
 * The watcher ping carries no path, so every open doc re-reads its own file.
 * A save needs no suppression flag: afterwards the disk matches savedText, so
 * the tick it causes is a no-op. */

async function recheckDocs() {
  for (const doc of wsDocs()) {
    const st = docState(doc.id);
    if (!st || st.path !== doc.path) continue;   // never mounted, or mid-retarget

    let res;
    try {
      res = await tote.readDoc(doc.path);
    } catch {
      markDocGone(doc.id);
      continue;
    }
    if (st.gone) { state.docs.delete(doc.id); loadDoc(doc.id); continue; }  // it came back

    if (res.text == null) {                       // image, pdf, or an error state
      if (res.mtimeMs === st.mtimeMs && res.size === st.size) continue;
      state.docs.delete(doc.id);
      loadDoc(doc.id);
      continue;
    }
    if (res.text === st.savedText) { hideStale(doc.id); continue; }  // disk is unchanged

    if (isDirty(doc.id)) { showStale(doc.id); continue; }

    const top = docScrollTop(doc.id);
    Object.assign(st, {
      text: res.text, savedText: res.text, dataUrl: res.dataUrl || null,
      mtimeMs: res.mtimeMs, size: res.size, error: res.error || null,
    });
    renderDocBody(doc.id);
    docScrollTo(doc.id, top);
  }
}

const docScroller = (id) => {
  const p = docPane(id);
  return p ? p.body.querySelector('.doc-view, .doc-src, .doc-image') : null;
};
const docScrollTop = (id) => { const el = docScroller(id); return el ? el.scrollTop : 0; };
const docScrollTo = (id, top) => { const el = docScroller(id); if (el && top) el.scrollTop = top; };
const docLeafOf = (id) =>
  T.leaves(tiles().tree).find((l) => l.kind === 'doc' && l.ref === id) || null;

// Unsaved edits plus a changed file on disk is the one case that must not be
// resolved silently in either direction.
function showStale(id) {
  const p = docPane(id), st = docState(id);
  if (!p || !st || st.stale) return;            // "keep mine" already answered this
  if (p.body.querySelector('.doc-stale')) return;

  const bar = document.createElement('div');
  bar.className = 'doc-stale';
  const msg = document.createElement('span');
  msg.textContent = '⚠ changed on disk';
  const reload = document.createElement('button');
  reload.textContent = 'reload';
  reload.onclick = () => { state.docs.delete(id); loadDoc(id); };
  const keep = document.createElement('button');
  keep.textContent = 'keep mine';
  // Not just dismissing the bar: the next save is now allowed to overwrite the
  // newer file without asking again, which is what clicking this means.
  keep.onclick = () => { st.stale = true; hideStale(id); };
  bar.append(msg, reload, keep);
  p.body.insertBefore(bar, p.body.firstChild);
  p.body.classList.add('has-stale');
}

function hideStale(id) {
  const p = docPane(id);
  if (!p) return;
  const bar = p.body.querySelector('.doc-stale');
  if (bar) bar.remove();
  p.body.classList.remove('has-stale');
}

function markDocGone(id) {
  const st = docState(id), doc = docOf(id), p = docPane(id);
  if (!st || !doc || !p || st.gone) return;
  st.gone = true;
  p.body.textContent = '';
  p.body.classList.remove('has-stale');
  p.ctrls.textContent = '';
  p.body.appendChild(docGoneEl(id));
}

function docGoneEl(id) {
  const doc = docOf(id), st = docState(id);
  const box = document.createElement('div');
  box.className = 'doc-error';
  const msg = document.createElement('div');
  msg.textContent = doc.path + ' is no longer on disk.';
  const row = document.createElement('div');
  row.className = 'doc-error-row';
  if (st.savedText != null) {
    const write = document.createElement('button');
    write.textContent = isDirty(id) ? 'write my version back' : 'write it back';
    write.onclick = () => saveDoc(id);
    row.appendChild(write);
  }
  const close = document.createElement('button');
  close.textContent = 'close pane';
  close.onclick = () => { const leaf = docLeafOf(id); if (leaf) closePane(leaf.id); };
  row.append(close);
  box.append(msg, row);
  return box;
}

// Forget a doc instance. The pane element and the tree leaf are handled by
// closePane, which is the only caller -- the same contract closeTabInstance has.
function closeDocInstance(id) {
  const list = wsDocs();
  const i = list.findIndex((d) => d.id === id);
  if (i >= 0) list.splice(i, 1);
  state.docs.delete(id);
}

/* ---------------- files ---------------- */

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

/* A dropped file lands as its path, exactly as a native terminal does it:
 * shell-escaped, space-separated, and with NO trailing newline -- when to send
 * stays the agent's decision. */
const shellEscapePath = (p) => p.replace(/([\s"'`\\$&*()|[\]{}<>;?!#~])/g, '\\$1');

function acceptFileDrop(el, onPaths) {
  el.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer.types || [])].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drop-file');
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-file');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-file');
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    onPaths(files.map((f) => tote.filePath(f)).filter(Boolean));
  });
}

async function spawnTerm(profile) {
  const id = ++state.termSeq;
  const pane = paneShell('term:' + id, profile.name);

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

  // Keys Tote steals from the agent. A TUI owns every bare key, so both of these
  // ride on Shift, which Claude Code and Codex leave alone:
  //   Enter -- Shift+Enter must open a new line, not send the message. xterm emits
  //     a bare CR for Enter and Shift+Enter alike, so an agent TUI cannot tell them
  //     apart; we send LF (0x0a) instead -- the byte Ctrl+J produces, which is the
  //     newline every agent TUI accepts without a per-terminal setup step. ESC+CR
  //     was tried first and Claude Code now reads it as "escape, then send".
  //   Arrows/Home/End -- scroll the scrollback. A bare Up/Down is the agent's prompt
  //     history, so without this a long answer is only reachable with the wheel or
  //     Shift+PageUp (Fn+Shift+Up on a laptop). Shift+PageUp/PageDown stay xterm's
  //     own bindings. On the alternate screen (vim, less) there is no scrollback,
  //     so the key belongs to the app.
  const SCROLL = {
    ArrowUp: () => term.scrollLines(-1),
    ArrowDown: () => term.scrollLines(1),
    Home: () => term.scrollToTop(),
    End: () => term.scrollToBottom(),
  };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return true;
    if (e.key === 'Enter') {
      if (entry.ptyId) tote.ptyWrite(entry.ptyId, '\n');
      return false;
    }
    const scroll = SCROLL[e.key];
    if (!scroll || term.buffer.active.type === 'alternate') return true;
    e.preventDefault();
    scroll();
    return false;
  });

  // Drag an image onto Claude Code and it arrives as a path it can read. Without
  // this the drop falls through to Chromium, which navigates the window to the
  // file instead.
  acceptFileDrop(pane.el, (paths) => {
    if (!entry.ptyId || !paths.length) return;
    tote.ptyWrite(entry.ptyId, paths.map(shellEscapePath).join(' ') + ' ');
    term.focus();
  });

  // Place the pane first so it has real dimensions, then fit synchronously: the
  // PTY must be created at the true size, not 80x24.
  openPane(T.leaf(newLeafId(), 'term', id));
  if (fit) { try { fit.fit(); } catch {} }

  try {
    const res = await tote.ptySpawn(profile.id, term.cols || 80, term.rows || 24);
    entry.ptyId = res.id;
    entry.alive = true;
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
  const owner = groupsOf(V).find((g) =>
    T.leaves(g.tree).some((l) => l.kind === 'term' && l.ref === id));
  const lf = owner && T.leaves(owner.tree).find((l) => l.kind === 'term' && l.ref === id);
  if (lf && t.wsId === state.workspaces.active && owner.id === V.activeGroup) {
    closePane(lf.id);
    return;
  }
  if (lf) owner.tree = T.removeLeaf(owner.tree, lf.id);
  if (t.alive) tote.ptyKill(t.ptyId);
  destroyPaneEl('term:' + id);
  state.terms.delete(id);
  renderGroupBar();
  saveViews();
}

tote.onPtyData((ptyId, data) => {
  for (const t of state.terms.values()) {
    if (t.ptyId === ptyId) {
      t.term.write(data);
      return;
    }
  }
  if (wizTerm && ptyId === wizTermPty) {
    wizTerm.write(data);
    // Buffer for the post-exit npm diagnostics; warnings sit at the tail, so
    // keeping only the newest chunk is safe if an install gets chatty.
    wizBuf = (wizBuf + data).slice(-131072);
  }
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
let groupSeq = 0;
const newGroupId = () => 'G' + (++groupSeq);

// Every group of every space, including a not-yet-migrated single tiling.
const groupsOf = (V) => (V ? (V.groups || (V.tiling ? [V.tiling] : [])) : []);

// Persisted ids must not be handed out again after a restart.
function adoptLeafSeq(all) {
  for (const V of Object.values(all || {})) {
    for (const g of groupsOf(V)) {
      for (const lf of T.leaves(g.tree)) {
        const n = parseInt(String(lf.id).slice(1), 10);
        if (n > leafSeq) leafSeq = n;
        // Terminal leaves reference a per-run counter. Without adopting it too,
        // the first terminal of the next run takes a number some other space's
        // stale leaf still points at, and that space mounts this terminal.
        if (lf.kind === 'term' && +lf.ref > state.termSeq) state.termSeq = +lf.ref;
      }
      const gn = parseInt(String(g.id || '').slice(1), 10);
      if (gn > groupSeq) groupSeq = gn;
    }
  }
}

/* Groups are the space's virtual desktops: each holds its own tiling tree, and
 * switching brings one tree to the front. Panes in the other groups stay alive
 * and hidden -- exactly how another space's panes behave -- because applyTiles
 * hides every pane that is not a leaf of the tree being applied. */
function groups() {
  const V = wsViews();
  if (!V.groups) {
    let base = V.tiling;
    if (!base) {
      const m = T.migrate(
        { tabs: V.tabs || [], active: V.active, layout: V.layout || state.settings.layout || {} },
        newLeafId, { w: innerWidth || 1400, h: innerHeight || 800 });
      base = { tree: m.tree, focus: m.focus, zoom: null };
      delete V.layout;
    }
    delete V.tiling;
    V.groups = [{ id: newGroupId(), name: '1', tree: base.tree, focus: base.focus, zoom: base.zoom || null }];
  }
  if (!V.groups.length) V.groups.push({ id: newGroupId(), name: '1', tree: null, focus: null, zoom: null });
  if (!V.groups.some((g) => g.id === V.activeGroup)) V.activeGroup = V.groups[0].id;
  return V.groups;
}

// The active group's tiling state. Everything below edits this and nothing else,
// so the tree code never has to know groups exist.
function tiles() {
  const gs = groups();
  const active = wsViews().activeGroup;
  return gs.find((g) => g.id === active) || gs[0];
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
  const ctrls = document.createElement('span');
  ctrls.className = 'pane-ctrls';       // per-kind head controls; empty for most panes
  const x = document.createElement('span');
  x.className = 'pane-x';
  x.textContent = '✕';
  x.title = 'Close pane';
  head.append(dot, title, ctrls, x);
  const body = document.createElement('div');
  body.className = 'pane-body';
  el.append(head, body);
  $('#tiles').appendChild(el);

  p = { el, head, body, title, dot, ctrls, key };
  panes.set(key, p);

  el.addEventListener('mousedown', () => { if (el.dataset.leaf) focusPane(el.dataset.leaf); }, true);
  x.onclick = (e) => { e.stopPropagation(); if (el.dataset.leaf) closePane(el.dataset.leaf); };
  head.addEventListener('mousedown', (e) => {
    if (e.target === x || (e.target.closest && e.target.closest('.pane-ctrls'))) return;
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
  if (lf.kind === 'doc') {
    const doc = (wsViews().docs || []).find((d) => d.id === lf.ref);
    if (!doc) return null;                       // stale leaf from a previous run
    const p = paneShell(key, doc.path);
    if (!state.docs.has(doc.id)) loadDoc(doc.id);  // first showing: read from disk
    return p;
  }
  if (lf.kind === 'term') {
    // A terminal belongs to the space that spawned it, the way a web leaf must
    // name a tab of this space. Anything else -- a dead ref, or a leaf pointing
    // at another space's agent -- is pruned by returning null.
    const t = [...state.terms.values()].find((x) => x.localId === lf.ref || x.ptyId === lf.ref);
    if (!t || t.wsId !== state.workspaces.active) return null;
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
  if (lf && lf.kind === 'doc') noteDocFocus(leafId);
  saveViews();
}

/* The files tree is a DOCK, not a tile: it takes the whole left edge whatever
 * else is open, and comes back at the width it had when it was closed. The
 * width is remembered per space so it survives group and app restarts. */
const FILES_DEFAULT_PX = 270, FILES_MIN_RATIO = 0.1, FILES_MAX_RATIO = 0.6;

function filesRatio() {
  const V = wsViews();
  const host = hostRect();
  const want = typeof V.filesRatio === 'number'
    ? V.filesRatio
    : (host.w ? FILES_DEFAULT_PX / host.w : 0.2);
  return Math.max(FILES_MIN_RATIO, Math.min(FILES_MAX_RATIO, want));
}

// Called before the leaf leaves the tree, while it still has a rect. A sole
// pane fills the host and says nothing about the dock width, so keep the old one.
function rememberFilesRatio(leafId) {
  const S = tiles();
  const host = hostRect();
  if (!host.w || !S.tree || S.tree.type === 'leaf') return;
  const r = T.rectsFor(S.tree, host, { gutter: GUTTER }).get(leafId);
  if (r) wsViews().filesRatio = r.w / host.w;
}

function openFilesPane() {
  const S = tiles();
  const node = T.leaf(newLeafId(), 'files');
  const had = T.leaves(S.tree).length;
  S.tree = T.insertRoot(S.tree, node, 'left', filesRatio());
  // A dock does not steal focus: whatever you were working in stays focused, so
  // the next pane you open still splits the content area and not the sidebar.
  if (!had) S.focus = node.id;
  S.zoom = null;
  applyTiles();
  renderGroupBar();
  saveViews();
  return node;
}

/* Which pane gets split. The focused one -- except the files dock, which would
 * wedge a web view or a terminal into a sidebar-width column. */
function splitTarget(S) {
  const live = T.leaves(S.tree);
  const focused = S.focus ? T.findLeaf(S.tree, S.focus) : null;
  const content = live.filter((l) => l.kind !== 'files');
  if (focused && (focused.kind !== 'files' || !content.length)) return focused.id;
  return (content[0] || live[0]).id;
}

// Opening a pane splits the focused one along its longer axis (dwindle).
function openPane(node) {
  const S = tiles();
  if (!S.tree) {
    S.tree = node;
  } else if (node.kind !== 'files' && !T.leaves(S.tree).some((l) => l.kind !== 'files')) {
    // Only the dock is open: the first content pane takes the rest of the width
    // instead of cutting the sidebar in half.
    S.tree = T.insertRoot(S.tree, node, 'right', 1 - filesRatio());
  } else {
    const rects = T.rectsFor(S.tree, hostRect(), { gutter: GUTTER });
    const target = splitTarget(S);
    S.tree = T.splitLeaf(S.tree, target, node, T.dirFor(rects.get(target) || hostRect()));
  }
  S.focus = node.id;
  S.zoom = null;
  applyTiles();
  renderGroupBar();
  saveViews();
  return node;
}

function closePane(leafId) {
  const S = tiles();
  const lf = T.findLeaf(S.tree, leafId);
  if (!lf) return;
  if (lf.kind === 'doc' && isDirty(lf.ref)) {
    const doc = docOf(lf.ref);
    if (!confirm('"' + (doc ? doc.path : '') + '" has unsaved changes.\nClose anyway?')) return;
  }
  if (lf.kind === 'files') rememberFilesRatio(leafId);
  S.tree = T.removeLeaf(S.tree, leafId);
  if (S.zoom === leafId) S.zoom = null;
  // tear down the instance behind the pane
  if (lf.kind === 'web') { destroyPaneEl(paneKey(lf)); closeTabInstance(lf.ref); }
  else if (lf.kind === 'term') { killTermByRef(lf.ref); destroyPaneEl(paneKey(lf)); }
  else if (lf.kind === 'doc') { destroyPaneEl(paneKey(lf)); closeDocInstance(lf.ref); }
  else { const p = panes.get('files'); if (p) p.el.classList.add('hidden'); }
  applyTiles();
  renderGroupBar();
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

/* ----- groups: the space's virtual desktops ----- */

// Lowest unused integer, so closing group 2 of 3 frees the name "2".
function nextGroupName(gs) {
  const taken = new Set(gs.map((g) => g.name));
  for (let i = 1; ; i++) if (!taken.has(String(i))) return String(i);
}

function renderGroupBar() {
  const host = $('#group-tabs');
  host.innerHTML = '';
  const V = wsViews();
  const gs = groups();
  for (const g of gs) {
    const chip = document.createElement('button');
    chip.className = 'group-chip' + (g.id === V.activeGroup ? ' active' : '');
    chip.textContent = g.name;
    const count = T.leaves(g.tree).length;
    chip.title = count ? g.name + ' — ' + count + ' pane(s)' : g.name + ' — empty';
    if (count) chip.appendChild(Object.assign(document.createElement('i'), { className: 'group-dot' }));
    chip.onclick = () => switchGroup(g.id);
    chip.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      const menu = $('#context-menu');
      menu.innerHTML = '';
      menu.appendChild(ctxItem('switch here', () => switchGroup(g.id)));
      menu.appendChild(ctxItem('rename…', () => renameGroup(g)));
      if (gs.length > 1) menu.appendChild(ctxItem('close group', () => closeGroup(g.id), true));
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      menu.classList.remove('hidden');
    };
    host.appendChild(chip);
  }
}

// Bring a group's tree to the front. Nothing is torn down: the other groups'
// webviews and PTYs keep running behind the applied tree.
function switchGroup(id) {
  const V = wsViews();
  if (V.activeGroup === id) return;
  V.activeGroup = id;
  applyTiles();
  renderGroupBar();
  focusActivePaneContent();
  saveViews();
}

function addGroup() {
  const V = wsViews();
  const gs = groups();
  const g = { id: newGroupId(), name: nextGroupName(gs), tree: null, focus: null, zoom: null };
  gs.push(g);
  V.activeGroup = g.id;
  applyTiles();
  renderGroupBar();
  saveViews();
}

async function renameGroup(g) {
  const name = await askInput('Rename group', g.name);
  if (!name || name === g.name) return;
  g.name = name;
  renderGroupBar();
  saveViews();
}

// Closing a group closes its panes through the one teardown path, so webviews
// and PTYs go with it instead of leaking as unreachable instances.
function closeGroup(id) {
  const V = wsViews();
  const gs = groups();
  if (gs.length < 2) { toast('A space keeps at least one group.', 'error'); return; }
  const idx = gs.findIndex((g) => g.id === id);
  if (idx < 0) return;
  const doomed = gs[idx];
  const leaves = T.leaves(doomed.tree);
  if (leaves.length && !confirm(`Close group "${doomed.name}" and its ${leaves.length} pane(s)?`)) return;

  const wasActive = V.activeGroup;
  V.activeGroup = id;                       // closePane always edits the ACTIVE group
  for (const lf of leaves) closePane(lf.id);
  gs.splice(idx, 1);
  V.activeGroup = wasActive !== id && gs.some((g) => g.id === wasActive)
    ? wasActive
    : gs[Math.min(idx, gs.length - 1)].id;
  applyTiles();
  renderGroupBar();
  focusActivePaneContent();
  saveViews();
}

function focusActivePaneContent() {
  const S = tiles();
  const lf = S.focus && T.findLeaf(S.tree, S.focus);
  if (!lf || lf.kind !== 'term') return;
  const t = [...state.terms.values()].find((x) => x.ptyId === lf.ref || x.localId === lf.ref);
  if (t) t.term.focus();
}

$('#btn-add-group').onclick = addGroup;

/* ----- toolbar + keyboard ----- */

$('#btn-files').onclick = () => {
  const S = tiles();
  const existing = T.leaves(S.tree).find((l) => l.kind === 'files');
  if (existing) closePane(existing.id);
  else openFilesPane();
};

const MOD = (e) => (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && e.altKey;
const ARROW = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

// The focused pane's doc, if it is one -- what Cmd+S and MOD+E act on.
function focusedDoc() {
  const S = tiles();
  const lf = S.focus ? T.findLeaf(S.tree, S.focus) : null;
  if (!lf || lf.kind !== 'doc') return null;
  const doc = docOf(lf.ref);
  return doc && state.docs.has(doc.id) ? doc : null;
}

addEventListener('keydown', (e) => {
  // Plain Cmd/Ctrl+S. A new modifier shape in this listener -- MOD is Cmd+Alt
  // for pane keys -- but nothing else in Tote has anything to save.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
    const doc = focusedDoc();
    if (doc) { e.preventDefault(); saveDoc(doc.id); return; }
  }
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
  if (e.key >= '1' && e.key <= '9') {          // switch group, like OS desktops
    e.preventDefault();
    const g = groups()[+e.key - 1];
    if (g) switchGroup(g.id);
    return;
  }
  if (e.key === 'e' || e.key === 'E') {        // flip a markdown or SVG pane
    const doc = focusedDoc();
    if (doc && docHasModes(doc.id)) {
      e.preventDefault();
      setDocMode(doc.id, doc.mode === 'src' ? 'view' : 'src');
      return;
    }
  }
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleZoom(); }
  if (e.key === 'w' || e.key === 'W') { e.preventDefault(); if (S.focus) closePane(S.focus); }
});

// Anywhere else, a dropped file is swallowed: letting it through means Chromium
// navigates away from the app.
addEventListener('dragover', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
addEventListener('drop', (e) => e.preventDefault());

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
let wizBuf = ''; // output of the current install run, for npm diagnostics

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

// One install run in the wizard terminal; resolves with the run's output when
// the process exits, so the caller can look at what npm said.
function wizRunOnce(term, cmdline) {
  return new Promise((resolve, reject) => {
    term.writeln('\x1b[36m$ ' + cmdline + '\x1b[0m');
    tote.ptyRun(cmdline).then(({ id }) => {
      wizBuf = '';
      wizTermPty = id;
      wizOnExit = (ptyId) => {
        if (ptyId !== id) return;
        wizOnExit = null;
        wizTermPty = null;
        resolve(wizBuf);
      };
    }, reject);
  });
}

// Self-healing install: run the profile's install command, and when npm hits
// one of the two failures we can mend, mend it and re-run — each mend at most
// once, so the loop is bounded at three runs. Both detectors are npm-specific,
// so non-npm installers pass straight through.
async function runWizardInstall(profile, btn) {
  const term = ensureWizTerm();
  const note = (msg) => term.writeln('\x1b[33m' + msg + '\x1b[0m');
  btn.disabled = true;
  btn.textContent = 'installing…';
  try {
    let cmd = profile.install;
    let triedPrefix = false;
    let triedScripts = false;
    for (;;) {
      const out = await wizRunOnce(term, cmd);
      // A root-owned global prefix (distro npm) fails before anything installs.
      if (!triedPrefix && NpmFix.eacces(out)) {
        triedPrefix = true;
        const fix = await tote.fixNpmPrefix();
        if (fix.fixed) {
          note("npm's global folder isn't writable — set npm's prefix to " + fix.prefix + ' (in ~/.npmrc) and retrying.');
          continue;
        }
        note("npm's global folder isn't writable (" + fix.reason + ').');
        note('Fix once with: npm config set prefix ~/.local — then install again.');
        break;
      }
      // npm >= 12 blocks dependency install scripts, which silently skips
      // native builds; it names the exact flag that allows them.
      const pkgs = triedScripts ? null : NpmFix.blockedScripts(out);
      if (pkgs) {
        triedScripts = true;
        note('npm blocked install scripts for ' + pkgs + ' — re-running with them allowed.');
        cmd = profile.install + ' --allow-scripts=' + pkgs;
        continue;
      }
      break;
    }
  } catch (e) {
    term.writeln('\x1b[31m' + e.message + '\x1b[0m');
  }
  term.writeln('\x1b[90m[install process finished]\x1b[0m');
  const ok = await tote.checkCommand(profile.command);
  btn.textContent = ok ? 'installed' : 'install';
  btn.disabled = ok;
  if (!ok) term.writeln('\x1b[33m"' + profile.command + '" still not on PATH — check output above.\x1b[0m');
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
tote.onWorkspaceChanged(() => { refreshTree(); recheckDocs(); });

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
