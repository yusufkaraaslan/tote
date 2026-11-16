// Ask every local viewer to flush layouts and freeze editing before replacement.
// A crashed/unresponsive viewer, navigation, or a newly opened window fails closed.
const crypto = require('node:crypto');
function createGuard({ onReply, windows, confirm, timeout = 15000 }) {
  let active = null;
  onReply((event, token, clean) => {
    if (active?.token !== token || !active.pending.has(event.sender.id)) return;
    active.pending.delete(event.sender.id);
    if (clean !== true) active.fail(Error('Save documents and resolve unsaved layouts in every window and device before updating.'));
    else if (!active.pending.size) active.pass();
  });
  return async () => {
    if (active) throw Error('An installation is already being confirmed.');
    if (!await confirm()) return null;
    const viewers = windows(), token = crypto.randomUUID();
    let timer, changed = false;
    const invalidated = () => { changed = true; };
    for (const win of viewers) {
      win.webContents.on('did-start-navigation', invalidated);
      win.webContents.on('render-process-gone', invalidated);
    }
    const unlock = () => {
      clearTimeout(timer);
      for (const win of viewers) if (!win.isDestroyed()) {
        win.webContents.removeListener('did-start-navigation', invalidated);
        win.webContents.removeListener('render-process-gone', invalidated);
        win.webContents.send('updates:guard', { token, release:true });
      }
      active = null;
    };
    unlock.assert = () => {
      if (changed || windows().some(w => !viewers.includes(w)) || viewers.some(w => w.isDestroyed())) throw Error('The open windows changed. Try again.');
    };
    try {
      await new Promise((resolve, reject) => {
        active = { token, pending:new Set(viewers.map(w => w.webContents.id)), pass:resolve, fail:reject };
        timer = setTimeout(() => reject(Error('A window did not respond. Save your work and try again.')), timeout);
        if (!viewers.length) return reject(Error('No viewer is available to confirm installation.'));
        for (const win of viewers) win.webContents.send('updates:guard', { token });
      });
      unlock.assert();
      return unlock;
    } catch (error) { unlock(); throw error; }
  };
}
module.exports = { createGuard };
