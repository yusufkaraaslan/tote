# Releases and updates

## Version and compatibility policy

`release.json` is the source of the desktop/mobile release version, Android versionCode/minimum SDK, wire protocol version and production `releasePlatforms`. Production currently targets Linux and Android; macOS/Windows remain preview-only until their signing and verification are ready. Edit it, increment Android versionCode for every distributed APK, then run `npm run release:version`. This synchronizes both package files and lockfiles. Android reads the metadata directly during Gradle configuration. The production migration requires Android 13+ (API 33); `androidMinSdkVersion` is enforced in source and APK verification. `npm run release:check`, mobile builds and Electron's beforePack hook reject version drift. Tagged builds must use `v<version>` exactly. Versions are stable numeric major.minor.patch values; preview artifacts are not GitHub prereleases and do not advertise updates.

App versions can differ while sharing a wire protocol. Updated clients show the version difference and keep feature fallbacks. An incompatible wire protocol refuses the connection and points to the release page. Increase the wire protocol only for an incompatible framing/behavior change; coordinate the host and both viewers. Additive capabilities keep their existing negotiation/fallback rules.

Update checks are explicit user actions: Settings → About on desktop; Updates on the Android Computers screen or workspace tools. The fixed public GitHub HTTPS endpoint receives no credentials, device names or workspace data. Requests time out after ten seconds and accept at most 256 KiB. Desktop Check for updates and Download update always request fresh metadata; concurrent requests share a fetch, and follow-up callers can reuse successful results for fifteen minutes. A failed explicit refresh reports failure rather than falling back to a cached no-update result. Malformed metadata, drafts and prereleases are rejected before caching; links pin the checked version under this repository, never using server-provided URLs. Nothing is downloaded or installed automatically.

Linux AppImage and Android support explicit download, verification and installation using a schema-1 `release-manifest.json` containing exact byte sizes, SHA-256 hashes, versions and protocol compatibility. Asset URLs are constructed under this repository, with bounded HTTPS redirects to GitHub's release asset host. Preview manifests, incompatible protocols, wrong architectures and downgrades are refused. Linux publisher trust comes from the fixed GitHub HTTPS origin plus its manifest; no Linux publisher signature is claimed. Android also checks the pinned production certificate and installed signing ancestry before the OS validates/installs the APK.

Installation checks unsaved desktop documents and layouts across every window and device slice, or unsent Android drafts. It never replaces or restarts the background host: the desktop viewer reconnects to the same immutable host runtime and sessions. Upgrade the host separately after finishing agents and explicitly stopping it. Package-managed Linux installs and other desktop platforms retain manual guidance. See [update operation and recovery](self-updates.md) and [background host operation](background-host.md).

## Build and review previews

Pull requests touching packaging inputs run `.github/workflows/release.yml`. It builds Linux, macOS, Windows and Android previews, runs packaged Electron version/asset/real-PTY smoke tests plus copied-host-runtime startup and reattach, runs Android native tests/lint, and uploads a combined artifact bundle with checksums. macOS packaging targets Apple Silicon; normal unit tests run on Intel macOS. The artifact filename identifies its architecture. Preview Windows binaries are unsigned; macOS previews use ad-hoc signing for Apple Silicon launch, without a publisher identity or notarization; preview Android APKs use a debug identity and are not a stable upgrade channel.

A workflow_dispatch run without `signed` builds previews after the full Validation workflow. Local desktop packaging: `node scripts/build-release.js`, then `node scripts/test-packaged.js`. Output stays in `dist/release`. Local Android: `npm run mobile:apk`. Normal `npm run dist:*` targets still work and validate release metadata before packaging.

Before publishing, review release notes and run provider login/OAuth popup, download routing, terminal resize/reconnect, and Android install/save/Tailscale checks on actual devices. CI covers logic, isolated renderers, native compilation, signature verification when configured, and packaged PTY loading; it cannot establish successful provider login or phone-specific behavior.

## Configure production signing

