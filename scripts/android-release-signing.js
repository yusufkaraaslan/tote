// Production APK signing: private credentials stay in environment variables.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { check } = require('./release-signing');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function policy(data, lineage) {
  if (data?.schema !== 1 || !Number.isInteger(data.minSdkVersion) || data.minSdkVersion < 33
    || data.minSdkVersion > 36 || ![data.certificateSha256, data.previousCertificateSha256, data.lineageSha256].every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))
    || data.certificateSha256 === data.previousCertificateSha256 || digest(lineage) !== data.lineageSha256)
    throw Error('Invalid Android production signing policy or lineage');
  return data;
}
function certificateDigests(output) {
  return [...output.matchAll(/^Signer #\d+(?: in lineage)? certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$/gm)].map(m => m[1].toLowerCase());
}
function verifyLineage(output, expected) {
  const certs = certificateDigests(output);
  if (certs.length !== 2 || certs[0] !== expected.previousCertificateSha256 || certs[1] !== expected.certificateSha256)
    throw Error('Signing history does not match approved identities');
  const first = output.split(/Signer #2 in lineage/)[0];
  if (!/Has installed data capability:\s*true/.test(first) || !/Has permission capability\s*:\s*true/.test(first)
    || !/Has rollback capability\s*:\s*false/.test(first))
    throw Error('Signing history must preserve installed data and permission trust, and forbid old-key rollback');
}
function verifyCertificate(output, expected) {
  const certs = certificateDigests(output);
  if (certs.length !== 1 || certs[0] !== expected.certificateSha256 || /certificate DN:.*Android Debug/i.test(output))
    throw Error('APK is not signed by the approved production identity');
}
function verifyManifest(output, expected, release) {
  const pkg = output.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  const sdk = output.match(/^sdkVersion:'(\d+)'/m);
  if (!pkg || pkg[1] !== 'com.tote.mobile' || pkg[2] !== String(release.androidVersionCode) || pkg[3] !== release.version
    || !sdk || Number(sdk[1]) !== expected.minSdkVersion || /^application-debuggable(?:\s|$)/m.test(output))
    throw Error('APK package, version, minimum Android version or debug flag is not approved');
}
function runner(env) {
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdk) throw Error('Android SDK is required');
  const tools = path.join(sdk, 'build-tools', '36.0.0');
  const toolEnv = env.JAVA_HOME ? { ...env, PATH: path.join(env.JAVA_HOME, 'bin') + path.delimiter + (env.PATH || '') } : env;
  return (name, args) => {
    const file = name === 'keytool' ? (env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool')
      : path.join(tools, name + (process.platform === 'win32' ? (name === 'apksigner' ? '.bat' : '.exe') : ''));
    try { return execFileSync(file, args, { env: toolEnv, timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw Error(name + ' failed; verify SDK/JDK, signing inputs and credentials. Tool output was withheld.'); }
  };
}
function verify(apk, expected, release, run) {
  verifyManifest(run('aapt', ['dump', 'badging', apk]).toString(), expected, release);
  verifyCertificate(run('apksigner', ['verify', '--verbose', '--print-certs', '--min-sdk-version', String(expected.minSdkVersion), apk]).toString(), expected);
  // Inspect the actual APK's proof, not merely the source lineage file.
  verifyLineage(run('apksigner', ['lineage', '--in', apk, '--print-certs']).toString(), expected);
}
function sign({ input, output, identity, lineage, release, env = process.env }) {
  check('android', env);
  const expected = policy(identity, fs.readFileSync(lineage)), run = runner(env);
  const cert = run('keytool', ['-exportcert', '-keystore', env.ANDROID_KEYSTORE_PATH, '-alias', env.ANDROID_KEY_ALIAS,
    '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD']);
  if (digest(cert) !== expected.certificateSha256) throw Error('Keystore identity does not match the production certificate');
  verifyLineage(run('apksigner', ['lineage', '--in', lineage, '--print-certs']).toString(), expected);
  verifyManifest(run('aapt', ['dump', 'badging', input]).toString(), expected, release);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw Error('Refusing to overwrite an existing signed artifact');
  const temporary = path.join(path.dirname(output), '.sign-' + crypto.randomUUID() + '.apk');
  try {
    run('apksigner', ['sign', '--ks', env.ANDROID_KEYSTORE_PATH, '--ks-key-alias', env.ANDROID_KEY_ALIAS,
      '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD', '--key-pass', 'env:ANDROID_KEY_PASSWORD',
      '--lineage', lineage, '--min-sdk-version', String(expected.minSdkVersion), '--rotation-min-sdk-version', '33',
      '--v1-signing-enabled', 'false', '--v2-signing-enabled', 'false', '--v4-signing-enabled', 'false',
      '--debuggable-apk-permitted', 'false', '--out', temporary, input]);
    verify(temporary, expected, release, run);
    fs.renameSync(temporary, output);
  } finally { fs.rmSync(temporary, { force: true }); }
  return expected.certificateSha256;
}
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..'), [input, output] = process.argv.slice(2);
    if (!input || !output) throw Error('Usage: node scripts/android-release-signing.js input.apk output.apk');
    const identity = JSON.parse(fs.readFileSync(path.join(root, 'mobile/signing/identity.json'), 'utf8'));
    sign({ input, output, identity, lineage: path.join(root, 'mobile/signing/production.lineage'), release: require('./release-version').check() });
    console.log('Production APK identity, signing history, metadata and non-debuggable build verified.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { policy, certificateDigests, verifyLineage, verifyCertificate, verifyManifest, runner, verify, sign };
