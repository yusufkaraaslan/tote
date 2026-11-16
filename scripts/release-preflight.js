// Read-only preparation for a signed build. Never reads secret values or publishes.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { check } = require('./release-version');
const REPO = 'yusufkaraaslan/tote';
const SIGNING_SECRETS = [
  'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
  'ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD',
];
const MANUAL = [
  'Verify production signatures/notarization and the existing Android signing identity.',
  'Record real provider login, OAuth, PDF/download and native Downloads-bridge checks.',
  'Verify sign-in startup, power behavior, phone discovery/voice/save and signed installed-app upgrades.',
  'Review the exact signed artifacts and checksums before explicitly publishing the draft.',
];

async function inspect({ sha, dirty, release, api }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Invalid candidate commit');
  const report = { version: release.version, commit: sha, checkedAt: new Date().toISOString(), checks: [], manualVerification: MANUAL };
  const add = (name, ok, detail) => report.checks.push({ name, status: ok ? 'pass' : 'blocked', detail });
  const read = async (name, endpoint, evaluate) => {
    try { evaluate(await api(endpoint)); }
    catch { report.checks.push({ name, status: 'unknown', detail: 'Evidence unavailable or malformed. Check GitHub access and configuration; this is not a pass.' }); }
  };
  add('Working tree', !dirty, dirty ? 'Commit or set aside local changes before preparing a release.' : 'Clean candidate checkout.');
  await read('Main ancestry', `/compare/main...${sha}`, result => {
    if (!['identical', 'behind', 'ahead', 'diverged'].includes(result.status)) throw Error('Invalid comparison');
    add('Main ancestry', ['identical', 'behind'].includes(result.status), 'Production candidates must already be in main history.');
  });
  for (const [name, workflow] of [['Validation', 'validation.yml'], ['Packaging', 'release.yml']]) {
    await read(name, `/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`, result => {
      if (!Array.isArray(result.workflow_runs) || !Number.isInteger(result.total_count)) throw Error('Invalid runs');
      // Include reruns of older run IDs: the latest activity must pass.
      const runs = result.workflow_runs.filter(r => r.head_sha === sha && ['push', 'pull_request', 'workflow_dispatch'].includes(r.event));
      if (runs.some(r => !Number.isSafeInteger(r.id) || !Number.isFinite(Date.parse(r.updated_at))
        || typeof r.status !== 'string')) throw Error('Invalid run');
      runs.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id);
      const run = runs[0];
      add(name, !!run && run.status === 'completed' && run.conclusion === 'success', run
        ? `Latest candidate run: https://github.com/${REPO}/actions/runs/${run.id} (${run.conclusion || run.status}).`
        : 'No workflow run found for this exact commit. Run validation and preview packaging on the candidate.');
    });
  }
  await read('Signing environment', '/environments/release-signing', environment => {
    if (environment.name !== 'release-signing') throw Error('Invalid environment');
    add('Signing environment', environment.deployment_branch_policy?.custom_branch_policies === true,
      'Use custom deployment rules limited to the main branch and v* tags.');
  });
  await read('Signing branch rules', '/environments/release-signing/deployment-branch-policies?per_page=100', result => {
    if (!Array.isArray(result.branch_policies) || !Number.isInteger(result.total_count)) throw Error('Invalid policies');
    const rules = result.branch_policies;
    const ok = result.total_count === 2 && rules.length === 2
      && rules.some(r => r.name === 'main' && r.type === 'branch')
      && rules.some(r => r.name === 'v*' && r.type === 'tag');
    add('Signing branch rules', ok, 'Require exactly main (branch) and v* (tag); signed-tag ancestry is checked by the workflow.');
  });
  await read('Signing secret names', '/environments/release-signing/secrets?per_page=100', result => {
    if (!Array.isArray(result.secrets) || !Number.isInteger(result.total_count) || result.total_count > result.secrets.length
      || result.secrets.some(s => typeof s.name !== 'string')) throw Error('Incomplete secret names');
    const names = new Set(result.secrets.map(s => s.name)), missing = SIGNING_SECRETS.filter(s => !names.has(s));
    add('Signing secret names', !missing.length, missing.length ? 'Missing: ' + missing.join(', ')
      : 'All required environment secret names exist. Values and certificate validity are not inspected.');
  });
  report.readyForSignedBuild = report.checks.every(c => c.status === 'pass');
  return report;
}

function summary(report) {
  return ['# Release preflight', '', `Candidate: ${report.version} at ${report.commit}`, `Checked: ${report.checkedAt}`, '',
    ...report.checks.map(c => `- ${c.status.toUpperCase()} — ${c.name}: ${c.detail}`), '',
    report.readyForSignedBuild ? 'Configuration and candidate CI checks pass. A signed build and physical verification are still required.'
      : 'Not ready for a signed build. Resolve blocked or unknown evidence first.', '',
    'This report is not publication approval and does not prove credentials work or installed upgrades succeed.', '',
    'Still verify:', ...report.manualVerification.map(s => '- ' + s), ''].join('\n');
}
async function main() {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'reports/releases'); fs.mkdirSync(out, { recursive: true });
  // A failed metadata/Git lookup must not leave yesterday's green evidence.
  for (const name of ['preflight.json', 'summary.md']) fs.rmSync(path.join(out, name), { force: true });
  const run = (file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const release = check(root);
  check(root, 'v' + release.version);
  const report = await inspect({ release, sha: run('git', ['rev-parse', 'HEAD']), dirty: !!run('git', ['status', '--porcelain']),
    api: endpoint => JSON.parse(run('gh', ['api', `repos/${REPO}${endpoint}`])) });
  fs.writeFileSync(path.join(out, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
  const text = summary(report); fs.writeFileSync(path.join(out, 'summary.md'), text); console.log(text);
  if (!report.readyForSignedBuild) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error('Release preflight could not complete. Check release metadata, Git and GitHub CLI access. No readiness claim was made.'); process.exitCode = 1; });
module.exports = { inspect, summary, SIGNING_SECRETS };
