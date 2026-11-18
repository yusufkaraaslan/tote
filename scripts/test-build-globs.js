// Exercise actual builder consumers when overriding their vulnerable glob library.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const builder = createRequire(require.resolve('app-builder-lib/package.json'));
const universal = createRequire(builder.resolve('@electron/universal/package.json'));
const asar = createRequire(builder.resolve('@electron/asar/package.json'));
const { FileMatcher } = builder('./out/fileMatcher');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-build-globs-'));
try {
  const files = ['src/main/main.js', 'src/renderer/vendor/xterm.js', 'src/.hidden',
    'src/renderer/ünicode.js', 'config/settings.json', 'package.json', 'release.json',
    'docs/private.md', '.env', 'reports/private.json', 'node_modules/node-pty/build/pty.node'];
  for (const name of files) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  const config = require('../package.json').build;
  const matcher = new FileMatcher(dir, path.join(dir, 'out'), value => value, config.files);
  const filter = matcher.createFilter();
  const selected = files.filter(name => filter(path.join(dir, name), fs.statSync(path.join(dir, name))));
  assert.deepEqual(selected, files.slice(0, 7), 'builder includes source/assets and excludes unrelated files');
  assert(filter(path.join(dir, 'src'), fs.statSync(path.join(dir, 'src'))), 'partial directory matches permit traversal');
  const excluded = new FileMatcher(dir, path.join(dir, 'out'), value => value, ['src/**/*', '!src/renderer/**/*']).createFilter();
  assert(excluded(path.join(dir, files[0]), fs.statSync(path.join(dir, files[0]))));
  assert(!excluded(path.join(dir, files[1]), fs.statSync(path.join(dir, files[1]))), 'negated patterns retain exclusion semantics');
  for (const pattern of config.asarUnpack) assert(builder('minimatch').minimatch(files[10], pattern));
  assert(universal('minimatch').minimatch('nested/native.node', '*.node', { matchBase: true }));
  assert(!universal('minimatch').minimatch('nested/private.txt', '*.node', { matchBase: true }));
  // ASAR 3 still calls minimatch as a function; do not override that older API.
  assert.equal(typeof asar('minimatch'), 'function');
  assert(asar('minimatch')('native/pty.node', '**/*.node'));
  const probe = spawnSync(process.execPath, ['-e',
    "new (require(process.argv[1]).Minimatch)('**/../'.repeat(24)+'x',{optimizationLevel:2})", builder.resolve('minimatch')],
    { timeout: 5000, encoding: 'utf8' });
  assert.ifError(probe.error); assert.equal(probe.status, 0, probe.stderr);
  console.log('Build glob consumers passed: source selection, exclusions, partial directories, native unpacking, universal matchBase, legacy ASAR API and bounded amplification.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
