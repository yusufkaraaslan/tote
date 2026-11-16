// Freeze editing through an asynchronous installation boundary. Modal dialogs
// escape an ancestor's inertness, and global shortcuts still receive keyboard
// events, so body.inert alone is insufficient.
(function(root) {
  function lock(document) {
    const window = document.defaultView;
    const nodes = [document.body, ...document.querySelectorAll('dialog')];
    const previous = nodes.map(node => node.inert);
    const events = ['keydown','keypress','keyup','beforeinput','paste','cut','drop','pointerdown','mousedown','touchstart','click','submit'];
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    nodes.forEach(node => { node.inert = true; });
    events.forEach(type => window.addEventListener(type, stop, {capture:true,passive:false}));
    return () => {
      events.forEach(type => window.removeEventListener(type, stop, true));
      nodes.forEach((node,i) => { node.inert = previous[i]; });
    };
  }
  if(typeof module !== 'undefined' && module.exports) module.exports = lock;
  else root.ToteUpdateLock = lock;
})(typeof window !== 'undefined' ? window : globalThis);
