import { version } from '../package.json';
import { Terminal } from '@xterm/xterm';
import { App } from '@capacitor/app';
import { renderTerminalReading, TERMINAL_THEME } from './reading.js';
import { createNavigation } from './navigation.js';
import { ComputerSearch } from './discovery.js';
import { DeviceClient } from './client.js';
import { Native, Updater, Speech, Discovery, Browser, initNative, socketFactory } from './native.js';
import { webUrl } from './web.js';
import RemoteWeb from '../../src/renderer/remoteWeb.js';
import { tailnetAddress, portNumber, workspaceGroups, chooseSelection, draftKey } from './model.js';
import TermReports from '../../src/renderer/termreports.js';
import Updates from '../../src/shared/updates.js';
import lockUpdateEditing from '../../src/shared/updateLock.js';
import Diagnostics from '../../src/shared/diagnostics.js';
import TermStream from '../../src/renderer/termstream.js';

let webProviders = [], sharedPane;
const providerFor = id => webProviders.find(p => p.id === id);
const diagnosticLog = Diagnostics.createLog(), diagnosticCache = new Map(), hostVersions = new Map();
const $ = id => document.getElementById(id);
$('build-version').textContent = 'Android ' + version;
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { notify('Phone storage is full. Preferences could not be saved.'); } };
let devices = load('tote.devices', []), selectedDevice = null, client = null;
let spaces = [];
let wsId = null, views = {}, sessions = [], groups = [], group = null, pane = null;
let selection = load('tote.selection', {}), drafts = new Map();
const sending = new Set(); // Terminal drafts stay in memory, never on the host.
const closing = new Set();
const accessPending = new Set();
let sizeController = null, observationConfirmed = false;
const closedTerminals = new Set(load('tote.closedTerminals', []));
let spaceEpoch = 0;
let connectionEpoch = 0, paneEpoch = 0, refreshEpoch = 0, reconnectTimer, retry = 0, paused = false, busy = false, attached = null;
let lastOutputTop = 0, readingTimer;
let wrapped = load('tote.wrapText', true);
let hostSizeSync = false;
let term = null, termStream = null, terminalSession = null, ready = false, polling, refreshTimer, messageTimer;
let discoveryInitialized = false, scanning = false, pendingProbes = 0, activeScan = null, discoveryTimer;
const availability = new Map();
const search = new ComputerSearch({ socketFactory,
  onVerified: found => {
    const previous = devices.find(d => d.address === found.address && d.port === found.port);
    const device = { ...found, id:previous?.id || crypto.randomUUID() };
    devices = [...devices.filter(d => d.id !== device.id), device];
    availability.set(device.id, 'Ready'); save('tote.devices', devices); renderDevices(); discoveryStatus();
  },
  onUnavailable: candidate => {
    const old = devices.find(d => d.address === candidate.address && d.port === candidate.port);
    if (old) { availability.set(old.id, 'Unavailable · check Tailscale and sharing'); renderDevices(); }
  },
  onProgress: pending => { pendingProbes = pending; discoveryStatus(); },
});
function discoveryStatus() {
  const readyCount = devices.filter(d => availability.get(d.id) === 'Ready').length;
  $('discovery-status').textContent = scanning || pendingProbes
    ? 'Finding your computers…'
    : readyCount ? readyCount + (readyCount === 1 ? ' computer ready. Tap to connect.' : ' computers ready. Tap to connect.')
    : devices.length ? 'No computers reachable right now. Check Tailscale and desktop sharing.'
    : 'No computers found yet. Check the steps below, then tap Find.';
  $('scan').disabled = scanning;
}
async function findComputers() {
  clearTimeout(discoveryTimer);
  if (!discoveryInitialized || paused || selectedDevice) return;
  activeScan = null; await Discovery.stop().catch(() => {});
  if (paused || selectedDevice) return;
  activeScan = crypto.randomUUID(); search.reset(); availability.clear(); scanning = true; discoveryStatus();
  for (const device of devices) { availability.set(device.id, 'Checking…'); search.add(device); }
  renderDevices();
  try { await Discovery.start({ id:activeScan }); }
  catch (e) { scanning = false; discoveryStatus(); notify(e.message); }
}
function stopSearch() { clearTimeout(discoveryTimer); activeScan = null; scanning = false; search.reset(); if (discoveryInitialized) Discovery.stop().catch(() => {}); discoveryStatus(); }
async function learnComputers(c) {
  try {
    const peers = await c.call('device:peers');
    if (c !== client || !Array.isArray(peers)) return;
    for (const peer of peers.slice(0,64)) search.add(peer);
  } catch { /* Older hosts can still serve terminals without peer discovery. */ }
}
$('scan').onclick = findComputers;
$('open-tailscale').onclick = () => Discovery.openTailscale().catch(e => notify(e.message));
const selectionKey = () => JSON.stringify([selectedDevice?.id, wsId]);
const inputKey = () => draftKey(selectedDevice?.id, wsId, pane?.ref || pane?.id);
function notify(message) { diagnosticLog.add('terminal', message); $('notice').textContent = message; $('notice').hidden = false; clearTimeout(messageTimer); messageTimer = setTimeout(() => $('notice').hidden = true, 6500); }
function banner(message) { $('connection-banner').textContent = message; $('connection-banner').hidden = !message; }
function rememberDraft() { if (selectedDevice && pane?.kind === 'term') drafts.set(inputKey(), $('draft').value); }
function fitDraft() { const d = $('draft'); d.style.height = '44px'; d.style.height = Math.min(140, Math.max(44, d.scrollHeight + 2)) + 'px'; }
function observerKey() { return 'tote.observe.' + inputKey(); }
function inputBlocked() { return sessionStorage.getItem(observerKey()) === 'observe' || accessPending.has(inputKey()); }
function renderAccess() {
  const observing = sessionStorage.getItem(observerKey()) === 'observe';
  const supported = pane?.session?.accessControl === true;
  const label = $('terminal-access');
  label.hidden = !supported && !observing;
  const where = sizeController === 'this-viewer' ? 'size here'
    : sizeController === 'another-viewer' ? 'size elsewhere' : 'size unclaimed';
  const access = observing ? (observationConfirmed ? 'Read-only' : 'Input paused') : 'Shared input';
  label.textContent = observing && !supported ? 'Input paused · older host' : access + ' · ' + where;
  $('observe').hidden = !supported || (observing && observationConfirmed);
  $('take-control').hidden = !observing && (!supported || sizeController === 'this-viewer');
  $('take-control').textContent = !supported && observing ? 'Enable input on this viewer' : 'Take control';
  $('observe').disabled = $('take-control').disabled = !ready || busy || attached !== pane?.ref || accessPending.has(inputKey());
}
function controls() {
  renderAccess();
  const writable = ready && !busy && !inputBlocked() && !closing.has(inputKey()) && pane?.kind === 'term' && pane.session?.alive && attached === pane.ref;
  $('send').disabled = !writable || sending.has(inputKey()) || !$('draft').value.trim();
  document.querySelectorAll('[data-key]').forEach(b => b.disabled = !writable);
  renderNavigation();
  $('new-terminal').disabled = busy || !ready; $('fit').disabled = !writable;
  for (const id of ['close-terminal', 'close-terminal-menu']) {
    $(id).hidden = pane?.kind !== 'term';
    $(id).disabled = busy || !ready || (pane?.session && inputBlocked()) || closing.has(inputKey()) || sending.has(inputKey());
  }
  $('mic').disabled = pane?.kind !== 'term'; $('draft').disabled = pane?.kind !== 'term';
  fitDraft();
}
function options(id, values, selected) {
  const el = $(id);
  const unchanged = el.options.length === values.length && values.every((v, i) =>
    el.options[i].value === v.id && el.options[i].textContent === (v.name || v.title));
  if (!unchanged) el.replaceChildren(...values.map(v => {
    const o = document.createElement('option'); o.value = v.id; o.textContent = v.name || v.title; return o;
  }));
  if (selected != null && el.value !== selected) el.value = selected;
}
function renderDevices() {
  $('devices').replaceChildren();
  for (const d of devices) {
    const row = document.createElement('div'); row.className = 'device-row';
    const button = document.createElement('button'); button.className = 'connect'; button.textContent = d.name;
    const sub = document.createElement('small'); sub.textContent = availability.get(d.id) || 'Remembered computer'; button.append(sub); button.onclick = () => openDevice(d);
    const remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove ' + d.name);
    remove.onclick = () => { devices = devices.filter(x => x.id !== d.id); save('tote.devices', devices); renderDevices(); };
    row.append(button, remove); $('devices').append(row);
  }
}
$('add-device').onsubmit = e => {
  e.preventDefault();
  try {
    const address = tailnetAddress($('device-address').value), port = portNumber($('device-port').value);
    const existing = devices.find(d => d.address === address && d.port === port);
    const device = { id: existing?.id || crypto.randomUUID(), name: $('device-name').value.trim() || address, address, port };
    devices = [...devices.filter(d => d.id !== device.id), device]; save('tote.devices', devices); renderDevices(); openDevice(device);
  } catch (e) { notify(e.message); }
};
function stopConnection() {
  sharedPane?.dispose(); sharedPane = null; webProviders = [];
  connectionEpoch++; spaceEpoch++; refreshEpoch++; paneEpoch++; clearTimeout(reconnectTimer); clearInterval(polling);
  const old = client; client = null; ready = false; busy = false; attached = null; old?.close(); controls();
}
function openDevice(device) {
  $('version-notice').hidden = true;
  stopSearch(); rememberDraft(); stopConnection(); selectedDevice = device; wsId = null; group = null; pane = null; retry = 0;
  terminalSession = null; $('draft').value = ''; $('terminal-scroll').hidden = true; $('file-view').hidden = true; $('composer').hidden = true; $('keys').hidden = true;
  spaces = []; groups = []; renderNavigation(); showEmpty('Connecting to ' + device.name + '…');
  $('home').hidden = true; $('workspace').hidden = false; $('device-label').textContent = device.name;
  connect();
}
async function connect() {
  if (!selectedDevice || paused) return;
  stopConnection(); const epoch = connectionEpoch; const device = selectedDevice;
  let connectedAt = 0;
  banner(retry ? 'Reconnecting… Your sessions are still on the computer.' : 'Connecting…');
  const c = client = new DeviceClient({ socketFactory,
    onEvent: (event, payload) => { if (client === c) return hostEvent(event, payload); },
    onClose: error => {
      if (client !== c) return;
      if (connectedAt && Date.now() - connectedAt >= 30000) retry = 0;
      diagnosticLog.add('connection', error);
      ready = false; attached = null; controls(); clearInterval(polling); banner(error.message);
      scheduleReconnect();
    },
  });
  try {
    const hello = await c.connect(device.address, device.port);
    if (epoch !== connectionEpoch) return;
    $('version-notice').textContent = Updates.peer(hello, version).message;
    $('version-notice').hidden = !$('version-notice').textContent;
    hostVersions.set(device.id, Diagnostics.report({host:{version:hello.tote}}).host.version);
    const catalog = await c.call('web:providers').catch(() => []);
    if (epoch !== connectionEpoch) return;
    webProviders = Array.isArray(catalog) ? catalog : [];
    ready = true; connectedAt = Date.now(); await refresh(true);
    if (epoch !== connectionEpoch) return;
    banner(''); controls(); learnComputers(c); polling = setInterval(() => refresh().catch(e => notify(e.message)), 10000);
  } catch (e) { if (epoch === connectionEpoch) { banner(e.message); scheduleReconnect(); } }
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (paused || !selectedDevice) return;
  reconnectTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retry++, 4)));
}
async function refresh(forceAttach = false) {
  const c = client, epoch = connectionEpoch;
  if (!c?.ready || busy) return;
  const rev = ++refreshEpoch;
  const [registry, nextViews, nextSessions] = await Promise.all([c.call('workspaces:list'), c.call('views:get'), c.call('pty:list')]);
  if (epoch !== connectionEpoch || rev !== refreshEpoch) return;
  views = nextViews || {}; sessions = nextSessions || [];
  const preferred = selection[JSON.stringify([selectedDevice.id, 'space'])];
  const nextWs = registry.list.find(w => w.id === wsId)?.id || registry.list.find(w => w.id === preferred)?.id || registry.active;
  spaces = registry.list;
  if (nextWs !== wsId || forceAttach) { await changeSpace(nextWs, forceAttach); return; }
  await renderGroups(forceAttach);
}
async function changeSpace(id, force = false) {
  if (!client?.ready) return;
  rememberDraft(); refreshEpoch++; paneEpoch++; const token = ++spaceEpoch, c = client, epoch = connectionEpoch; busy = true; controls();
  $('terminal-scroll').hidden = true; $('file-view').hidden = true; $('composer').hidden = true; $('keys').hidden = true;
  showEmpty('Loading workspace…');
  try {
    if (attached) { const old = attached; attached = null; await c.call('pty:detach', [{ id: old }]); }
    if (epoch !== connectionEpoch || token !== spaceEpoch) return;
    await c.call('workspaces:setActive', [id]);
    if (epoch !== connectionEpoch || token !== spaceEpoch) return;
    const [nextViews, nextSessions] = await Promise.all([c.call('views:get'), c.call('pty:list')]);
    if (epoch !== connectionEpoch || token !== spaceEpoch) return;
    views = nextViews || {}; sessions = nextSessions || [];
    wsId = id; selection[JSON.stringify([selectedDevice.id, 'space'])] = id; save('tote.selection', selection);
    group = null; pane = null; await renderGroups(true);
  } finally { if (epoch === connectionEpoch && token === spaceEpoch) { busy = false; controls(); } }
}
async function renderGroups(force = false) {
  if (!force && pane?.id === '_files') return;
  groups = workspaceGroups(views[wsId], sessions, wsId);
  for (const g of groups) g.panes = g.panes.filter(p => p.kind !== 'term' || !closedTerminals.has(draftKey(selectedDevice.id, wsId, p.ref)));
  for (const g of groups) for (const p of g.panes) if (p.kind === 'web') p.title = providerFor(p.providerId)?.name || p.providerId || 'Web tab';
  const saved = selection[selectionKey()] || {};
  const chosen = chooseSelection(groups, group?.id || saved.group || views[wsId]?.activeGroup, pane?.id || saved.pane, force);
  group = chosen.group;
  if (force || chosen.pane?.id !== pane?.id || chosen.pane?.ref !== pane?.ref || (chosen.pane?.kind === 'term' && !chosen.pane.unavailable && attached !== chosen.pane.ref)) await showPane(chosen.pane);
  else { pane = chosen.pane; if (!hostSizeSync && pane?.session && termStream) termStream.write({ data:'', cols:pane.session.cols, rows:pane.session.rows }); controls(); }
}
const navigation = createNavigation({
  onSpace: id => changeSpace(id).catch(e => notify(e.message)),
  onGroup: id => changeGroup(id).catch(e => notify(e.message)),
  onPane: id => showPane(group?.panes.find(p => p.id === id)).catch(e => notify(e.message)),
});
function renderNavigation() {
  $('space-label').textContent = spaces.find(w => w.id === wsId)?.name || 'Connecting…';
  $('pane-label').textContent = pane?.title || 'No terminal selected';
  $('group-label').textContent = group?.name || '';
  Object.assign($('workspace').dataset,{space:wsId || '',group:group?.id || '',pane:pane?.id || '',ready:String(ready && !busy)});
  navigation.update({ spaces, groups, wsId, groupId:group?.id, paneId:pane?.id, device:selectedDevice?.name, disabled:busy || !ready });
}
async function changeGroup(id) {
  const g = groups.find(g => g.id === id); if (!g || busy || !ready) return;
  group = g; const chosen = g.panes.find(p => !p.unavailable) || g.panes[0];
  await showPane(chosen);
}
async function showPane(next) {
  sharedPane?.dispose(); sharedPane = null;
  rememberDraft(); const token = ++paneEpoch, c = client;
  termStream?.dispose(); termStream = null;
  const old = attached; attached = null; sizeController = null; observationConfirmed = false; pane = next;
  selection[selectionKey()] = { group: group?.id, pane: pane?.id }; save('tote.selection', selection);
  $('draft').value = drafts.get(inputKey()) || ''; controls();
  $('terminal-scroll').hidden = true; $('file-view').hidden = true;
  showEmpty('Loading pane…');
  if (old && c?.ready) await c.call('pty:detach', [{ id: old }]);
  if (token !== paneEpoch || c !== client) return;
  $('file-view').hidden = true; $('empty').hidden = true; $('terminal-scroll').hidden = true; $('composer').hidden = pane?.kind !== 'term'; $('keys').hidden = true; $('toggle-keys').setAttribute('aria-expanded','false');
  if (!pane || pane.unavailable) { showEmpty(pane ? 'This terminal is no longer available. Start a new terminal from ⋮.' : 'No panes in this group. Open Files or start a terminal from ⋮.'); return; }
  if (pane.kind === 'files') { await showFiles(); return; }
  if (pane.kind === 'doc') { await readFile(pane.path); return; }
  if (pane.kind === 'web') {
    const tabId = pane.ref, space = wsId;
    showEmpty('');
    sharedPane = RemoteWeb.mount($('empty'), data => c.call('web:pane', [{ wsId: space, tabId, ...data }]),
      () => ready && !busy && client === c && token === paneEpoch && !paused, pane.providerId === 'dsh-local');
    const key = inputKey(), field = sharedPane.input;
    field.value = drafts.get(key) || '';
    field.oninput = () => { if (field.value) drafts.set(key, field.value); else drafts.delete(key); };
    return;
  }
  if (pane.kind !== 'term') { showEmpty('This pane is not supported on Android.'); return; }
  $('terminal-scroll').hidden = false;
  if (!term) {
    term = new Terminal({ cols: pane.session.cols || 80, rows: pane.session.rows || 24, fontSize: 13, fontFamily: 'monospace', scrollback: 5000, theme: TERMINAL_THEME, convertEol: false });
    term.open($('terminal'));
    term.onData(data => { if (!TermReports.isTermReport(data)) writeInput(data).catch(e => notify(e.message)); });
    term.attachCustomKeyEventHandler(e => { if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) { writeInput('\n').catch(e => notify(e.message)); return false; } return true; });
  }
  // Keep one renderer alive: xterm 5.5 has pending viewport callbacks after dispose.
  await new Promise(resolve => term.write('', resolve));
  if (token !== paneEpoch || c !== client) return;
  if (terminalSession !== pane.ref) term.reset();
  terminalSession = pane.ref;
  clearTimeout(readingTimer); readingTimer = null; $('terminal-text').textContent = '';
  $('terminal-scroll').scrollTop = 0; $('terminal-scroll').scrollLeft = 0; lastOutputTop = 0;
  setTerminalSize(pane.session.cols || 80, pane.session.rows || 24);
  hostSizeSync = !!pane.session.sizeSync;
  termStream = TermStream.create(term, {
    onSize: p => {
      if (token !== paneEpoch) return;
      if (typeof p.controlsSize === 'boolean') hostSizeSync = true;
      if (p.controller && sizeController !== p.controller) { sizeController = p.controller; renderAccess(); }
      if (pane?.session) Object.assign(pane.session, {cols:p.cols,rows:p.rows});
      setTerminalSize(p.cols, p.rows);
    },
    onParsed: p => {
      if (token !== paneEpoch) return;
      if (wrapped) { if (p.replay) renderReading(true); else scheduleReading(); }
      else if (p.follow) revealOutput();
    },
  });
  attached = pane.ref; // replay may arrive before attach's return frame
  const storageKey = observerKey();
  try {
    const meta = await c.call('pty:attach', [pane.ref, { readOnly: sessionStorage.getItem(storageKey) === 'observe' }]);
    if (token === paneEpoch) {
      pane.session = meta;
      observationConfirmed = !!meta.readOnly;
      if (observationConfirmed) sessionStorage.setItem(storageKey, 'observe');
      controls();
    }
  }
  catch (e) { if (token === paneEpoch) { attached = null; controls(); } throw e; }
}
function cellSize() {
  const context = document.createElement('canvas').getContext('2d');
  context.font = '13px monospace'; return { width:context.measureText('W').width, height:16 };
}
function setTerminalSize(cols, rows) {
  if (!term) return;
  const cell = cellSize(); term.resize(cols, rows);
  $('terminal').style.width = Math.ceil(cols * cell.width + 18) + 'px';
  $('terminal').style.height = Math.max($('stage').clientHeight - 16, rows * cell.height) + 'px';
}
function showEmpty(text) { $('empty').textContent = text; $('empty').hidden = false; controls(); }
// A desktop terminal can be much taller than the phone. Follow the active
// output row in the outer scroller as well as xterm's own scrollback viewport.
function followingOutput() {
  if (wrapped) { const el = $('terminal-scroll'); return el.scrollHeight - el.clientHeight - el.scrollTop < 36; }
  return term && Math.abs($('terminal-scroll').scrollTop - lastOutputTop) < 24 &&
    term.buffer.active.viewportY >= term.buffer.active.baseY;
}
function revealOutput() {
  if (!term || $('terminal-scroll').hidden) return;
  if (wrapped) { $('terminal-scroll').scrollTop = $('terminal-scroll').scrollHeight; return; }
  term.scrollToBottom();
  const screen = $('terminal').querySelector('.xterm-screen');
  const rowHeight = screen?.getBoundingClientRect().height / term.rows || cellSize().height;
  const scroller = $('terminal-scroll');
  scroller.scrollTop = Math.max(0, (term.buffer.active.cursorY + 2) * rowHeight + 16 - scroller.clientHeight);
  lastOutputTop = scroller.scrollTop;
}
function renderReading(forceFollow = false) {
  if (!term || !wrapped) return;
  const follow = forceFollow || followingOutput();
  renderTerminalReading($('terminal-text'), term.buffer.active, {theme:term.options.theme,brightBold:term.options.drawBoldTextInBrightColors});
  if (follow) revealOutput();
}
function scheduleReading() {
  if (!wrapped || readingTimer) return;
  const token = paneEpoch;
  readingTimer = setTimeout(() => { readingTimer = null; if (token === paneEpoch) renderReading(); }, 60);
}
function applyReadingMode() {
  $('terminal-scroll').classList.toggle('reading', wrapped);
  $('terminal-text').hidden = !wrapped;
  $('reading-mode').setAttribute('aria-pressed', String(wrapped));
  renderReading(true); if (!wrapped) { term?.refresh(0, term.rows - 1); revealOutput(); }
}
$('reading-mode').onclick = () => { wrapped = !wrapped; save('tote.wrapText', wrapped); applyReadingMode(); };
applyReadingMode();
new ResizeObserver(() => { if (followingOutput()) revealOutput(); }).observe($('stage'));
function hostEvent(event, p) {
  if (event === 'pty:data' && p.id === attached && term) {
    return termStream?.write({ ...p, follow: p.replay || followingOutput() });
  } else if (event === 'pty:exit' && p.id === attached) {
    if (pane?.session) pane.session.alive = false;
    notify('Terminal exited' + (p.exitCode == null ? '.' : ' with code ' + p.exitCode + '.')); controls();
  } else if (['views:changed','workspaces:changed'].includes(event)) {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(e => notify(e.message)), 150);
  }
}
async function writeInput(data) {
  if (!ready || busy || inputBlocked() || closing.has(inputKey()) || !pane?.session?.alive || attached !== pane.ref) throw new Error('Terminal is not ready. Your draft is kept on the phone.');
  await client.call('pty:write', [{ id: attached, data }]);
}
async function closeTerminal() {
  if (!ready || busy || (pane?.session && inputBlocked()) || pane?.kind !== 'term' || closing.has(inputKey()) || sending.has(inputKey())) return;
  const c = client, epoch = connectionEpoch, space = wsId, id = pane.ref, key = inputKey();
  const hasSession = !!pane.session;
  const consequence = pane.session?.alive
    ? 'This stops the terminal and its running agent on the computer for every viewer.'
    : 'This removes the ended terminal from this phone.';
  if (!confirm(`Close “${pane.title}”?\n\n${consequence}\nAny unsent draft stays on this phone.`)) return;
  if (c !== client || epoch !== connectionEpoch || !ready || busy) return;
  rememberDraft(); closing.add(key); controls();
  try {
    // Capture the session and connection before awaiting; never retry a kill
    // after reconnecting or redirect it to a newly selected pane/device.
    if (hasSession) await c.call('pty:kill', [{ id }]);
    closedTerminals.add(key);
    save('tote.closedTerminals', [...closedTerminals]);
    if (c === client && epoch === connectionEpoch && wsId === space) {
      sessions = sessions.filter(s => s.id !== id);
      await renderGroups(pane?.kind === 'term' && pane.ref === id);
    }
  } catch (e) {
    notify('Could not confirm the terminal closed. Check its status before retrying. ' + e.message);
  } finally {
    closing.delete(key); controls();
  }
}
async function changeAccess(mode) {
  const c = client, id = attached, key = inputKey(), storageKey = observerKey(), epoch = paneEpoch;
  if (!ready || busy || !id || id !== pane?.ref || accessPending.has(key)) return;
  accessPending.add(key);
  // Keep observation selected across a lost reply and the next attach.
  if (mode === 'observe') sessionStorage.setItem(storageKey, 'observe');
  controls();
  try {
    const access = pane.session?.accessControl ? await c.call('pty:access', [{ id, mode }])
      : { readOnly: false, controller: null };
    if (c === client && epoch === paneEpoch && id === attached) {
      if (!access.readOnly) sessionStorage.removeItem(storageKey);
      observationConfirmed = access.readOnly;
      sizeController = access.controller;
    }
  } catch (e) { notify(e.message); }
  finally { accessPending.delete(key); controls(); }
}
$('observe').onclick = () => changeAccess('observe');
$('take-control').onclick = () => changeAccess('control');
$('close-terminal').onclick = closeTerminal;
$('close-terminal-menu').onclick = closeTerminal;
$('draft').oninput = () => { rememberDraft(); controls(); };
$('composer').onsubmit = async e => {
  e.preventDefault(); const text = $('draft').value, key = inputKey(); if (!text.trim() || $('send').disabled) return;
  sending.add(key); controls();
  try {
    // xterm paste wraps multiline input only when the host application enabled bracketed paste.
    const data = term?.modes.bracketedPasteMode ? '\x1b[200~' + text + '\x1b[201~\r' : text.replace(/\r?\n/g, '\n') + '\r';
    await writeInput(data);
    if (inputKey() === key && $('draft').value === text) { $('draft').value = ''; drafts.delete(key); }
  } catch (e) { notify(e.message + ' Input may have reached the host; check before resending.'); }
  sending.delete(key); controls();
};
const keys = { esc:'\x1b', tab:'\t', up:'\x1b[A', down:'\x1b[B', left:'\x1b[D', right:'\x1b[C', enter:'\r', interrupt:'\x03' };
document.querySelectorAll('[data-key]').forEach(b => b.onclick = () => writeInput(keys[b.dataset.key]).catch(e => notify(e.message)));
$('toggle-keys').onclick = () => { $('keys').hidden = !$('keys').hidden; $('toggle-keys').setAttribute('aria-expanded', String(!$('keys').hidden)); };
$('more').onclick = () => { $('workspace-tools').hidden = !$('workspace-tools').hidden; $('more').setAttribute('aria-expanded',String(!$('workspace-tools').hidden)); };
$('refresh').onclick = () => refresh().catch(e => notify(e.message));
$('fit').onclick = async () => {
  if (!term || !attached || inputBlocked() || !confirm('Resize the shared terminal to this phone? Other viewers will see the new size too.')) return;
  const cols = Math.max(20, Math.floor(($('stage').clientWidth - 34) / cellSize().width)), rows = Math.max(6, Math.floor(($('stage').clientHeight - 16) / 16));
  try { await client.call('pty:resize', [{ id: attached, cols, rows }]); if (!hostSizeSync) termStream?.write({data:'',cols,rows}); } catch (e) { notify(e.message); }
};
async function showFiles() {
  const token = paneEpoch, c = client;
  $('terminal-scroll').hidden = true; $('empty').hidden = true; $('file-view').hidden = false; $('composer').hidden = true;
  $('file-content').textContent = 'Loading files…'; $('file-back').hidden = true;
  const tree = await c.call('workspace:tree');
  if (token !== paneEpoch || c !== client) return;
  $('file-content').replaceChildren();
  function append(nodes, parent) {
    for (const node of nodes || []) {
      if (node.type === 'dir') { const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = node.name; details.append(summary); append(node.children, details); parent.append(details); }
      else { const button = document.createElement('button'); button.className = 'file'; button.textContent = node.name; button.onclick = () => readFile(node.path).catch(e => notify(e.message)); parent.append(button); }
    }
  }
  append(tree, $('file-content')); if (!tree?.length) $('file-content').textContent = 'This space has no visible files.';
}
async function readFile(path) {
  const token = ++paneEpoch, c = client;
  $('terminal-scroll').hidden = true; $('empty').hidden = true; $('file-view').hidden = false; $('composer').hidden = true; $('file-back').hidden = false; $('file-content').textContent = 'Loading…';
  const doc = await c.call('workspace:readDoc', [path]);
  if (token !== paneEpoch || c !== client) return;
  const title = document.createElement('h3'); title.textContent = path; $('file-content').replaceChildren(title);
  if (doc.error) { const p = document.createElement('p'); p.textContent = doc.error; $('file-content').append(p); }
  else if (doc.kind === 'image' && /^data:image\//.test(doc.dataUrl || '')) { const img = document.createElement('img'); img.src = doc.dataUrl; img.alt = path; $('file-content').append(img); }
  else { const pre = document.createElement('pre'); pre.textContent = typeof doc.text === 'string' ? doc.text : 'Preview is not available for this file type on Android yet.'; $('file-content').append(pre); }
}
$('files').onclick = () => showPane({ id:'_files', kind:'files', title:'Files' }).catch(e => notify(e.message));
$('file-back').onclick = () => showFiles().catch(e => notify(e.message));
async function openWeb(value) {
  try {
    const url = webUrl(value);
    await Browser.open({ url, toolbarColor: '#17191f' });
    $('web-dialog').close();
    $('web-url').value = ''; // Startup links can contain authentication tokens.
  } catch (error) {
    if ($('web-dialog').open) $('web-error').textContent = error.message;
    else notify(error.message);
  }
}
function showWebDialog() {
  $('web-error').textContent = '';
  const c = client, space = wsId;
  $('web-providers').replaceChildren();
  if (!webProviders.length) $('web-error').textContent = 'Update Tote and its background host on the selected computer to open shared panes.';
  for (const provider of webProviders) {
    const button = document.createElement('button');
    button.textContent = provider.name;
    button.onclick = async () => {
      button.disabled = true;
      try {
        const existing = groups.flatMap(g => g.panes).find(p => p.kind === 'web' && p.providerId === provider.id);
        const ref = existing?.ref ?? await c.call('web:open', [{ wsId: space, providerId: provider.id }]);
        if (client !== c || wsId !== space || !$('web-dialog').open) return;
        await refresh();
        if (client !== c || wsId !== space || !$('web-dialog').open) return;
        const target = groups.find(g => g.panes.some(p => p.kind === 'web' && p.ref === ref));
        if (!target) throw Error('The pane layout is changing. Select the pane again.');
        $('web-dialog').close();
        group = target;
        await showPane(group.panes.find(p => p.kind === 'web' && p.ref === ref));
      } catch (error) { if (client === c && wsId === space) $('web-error').textContent = error.message; }
      finally { button.disabled = false; }
    };
    $('web-providers').append(button);
  }
  $('web-dialog').showModal();
}
$('open-web').onclick = showWebDialog;
$('workspace-tools').addEventListener('click', e => {
  if (!e.target.closest('button')) return;
  $('workspace-tools').hidden = true;
  $('more').setAttribute('aria-expanded', 'false');
});
$('cancel-web').onclick = () => { $('web-dialog').close(); $('web-url').value = ''; };
$('web-form').onsubmit = e => { e.preventDefault(); openWeb($('web-url').value); };
$('new-terminal').onclick = async () => {
  try { const profiles = await client.call('config:getCliProfiles'); options('profiles', profiles); $('start-new').disabled = !profiles.length; $('new-dialog').showModal(); } catch (e) { notify(e.message); }
};
$('cancel-new').onclick = () => $('new-dialog').close();
$('start-new').onclick = async () => {
  $('start-new').disabled = true; const c = client, epoch = connectionEpoch;
  try {
    const sid = crypto.randomUUID(); await c.call('pty:spawn', [{ sid, profileId:$('profiles').value, cols:80, rows:24 }]);
    if (epoch !== connectionEpoch) return;
    $('new-dialog').close(); group = { id:'_sessions' }; pane = null;
    selection[selectionKey()] = { group:'_sessions', pane:sid }; await refresh();
  } catch (e) { notify(e.message); } finally { $('start-new').disabled = false; }
};
let voiceToken = 0, voiceKey;
async function cancelVoice() { voiceToken++; $('recording').close(); await Speech.cancel().catch(() => {}); }
$('mic').onclick = async () => {
  const token = ++voiceToken; voiceKey = inputKey(); $('partial').textContent = ''; $('recording-title').textContent = 'Starting microphone…'; $('stop-voice').disabled = true; $('recording').showModal();
  try {
    const result = await Speech.start();
    if (token !== voiceToken) return;
    $('recording').close();
    if (inputKey() !== voiceKey) { notify('Voice destination changed. Please record again.'); return; }
    if (result.text?.trim()) { $('draft').value = [$('draft').value, result.text.trim()].filter(Boolean).join('\n'); rememberDraft(); controls(); }
    $('draft').focus(); $('draft').setSelectionRange($('draft').value.length, $('draft').value.length); await Native.showKeyboard();
  } catch (e) { if (token === voiceToken) { $('recording').close(); notify(e.message); } }
};
$('stop-voice').onclick = () => { $('stop-voice').disabled = true; $('recording-title').textContent = 'Transcribing…'; Speech.stop().catch(e => { cancelVoice(); notify(e.message); }); };
$('cancel-voice').onclick = cancelVoice;
$('recording').addEventListener('cancel', e => { e.preventDefault(); cancelVoice(); });
function home() { navigation.close(); cancelVoice(); rememberDraft(); selectedDevice = null; stopConnection(); $('workspace').hidden = true; $('home').hidden = false; findComputers(); }
$('back').onclick = home;
let diagnosticReport = null, diagnosticRequest = 0;
async function refreshDiagnostics() {
  const ticket = ++diagnosticRequest, device = selectedDevice, c = client;
  diagnosticReport = null; $('diagnostics-save').disabled = true;
  $('diagnostics-preview').textContent = ''; $('diagnostics-summary').replaceChildren();
  $('diagnostics-status').textContent = 'Collecting diagnostics…';
  let snapshot = diagnosticCache.get(device?.id), status = snapshot ? 'cached' : 'unavailable';
  const metrics = device && pane?.kind === 'term' && terminalSession === pane.ref && term ? [{ id: pane.ref, focused: true,
    alive: pane.session?.alive, host: {cols: pane.session?.cols, rows: pane.session?.rows},
    local: { cols: term.cols, rows: term.rows, width: $('stage').clientWidth, height: $('stage').clientHeight } }] : [];
  try {
    if (c?.ready) {
      try {
        const result = await Diagnostics.withTimeout(c.call('device:diagnostics'));
        if (!result || result.format !== 'tote-diagnostics-v1') throw new Error('Incompatible host diagnostics');
        // Keep only redacted fields plus transient session IDs for viewport matching.
        const safe = Diagnostics.report(result);
        snapshot = { ...safe, terminals: safe.terminals.map((t,i) => ({ ...t, id: result.terminals[i]?.id })) };
        diagnosticCache.set(device.id, snapshot); status = 'current';
      } catch (error) {
        diagnosticLog.add('diagnostics', error);
        if (!snapshot && /Not a host method|incompatible/i.test(error.message)) status = 'unsupported';
      }
    }
    const [native, info] = await Promise.all([
      Native.diagnostics().catch(error => { diagnosticLog.add('diagnostics', error); return {}; }),
      App.getInfo ? App.getInfo().catch(() => null) : null,
    ]);
    if (ticket !== diagnosticRequest || !$('diagnostics-dialog').open) return;
    if (device !== selectedDevice || c !== client) { $('diagnostics-status').textContent = 'Connection changed. Refresh diagnostics.'; return; }
    diagnosticReport = Diagnostics.compose({ snapshot, status, metrics,
      viewer: { kind: 'android', platform: 'android', version: info?.version || version },
      hostVersion: hostVersions.get(device?.id), native,
      connection: { mode: device ? 'remote' : 'none', state: c?.ready ? 'connected' : device ? 'disconnected' : 'unknown',
        flow: c?.flow, pendingCalls: c?.pending.size || 0, queuedBytes: c?.outputBytes || 0, pendingFrames: c?.output.size || 0 },
      events: diagnosticLog.snapshot(),
    });
    Diagnostics.render($('diagnostics-summary'), diagnosticReport);
    $('diagnostics-preview').textContent = Diagnostics.stringify(diagnosticReport);
    $('diagnostics-save').disabled = false;
    $('diagnostics-status').textContent = 'Snapshot ready. Raw error messages are excluded.';
  } catch { if (ticket === diagnosticRequest) $('diagnostics-status').textContent = 'Could not collect diagnostics. Try refreshing.'; }
}
function openDiagnostics() { $('diagnostics-dialog').showModal(); refreshDiagnostics(); }
$('home-diagnostics').onclick = openDiagnostics; $('open-diagnostics').onclick = openDiagnostics;
$('diagnostics-close').onclick = () => $('diagnostics-dialog').close();
$('diagnostics-refresh').onclick = refreshDiagnostics;
$('diagnostics-save').onclick = async () => {
  if (!diagnosticReport) return;
  $('diagnostics-save').disabled = true;
  try {
    const result = await Native.exportDiagnostics({ text: Diagnostics.stringify(diagnosticReport) });
    $('diagnostics-status').textContent = result.saved ? 'Report saved.' : 'Save canceled.';
  } catch { $('diagnostics-status').textContent = 'Could not save the report.'; }
  finally { $('diagnostics-save').disabled = !diagnosticReport; }
};

let updateVersion = null;
function renderUpdateDrafts() {
  rememberDraft();
  const list = $('updates-drafts'); list.replaceChildren();
  for (const [key, text] of drafts) {
    if (!text.trim()) continue;
    const row = document.createElement('section'), label = document.createElement('label');
    label.textContent = `Saved draft ${list.children.length + 1} — select and copy before discarding`;
    const value = document.createElement('textarea'); value.value = text; value.readOnly = true; label.append(value);
    const discard = document.createElement('button'); discard.textContent = 'Discard this draft';
    discard.onclick = () => {
      if (!confirm('Discard this unsent draft? Copy any text you want to keep first.')) return;
      // Never erase a newer buffer if an asynchronous edit changed the draft.
      rememberDraft();
      if (drafts.get(key) !== text) { renderUpdateDrafts(); return; }
      if (inputKey() === key && $('draft').value === text) { $('draft').value = ''; controls(); }
      if (inputKey() === key && sharedPane?.input.value === text) sharedPane.input.value = '';
      drafts.delete(key); renderUpdateDrafts();
    };
    row.append(label, discard); list.append(row);
  }
  $('updates-draft-review').hidden = !list.children.length;
}
function updateProgress(s) {
  $('updates-install').hidden = s.phase !== 'ready';
  $('updates-cancel').hidden = s.phase !== 'downloading';
  $('updates-download').disabled = s.phase === 'downloading';
  $('updates-progress').textContent = s.phase === 'downloading' ? (s.total ? `Downloading… ${Math.floor(100*s.received/s.total)}%` : 'Preparing download…')
    : s.phase === 'ready' ? `Tote ${s.version} is verified and ready to install.` : s.message || '';
}
function openUpdates() { renderUpdateDrafts(); $('updates-dialog').showModal(); Updater.status().then(updateProgress).catch(() => {}); }
$('updates-download').onclick = async () => {
  if (!updateVersion) return;
  updateProgress({phase:'downloading'});
  const poll = setInterval(() => Updater.status().then(updateProgress).catch(() => {}), 500);
  try { updateProgress(await Updater.download({version:updateVersion})); }
  catch (error) { updateProgress({phase:'error',message:error.message}); }
  finally { clearInterval(poll); }
};
$('updates-cancel').onclick = () => Updater.cancel();
$('updates-install').onclick = async () => {
  cancelVoice(); renderUpdateDrafts();
  if ([...document.querySelectorAll('.remote-web input[type=password]')].some(input => input.value)) {
    $('updates-status').textContent = 'Insert or clear the text in your web pane before installing.';
    return;
  }
  if ([...drafts.values()].some(text => text.trim())) {
    $('updates-progress').textContent = 'Save or clear your phone drafts before installing an update. Review unsent drafts above.'; return;
  }
  // Keep editing frozen through verification, permission settings and the OS
  // installer. Returning from settings never automatically starts installation.
  const unlock = lockUpdateEditing(document);
  try {
    const result = await Updater.install();
    $('updates-progress').textContent = result.permissionStep
      ? (result.allowed ? 'Installation allowed. Tap Install update again to continue.' : 'Android permission was not granted. Tap Install update to try again.')
      : 'Returned from Android’s installer. If installation was canceled, you can try again.';
  } catch (error) { $('updates-progress').textContent = error.message; }
  finally { unlock(); }
};
$('home-updates').onclick = openUpdates; $('open-updates').onclick = openUpdates;
$('updates-close').onclick = () => $('updates-dialog').close();
$('updates-check').onclick = async () => {
  updateVersion = null;
  $('updates-check').disabled = true; $('updates-open').hidden = true; $('updates-download').hidden = true;
  $('updates-status').textContent = 'Checking GitHub…';
  try {
    const info = App.getInfo ? await App.getInfo().catch(() => null) : null;
    const r = Updates.latest(await Native.checkUpdates(), info?.version || version);
    $('updates-status').textContent = r.available ? `Tote ${r.latest} is available. Installed: ${r.current}.` : `Installed: ${r.current}. Latest stable: ${r.latest}. No newer stable release is available.`;
    updateVersion = r.available ? r.latest : null;
    $('updates-open').hidden = !r.available; $('updates-download').hidden = !r.available;
  } catch { $('updates-status').textContent = 'Could not check for updates. Check your internet connection and try later.'; }
  finally { $('updates-check').disabled = false; }
};
$('updates-open').onclick = async () => {
  if (!updateVersion) return;
  renderUpdateDrafts();
  if ([...document.querySelectorAll('.remote-web input[type=password]')].some(input => input.value)) {
    $('updates-status').textContent = 'Insert or clear the text in your web pane before installing.';
    return;
  }
  if ([...drafts.values()].some(text => text.trim())) { $('updates-status').textContent = 'Save or clear your phone drafts before installing an update. Drafts are currently kept only in memory.'; return; }
  try { await Native.openUpdates({ version: updateVersion }); } catch { $('updates-status').textContent = 'Could not open the release page.'; }
};

async function init() {
  renderDevices();
  await initNative();
  await Discovery.addListener('candidate', candidate => { if (candidate.scan === activeScan && scanning && !selectedDevice && !paused) search.add(candidate); });
  await Discovery.addListener('finished', event => { if (event.scan !== activeScan) return; scanning = false; discoveryStatus(); if (event.error) notify(event.error);
    clearTimeout(discoveryTimer);
    if (!selectedDevice && !paused) discoveryTimer = setTimeout(findComputers, 5000);
  });
  discoveryInitialized = true; findComputers();
  await Speech.addListener('state', event => { if (!$('recording').open) return; $('recording-title').textContent = event.listening ? 'Recording…' : 'Transcribing…'; $('stop-voice').disabled = !event.listening; if (event.text) $('partial').textContent = event.text; });
  await App.addListener('appStateChange', ({ isActive }) => { paused = !isActive; if (paused) { stopSearch(); cancelVoice(); rememberDraft(); stopConnection(); } else if (selectedDevice) connect(); else findComputers(); });
  await App.addListener('backButton', () => { if ($('updates-dialog').open) $('updates-dialog').close(); else if ($('diagnostics-dialog').open) $('diagnostics-dialog').close(); else if (navigation.isOpen()) navigation.close(); else if ($('recording').open) cancelVoice(); else if ($('web-dialog').open) { $('web-dialog').close(); $('web-url').value = ''; } else if ($('new-dialog').open) $('new-dialog').close(); else if (!$('file-view').hidden) { const terminal = group?.panes.find(p => p.kind === 'term' && !p.unavailable); if (terminal) showPane(terminal).catch(e => notify(e.message)); else home(); } else if (selectedDevice) home(); else App.exitApp(); });
}
init().catch(e => notify('Android initialization failed: ' + e.message));