Run `npm run release:preflight` from the candidate checkout with an authenticated GitHub CLI. It validates release metadata/notes, requires a clean checkout already in main history, checks the latest Validation and Release packaging runs for that exact commit, and reads the signing environment's branch rules and secret **names**. It never retrieves secret values or changes GitHub settings. Missing, inaccessible, malformed or incomplete evidence exits nonzero. The JSON and human-readable reports live under ignored `reports/releases/`; old reports are removed before a new check. A passing report only means configuration and candidate CI checks passed, not that signing or physical upgrades work.

Use the GitHub **release-signing** environment, restrict it to main/version tags, and configure reviewers as appropriate for the repository. Provision the environment secrets for the platforms selected in `release.json` (currently Android only; Linux uses checksums); no credential belongs in Git, a workflow file, an issue, or chat:

Use custom deployment rules with exactly `main` of type **branch** and `v*` of type **tag** ([GitHub deployment rules](https://docs.github.com/en/rest/deployments/branch-policies)). The workflow independently rejects unmerged signed candidates. Creating an empty environment or setting secret names does not establish certificate validity; the signed rehearsal must pass next.

| Platform | Secrets |
| --- | --- |
| macOS | `MAC_CSC_LINK` (base64 Developer ID certificate), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |
| Windows | `WIN_CSC_LINK` (base64 signing certificate), `WIN_CSC_KEY_PASSWORD` |
| Android | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` |

macOS/Windows production jobs are omitted while those platforms are excluded; preview jobs still build all four platforms. The final manifest requires exactly the selected production artifacts and rejects excluded-platform files. macOS/Windows credentials are passed only to their builder step. Production builds fail if signing configuration is absent. macOS signing and notarization are verified with codesign and stapler; Windows app and installer signatures are checked with Authenticode. The Android keystore is decoded into runner temporary storage, removed even on build failure, and release APK signatures are verified with apksigner. Linux artifacts use checksums; this workflow does not claim a Linux publisher certificate. Keep a secure backup of the Android signing key. The Android 13+ production APK carries the approved proof of rotation from the 0.4.0 identity; CI pins both public fingerprints, verifies the embedded lineage, rejects debuggable APKs and never receives the legacy private key. See [Android identity and recovery](../mobile/signing/README.md).

At the start of the 2026-11-16 readiness review, only the preview environment existed. The release-signing environment now has main/version-tag restrictions; Android uses a separate production key and approved public signing lineage; check preflight for current secret provisioning. Re-run preflight for current evidence. Unsigned preview validation is possible now; production certificate/notarization and installed-app upgrade validation require provisioning. A checksummed preview must never be relabeled a signed release. Record physical verification using the [release readiness checklist](release-readiness.md).

See [electron-builder signing](https://www.electron.build/code-signing.html) and [Android app signing](https://developer.android.com/studio/publish/app-signing). The workflow uses electron-builder 26's installed APIs; assess configuration changes separately when upgrading that dependency.

## Create a draft release

1. Merge the reviewed version change and matching `docs/releases/v<version>.md` notes into main. Run full Validation and preview packaging on the exact candidate commit (PR-head results do not cover a new merge commit). Run `npm run release:preflight` and resolve all blocked/unknown checks.
2. Provision signing, then test workflow_dispatch on main with `signed=true`. This builds signed artifacts but does not publish a release.
3. Push a matching `v<version>` tag on the reviewed main commit. The workflow checks that the tagged commit is already in main’s history before signing. Full validation, signed packaging, packaged smoke tests and final artifact verification must all pass.
4. The assembly job checks every selected platform's manifest and file hashes, creates `SHA256SUMS` and `release-manifest.json`, and creates a **draft GitHub release**. Existing tags/releases are not overwritten by reruns.
5. Review artifacts and perform physical installation/upgrade checks, then explicitly publish the draft. Only a published stable release becomes eligible for [GitHub's latest-release endpoint](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

Checksums can be verified with `sha256sum -c SHA256SUMS` on Linux, `shasum -a 256 -c SHA256SUMS` on macOS, or `Get-FileHash -Algorithm SHA256 <file>` on Windows. Compare against the checksum obtained from the release you intended to download.

Keep the prior release available for manual rollback. Finish running sessions before rollback; do not promise schema downgrade compatibility without checking the release notes and retaining the configuration backup. Review dependency/security updates regularly as tracked in #17; never merge major runtime upgrades solely because packaging succeeded.
