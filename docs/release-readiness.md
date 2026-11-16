# Release readiness and the self-update sequence

The background host implementation is merged in #41. Continue in this order:

1. Release readiness (#3/#17): exact-commit preview CI, production signing setup, signed build rehearsal and physical verification below.
2. Review the remaining dependency proposals. Keep desktop/mobile terminal libraries aligned and major Capacitor/Gradle/runtime changes separate. Repeat affected release checks after changing dependencies.
3. Implement in-app download/verification and installation. Use the published stable channel and the verified platform artifact; retain explicit user control, unsaved-buffer/draft guards and host compatibility checks. Never replace or restart an active host automatically.

The current app checks versions and opens the release page; it does not install updates. Neither merging source nor generating preview artifacts updates an installed app.

## Automated evidence

Run `npm run release:preflight` on the merged release candidate. The command is read-only apart from ignored local reports and checks metadata, clean source, main ancestry, exact-commit CI and signing configuration names/rules. It exits nonzero on unavailable evidence. Preview packaging must run again on the merge commit; use Actions → Release packaging → Run workflow with `signed=false`. A production rehearsal uses `signed=true` only after provisioning the release-signing environment. Both dispatch paths run Validation first.

Packaged smoke tests now remove a disposable desktop installation while its copied host runs, create a fresh viewer connection, and verify the original PID, shell state, dimensions and busy-stop guard. This runs on Linux, Windows and Apple Silicon macOS. It exercises replacing files with the same candidate build; it does not prove a signed old-to-new installer upgrade, old configuration schema migration, OS sign-in, provider acceptance or phone behavior.

## Physical verification record

For each release, copy this table into its release verification record or issue #3. Record the candidate commit, source/target versions, exact artifact SHA-256, OS/architecture, test date and result. For Android also record the signing certificate SHA-256 and versionCode before/after. Public certificate fingerprints are suitable evidence; private keys, credentials, provider cookies and user paths are not.

Leave unavailable checks **pending**. A failed check needs a linked fix and rerun. A preview pass cannot replace signed-upgrade evidence. Repeat affected checks if code, dependencies, packaging or signing identity changes after the recorded run.

| Check | Evidence to record | Current status |
| --- | --- | --- |
| macOS identity/notarization | Developer ID/team, codesign and stapler results for the distributed app; launch without bypassing OS verification | Pending |
| Windows identity | Valid Authenticode publisher on the app and installer; installation/launch result | Pending |
| Android identity | Existing installed/released APK certificate matches production APK; in-place upgrade succeeds and data persists | Pending |
| Desktop upgrade with a live host | Start a real agent, record host PID and shell marker, save documents, install reviewed candidate, reopen; PID/state/layout persist; new viewer reports any version mismatch | Pending on Linux/macOS/Windows |
| Explicit host upgrade | Finish agents, stop host, start current runtime; status reports new version; workspace config and saved panes remain; restart does not replay old input | Pending on Linux/macOS/Windows |
| Sign-in and power | Opt-in startup works after sign-out/sign-in; opt-out removes startup; keep-awake on/off behavior; reboot correctly ends old PTYs and offers agent resume guidance | Pending on Linux/macOS/Windows |
| Provider and document behavior | Retained login, fresh OAuth, popup downloads from two spaces, PDF viewing, focus/typing and unsaved draft preservation | Pending |
| Native Downloads bridge | On macOS, recognized app exports copy into the intended space; unrelated downloads remain untouched | Pending |
| Android on a physical phone | Existing-key upgrade, automatic Tailscale discovery, reconnect without repeated input, colors/wrapping, voice draft, save permission/cancellation and background/foreground | Pending |
| Recovery | Previous artifact retained; configuration backup available; interrupted installation recovery documented; no unverified schema downgrade promise | Pending |

The 0.4.0 release includes Linux packages and an Android APK. Do not assume a historical production macOS/Windows signing identity exists. For Android, compare the installed app or previously distributed APK's certificate before provisioning the key. A newly generated key cannot upgrade an installation signed by another key. Do not uninstall merely to bypass this mismatch.

## Publication and updater boundary

A successful signed workflow on a matching main-history tag creates a draft only. Review the signed artifact checksums and physical record before explicitly publishing. The updater must consume only a published stable release; unsigned/debug previews remain outside that channel.

In-app installation follows this readiness stage and dependency review. Its implementation still needs platform/architecture selection, bounded downloads, checksum and publisher verification, interrupted-download recovery, explicit install/relaunch consent, dirty-document/draft checks, and a host-upgrade choice that defers while agents are running. Linux package-managed installs need their package-manager path rather than silent replacement of managed files. Android must use the existing app identity and the OS install confirmation flow. These are planned behaviors, not current app capabilities.
