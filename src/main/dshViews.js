const { WebContentsView, session } = require('electron');

// Private browsers are leased by frame pulls. A vanished viewer cannot leave
// Chromium processes around indefinitely, even with a 0.5.10 background host.
const views = new Map();
const slots = Array.from({ length: 16 }, (_, i) => 'tote-dsh-view-' + i);
const idleMs = 10 * 60 * 1000;

function dshGuest(request, createPage) {
  const { id, width, height } = request.source.viewport || {};
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) ||
      ![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= 4096) || width * height > 8388608) {
    throw Error('Invalid web pane dimensions.');
  }
  const key = JSON.stringify([request.viewerId, request.wsId, request.tabId, id]);
  let entry = views.get(key);
  if (!entry) {
    if (request.operation !== 'frame') throw Error('The web page changed. Try the action again.');
    if (!slots.length) throw Error('The web pane limit on the selected computer has been reached.');
    const partition = slots.pop();
    const browserSession = session.fromPartition(partition);
    const view = new WebContentsView({ webPreferences: {
      session: browserSession, offscreen: true, sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    const wc = view.webContents;
    entry = { view, ready: false };
    views.set(key, entry);
    wc.once('destroyed', () => {
      clearTimeout(entry.timer);
      if (views.get(key) === entry) views.delete(key);
      // Finish initialization before clearing, including a pending login copy.
      entry.loading.finally(() => browserSession.clearData()).then(() => slots.push(partition)).catch(() => {});
    });
    entry.loading = createPage(wc).then(() => { entry.ready = true; }, () => {
      entry.failed = true;
      // Let the next poll report the failure, then allow a fresh attempt.
    });
  }
  clearTimeout(entry.timer);
  const wc = entry.view.webContents;
  entry.timer = setTimeout(() => wc.close(), idleMs);
  entry.timer.unref();
  if (entry.failed) {
    wc.close();
    throw Error('The web page could not load. Check DSH on the selected computer.');
  }
  if (!entry.ready) throw Error('Waiting for DSH on the selected computer.');
  return wc;
}

function closeDshViews() {
  for (const { view } of views.values()) view.webContents.close();
}

module.exports = { dshGuest, closeDshViews };
