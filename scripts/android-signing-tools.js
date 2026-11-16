// Shared by local provisioning and disposable CI rehearsals. Never prints passwords.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { runner, certificateDigests } = require('./android-release-signing');
const fingerprint = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function generateKey(file, alias, password, env, name) {
  if (fs.existsSync(file)) throw Error('Refusing to replace an existing signing key');
  const run = runner({ ...env, TOTE_KEY_PASSWORD: password });
  run('keytool', ['-genkeypair', '-keystore', file, '-storetype', 'PKCS12', '-alias', alias,
    '-storepass:env', 'TOTE_KEY_PASSWORD', '-keypass:env', 'TOTE_KEY_PASSWORD',
    '-keyalg', 'RSA', '-keysize', '3072', '-sigalg', 'SHA256withRSA', '-validity', '10000', '-dname', name]);
  fs.chmodSync(file, 0o600);
  return fingerprint(run('keytool', ['-exportcert', '-keystore', file, '-alias', alias, '-storepass:env', 'TOTE_KEY_PASSWORD']));
}
function rotate({ oldFile, oldAlias, oldPassword, newFile, newAlias, newPassword, output, env }) {
  if (fs.existsSync(output)) throw Error('Refusing to replace existing signing history');
  const run = runner({ ...env, TOTE_OLD_PASSWORD: oldPassword, TOTE_NEW_PASSWORD: newPassword });
  run('apksigner', ['rotate', '--out', output,
    '--old-signer', '--ks', oldFile, '--ks-key-alias', oldAlias, '--ks-pass', 'env:TOTE_OLD_PASSWORD', '--key-pass', 'env:TOTE_OLD_PASSWORD',
    // AndroidX's existing signature permission must survive the signer change.
    '--set-installed-data', 'true', '--set-shared-uid', 'false', '--set-permission', 'true', '--set-rollback', 'false', '--set-auth', 'false',
    '--new-signer', '--ks', newFile, '--ks-key-alias', newAlias, '--ks-pass', 'env:TOTE_NEW_PASSWORD', '--key-pass', 'env:TOTE_NEW_PASSWORD']);
  return certificateDigests(run('apksigner', ['lineage', '--in', output, '--print-certs']).toString());
}
module.exports = { fingerprint, generateKey, rotate };
