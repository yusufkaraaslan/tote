// Mobile selection is local. Never save a narrow screen's layout to views.json.
export function tailnetAddress(value) {
  const text = String(value || '').trim();
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255) ||
      Number(parts[0]) !== 100 || Number(parts[1]) < 64 || Number(parts[1]) > 127) {
    throw new Error('Enter the computer’s Tailscale IPv4 address (100.64–127.x.x).');
  }
  return parts.map(Number).join('.');
}
export function portNumber(value) {
  const port = Number(value || 47821);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  return port;
}
export function leaves(tree) {
  if (!tree) return [];
  if (tree.type === 'leaf') return [tree];
  return [...leaves(tree.a), ...leaves(tree.b)];
}
export function workspaceGroups(view = {}, sessions = [], wsId) {
  const live = sessions.filter(s => s.wsId === wsId);
  const byId = new Map(live.map(s => [s.id, s]));
  const used = new Set();
  const groups = (view.groups || (view.tiling ? [{ ...view.tiling, id: 'legacy', name: 'Main' }] : [])).map((g, i) => ({
    id: g.id || 'group-' + i, name: g.name || String(i + 1),
    panes: leaves(g.tree).map(l => {
      if (l.kind === 'term') {
        used.add(l.ref);
        const session = byId.get(l.ref);
        return { id: l.id, kind: 'term', ref: l.ref, session, title: session?.title || 'Ended terminal', unavailable: !session };
      }
      if (l.kind === 'doc') {
        const doc = view.docs?.find(d => d.id === l.ref);
        return { id: l.id, kind: 'doc', path: doc?.path, title: doc?.path?.split('/').pop() || 'Document', unavailable: !doc };
      }
      return { id: l.id, kind: l.kind, title: l.kind === 'files' ? 'Files' : 'Web tab (desktop)' };
    }),
  }));
  const other = live.filter(s => !used.has(s.id));
  if (other.length) groups.push({ id: '_sessions', name: 'Other terminals', panes: other.map(s => ({ id: s.id, ref: s.id, kind: 'term', title: s.title || 'Terminal', session: s })) });
  return groups.length ? groups : [{ id: '_empty', name: 'Main', panes: [] }];
}
export function chooseSelection(groups, preferredGroup, preferredPane, preferLive = false) {
  let group = groups.find(g => g.id === preferredGroup) || groups[0];
  const running = p => p.kind === 'term' && !p.unavailable && p.session?.alive !== false;
  const remembered = group?.panes.find(p => p.id === preferredPane && !p.unavailable && (p.kind !== 'term' || running(p)));
  // On entry, use a running terminal if the saved selection is gone. Persisted
  // desktop groups can contain only old session ids after a host restart.
  // Keep an explicitly remembered document/files pane, and keep every group
  // available for manual selection even when it is empty.
  if (preferLive && !remembered) {
    group = (group?.panes.some(running) ? group : groups.find(g => g.panes.some(running))) || group;
  }
  const pane = remembered || (preferLive && group?.panes.find(running)) ||
    group?.panes.find(p => p.id === preferredPane) || group?.panes.find(p => !p.unavailable) || group?.panes[0];
  return { group, pane };
}
export function draftKey(device, ws, sid) { return JSON.stringify([device, ws, sid]); }
