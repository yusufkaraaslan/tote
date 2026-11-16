const test = require('node:test'), assert = require('node:assert/strict');
const { inspect, summary, SIGNING_SECRETS } = require('./release-preflight');
const sha = 'a'.repeat(40), release = require('../release.json');
function fixture() {
  return {
    [`/compare/main...${sha}`]: { status: 'identical' },
    ...Object.fromEntries(['validation.yml', 'release.yml'].map(name => [`/actions/workflows/${name}/runs?head_sha=${sha}&per_page=100`, {
      total_count: 1, workflow_runs: [{ id: 12, head_sha: sha, status: 'completed', conclusion: 'success', event: 'push', updated_at: '2026-11-16T00:00:00Z' }],
    }])),
    '/environments/release-signing': { name: 'release-signing', deployment_branch_policy: { custom_branch_policies: true } },
    '/environments/release-signing/deployment-branch-policies?per_page=100': { total_count: 2, branch_policies: [{ name: 'main', type: 'branch' }, { name: 'v*', type: 'tag' }] },
    '/environments/release-signing/secrets?per_page=100': { total_count: SIGNING_SECRETS.length, secrets: SIGNING_SECRETS.map(name => ({ name })) },
  };
}
const inspectFixture = (data, options = {}) => inspect({ sha, release, dirty: false, api: async endpoint => data[endpoint], ...options });
test('preflight distinguishes preparation from successful signing and publication', async () => {
  const report = await inspectFixture(fixture());
  assert.equal(report.readyForSignedBuild, true);
  assert.match(summary(report), /not publication approval/);
  assert(report.manualVerification.some(s => s.includes('signed installed-app upgrades')));
});
test('Linux and Android preparation does not require macOS or Windows secrets', async () => {
  const data = fixture(), secretData = data['/environments/release-signing/secrets?per_page=100'];
  secretData.secrets = secretData.secrets.filter(s => s.name.startsWith('ANDROID_'));
  secretData.total_count = secretData.secrets.length;
  assert.equal((await inspectFixture(data, { release: { ...release, releasePlatforms: ['linux', 'android'] } })).readyForSignedBuild, true);
  assert.equal((await inspectFixture(data, { release: { ...release, releasePlatforms: ['linux', 'darwin', 'win32', 'android'] } })).readyForSignedBuild, false);
});
test('missing, malformed or inaccessible evidence never becomes a clean report or leaks error text', async () => {
  for (const endpoint of Object.keys(fixture())) {
    const data = fixture(); delete data[endpoint];
    const report = await inspectFixture(data);
    assert.equal(report.readyForSignedBuild, false, endpoint);
    assert(report.checks.some(c => c.status === 'unknown'));
  }
  const report = await inspectFixture({}, { api: async () => { throw Error('secret-value-do-not-print'); } });
  assert.equal(report.readyForSignedBuild, false);
  assert(!JSON.stringify(report).includes('secret-value-do-not-print'));
});
test('dirty or unmerged candidates, incomplete rules and missing secret names block signed preparation', async () => {
  assert.equal((await inspectFixture(fixture(), { dirty: true })).readyForSignedBuild, false);
  for (const status of ['ahead', 'diverged']) {
    const data = fixture(); data[`/compare/main...${sha}`].status = status;
    assert.equal((await inspectFixture(data)).readyForSignedBuild, false);
  }
  const data = fixture();
  data['/environments/release-signing/secrets?per_page=100'].secrets.pop();
  data['/environments/release-signing/secrets?per_page=100'].total_count--;
  const report = await inspectFixture(data);
  assert.match(summary(report), /Missing: ANDROID_KEY_PASSWORD/);
  assert.equal(report.readyForSignedBuild, false);
  const rules = fixture(); rules['/environments/release-signing/deployment-branch-policies?per_page=100'].branch_policies[0].name = '*';
  assert.equal((await inspectFixture(rules)).readyForSignedBuild, false);
});
test('CI must match the candidate and the newest run cannot be masked by older success', async () => {
  const key = `/actions/workflows/release.yml/runs?head_sha=${sha}&per_page=100`;
  for (const extra of [{ id: 13, status: 'in_progress', conclusion: null }, { id: 13, status: 'completed', conclusion: 'failure' }, { id: 11, status: 'completed', conclusion: 'failure' }]) {
    const data = fixture(); data[key].workflow_runs.push({ head_sha: sha, event: 'workflow_dispatch', updated_at: '2026-11-17T00:00:00Z', ...extra }); data[key].total_count++;
    assert.equal((await inspectFixture(data)).readyForSignedBuild, false);
  }
  const data = fixture(); data[key].workflow_runs[0].head_sha = 'b'.repeat(40);
  assert.equal((await inspectFixture(data)).readyForSignedBuild, false);
});

test('preflight secret names stay aligned with the production workflow', () => {
  const fs = require('node:fs'), path = require('node:path');
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
  const used = [...new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual([...SIGNING_SECRETS].sort(), used);
});
