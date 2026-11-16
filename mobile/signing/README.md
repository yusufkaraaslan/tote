# Android production identity

Only public material belongs in this directory:

- `identity.json` pins the production and previous certificate SHA-256 fingerprints, minimum Android API, and lineage-file hash.
- `production.lineage` is the public proof of rotation from the published 0.4.0 development certificate to the production certificate. It contains certificates and signatures, not private keys or passwords.

Production starts at **Android 13 / API 33**. The owner approved this minimum to move off the development identity without maintaining a legacy signing path. Do not install these APKs on Android 12 or older, silently lower the manifest minimum, or sign v1/v2 with the old development key to bypass it.

The old identity retains installed-data and permission trust. AndroidX's existing `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` requires permission trust during the upgrade; removing it produced `INSTALL_FAILED_DUPLICATE_PERMISSION` in the real 0.4.0 migration rehearsal. Shared UID, authentication and old-key rollback capabilities remain disabled. Never regenerate or edit signing history merely to get a build to pass.

The production SHA-256 is `852cf5eb5a038044e302ed8ee0b8f4cbcac24652f56a2184fedef691d4bb060f`. The previous development SHA-256 is `c202f9a258bba2abda07ded1af49ec59d3622276eeb40778d5ee4c1d7dfd4cf4`. Certificate fingerprints are public; the signing keys are not.

## Signing and verification

The release workflow uses the four Android secrets in the restricted `release-signing` environment. Gradle builds a non-debuggable release APK, then `scripts/android-release-signing.js` verifies the keystore certificate, applies the approved lineage and checks the resulting APK's certificate, embedded signing history, application ID, versionCode/versionName, minimum SDK and debug flag. It refuses mismatched keys, altered lineage, debug APKs and existing output files. Passwords are passed through environment variables, never command arguments or output. The previous development key is needed only when establishing or modifying lineage, not in release CI.

`npm run test:android-signing` creates disposable old/new keys, builds the real release variant, signs it with fixture lineage and exercises verification/rejection paths. CI runs it on Android validation without production credentials.

For an in-place emulator rehearsal, start a **fresh, root-capable Android 13+ emulator** with no Tote installation, then run:

```sh
node scripts/test-android-upgrade.js emulator-PORT previous.apk candidate.apk
```

It refuses phones and emulators that already have Tote. It installs the previous debuggable APK, writes a private-data marker, updates in place, checks the marker using the emulator's root access, verifies that the candidate disallows `run-as`, and launches it. It removes only the fixture installation it created. Results go to ignored `reports/releases/android-upgrade.json`. This command is for the legacy-debug-to-production transition, not arbitrary release rollback testing.

On 2026-11-16 the published 0.4.0 APK (versionCode 9) upgraded to the 0.5.0 candidate (versionCode 11) in an Android 15/API 35 emulator. App data survived and the non-debuggable app launched. Physical phone discovery, voice, file-save and installation behavior remain pending; an emulator pass is not phone acceptance.

## Key custody and recovery

The maintainer's local private bundle is outside the repository at `~/.local/share/tote-signing/android-production`, with an owner-only directory and private key/credential files. It contains the production keystore, credentials, the preserved legacy key and signing history. Keep a separate encrypted offline backup of the complete bundle before publication. GitHub secrets are not a recoverable backup: their values cannot be downloaded later.

Do not put private keys or the credential file in Git, issues, chat, CI artifacts or release bundles. Do not overwrite either signing key. Losing the production private key can prevent future updates. Keep the legacy key for migration recovery, but never use it to sign a new production APK. Rotation or revocation requires a reviewed migration plan and an in-place upgrade test.

References: [Android app signing](https://developer.android.com/studio/publish/app-signing), [apksigner rotation](https://developer.android.com/tools/apksigner), [v3.1 signing](https://source.android.com/docs/security/features/apksigning/v3-1).
