// Destructive only to a fresh, explicitly selected emulator fixture. Never a phone.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
function main() {
  const out = path.resolve(__dirname, '../reports/releases'); fs.mkdirSync(out, { recursive: true });
  fs.rmSync(path.join(out, 'android-upgrade.json'), { force: true });
  const [serial, previous, candidate] = process.argv.slice(2);
  if (!/^emulator-\d+$/.test(serial || '') || !previous || !candidate) throw Error('Usage: node scripts/test-android-upgrade.js emulator-PORT previous.apk candidate.apk');
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw Error('Android SDK is required');
  const adb = (...args) => execFileSync(path.join(sdk, 'platform-tools', 'adb'), ['-s', serial, ...args], { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(adb('shell', 'getprop', 'ro.kernel.qemu'), '1', 'physical devices are refused');
  assert(!adb('shell', 'pm', 'list', 'packages', 'com.tote.mobile').split('\n').includes('package:com.tote.mobile'), 'use a fresh emulator; existing Tote data is never removed');
  const api = Number(adb('shell', 'getprop', 'ro.build.version.sdk'));
  assert(api >= 33, 'production migration requires Android 13+');
  const marker = 'upgrade-' + crypto.randomUUID();
  let installed = false;
  try {
    assert.match(adb('install', path.resolve(previous)), /Success/); installed = true;
    adb('shell', 'run-as', 'com.tote.mobile', 'sh', '-c', `'mkdir -p files; echo ${marker} > files/tote-upgrade-fixture'`);
    assert.match(adb('install', '-r', path.resolve(candidate)), /Success/);
    assert.throws(() => adb('shell', 'run-as', 'com.tote.mobile', 'id'), 'production APK must not allow run-as');
    adb('root'); adb('wait-for-device');
    assert.equal(adb('shell', 'id', '-u'), '0', 'test image must support root for fixture verification');
    assert.equal(adb('shell', 'cat', '/data/user/0/com.tote.mobile/files/tote-upgrade-fixture'), marker, 'existing app data survives');
    assert.match(adb('shell', 'am', 'start', '-W', '-n', 'com.tote.mobile/.MainActivity'), /Status: ok/);
    assert(adb('shell', 'pidof', 'com.tote.mobile'), 'updated app starts');
    const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const report = { checkedAt: new Date().toISOString(), emulatorApi: api, previousSha256: hash(previous), candidateSha256: hash(candidate),
      inPlaceUpgrade: true, appDataPreserved: true, candidateNotDebuggable: true, launch: true, physicalDeviceVerified: false };
    fs.writeFileSync(path.join(out, 'android-upgrade.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Android emulator upgrade passed: in-place install, preserved app data, non-debuggable candidate and launch. Physical-device verification remains pending.');
  } finally { if (installed) adb('uninstall', 'com.tote.mobile'); }
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
