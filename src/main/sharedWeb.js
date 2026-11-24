// Capture only the registered provider guest (or its own OAuth popup).
// The device protocol carries pixels and a small set of page gestures.
const { randomUUID, createHash } = require('node:crypto');
const keys = { Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27,
  ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35 };

class SharedWeb {
  constructor() {
    this.panes = new Map();
    this.screens = new WeakMap();
    this.popups = new WeakMap();
    this.localOrigins = new WeakMap();
    this.responses = new WeakMap();
    this.remoteWorkspace = new WeakMap();
  }

  register({ wsId, tabId, providerId }, wc) {
    const key = JSON.stringify([wsId, tabId, providerId]);
    let guests = this.panes.get(key);
    if (!guests) { guests = new Set(); this.panes.set(key, guests); }
    if (guests.has(wc)) return;
    guests.add(wc);
    wc.once('destroyed', () => {
      guests.delete(wc);
      if (!guests.size) this.panes.delete(key);
    });
  }

  guest({ wsId, tabId, providerId }) {
    let wc = this.panes.get(JSON.stringify([wsId, tabId, providerId]))?.values().next().value;
    while (wc && this.popups.has(wc)) wc = this.popups.get(wc);
    return wc;
  }

  screen(wc) {
    let screen = this.screens.get(wc);
    if (!screen) {
      screen = { token: randomUUID(), queue: Promise.resolve(), pending: 0, ownsDebugger: false };
      this.screens.set(wc, screen);
      wc.on('did-start-navigation', details => {
        if (details.isMainFrame) screen.token = randomUUID();
      });
    }
    return screen;
  }

  async handle(wc, request, attachFile) {
    if (!wc || wc.isDestroyed() || !/^https?:\/\//i.test(wc.getURL())) throw Error('Waiting for the web page on the selected computer.');
    const screen = this.screen(wc);
    if (screen.pending >= 8) throw Error('The web pane is busy. Try again.');
    const deadline = Date.now() + 6000;
    screen.pending++;
    clearTimeout(screen.release);
    const work = screen.queue.then(async () => {
      if (Date.now() >= deadline) throw Error('The web pane request expired.');
      if (wc.isDestroyed() || !/^https?:\/\//i.test(wc.getURL())) throw Error('The web page changed.');
      const debug = wc.debugger;
      if (!debug.isAttached()) { debug.attach(); screen.ownsDebugger = true; }
      const command = (method, params = {}) => debug.sendCommand(method, params);
      const token = screen.token;
      const { cssVisualViewport: viewport } = await command('Page.getLayoutMetrics');
      const { clientWidth: width, clientHeight: height } = viewport;
      if (!(width > 0 && height > 0)) throw Error('The web pane has no visible page on the computer.');
      if (request.operation === 'frame') {
        const pixels = await wc.capturePage(undefined, { stayHidden: false, stayAwake: true });
        if (pixels.isEmpty()) throw Error('Waiting for the web page on the selected computer.');
        const size = pixels.getSize();
        const jpeg = size.width > 1440 || size.height > 1440
          ? pixels.resize(size.width >= size.height ? { width: 1440 } : { height: 1440 }) : pixels;
        const data = jpeg.toJPEG(73).toString('base64');
        if (data.length > 3 * 1024 * 1024 || token !== screen.token) throw Error('The web page changed. Refreshing…');
        const revision = createHash('sha256').update(data).digest('base64');
        const needsLogin = this.localOrigins.has(wc) && [401, 403].includes(this.responses.get(wc));
        const source = { token, width, height, revision, needsLogin };
        return request.source?.revision === revision ? { source } : { source, image: data };
      }
      if (Date.now() >= deadline || screen.token !== token || request.source?.token !== token || request.source.width !== width || request.source.height !== height) {
        throw Error('The web page changed. Try the action again.');
      }
      if (this.guest(request) !== wc) throw Error('The web page changed. Try the action again.');
      const input = request.input;
      this.remoteWorkspace.set(wc, request.wsId);
      if (input?.type === 'file') return attachFile(wc, request.file);
      if (input?.type === 'login') {
        let url;
        try { url = new URL(input.url); } catch {}
        if (!url || url.origin !== this.localOrigins.get(wc) || url.username || url.password ||
            ![401, 403].includes(this.responses.get(wc))) throw Error('Use the startup link for this local service.');
        await wc.loadURL(url.href);
        return true;
      }
      if (input?.type === 'text' && typeof input.text === 'string' && input.text.length <= 16384) {
        return command('Input.insertText', { text: input.text });
      }
      if (input?.type === 'key' && Object.hasOwn(keys, input.key)) {
        const key = input.key, info = { key, windowsVirtualKeyCode: keys[key], modifiers: input.shift === true ? 8 : 0 };
        await command('Input.dispatchKeyEvent', { ...info, type: 'keyDown', ...(key === 'Enter' ? { text: '\r' } : {}) });
        return command('Input.dispatchKeyEvent', { ...info, type: 'keyUp' });
      }
      if (![input?.x, input?.y].every(n => Number.isFinite(n) && n >= 0 && n < 1)) throw Error('Invalid web pane gesture.');
      const point = { x: input.x * width, y: input.y * height };
      if (input.type === 'click') {
        await command('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', clickCount: 1 });
        return command('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
      }
      if (input.type === 'scroll' && [input.dx, input.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 2000)) {
        return command('Input.dispatchMouseEvent', { ...point, type: 'mouseWheel', deltaX: input.dx, deltaY: input.dy });
      }
      throw Error('Unsupported web pane gesture.');
    });
    screen.queue = work.catch(() => {}).finally(() => {
      if (--screen.pending) return;
      screen.release = setTimeout(() => {
        if (screen.ownsDebugger && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
        screen.ownsDebugger = false;
      }, 4000);
      screen.release.unref();
    });
    return work;
  }
}
module.exports = { SharedWeb };
