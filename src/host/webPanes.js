// The browser lives in a local Electron window. Only an authenticated local
// connection can offer that browser or complete a request sent to it.
const { randomUUID } = require('node:crypto');

class WebPanes {
  constructor() {
    this.sources = new Map();
    this.pending = new Map();
  }

  remove(id) {
    this.sources.delete(id);
    for (const request of this.pending.values()) {
      if (request.source === id || request.viewer === id) request.finish(null, 'Web pane disconnected.');
    }
  }

  async request(ctx, operation, data) {
    const source = this.sources.values().next().value;
    if (!source) throw Error('Open Tote on the selected computer to share its web panes.');
    if (data.wsId !== ctx.wsId) throw Error('The selected workspace has changed.');
    if (this.pending.size >= 64) throw Error('The computer is busy serving web panes.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (result, error) => {
        this.pending.delete(id);
        clearTimeout(timer);
        if (error) reject(Error(error)); else resolve(result);
      };
      const timer = setTimeout(() => finish(null, 'Web pane timed out on the selected computer.'), 8000);
      this.pending.set(id, { source: source.id, viewer: ctx.viewer.id, finish });
      try { source.send('web:request', { id, operation, ...data }); }
      catch { finish(null, 'Web pane disconnected.'); }
    });
  }

  reply(ctx, { id, result, error }) {
    const pending = this.pending.get(id);
    if (pending?.source === ctx.viewer.id) pending.finish(result, error);
  }
}
module.exports = { WebPanes };
