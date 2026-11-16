// Parse each chunk at the host's grid size. xterm writes are asynchronous:
// resizing immediately when a later packet arrives would reflow earlier bytes
// before they have even been parsed. Shared by desktop and Android viewers.
(function (root) {
  function create(term, { onSize = () => {}, onParsed = () => {} } = {}) {
    const queue = [];
    let busy = false, disposed = false, active = null;
    function next() {
      if (busy || disposed || !queue.length) return;
      busy = true;
      const entry = active = queue.shift(), p = entry.packet;
      if (p.replay) term.reset();
      if (Number.isInteger(p.cols) && Number.isInteger(p.rows) && p.cols > 0 && p.rows > 0) {
        if (term.cols !== p.cols || term.rows !== p.rows) term.resize(p.cols, p.rows);
        onSize(p);
      }
      const done = () => {
        if (disposed) return;
        onParsed(p);
        entry.resolve(); active = null;
        busy = false;
        next();
      };
      if (p.data) term.write(p.data, done);
      else done();
    }
    return {
      write(p) {
        if (disposed) return Promise.resolve();
        // A fresh host snapshot supersedes queued output from the old link.
        // Let the active parse finish before reset, but never accumulate old
        // queues across reconnects if a parser is exceptionally slow.
        if (p.replay) { for (const entry of queue) entry.resolve(); queue.length = 0; }
        return new Promise(resolve => { queue.push({ packet: p, resolve }); next(); });
      },
      dispose() { disposed = true; active?.resolve(); for (const entry of queue) entry.resolve(); queue.length = 0; },
    };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TermStream = api;
})(typeof window !== 'undefined' ? window : globalThis);
