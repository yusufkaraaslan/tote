# In-app updates

This checkpoint adds **Check → Download → Verify → Install** for Linux AppImage and Android 13+. Every network check/download and every installation starts with a user action. There is no background polling, forced upgrade, silent Android install, automatic host restart or release publication.

The first release containing the updater must be installed manually. A subsequent **published stable** release must include a production schema-1 manifest. The existing 0.4.0 release and CI previews cannot be offered as verified in-app installations. Merging this code or building a signed rehearsal does not update any installed app.

## Desktop

In **Settings → About**, choose **Check for updates**, **Download update**, then **Install and reopen**. Only a writable, regular Linux AppImage can replace itself. Symlinked images and read-only installations are refused. `.deb`/pacman users use their package manager; macOS/Windows retain the release-page path.

Download progress and cancellation are available. A private staged package survives a viewer restart and is fully rehashed before use. Failed/canceled partial downloads cannot install and are removed on retry. A new download replaces the previous staged candidate. The manifest pins the exact newer stable version, protocol, architecture, filename, byte count and SHA-256 digest. HTTPS redirects are limited to this repository's release path and `release-assets.githubusercontent.com`; metadata and package sizes, redirects, idle time and total duration are bounded. No URLs from release API metadata are used, and no credentials or workspace data are sent.

Installation first asks you to save provider web-tab drafts, which Tote cannot inspect. It then freezes document editing in every local viewer, flushes layout saves and checks unsaved documents/layouts in every device slice. Dirty, disconnected-with-pending-layout, crashed or unresponsive viewers block installation. New windows are refused while installation is underway. Navigation/window changes abort before replacement. Running setup commands also block installation.

The verified package is copied to a private sibling directory on the destination filesystem, rehashed and flushed. The prior executable is copied and flushed as `previous.AppImage` in that `.tote-update-*` directory. An atomic rename replaces the original AppImage; its path stays the same. Tote then requests a viewer relaunch. The backup remains for recovery; Tote does not automatically downgrade data or remove old recovery directories. If relaunch fails, launch the original AppImage path manually. If the new version cannot start, preserve configuration backups and consult its release notes before manually launching the recovery image. Finish host agents before any host rollback.

The independent background host runs from an immutable copy outside the installation. Viewer updates leave that copy, its PID and its PTYs untouched. A protocol-changing release is refused by this updater; coordinate a manual host/client upgrade for that case. To adopt a newer compatible host after a viewer update, finish its agents, refresh host status and choose **Upgrade idle host**. The host checks again for live terminals when stopping; a late-starting agent defers the upgrade. Existing sign-in startup registration is updated to the new runtime while preserving your opt-in choice. An old host is never replaced or restarted automatically.

Linux trust is the fixed public repository over HTTPS and the checksum manifest served from that origin. This is not an independently signed Linux update feed; compromise of that publishing origin remains a trust boundary.

## Android

Open **Updates** from Computers or workspace tools. Download verifies the same production manifest policy plus increasing Android versionCode, minimum SDK, package ID, non-debuggable APK, pinned current production signer and installed signing ancestry. APK verification runs again before handing a narrowly scoped content URI to Android's package installer. The OS performs final signature/lineage verification and asks for confirmation. Old-key-only APKs, previews and rollbacks are refused.

All unsent drafts, including orphaned drafts, must first be copied or explicitly discarded. Editing remains blocked while native verification/settings/the installer are open. If Android requires **Allow from this source**, returning from settings only shows guidance: tap **Install update** again to continue. Denying permission or canceling the installer keeps the installed app and allows retry. Android owns the actual installation outcome; a return from its installer is not reported as successful installation. The app's version after reopening is authoritative.

Staged APKs live in app-private storage, and the FileProvider grants access only to the update package directory. No storage permission is requested. Host terminals remain on the computer throughout. The first production-key migration remains an Android 13+ manual install for old clients without this updater.

## Validation and release gate

`npm test` covers manifest policy, publisher boundaries, size limits, cancellation, tampering, recovered staging, atomic replacement/recovery and all-viewer guards. Desktop layout renderer tests cover dirty buffers on both current and hidden devices. Mobile renderer tests cover download, permission-return behavior and draft blocking. Native unit tests independently reject malformed/rollback/incompatible manifests; Android compilation/lint and release signing rehearsals validate the native integration.

Before publishing, run exact-commit validation/packaging and a signed Linux/Android rehearsal, then complete the [physical release checklist](release-readiness.md): real AppImage relaunch with a live agent, Android permission/cancel/upgrade and data retention, provider/Tailscale checks, and encrypted offline signing-key backup. CI evidence does not claim those owner/device checks have happened. Publication remains an explicit separate action.

The implementation rehearsal on 2026-11-16 used a disposable API 33 emulator and an updater-enabled debug fixture numbered 0.4.9/code 10. It verified a privately staged production CI APK (run `43927306298`, 0.5.0/code 11, SHA-256 `481235545cb9330d4f98cfcb344dcb7123f44e3edf8dcaedb4e26b8b24ff43ed`), exercised permission denial/return and installer cancellation/retry, then completed the upgrade through Android's actual package-installer confirmation. A private data marker survived, the installed app was non-debuggable and it launched. This caught and fixed a provider-component aliasing bug that compilation/lint did not detect. The fixture was removed afterward. This rehearsal exercises native verification and installation; it does not claim a real published network update or physical-phone QA.
