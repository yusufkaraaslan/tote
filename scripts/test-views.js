const test = require('node:test');
const assert = require('node:assert/strict');
const { Views } = require('../src/host/views');
const { create } = require('../src/renderer/viewsync');
const copy = value => JSON.parse(JSON.stringify(value));
const layout = name => ({ tabs: [{ id: name, providerId: 'p' }], groups: [{ id: name, tree: null }] });
function host(initial = { a: layout('original'), b: layout('other') }) {
  let data = copy(initial), saves = 0;
  const cfg = { getViews: () => data, saveViews: value => { data = copy(value); saves++; } };
  return { service: new Views(cfg, id => ['a', 'b'].includes(id)), data: () => copy(data), saves: () => saves };
}
function client(t, h, extra = {}) {
  const c = create({ read: async () => h.service.snapshot(), write: async p => h.service.patch(p), delay: 10000, ...extra });
  t.after(() => c.dispose());
  return c;
}
function change(c, id, value) { const v = c.views(); v[id] = value; c.edit(v); }

test('two stale viewers edit different workspaces without replacing the collection', async t => {
  const h = host(), a = client(t, h), b = client(t, h);
  await Promise.all([a.refresh(), b.refresh()]);
  change(a, 'a', layout('window-a')); change(b, 'b', layout('window-b'));
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(h.data().a.tabs[0].id, 'window-a');
  assert.equal(h.data().b.tabs[0].id, 'window-b');
  assert.equal(a.status().pending + b.status().pending, 0);
});

test('same-workspace conflict preserves both sides and requires explicit resolution', async t => {
  const h = host(), a = client(t, h), b = client(t, h);
  await Promise.all([a.refresh(), b.refresh()]);
  change(a, 'a', layout('winner')); change(b, 'a', layout('local-draft'));
  await a.flush(); await b.flush();
  assert.equal(h.data().a.tabs[0].id, 'winner');
  assert.equal(b.views().a.tabs[0].id, 'local-draft');
  assert.deepEqual(b.status().conflicts, ['a']);
  await b.refresh(); await b.flush();
  assert.equal(h.saves(), 1, 'conflicts must not retry as unconditional writes');
  assert.ok(b.resolve('a', 'saved'));
  assert.equal(b.views().a.tabs[0].id, 'winner');
});

test('conflict does not strand edits to another workspace in the same batch', async t => {
  const h = host(), c = client(t, h);
  await c.refresh();
  change(c, 'a', layout('draft-a')); change(c, 'b', layout('draft-b'));
  h.service.patch({ changes: [{ wsId: 'a', revision: h.service.snapshot().revisions.a, value: layout('remote-a') }] });
  await c.flush();
  assert.equal(h.data().a.tabs[0].id, 'remote-a');
  assert.equal(h.data().b.tabs[0].id, 'draft-b');
  assert.deepEqual(c.status().conflicts, ['a']);
});

test('explicit replacement still checks for intervening changes', async t => {
  const h = host(), c = client(t, h);
  await c.refresh(); change(c, 'a', layout('mine'));
  const remoteChange = name => h.service.patch({ changes: [{ wsId: 'a', revision: h.service.snapshot().revisions.a, value: layout(name) }] });
  remoteChange('theirs'); await c.flush();
  assert.ok(c.resolve('a', 'local'));
  remoteChange('newer'); await c.flush();
  assert.deepEqual(c.status().conflicts, ['a']);
  assert.equal(h.data().a.tabs[0].id, 'newer');
  c.resolve('a', 'local'); await c.flush();
  assert.equal(h.data().a.tabs[0].id, 'mine');
});

test('an edit made while a save is in flight is rebased on its acknowledgement', async t => {
  const h = host(); let release, sends = 0;
  const c = client(t, h, { write: async patch => {
    const result = h.service.patch(patch);
    if (++sends === 1) await new Promise(r => { release = r; });
    return result;
  } });
  await c.refresh(); change(c, 'a', layout('first'));
  const pending = c.flush(); await new Promise(r => setImmediate(r));
  change(c, 'a', layout('second')); c.flush(); release(); await pending;
  assert.equal(h.data().a.tabs[0].id, 'second');
  assert.equal(c.status().pending, 0);
});

