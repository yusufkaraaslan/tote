// Parse each chunk at the host's grid size. xterm writes are asynchronous:
// resizing immediately when a later packet arrives would reflow earlier bytes
// before they have even been parsed. Shared by desktop and Android viewers.
(function (root) {
  function create(term, { onSize = () => {}, onParsed = () => {} } = {}) {
    const queue = [];
    let busy = false, disposed = false;
    function next() {
      if (busy || disposed || !queue.length) return;
      busy = true;
      const p = queue.shift();
      if (p.replay) term.reset();
      if (Number.isInteger(p.cols) && Number.isInteger(p.rows) && p.cols > 0 && p.rows > 0) {
        if (term.cols !== p.cols || term.rows !== p.rows) term.resize(p.cols, p.rows);
        onSize(p);
      }
      const done = () => {
        if (disposed) return;
        onParsed(p);
        busy = false;
        next();
      };
      if (p.data) term.write(p.data, done);
      else done();
    }
    return {
      write(p) { if (!disposed) { queue.push(p); next(); } },
      dispose() { disposed = true; queue.length = 0; },
    };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TermStream = api;
})(typeof window !== 'undefined' ? window : globalThis);
