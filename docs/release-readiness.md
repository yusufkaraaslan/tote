# Release readiness and the self-update sequence

The background host implementation is merged in #41. The agreed first self-update targets are **Linux and Android**. `release.json` selects those production platforms; previews still exercise all desktop platforms and Android. Continue in this order:

1. Release readiness (#3/#17): exact-commit preview CI, production signing setup, signed build rehearsal and physical verification below.
2. Review the remaining dependency proposals. Keep desktop/mobile terminal libraries aligned and major Capacitor/Gradle/runtime changes separate. Repeat affected release checks after changing dependencies.
3. Implement in-app download/verification and installation. Use the published stable channel and the verified platform artifact; retain explicit user control, unsaved-buffer/draft guards and host compatibility checks. Never replace or restart an active host automatically.

The source now implements guarded in-app updates for Linux AppImage and Android; see [installation and recovery](self-updates.md). Dependency review is complete for this checkpoint; the five major/toolchain proposals remain separately tracked in [dependency decisions](dependencies.md). Neither merging source nor generating preview artifacts updates an installed app. The first updater-capable release must be installed manually, and publishing remains a separate step after the physical checks and signing-key backup below.

## Automated evidence

Run `npm run release:preflight` on the merged release candidate. It requires signing secrets only for selected production platforms, so macOS/Windows credentials do not block Linux/Android. The command is read-only apart from ignored local reports and checks metadata, clean source, main ancestry, exact-commit CI and signing configuration names/rules. It exits nonzero on unavailable evidence. Preview packaging must run again on the merge commit; use Actions → Release packaging → Run workflow with `signed=false`. A production rehearsal uses `signed=true` only after provisioning the release-signing environment. Both dispatch paths run Validation first.

Packaged smoke tests now remove a disposable desktop installation while its copied host runs, create a fresh viewer connection, and verify the original PID, shell state, dimensions and busy-stop guard. This runs on Linux, Windows and Apple Silicon macOS. It exercises replacing files with the same candidate build; it does not prove a signed old-to-new installer upgrade, old configuration schema migration, OS sign-in, provider acceptance or phone behavior.

## Physical verification record

For each release, copy this table into its release verification record or issue #3. Record the candidate commit, source/target versions, exact artifact SHA-256, OS/architecture, test date and result. For Android also record the signing certificate SHA-256 and versionCode before/after. Public certificate fingerprints are suitable evidence; private keys, credentials, provider cookies and user paths are not.

Leave unavailable checks **pending**. A failed check needs a linked fix and rerun. A preview pass cannot replace signed-upgrade evidence. Repeat affected checks if code, dependencies, packaging or signing identity changes after the recorded run.

| Check | Evidence to record | Current status |
| --- | --- | --- |
| macOS identity/notarization | Developer ID/team, codesign and stapler results for the distributed app; launch without bypassing OS verification | Deferred until macOS production |
| Windows identity | Valid Authenticode publisher on the app and installer; installation/launch result | Deferred until Windows production |
| Android identity | Verified signing continuity or migration from the installed/released APK; in-place upgrade succeeds and data persists | API 33/35 emulator upgrades passed; owner reported physical code-11 app working on 2026-11-17; detailed data-retention check not individually recorded |
| Desktop upgrade with a live host | Start a real agent, record host PID and shell marker, save documents, install reviewed candidate, reopen; PID/state/layout persist; new viewer reports any version mismatch | Pending for Linux production; macOS/Windows before promotion |
| Explicit host upgrade | Finish agents, stop host, start current runtime; status reports new version; workspace config and saved panes remain; restart does not replay old input | Linux restart and runtime match confirmed 2026-11-17; owner reported working; detailed pane/input checks not individually recorded |
| Sign-in and power | Opt-in startup works after sign-out/sign-in; opt-out removes startup; keep-awake on/off behavior; reboot correctly ends old PTYs and offers agent resume guidance | Pending for Linux production; macOS/Windows before promotion |
| Provider and document behavior | Retained login, fresh OAuth, popup downloads from two spaces, PDF viewing, focus/typing and unsaved draft preservation | Pending |
| Native Downloads bridge | On macOS, recognized app exports copy into the intended space; unrelated downloads remain untouched | Deferred until macOS production |
| Android on a physical phone | Existing-key upgrade, automatic Tailscale discovery, reconnect without repeated input, colors/wrapping, voice draft, save permission/cancellation and background/foreground | General owner acceptance 2026-11-17; individual scenario results not recorded |
| Recovery | Previous artifact retained; configuration backup available; interrupted installation recovery documented; no unverified schema downgrade promise | Pending |

The 0.4.0 release includes Linux packages and an Android APK. Inspection on 2026-11-16 found its public certificate subject is `CN=Android Debug`; SHA-256 is `c202f9a258bba2abda07ded1af49ec59d3622276eeb40778d5ee4c1d7dfd4cf4`. A matching local development key is available. This establishes continuity evidence, not a production signing identity. That key is preserved outside Git. A dedicated production identity and public proof of rotation are now pinned in mobile/signing. The owner approved Android 13+ for the production migration. The published 0.4.0 APK upgraded in place to the non-debuggable candidate on API 33 and API 35 emulators with app data preserved; physical phone acceptance remains pending. Do not pass the development key off as a production certificate. See [Android signing guidance](https://developer.android.com/studio/publish/app-signing). Do not assume a historical production macOS/Windows signing identity exists. For Android, compare the installed app or previously distributed APK's certificate before provisioning the key. A different key without a valid proof of rotation cannot upgrade the existing installation. Do not uninstall merely to bypass this mismatch.

## Signed rehearsal record (2026-11-16)

PR #43 merged the Android 13+ production identity and verified rotation policy at `444af3093a5e0d417813727c3791ec2d871cbbdd`. The four Android signing secrets are provisioned in the restricted `release-signing` environment; private keys remain outside Git. [Production rehearsal 43893662041](https://github.com/yusufkaraaslan/tote/actions/runs/43893662041) passed validation, Linux packaging and packaged host/PTY checks, production Android signing, and checksum/manifest assembly. It did not publish a release.

The downloaded CI APK has SHA-256 `948b1621076555b71acf92661312f54c5909d35f8819410da4c0c389bf552f96` and production certificate `852cf5eb5a038044e302ed8ee0b8f4cbcac24652f56a2184fedef691d4bb060f`. Local verification checked its embedded signing history, non-debuggable manifest, version 0.5.0/code 11 and minimum API 33. On a disposable API 33 emulator, the published 0.4.0/code 9 APK upgraded directly to this CI artifact, retained a private app-data marker and launched. The byte-identical locally signed candidate also passed on API 35. The fixture app was removed afterward; no existing user installation was changed.

The separate main push run exposed a Windows test cleanup race after successful host assertions: a terminal working-directory handle briefly prevented temporary-folder deletion. Cleanup now retries transient filesystem locks with a bounded retry count instead of a fixed delay; persistent locks still fail the test. Physical phone and desktop checks in the table remain pending, as does an encrypted offline backup of the production signing bundle.

## Publication and updater boundary

A successful signed workflow on a matching main-history tag creates a draft only. Review the signed artifact checksums and physical record before explicitly publishing. The updater must consume only a published stable release; unsigned/debug previews remain outside that channel.

In-app download, verification and installation are implemented for Linux AppImage and Android. Package-managed Linux installs retain package-manager guidance. Installation protects unsaved work and preserves the running host; host replacement remains a separate explicit action after agents finish. See [update operation and recovery](self-updates.md).

## Owner verification on 2026-11-17

The maintainer installed the patched Linux pacman build from PR #47, restarted its background host, and reported the desktop and Android app working. Read-only checks confirmed the installed desktop archive matched the tested build, the host used that same runtime, and the new Codex session had truecolor, no inherited NO_COLOR and --no-alt-screen. The maintainer then explicitly authorized publishing 0.5.0. This is general owner acceptance, not a claim that each physical checklist scenario above was individually exercised.

- Desktop candidate: a612b533b90cdfe61402a57e5b7018e332d732df, merged as 6988f6884b46dbef18f35c7f93b2f0e41f27b634; Linux x64 pacman SHA-256 `2bff8834197510e030867a45b752286a9c3905a13f859a5417cddbdabff89ceb`.
- Android rehearsal: main commit efeae7a1300b1afd5f218f0d9f8c98725119cace, version 0.5.0/code 11; APK SHA-256 `b9910f5ecfc2c315f21a433c98522300d26dc51663a76c5b2499dcd14098a74a`; production certificate `852cf5eb5a038044e302ed8ee0b8f4cbcac24652f56a2184fedef691d4bb060f`. Android source did not change in PR #47.
- Official publication increments Android versionCode to 12 so the rehearsal installation can be replaced. Its final artifacts still require automated signature/checksum verification; the code-11 physical result does not claim a code-12 phone installation.
- An encrypted signing-bundle backup was created and its decrypted contents compared with all six source files. The maintainer confirmed that the encrypted archive is saved offline and the recovery key is kept separately. No private material belongs in this record.
