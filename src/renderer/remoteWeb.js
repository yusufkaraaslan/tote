// One request at a time per visible pane. A frame identifies the exact guest
// and viewport an input was aimed at; never resend input after a disconnect.
(function (root) {
  function mount(container, call, active = () => true) {
    const panel = document.createElement('section');
    panel.className = 'remote-web';
    const stage = document.createElement('div');
    stage.className = 'remote-web-stage';
    stage.tabIndex = 0;
    stage.setAttribute('aria-label', 'Remote web page');
    const image = document.createElement('img');
    image.alt = 'Web page on the selected computer';
    image.draggable = false;
    image.hidden = true;
    const message = document.createElement('span');
    message.textContent = 'Connecting to the web pane…';
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.placeholder = 'Type into selected field';
    input.setAttribute('aria-label', input.placeholder);
    const insert = document.createElement('button');
    insert.textContent = 'Insert text';
    const enter = document.createElement('button');
    enter.type = 'button'; enter.textContent = 'Enter';
    stage.append(image, message);
    form.append(input, insert, enter);
    const login = document.createElement('form');
    login.hidden = true;
    const link = document.createElement('input');
    link.type = 'password'; link.autocomplete = 'off'; link.maxLength = 8192;
    link.placeholder = 'Local service startup URL';
    link.setAttribute('aria-label', link.placeholder);
    const connect = document.createElement('button');
    connect.textContent = 'Connect URL';
    login.append(link, connect);
    panel.append(stage, login, form);
    container.append(panel);
    let source = null, lastImage = null, disposed = false, timer, queue = Promise.resolve(), pending = 0;
    const visible = () => !disposed && panel.isConnected && active() && !document.hidden && panel.getClientRects().length;
    const problem = error => {
      message.textContent = /Not callable|Not a host method/.test(error.message)
        ? 'Update Tote and its background host on the selected computer to share web panes.' : error.message;
      message.hidden = false;
    };
    async function poll() {
      if (disposed || !panel.isConnected) return;
      let delay = 450;
      if (visible() && !pending) {
        try {
          const frame = await call({ source });
          if (visible()) {
            if (frame.image) {
              if (typeof frame.image !== 'string' || frame.image.length > 3 * 1024 * 1024) throw Error('Invalid web pane image.');
              const next = new Image();
              next.src = 'data:image/jpeg;base64,' + frame.image;
              await next.decode();
              if (!visible()) return;
              image.src = next.src; lastImage = frame.source.revision;
            }
            if (lastImage !== frame.source.revision) throw Error('Refreshing the web pane…');
            source = frame.source; image.hidden = false; message.hidden = true;
            login.hidden = !source.needsLogin;
            if (login.hidden) link.value = '';
          }
        } catch (e) { source = null; lastImage = null; image.hidden = true; if (visible()) problem(e); delay = 1800; }
        finally { if (!disposed) timer = setTimeout(poll, delay); }
      } else timer = setTimeout(poll, 450);
    }
    function send(action) {
      const target = source;
      if (!visible() || !target) return Promise.resolve(false);
      if (pending >= 32) {
        problem(Error('The input queue is full. Wait for the page before typing again.'));
        return Promise.resolve(false);
      }
      pending++;
      const done = queue.then(async () => {
        if (!visible() || document.body.inert || source?.token !== target.token) return false;
        await call({ source: target, input: action });
        return true;
      }).catch(e => { if (visible()) problem(e); source = null; return false; }).finally(() => { pending--; });
      queue = done;
      return done;
    }
    let contact;
    const point = e => {
      const r = image.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    image.onpointerdown = e => {
      if (!e.isPrimary || e.button !== 0) return;
      contact = { ...point(e), id: e.pointerId };
      image.setPointerCapture(e.pointerId); stage.focus();
    };
    image.onpointercancel = () => { contact = null; };
    image.onpointerup = e => {
      if (contact?.id !== e.pointerId || !source) return;
      const start = contact, end = point(e); contact = null;
      const dx = Math.round((start.x - end.x) * source.width), dy = Math.round((start.y - end.y) * source.height);
      if (Math.abs(dx) + Math.abs(dy) > 8) send({ type: 'scroll', x: start.x, y: start.y,
        dx: Math.max(-2000, Math.min(2000, dx)), dy: Math.max(-2000, Math.min(2000, dy)) });
      else send({ type: 'click', x: start.x, y: start.y });
    };
    image.onwheel = e => {
      e.preventDefault();
      send({ type: 'scroll', ...point(e), dx: Math.max(-2000, Math.min(2000, e.deltaX)), dy: Math.max(-2000, Math.min(2000, e.deltaY)) });
    };
    stage.onkeydown = e => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1) send({ type: 'text', text: e.key });
      else if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        send({ type: 'key', key: e.key, shift: e.shiftKey });
      } else return;
      e.preventDefault(); e.stopPropagation();
    };
    stage.onpaste = e => { e.preventDefault(); send({ type: 'text', text: e.clipboardData.getData('text/plain') }); };
    input.maxLength = 16384;
    form.onsubmit = async e => {
      e.preventDefault();
      const text = input.value;
      if (!text || insert.disabled) return;
      insert.disabled = true;
      try {
        if (await send({ type: 'text', text }) && !disposed && input.value === text) {
          input.value = '';
          input.dispatchEvent(new Event('input'));
        }
      } finally { insert.disabled = false; }
    };
    login.onsubmit = async e => {
      e.preventDefault();
      if (connect.disabled || !link.value) return;
      connect.disabled = true;
      const url = link.value.trim();
      try { if (await send({ type: 'login', url })) link.value = ''; }
      finally { connect.disabled = false; }
    };
    enter.onclick = () => send({ type: 'key', key: 'Enter' });
    timer = setTimeout(poll, 0);
    return { element: panel, stage, input, attach: path => send({ type: 'file', path }), dispose() { disposed = true; clearTimeout(timer); panel.remove(); } };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { mount };
  else root.RemoteWeb = { mount };
})(globalThis);
