const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const S = require('./android-release-signing');
const release = require('../release.json');
const lineage = Buffer.from('fixture lineage');
const identity = { schema: 1, minSdkVersion: 33, certificateSha256: 'a'.repeat(64), previousCertificateSha256: 'b'.repeat(64), lineageSha256: crypto.createHash('sha256').update(lineage).digest('hex') };
const history = `Signer #1 in lineage certificate SHA-256 digest: ${identity.previousCertificateSha256}\nHas installed data capability: true\nHas permission capability: true\nHas rollback capability      : false\nSigner #2 in lineage certificate SHA-256 digest: ${identity.certificateSha256}\n`;
const manifest = `package: name='com.tote.mobile' versionCode='${release.androidVersionCode}' versionName='${release.version}'\nsdkVersion:'33'\napplication: label='Tote'\n`;
test('production policy pins distinct identities and exact signing history bytes', () => {
  assert.equal(S.policy(identity, lineage), identity);
  for (const change of [{ minSdkVersion: 24 }, { certificateSha256: identity.previousCertificateSha256 }, { lineageSha256: '0'.repeat(64) }, { certificateSha256: null }])
    assert.throws(() => S.policy({ ...identity, ...change }, lineage));
  assert.throws(() => S.policy(identity, Buffer.from('modified')));
});
test('history must keep app data without authorizing old-key rollback or unexpected signers', () => {
  S.verifyLineage(history, identity);
  for (const output of [history.replace('capability: true', 'capability: false'), history.replace(': false', ': true'), history.replace('permission capability: true', 'permission capability: false'), history.replace(identity.previousCertificateSha256, 'c'.repeat(64)), history + `Signer #3 in lineage certificate SHA-256 digest: ${'c'.repeat(64)}\n`])
    assert.throws(() => S.verifyLineage(output, identity));
});
test('APK identity rejects a debug key, another publisher or multiple signers', () => {
  const cert = `Signer #1 certificate SHA-256 digest: ${identity.certificateSha256}\n`;
  S.verifyCertificate(cert, identity);
  for (const output of ['', cert.replace(identity.certificateSha256, identity.previousCertificateSha256), cert + 'Signer #1 certificate DN: CN=Android Debug\n', cert + cert])
    assert.throws(() => S.verifyCertificate(output, identity));
});
test('release APK must match app ID, versions and manifest minimum and must not be debuggable', () => {
  S.verifyManifest(manifest, identity, release);
  for (const output of [manifest.replace('com.tote.mobile', 'unrelated.app'), manifest.replace("sdkVersion:'33'", "sdkVersion:'24'"), manifest.replace(`versionCode='${release.androidVersionCode}'`, "versionCode='1'"), manifest + 'application-debuggable\n', 'malformed'])
    assert.throws(() => S.verifyManifest(output, identity, release));
});
test('Android update content grants use a distinct provider component and a narrow package directory', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname,'../mobile/android/app/src/main');
  const xml = fs.readFileSync(path.join(root,'AndroidManifest.xml'),'utf8');
  const providers = [...xml.matchAll(/<provider\s+([^>]+)>/g)].map(m=>m[1]);
  const components = providers.map(p=>p.match(/android:name="([^"]+)"/)[1]);
  assert.equal(new Set(components).size,components.length,'Android aliases provider instances when their component class is reused');
  const update = providers.find(p=>p.includes('${applicationId}.updates'));
  assert(update && update.includes('android:exported="false"') && update.includes('android:grantUriPermissions="true"'));
  const paths = fs.readFileSync(path.join(root,'res/xml/update_paths.xml'),'utf8');
  assert.match(paths,/<files-path[^>]+path="updates\/packages\/"/);
  assert(!/<(?:root|external|cache)-path/.test(paths));
});
