// Native signing rehearsal with disposable keys. Run where JDK 21/SDK 37.0 and build tools 36.0.0 are available.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { generateKey, rotate, fingerprint } = require('./android-signing-tools');
const { sign, runner } = require('./android-release-signing');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tote-signing-test-'));
const release = require('../release.json');
try {
  const oldFile = path.join(dir, 'old.jks'), newFile = path.join(dir, 'new.jks'), lineage = path.join(dir, 'history.bin');
  const password = 'disposable-test-credential', env = { ...process.env, ANDROID_KEYSTORE_PATH: newFile,
    ANDROID_KEYSTORE_PASSWORD: password, ANDROID_KEY_PASSWORD: password, ANDROID_KEY_ALIAS: 'current' };
  const previousCertificateSha256 = generateKey(oldFile, 'previous', password, env, 'CN=Tote CI Previous');
  const certificateSha256 = generateKey(newFile, 'current', password, env, 'CN=Tote CI Current');
  assert.deepEqual(rotate({ oldFile, oldAlias: 'previous', oldPassword: password, newFile, newAlias: 'current', newPassword: password, output: lineage, env }),
    [previousCertificateSha256, certificateSha256]);
  const identity = { schema: 1, minSdkVersion: 33, previousCertificateSha256, certificateSha256, lineageSha256: fingerprint(fs.readFileSync(lineage)) };
  execFileSync(path.join(root, 'mobile/android/gradlew'), ['-p', path.join(root, 'mobile/android'), '--no-daemon', 'testReleaseUnitTest', 'lintRelease', 'assembleRelease'],
    { env, stdio: 'inherit', timeout: 300000 });
  const input = path.join(root, 'mobile/android/app/build/outputs/apk/release/app-release.apk');
  const output = path.join(dir, 'production-test.apk');
  sign({ input, output, identity, lineage, release, env });
  assert(fs.existsSync(output));
  assert.throws(() => sign({ input, output: path.join(dir, 'wrong.apk'), identity: { ...identity, certificateSha256: '0'.repeat(64) }, lineage, release, env }), /Keystore identity/);
  assert.throws(() => sign({ input, output, identity, lineage, release, env }), /overwrite/);
  const run = runner(env);
  const info = run('apksigner', ['verify', '--verbose', '--min-sdk-version', '33', output]).toString();
  assert.match(info, /Verified using v3 scheme.*true/);
  assert(!/^application-debuggable/m.test(run('aapt', ['dump', 'badging', output]).toString()));
  console.log('Android release rehearsal passed: dedicated identity, proof of rotation, APK metadata, release flags and wrong-key rejection. Disposable keys only.');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
