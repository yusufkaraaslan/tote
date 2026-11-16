const test = require('node:test'), assert = require('node:assert/strict');
const { runtimeStatus, auditStatus, releaseFeed } = require('./dependency-health');
const releases = ['45.0.0', '44.3.1', '43.2.0', '45.3.3', '37.10.3', '46.0.0-beta.1', '44.3.1'].map(version => ({ version }));

test('Electron support uses the latest three stable majors, latest minor and patch, regardless of feed ordering', () => {
  assert.deepEqual(runtimeStatus(releases, '45.3.3').supported, ['45.3.3', '44.3.1', '43.2.0']);
  assert.equal(runtimeStatus(releases, '44.3.1').healthy, true);
  assert.equal(runtimeStatus(releases, '37.10.3').supportedLine, false);
  assert.equal(runtimeStatus(releases, '45.0.0').supportedMinor, false);
  assert.equal(runtimeStatus(releases, '45.3.2').healthy, false);
  assert.equal(runtimeStatus(releases, '46.0.0').healthy, false);
  for (const data of [null, [], [{ version: '45.3.3' }]]) assert.throws(() => runtimeStatus(data, '37.10.3'));
});

test('audits include development dependencies and never treat missing/failed evidence as clean', () => {
  const counts = { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 };
  const result = c => ({ status: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: c } }) });
  assert.equal(auditStatus(result(counts)).healthy, true);
  assert.equal(auditStatus(result({ ...counts, critical: 1, total: 2 })).healthy, false);
  assert.equal(auditStatus(result({ ...counts, high: 1, total: 2 })).healthy, false);
  for (const bad of [{ status: null, signal: 'SIGTERM' }, { status: 2 }, { status: 0, stdout: '{}' },
    { status: 1, stdout: '{"error":{"code":"ENOAUDIT"}}' }, result({ ...counts, high: -1 }), result({ ...counts, total: 9 })])
    assert.throws(() => auditStatus(bad));
});

test('release feed fails on HTTP, malformed JSON and oversized responses', async () => {
  assert.deepEqual(await releaseFeed(async () => new Response(JSON.stringify(releases))), releases);
  await assert.rejects(releaseFeed(async () => new Response('', { status: 503 })));
  await assert.rejects(releaseFeed(async () => new Response('not json')));
  await assert.rejects(releaseFeed(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))), /8 MiB/);
  await assert.rejects(releaseFeed(async () => { throw Error('offline'); }), /offline/);
});
