const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version, compare } = require('../src/shared/updates');
const FEED = 'https://releases.electronjs.org/releases.json';

function runtimeStatus(releases, installed) {
  if (!Array.isArray(releases) || !version(installed)) throw Error('Invalid Electron release metadata');
  const stable = [...new Set(releases.map(r => r?.version).filter(v => version(v)))].sort((a, b) => compare(b, a));
  const latestByMajor = new Map();
  for (const v of stable) if (!latestByMajor.has(version(v)[0])) latestByMajor.set(version(v)[0], v);
  const supported = [...latestByMajor.values()].slice(0, 3);
  if (supported.length !== 3) throw Error('Incomplete Electron release feed');
  const current = version(installed), latestInLine = latestByMajor.get(current[0]);
  const supportedLine = supported.some(v => version(v)[0] === current[0]);
  const supportedMinor = supportedLine && current[1] === version(latestInLine)[1];
  return { installed, supported, latestInLine: latestInLine || null, supportedLine, supportedMinor,
    healthy: supportedMinor && installed === latestInLine };
}

function auditStatus(result) {
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw Error('npm audit failed or timed out');
  const report = JSON.parse(result.stdout);
  const counts = report.metadata?.vulnerabilities;
  if (report.error || !counts || !['info', 'low', 'moderate', 'high', 'critical', 'total'].every(k => Number.isInteger(counts[k]) && counts[k] >= 0))
    throw Error('Incomplete npm audit report');
  if (['info', 'low', 'moderate', 'high', 'critical'].reduce((n, k) => n + counts[k], 0) !== counts.total)
    throw Error('Inconsistent npm audit counts');
  return { counts, healthy: counts.high === 0 && counts.critical === 0 };
}

async function releaseFeed(fetcher = fetch) {
  const response = await fetcher(FEED, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok || !response.body) throw Error('Electron release feed unavailable');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw Error('Electron release feed exceeds 8 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const root = path.join(__dirname, '..'), out = path.join(root, 'reports/dependencies');
  fs.mkdirSync(out, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), electronFeed: FEED, audits: {} };
  for (const [name, directory] of [['desktop', root], ['mobile', path.join(root, 'mobile')]]) {
    const evidence = path.join(out, name + '-audit.json');
    fs.rmSync(evidence, { force: true });
    try {
      if (!process.env.npm_execpath) throw Error('Run through npm run dependencies:report');
      const result = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--package-lock-only', '--ignore-scripts', '--json'],
        { cwd: directory, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      if (result.stdout) fs.writeFileSync(evidence, result.stdout);
      report.audits[name] = auditStatus(result);
    } catch (error) { report.audits[name] = { healthy: false, error: error.message }; }
  }
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    report.electron = runtimeStatus(await releaseFeed(), lock.packages['node_modules/electron'].version);
  } catch (error) { report.electron = { healthy: false, error: error.message }; }
  report.healthy = report.electron.healthy && Object.values(report.audits).every(a => a.healthy);
  fs.writeFileSync(path.join(out, 'health.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['# Dependency health', '', `Checked: ${report.checkedAt}`, '',
    'Includes development dependencies: Electron ships to users even though npm classifies it as development.', ''];
  for (const [name, result] of Object.entries(report.audits)) lines.push(result.error
    ? `- ${name}: check failed; inspect health.json.`
    : `- ${name}: ${result.counts.critical} critical, ${result.counts.high} high, ${result.counts.moderate} moderate affected packages.`);
  const e = report.electron;
  lines.push(e.error ? '- Electron: check failed; inspect health.json.'
    : `- Electron ${e.installed}; latest supported lines: ${e.supported.join(', ')}; current patch on a supported line: ${e.healthy ? 'yes' : 'no'}.`,
    '', report.healthy ? 'Checks passed.' : 'Maintenance required. Review docs/dependencies.md; do not run audit fix --force or automatically merge runtime upgrades.', '');
  const summary = lines.join('\n');
  fs.writeFileSync(path.join(out, 'summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  if (!report.healthy) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runtimeStatus, auditStatus, releaseFeed };
