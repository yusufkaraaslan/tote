# Releases and updates

## Version and compatibility policy

`release.json` is the source of the desktop/mobile release version, Android versionCode, and wire protocol version. Edit it, increment Android versionCode for every distributed APK, then run `npm run release:version`. This synchronizes both package files and lockfiles. Android reads the metadata directly during Gradle configuration. `npm run release:check`, mobile builds and Electron's beforePack hook reject version drift. Tagged builds must use `v<version>` exactly. Versions are stable numeric major.minor.patch values; preview artifacts are not GitHub prereleases and do not advertise updates.

App versions can differ while sharing a wire protocol. Updated clients show the version difference and keep feature fallbacks. An incompatible wire protocol refuses the connection and points to the release page. Increase the wire protocol only for an incompatible framing/behavior change; coordinate the host and both viewers. Additive capabilities keep their existing negotiation/fallback rules.

Update checks are explicit user actions: Settings → About on desktop; Updates on the Android Computers screen or workspace tools. The fixed public GitHub HTTPS endpoint receives no credentials, device names or workspace data. Requests time out after ten seconds, accept at most 256 KiB, and successful results are cached for fifteen minutes. Drafts and prereleases are excluded; links are constructed from validated versions under this repository, never taken from server-provided URLs. Nothing is downloaded or installed automatically.

Desktop's download-page action rechecks **all local host sessions**, including other windows and spaces, before and after the update check. If any terminal is alive, installation guidance is deferred. Android requires memory-only drafts to be saved or cleared. These checks do not control installers launched outside Tote. Finish agents and save documents before manually quitting/replacing desktop Tote. Uninterrupted UI upgrades depend on the independent background host in [#6](https://github.com/yusufkaraaslan/tote/issues/6).

## Build and review previews

Pull requests touching packaging inputs run `.github/workflows/release.yml`. It builds Linux, macOS, Windows and Android previews, runs packaged Electron version/asset/real-PTY smoke tests, runs Android native tests/lint, and uploads a combined artifact bundle with checksums. macOS targets the selected runner's native architecture; the artifact filename identifies it. Preview macOS/Windows binaries are unsigned; preview Android APKs use a debug identity and are not a stable upgrade channel.

A workflow_dispatch run without `signed` builds previews after the full Validation workflow. Local desktop packaging: `node scripts/build-release.js`, then `node scripts/test-packaged.js`. Output stays in `dist/release`. Local Android: `npm run mobile:apk`. Normal `npm run dist:*` targets still work and validate release metadata before packaging.

Before publishing, review release notes and run provider login/OAuth popup, download routing, terminal resize/reconnect, and Android install/save/Tailscale checks on actual devices. CI covers logic, isolated renderers, native compilation, signature verification when configured, and packaged PTY loading; it cannot establish successful provider login or phone-specific behavior.

## Configure production signing

Use the GitHub **release-signing** environment, restrict it to main/version tags, and configure reviewers as appropriate for the repository. Provision these environment secrets; no credential belongs in Git, a workflow file, an issue, or chat:

| Platform | Secrets |
| --- | --- |
| macOS | `MAC_CSC_LINK` (base64 Developer ID certificate), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | `WIN_CSC_LINK` (base64 signing certificate), `WIN_CSC_KEY_PASSWORD` |
| Android | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` |

macOS/Windows credentials are passed only to their builder step. Production builds fail if signing configuration is absent. macOS signing and notarization are verified with codesign and stapler; Windows app and installer signatures are checked with Authenticode. The Android keystore is decoded into runner temporary storage, removed even on build failure, and release APK signatures are verified with apksigner. Linux artifacts use checksums; this workflow does not claim a Linux publisher certificate. Keep a secure backup of the Android signing key and reuse the existing app identity to preserve upgrade compatibility.

The repo currently has no signing secrets configured. Unsigned preview validation is possible now; production certificate/notarization and installed-app upgrade validation require that provisioning. A checksummed preview must never be relabeled a signed release.

See [electron-builder signing](https://www.electron.build/code-signing.html) and [Android app signing](https://developer.android.com/studio/publish/app-signing). The workflow uses electron-builder 25's installed APIs; assess configuration changes separately when upgrading that dependency.

## Create a draft release

1. Merge the reviewed version change and matching `docs/releases/v<version>.md` notes into main. Confirm full Validation and preview packaging pass.
2. Provision signing, then test workflow_dispatch on main with `signed=true`. This builds signed artifacts but does not publish a release.
3. Push a matching `v<version>` tag on the reviewed main commit. Full validation, signed packaging, packaged smoke tests and final artifact verification must all pass.
4. The assembly job checks every platform's manifest and file hashes, creates `SHA256SUMS` and `release-manifest.json`, and creates a **draft GitHub release**. Existing tags/releases are not overwritten by reruns.
5. Review artifacts and perform physical installation/upgrade checks, then explicitly publish the draft. Only a published stable release becomes eligible for [GitHub's latest-release endpoint](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

Checksums can be verified with `sha256sum -c SHA256SUMS` on Linux, `shasum -a 256 -c SHA256SUMS` on macOS, or `Get-FileHash -Algorithm SHA256 <file>` on Windows. Compare against the checksum obtained from the release you intended to download.

Keep the prior release available for manual rollback. Finish running sessions before rollback; do not promise schema downgrade compatibility without checking the release notes and retaining the configuration backup. Review dependency/security updates regularly as tracked in #17; never merge major runtime upgrades solely because packaging succeeded.
