const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, create } = require('../src/renderer/sessionDiscovery');
const T = require('../src/renderer/layout');
const { Views } = require('../src/host/views');
const session = (id, wsId = 'w') => ({ id, wsId, kind: 'agent', alive: true });
function store(views = {}) {
  let data = views;
  return new Views({ getViews: () => data, saveViews: v => { data = v; } }, () => true);
}
test('places live sessions in their workspace, preserves files dock, focus and other groups', () => {
  const files = T.leaf('f', 'files'), doc = T.leaf('d', 'doc', 'doc');
  const db = store({ w: { tabs: [], docs: [{ id: 'doc', path: 'note.md' }], activeGroup: 'a',
    groups: [{ id: 'a', tree: T.split('row', 0.2, files, doc), focus: 'd' },
      { id: 'b', tree: T.leaf('old', 'term', 'placed') }] }, other: { groups: [] } });
  const snapshot = db.snapshot(), before = JSON.stringify(snapshot);
  const changes = plan(snapshot, [session('new'), session('placed'), session('remote', 'other'),
    { ...session('dead'), alive: false }, { ...session('auth'), kind: 'connect' }, session('removed', 'gone')], ['w', 'other']);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(db.patch({ changes }).ok, true);
  const v = db.snapshot().views.w;
  assert.deepEqual(v.groups[0].tree.a, files); assert.equal(v.groups[0].tree.ratio, 0.2);
  assert.equal(v.groups[0].focus, 'd'); assert.deepEqual(v.docs, snapshot.views.w.docs);
  assert.deepEqual(v.groups[1], snapshot.views.w.groups[1]);
  assert.deepEqual(T.leaves(v.groups[0].tree).map(l => l.ref), [undefined, 'doc', 'new']);
  assert.deepEqual(plan(db.snapshot(), [session('new'), session('placed'), session('remote', 'other')], ['w', 'other']), []);
});
test('legacy tabs and single tiling survive discovery', () => {
  for (const value of [{ tabs: [{ id: 'tab', providerId: 'claude' }] }, { tiling: { tree: T.leaf('tab-leaf', 'web', 'tab') } }]) {
    const db = store({ w: value }); db.patch({ changes: plan(db.snapshot(), [session('new')], ['w']) });
    const v = db.snapshot().views.w;
    assert.deepEqual(T.leaves(v.groups[0].tree).map(l => l.ref), ['tab', 'new']);
  }
});
test('two viewers converge on one leaf; CAS conflicts preserve concurrent edits', async () => {
  const db = store(), sessions = [session('phone')]; let refreshes = 0, allowed = true;
  const worker = () => create({ read: async () => db.snapshot(), list: async () => sessions,
    write: async p => db.patch(p), refresh: async () => refreshes++, available: () => allowed, workspaceIds: () => ['w'] });
  const a = worker(), b = worker();
  await Promise.all([a.poll(), b.poll()]); assert.deepEqual(db.snapshot().views, {});
  await Promise.all([a.poll(), b.poll()]);
  assert.equal(T.leaves(db.snapshot().views.w.groups[0].tree).length, 1); assert.equal(refreshes, 2);
  sessions.push(session('second')); allowed = false; await a.poll(); assert.equal(refreshes, 2);
  allowed = true;
  const c = create({ read: async () => db.snapshot(), list: async () => sessions, available: () => true, workspaceIds: () => ['w'],
    refresh: async () => {}, write: async patch => {
      const snap = db.snapshot(), value = snap.views.w; value.groups[0].name = 'User edit';
      db.patch({ changes: [{ wsId: 'w', revision: snap.revisions.w, value }] });
      assert.equal(db.patch(patch).ok, false);
    } });
  await c.poll(); await c.poll();
  assert.equal(db.snapshot().views.w.groups[0].name, 'User edit');
  assert.equal(T.leaves(db.snapshot().views.w.groups[0].tree).length, 1);
});
test('a pending read cannot write after the selected device becomes unavailable', async () => {
  let resolve, available = true, writes = 0;
  const c = create({ read: () => new Promise(r => { resolve = r; }), list: async () => [session('phone')],
    available: () => available, workspaceIds: () => ['w'], write: async () => writes++, refresh: async () => {} });
  const pending = c.poll(); available = false; resolve(store().snapshot()); await pending;
  assert.equal(writes, 0);
});