test('reconnect after a lost acknowledgement recognizes the committed layout without resending', async t => {
  const h = host(); let sends = 0;
  const c = client(t, h, { write: async p => { sends++; h.service.patch(p); throw new Error('connection lost'); } });
  await c.refresh(); change(c, 'a', layout('committed')); await c.flush();
  assert.match(c.status().error, /connection lost/);
  await c.refresh();
  assert.equal(c.status().pending, 0); assert.equal(sends, 1);
});

test('unsaved document protection keeps the local layout on remote removal or retargeting', async t => {
  const h = host(); let dirty = true;
  const c = client(t, h, { protect: id => id === 'a' && dirty });
  await c.refresh();
  h.service.patch({ changes: [{ wsId: 'a', revision: h.service.snapshot().revisions.a, value: null }] });
  await c.refresh();
  assert.ok(c.views().a); assert.deepEqual(c.status().conflicts, ['a']);
  assert.equal(c.resolve('a', 'saved'), false);
  dirty = false; assert.ok(c.resolve('a', 'saved'));
  assert.equal(c.views().a, undefined);
});

test('device controllers retain their destinations across debounce and delayed replies', async t => {
  const first = host(), second = host(); const destinations = []; let release;
  const a = client(t, first, { delay: 0, write: async p => {
    destinations.push('first'); await new Promise(r => { release = r; }); return first.service.patch(p);
  } });
  const b = client(t, second, { delay: 0, write: async p => { destinations.push('second'); return second.service.patch(p); } });
  await a.refresh(); await b.refresh();
  change(a, 'a', layout('first-device')); const pending = a.flush();
  await new Promise(r => setImmediate(r));
  change(b, 'a', layout('second-device')); await b.flush(); release(); await pending;
  assert.deepEqual(destinations, ['first', 'second']);
  assert.equal(first.data().a.tabs[0].id, 'first-device'); assert.equal(second.data().a.tabs[0].id, 'second-device');
});

test('older hosts allow local layouts but never receive unsafe saves', async t => {
  const h = host(); let writes = 0;
  const c = client(t, h, { read: async () => ({ protocol: 0, views: h.data() }), write: async () => { writes++; } });
  await c.refresh(); change(c, 'a', layout('temporary')); await c.flush();
  assert.equal(writes, 0); assert.equal(c.status().supported, false);
  assert.equal(c.views().a.tabs[0].id, 'temporary');
});

test('legacy whole-map saves are diffed from the reader baseline and reject stale changes', () => {
  const h = host(), a = { viewsBaseline: h.service.snapshot() }, b = { viewsBaseline: h.service.snapshot() };
  const one = copy(a.viewsBaseline.views), two = copy(b.viewsBaseline.views);
  one.a = layout('a-new'); two.b = layout('b-new');
  h.service.legacy(a, one); h.service.legacy(b, two);
  assert.equal(h.data().a.tabs[0].id, 'a-new'); assert.equal(h.data().b.tabs[0].id, 'b-new');
  two.b = layout('b-again'); h.service.legacy(b, two);
  assert.equal(h.data().a.tabs[0].id, 'a-new', 'a legacy save must not claim to have seen merged changes');
  two.a = layout('stale');
  assert.throws(() => h.service.legacy(b, two), /changed in another viewer/);
  // A third viewer changed a after b's last accepted save.
  h.service.patch({ changes: [{ wsId: 'a', revision: h.service.snapshot().revisions.a, value: layout('newest') }] });
  assert.throws(() => h.service.legacy(b, two), /changed in another viewer/);
  assert.throws(() => h.service.legacy({}, {}), /Read layouts/);
  assert.equal(h.data().a.tabs[0].id, 'newest');
});

test('restart preserves revision checks, removed workspaces cannot be resurrected, and malformed patches fail', () => {
  const h = host(), baseline = h.service.snapshot();
  const restarted = host(h.data());
  assert.deepEqual(restarted.service.snapshot().revisions, baseline.revisions);
  assert.equal(h.service.patch({ changes: [{ wsId: 'removed', revision: null, value: layout('bad') }] }).ok, false);
  for (const changes of [[{ wsId: '__proto__', revision: null, value: {} }],
    [{ wsId: 'a', value: {} }], [{ wsId: 'a', revision: null, value: [] }]]) {
    assert.throws(() => h.service.patch({ changes }), /Invalid workspace/);
  }
  assert.equal(h.saves(), 0);
});
