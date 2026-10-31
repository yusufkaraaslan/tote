import { version } from '../package.json';
import { Terminal } from '@xterm/xterm';
import { App } from '@capacitor/app';
import { readableTerminal } from './reading.js';
import { createNavigation } from './navigation.js';
import { ComputerSearch } from './discovery.js';
import { DeviceClient } from './client.js';
import { Native, Speech, Discovery, initNative, socketFactory } from './native.js';
import { tailnetAddress, portNumber, workspaceGroups, chooseSelection, draftKey } from './model.js';
import TermReports from '../../src/renderer/termreports.js';

const $ = id => document.getElementById(id);
$('build-version').textContent = 'Android ' + version;
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { notify('Phone storage is full. Preferences could not be saved.'); } };
let devices = load('tote.devices', []), selectedDevice = null, client = null;
let spaces = [];
let wsId = null, views = {}, sessions = [], groups = [], group = null, pane = null;
let selection = load('tote.selection', {}), drafts = new Map();
const sending = new Set(); // Terminal drafts stay in memory, never on the host.
let spaceEpoch = 0;
let connectionEpoch = 0, paneEpoch = 0, refreshEpoch = 0, reconnectTimer, retry = 0, paused = false, busy = false, attached = null;
let lastOutputTop = 0, readingTimer;
let wrapped = load('tote.wrapText', true);
let term = null, terminalSession = null, ready = false, polling, refreshTimer, messageTimer;
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
function notify(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(messageTimer); messageTimer = setTimeout(() => $('notice').hidden = true, 6500); }
function banner(message) { $('connection-banner').textContent = message; $('connection-banner').hidden = !message; }
function rememberDraft() { if (selectedDevice && pane) drafts.set(inputKey(), $('draft').value); }
function fitDraft() { const d = $('draft'); d.style.height = '44px'; d.style.height = Math.min(140, Math.max(44, d.scrollHeight + 2)) + 'px'; }
function controls() {
  const writable = ready && !busy && pane?.kind === 'term' && pane.session?.alive && attached === pane.ref;
  $('send').disabled = !writable || sending.has(inputKey()) || !$('draft').value.trim();
  document.querySelectorAll('[data-key]').forEach(b => b.disabled = !writable);
  renderNavigation();
  $('new-terminal').disabled = busy || !ready; $('fit').disabled = !writable;
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
  connectionEpoch++; spaceEpoch++; refreshEpoch++; paneEpoch++; clearTimeout(reconnectTimer); clearInterval(polling);
  const old = client; client = null; ready = false; busy = false; attached = null; old?.close(); controls();
}
function openDevice(device) {
  stopSearch(); rememberDraft(); stopConnection(); selectedDevice = device; wsId = null; group = null; pane = null; retry = 0;
  terminalSession = null; $('draft').value = ''; $('terminal-scroll').hidden = true; $('file-view').hidden = true; $('composer').hidden = true; $('keys').hidden = true;
  spaces = []; groups = []; renderNavigation(); showEmpty('Connecting to ' + device.name + '…');
  $('home').hidden = true; $('workspace').hidden = false; $('device-label').textContent = device.name;
  connect();
}
async function connect() {
  if (!selectedDevice || paused) return;
  stopConnection(); const epoch = connectionEpoch; const device = selectedDevice;
  banner(retry ? 'Reconnecting… Your sessions are still on the computer.' : 'Connecting…');
  const c = client = new DeviceClient({ socketFactory,
    onEvent: (event, payload) => { if (client === c) hostEvent(event, payload); },
    onClose: error => {
      if (client !== c) return;
      ready = false; attached = null; controls(); clearInterval(polling); banner(error.message);
      scheduleReconnect();
    },
  });
  try {
    await c.connect(device.address, device.port);
    if (epoch !== connectionEpoch) return;
    ready = true; retry = 0; await refresh(true);
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
  const saved = selection[selectionKey()] || {};
  const chosen = chooseSelection(groups, group?.id || saved.group || views[wsId]?.activeGroup, pane?.id || saved.pane, force);
  group = chosen.group;
  if (force || chosen.pane?.id !== pane?.id || chosen.pane?.ref !== pane?.ref || (chosen.pane?.kind === 'term' && !chosen.pane.unavailable && attached !== chosen.pane.ref)) await showPane(chosen.pane);
  else { pane = chosen.pane; if (pane?.session && term) setTerminalSize(pane.session.cols || 80, pane.session.rows || 24); controls(); }
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
  rememberDraft(); const token = ++paneEpoch, c = client;
  const old = attached; attached = null; pane = next;
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
  if (pane.kind !== 'term') { showEmpty('Web-provider tabs run on the desktop. Android currently supports terminals and file previews.'); return; }
  $('terminal-scroll').hidden = false;
  if (!term) {
    term = new Terminal({ cols: pane.session.cols || 80, rows: pane.session.rows || 24, fontSize: 13, fontFamily: 'monospace', scrollback: 5000, theme: { background: '#0c0d0b', foreground: '#d4d8ca', cursor: '#e0a458' }, convertEol: false });
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
  attached = pane.ref; // replay may arrive before attach's return frame
  try { const meta = await c.call('pty:attach', [pane.ref]); if (token === paneEpoch) { pane.session = meta; controls(); } }
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
  const text = readableTerminal(term.buffer.active);
  if ($('terminal-text').textContent !== text) $('terminal-text').textContent = text;
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
    const token = paneEpoch, follow = p.replay || followingOutput();
    if (p.replay) term.reset();
    term.write(p.data, () => {
      if (token !== paneEpoch || p.id !== attached) return;
      if (wrapped) { if (p.replay) renderReading(true); else scheduleReading(); }
      else if (follow) revealOutput();
    });
  } else if (event === 'pty:exit' && p.id === attached) {
    if (pane?.session) pane.session.alive = false;
    notify('Terminal exited' + (p.exitCode == null ? '.' : ' with code ' + p.exitCode + '.')); controls();
  } else if (['views:changed','workspaces:changed'].includes(event)) {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(e => notify(e.message)), 150);
  }
}
async function writeInput(data) {
  if (!ready || busy || !pane?.session?.alive || attached !== pane.ref) throw new Error('Terminal is not ready. Your draft is kept on the phone.');
  await client.call('pty:write', [{ id: attached, data }]);
}
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
  if (!term || !attached || !confirm('Resize the shared terminal to this phone? Other viewers will see the new size too.')) return;
  const cols = Math.max(20, Math.floor(($('stage').clientWidth - 34) / cellSize().width)), rows = Math.max(6, Math.floor(($('stage').clientHeight - 16) / 16));
  try { await client.call('pty:resize', [{ id: attached, cols, rows }]); setTerminalSize(cols, rows); } catch (e) { notify(e.message); }
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
  await App.addListener('backButton', () => { if (navigation.isOpen()) navigation.close(); else if ($('recording').open) cancelVoice(); else if ($('new-dialog').open) $('new-dialog').close(); else if (!$('file-view').hidden) { const terminal = group?.panes.find(p => p.kind === 'term' && !p.unavailable); if (terminal) showPane(terminal).catch(e => notify(e.message)); else home(); } else if (selectedDevice) home(); else App.exitApp(); });
}
init().catch(e => notify('Android initialization failed: ' + e.message));
