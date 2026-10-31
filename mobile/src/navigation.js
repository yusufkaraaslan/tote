// Phone navigation stays in one drawer, with groups nested under their space.
export function createNavigation({ onSpace, onGroup, onPane }) {
  const panel = document.getElementById('navigation');
  const list = document.getElementById('navigation-list');
  const toggle = document.getElementById('nav-toggle');
  const workspace = document.getElementById('workspace');
  let signature = '', returnFocus;
  function close() {
    panel.hidden = true; workspace.inert = false; toggle.setAttribute('aria-expanded', 'false');
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function open() {
    returnFocus = document.activeElement; panel.hidden = false; workspace.inert = true;
    toggle.setAttribute('aria-expanded', 'true'); document.getElementById('nav-close').focus();
  }
  toggle.onclick = open;
  document.getElementById('context').onclick = open;
  document.getElementById('pane-context').onclick = open;
  document.getElementById('nav-close').onclick = close;
  document.getElementById('nav-scrim').onclick = close;
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key !== 'Tab') return;
    const buttons = [...panel.querySelectorAll('aside button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  function update({ spaces, groups, wsId, groupId, paneId, device, disabled }) {
    document.getElementById('nav-device').textContent = device || 'Connecting…';
    const model = spaces.map(w => ({ id:w.id, name:w.name, groups:w.id === wsId ? groups.map(g => ({
      id:g.id, name:g.name, panes:g.panes.map(p => ({id:p.id,title:p.title,kind:p.kind,unavailable:p.unavailable})),
    })) : [] }));
    const next = JSON.stringify([model,wsId,groupId,paneId,disabled]);
    if (next === signature) return;
    signature = next;
    const focused = document.activeElement?.dataset.navKey;
    const fragment = document.createDocumentFragment();
    function row(kind, id, title, active, action) {
      const button = document.createElement('button'); button.className = 'nav-' + kind;
      button.dataset[kind] = id; button.dataset.navKey = kind + ':' + id;
      button.textContent = title; button.disabled = disabled;
      if (active) button.setAttribute('aria-current','true');
      button.onclick = action;
      return button;
    }
    for (const w of model) {
      const section = document.createElement('section');
      section.append(row('space',w.id,w.name,w.id === wsId,() => onSpace(w.id)));
      for (const g of w.groups) {
        const container = document.createElement('div'); container.className = 'nav-group-section';
        container.append(row('group',g.id,g.name,g.id === groupId,() => onGroup(g.id)));
        if (g.id === groupId) {
          for (const p of g.panes) container.append(row('pane',p.id,p.title + (p.unavailable ? ' · unavailable' : ''),p.id === paneId,() => { onPane(p.id); close(); }));
          if (!g.panes.length) { const empty = document.createElement('small'); empty.className='nav-empty'; empty.textContent='No panes'; container.append(empty); }
        }
        section.append(container);
      }
      fragment.append(section);
    }
    list.replaceChildren(fragment);
    if (focused && !panel.hidden) [...list.querySelectorAll('button')].find(b => b.dataset.navKey === focused)?.focus();
  }
  return { update, open, close, isOpen:() => !panel.hidden };
}
