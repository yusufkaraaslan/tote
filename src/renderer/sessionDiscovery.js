// A phone starts a host session, not a desktop layout. Desktop viewers place
// unreferenced sessions using the host's revision checks, never a blind save.
(function (root) {
  const T = typeof module !== 'undefined' && module.exports ? require('./layout') : root.TileTree;
  const groups = v => v?.groups || (v?.tiling ? [v.tiling] : []);
  function plan(snapshot, sessions, workspaceIds) {
    if (snapshot?.protocol !== 1) return [];
    const views = snapshot.views || {}, used = new Set();
    for (const v of Object.values(views)) for (const g of groups(v)) {
      for (const l of T.leaves(g.tree)) if (l.kind === 'term') used.add(l.ref);
    }
    const next = new Map();
    for (const s of [...sessions].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!s.alive || s.kind !== 'agent' || used.has(s.id) || !workspaceIds.includes(s.wsId)) continue;
      used.add(s.id);
      let v = next.get(s.wsId);
      if (!v) {
        v = JSON.parse(JSON.stringify(views[s.wsId] || { tabs: [] }));
        next.set(s.wsId, v);
        if (!v.groups) {
          let serial = 0;
          const base = v.tiling || T.migrate(v, () => 'session-layout-' + s.id + '-' + serial++, { w: 1400, h: 800 });
          v.groups = [{ ...base, id: 'session-group-' + s.id, name: '1' }];
          delete v.tiling; delete v.layout;
        }
        if (!v.groups.length) v.groups.push({ id: 'session-group-' + s.id, name: '1', tree: null });
        if (!v.groups.some(g => g.id === v.activeGroup)) v.activeGroup = v.groups[0].id;
      }
      const g = v.groups.find(g => g.id === v.activeGroup), leaves = T.leaves(g.tree);
      const content = leaves.filter(l => l.kind !== 'files');
      const target = content.find(l => l.id === g.focus) || content.at(-1);
      const node = T.leaf('session-pane-' + s.id, 'term', s.id);
      g.tree = target ? T.splitLeaf(g.tree, target.id, node, content.length % 2 ? 'row' : 'col')
        : T.insertRoot(g.tree, node, 'right', 1 - (v.filesRatio || 0.23));
      if (!g.focus) g.focus = node.id;
    }
    return [...next].map(([wsId, value]) => ({ wsId, value, revision: snapshot.revisions[wsId] ?? null }));
  }
  function create({ read, list, write, refresh, available, workspaceIds }) {
    let running = false, previous = new Set();
    return { async poll() {
      if (running || !available()) return;
      running = true;
      try {
        const [snapshot, sessions] = await Promise.all([read(), list()]);
        if (!available() || snapshot?.protocol !== 1) return;
        // Let a desktop's ordinary debounced layout save arrive first. Two
        // observations also avoid briefly adopting a session being closed.
        const candidates = sessions.filter(s => previous.has(s.id));
        previous = new Set(sessions.filter(s => s.alive).map(s => s.id));
        const changes = plan(snapshot, candidates, workspaceIds());
        if (!changes.length) return;
        await write({ changes });
        // A lost CAS race is harmless: another viewer may have placed it.
        // Always reread; never turn automatic placement into a local draft.
        await refresh();
      } finally { running = false; }
    } };
  }
  const api = { plan, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionDiscovery = api;
})(typeof window !== 'undefined' ? window : globalThis);
