# Dependency maintenance

Tote loads authenticated provider pages and ships a Chromium runtime, native PTYs and Android libraries. Dependency changes need both advisory review and behavior checks. This process is tracked in [#17](https://github.com/yusufkaraaslan/tote/issues/17); changing web leaves to WebContentsView remains a separate migration in [#2](https://github.com/yusufkaraaslan/tote/issues/2).

## Cadence and automation

- Weekly: review Dependabot proposals for root npm, mobile npm, Android Gradle and GitHub Actions. `.github/dependabot.yml` groups related xterm and Capacitor packages; Electron, electron-builder and node-pty have separate proposals. Major upgrades remain visible. No automatic merge is configured.
- Weekly, or manually through **Actions → Dependency maintenance**: audit both complete npm lockfiles and check the installed Electron version against the official release feed. Reports include development dependencies because Electron is declared there but ships to users. A high/critical audit finding, an outdated Electron patch/minor, an unsupported major, or an unavailable/malformed report fails the health job. Evidence is retained in the job summary and a 30-day artifact. Existing findings are not suppressed to make this job green.
- Every PR: dependency review rejects newly introduced high/critical advisories in runtime, development and unknown scopes. It does not post PR comments. Existing debt remains visible in the weekly report; a green PR check does not certify the entire dependency tree.
- Monthly: review Electron support, Android/Capacitor requirements, Gradle and action-runtime changes, and the decisions below. Prepare a maintenance release after validation. Triage new high/critical advisories within one working day and schedule an expedited fix when exposure warrants it.

Dependabot version proposals start when the configuration reaches the default branch. Repository **Settings → Code security** must also keep the dependency graph, Dependabot alerts and security updates enabled. Those security proposals are independent of the weekly version-update limit. Workflow failures notify according to each maintainer's GitHub notification settings; there is no separate email or chat sender.

Run the same health report locally without installing packages or executing dependency lifecycle scripts:

```sh
npm run dependencies:report
```

Read `reports/dependencies/summary.md`, `health.json` and both raw audit reports. Exit code 1 means maintenance is required or a check could not complete. Do not use `npm audit fix --force` to bypass review. The npm report does not scan Maven/Gradle artifacts or replace upstream Electron/Chromium advisories; review Gradle proposals, GitHub advisory alerts and upstream Android release notes too.

Electron supports its [latest three stable major lines and the latest minor in each](https://www.electronjs.org/docs/latest/tutorial/electron-timelines). The report derives those lines from the [official release feed](https://releases.electronjs.org/releases.json), excludes prereleases, and additionally requires the latest patch in the selected line. It never hardcodes a permanent supported-major range.

## Upgrade validation

1. Record current/target versions, upstream changelogs and advisory links, affected shipped/build-time paths, and the decision in the PR. For Electron, inspect every intervening [breaking change](https://www.electronjs.org/docs/latest/breaking-changes). Keep major Electron, builder and Capacitor migrations separate unless a documented compatibility dependency requires combining them. Keep actions pinned to reviewed commit SHAs.
2. Update package manifests and lockfiles together. Review root `allowScripts` entries when Electron or node-pty changes; retain explicit version approvals. Align desktop/mobile xterm versions and the add-on compatibility requirements. Capacitor core/android/cli move together; check app plugin, JDK, SDK, AGP and Gradle requirements. Do not edit generated Capacitor files as the source of an upgrade.
3. Require the full Validation workflow: Linux, Intel macOS and Windows unit tests; renderer suites for sidebar, shared terminals, layout conflicts, provider sessions/downloads and mobile; Android native tests, lint and APK build. The provider suite runs the real main process and sandboxed preload with isolated configuration and loopback pages, checking cookie partitions, popup/opener behavior, per-window download routing and preserved drafts. It does not validate a provider's actual login service. Report-policy tests run with `npm test` and cover malformed/offline evidence and supported-line boundaries.
4. Require Release packaging on dependency/lockfile changes: Linux formats, Apple Silicon macOS DMG, Windows installer, Android APK, packaged Electron asset/version/real-PTY checks and checksum assembly. Run production signature verification after credential provisioning as described in [releases](releases.md). A passing source-level PTY test alone cannot validate Electron's native ABI. Python 3.11 remains pinned for reproducible builder 26/node-gyp 12 rebuilds.
5. Before approving a runtime upgrade, perform and record these actual-device checks. Mark unavailable checks as pending, not passed:

| Surface | Required evidence |
| --- | --- |
| Provider session | Existing login persists; fresh login and OAuth popup stay in the provider partition; non-http redirects open correctly; logout works. |
| Downloads | Download from two spaces/windows lands in each initiating space's inbox; native Downloads bridge copies only allowed app exports on macOS and leaves unrelated files alone. |
| Web panes | Focus, typing, splitter drag, group/space/device switch and closing a tab retain other provider drafts; overlays remain usable. |
| Terminals | Spawn a real CLI, Shift+Enter, alternate-screen TUI, two differently sized viewers, mobile wrapping/colors, reconnect replay, no repeated input. |
| Android | Install/upgrade with the existing signing identity, Tailscale discovery/reconnect, voice draft, file save permission/cancellation and background/foreground cycle. |

6. Retain the prior release and a configuration backup for rollback. Follow the release checklist before publishing. The background host survives desktop quit/replacement using its own runtime copy. Finish agents before explicitly stopping or upgrading that host; signed installed-app upgrades still need physical verification. See [background host operation](background-host.md).

The WebContentsView migration in #2 must carry the same provider/overlay/session evidence. It is not a prerequisite for proposing security updates, and maintenance work must not silently mix that migration into a version bump.

## Decision log

Record date, evidence, action, owner/follow-up and verification before accepting or deferring an upgrade. Deferrals need a review date; do not globally ignore a major version or allowlist an advisory without an exposure assessment.

| Date | Evidence and decision | Follow-up |
| --- | --- | --- |
| 2026-11-16 | Locked Electron 37.10.3 and builder 25.1.8. Official feed reports supported lines 45/44/43. Root audit reports 16 high and 1 critical affected packages (including transitive builder tooling); mobile reports 3 moderate, no high/critical. These counts are package findings, not distinct exploitable vulnerabilities. Keep the maintenance automation separate from runtime upgrades; the health report correctly fails on this existing debt. | Repository maintainers, #17: prioritize an Electron upgrade and a separate builder upgrade. Evaluate current advisory paths, breaking changes and the full matrix above before merge. Review by 2026-11-23; expedite exposed high/critical paths. |

Sources: [Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference), [dependency review action](https://github.com/actions/dependency-review-action), [Electron releases](https://releases.electronjs.org/). Live reports take precedence over this dated snapshot.

### Electron 45 upgrade candidate (2026-11-16)

Target 45.3.3, the current stable npm release, from 37.10.3. Reviewed [breaking changes through 45](https://www.electronjs.org/docs/latest/breaking-changes): the preload only imports Electron and does not use removed Node shims; clipboard IPC now returns the asynchronous write and native menu copy handles rejection; provider guests remain sandboxed with Node integration disabled. Native PTYs stay unpacked, avoiding ASAR file-descriptor changes. No removed tracing, capture, certificate-selection or login-item APIs are used. PDF behavior, real OAuth and native downloads still need the physical checks above.

This raises the desktop minimum to macOS 13 and keeps 64-bit Windows/Linux builds. Development requires Node 22.12+. Electron now downloads its binary on first CLI/use, so its obsolete postinstall approval is removed; node-pty's explicit script approval remains. Keep runtime and builder changes as separate commits. Hosted packaging proved builder 25 cannot detect Electron 45’s native ABI, so both upgrades must merge together.

### Builder 26 upgrade candidate (2026-11-16)

Target electron-builder 26.18.1 (the stable `v26` npm tag) from 25.1.8, paired with the Electron upgrade because builder 25’s node-abi metadata cannot identify Electron 45 on any desktop platform. Reviewed [26.0 breaking changes](https://github.com/electron-userland/electron-builder/releases/tag/v26.0.0) and [26.18.1 notes](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.18.1): Tote uses environment signing credentials, no removed Windows signing fields or custom Linux desktop entries, native-architecture DMGs and explicit `publish: never`. Preview ad-hoc signing and production signature verification remain in place. Linux desktopName and syncDesktopName keep the launcher filename and window identity aligned. Native rebuild tooling moves to @electron/rebuild 4.2.1 and node-gyp 12.4.0; tar becomes 7.5.23. Squirrel's optional install script stays blocked because Tote builds NSIS installers, not Squirrel packages.

The root audit now has **zero high/critical** affected packages. Six moderate affected-package entries remain from the minimatch glob-amplification advisory [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), in builder/universal build tooling. Mobile retains three moderate entries. Do not accept npm's suggested builder downgrade to 25 to clear these counts: it restores the critical/high dependency paths. Track upstream compatible fixes under #17; avoid forcing minimatch 11 into dependencies requiring 9/10 without a separate compatibility assessment. Review by 2026-11-23. A passing health threshold is not a claim of zero advisories.

### WebSocket control-frame fix (2026-11-16)

Accept ws 8.23.0 from 8.22.0 in #35. The [upstream security fix](https://github.com/websockets/ws/commit/ace7248f685b10a87eff882e66c5b37fbee03d63) bounds pending automatic pong replies, which bypass Tote's application-message queues. Keep the default limit of 60 on both the host listener and viewer client. A deterministic loopback regression holds socket writes and sends 61 pings in each direction; it verifies only the offending connection is retired, the shared session survives, and a healthy viewer still receives output and sends input. The regression fails against 8.22.0 and passes with 8.23.0. Full Validation and packaging remain the merge gates; physical Tailscale/phone checks remain part of release verification.

### Remaining proposals reviewed for the updater baseline (2026-11-16)

The compatible maintenance changes are combined so their final lockfile, Android build and release workflow are tested together. No forced dependency overrides are used.

| Proposal | Decision and compatibility evidence |
| --- | --- |
| #40 mobile rimraf/minimatch | Accept rimraf 6.1.4, which [declares glob 14](https://github.com/isaacs/rimraf/blob/v6.1.4/package.json); glob brings compatible minimatch 11.0.8 and path-scurry 3. The sole parent is Capacitor CLI, outside the shipped WebView bundle. Reviewed CLI synchronous cleanup calls and exercised glob/cleanup in a disposable directory. Supported development Node versions satisfy the new engines. |
| #28 Capacitor 8.6.2 | Accept core/android/cli together. [8.6.1 fixes](https://github.com/ionic-team/capacitor/blob/8.6.2/android/CHANGELOG.md) address absent-bridge lifecycle calls, released listeners and keyboard/system-bar insets; 8.6.2 aligns package versions. Keep app plugin 8.x, JDK 21, compile/target SDK 36 and minimum API 33. Recheck phone keyboard, speech and foreground/background behavior before release. |
| #29 esbuild 0.28.2 | Accept for mobile builds. Reviewed [0.26/0.27 changes](https://github.com/evanw/esbuild/blob/v0.28.2/CHANGELOG-2025.md) and [0.28 changes](https://github.com/evanw/esbuild/blob/v0.28.2/CHANGELOG.md). Tote keeps its explicit chrome100 target, IIFE bundle and separate output directory. New build-host requirements fit supported platforms; binary download integrity checks improve the fallback installer. Mobile UI tests exercise the generated bundle. |
| #27 org.json 20260814 | Accept the [upstream update](https://github.com/stleary/JSON-java/releases/tag/20260814) in JVM tests only. Android still uses its platform JSON implementation. Native unit tests and lint validate the fixture dependency. |
| #32 Google Services 4.6.0 | Accept the build-classpath update. [Plugin requirements](https://github.com/google/play-services-plugins/tree/master/google-services-plugin) allow the current AGP. Tote has no google-services.json, so the plugin remains unapplied; this does not enable Firebase or notifications or claim Firebase integration testing. |
| #31 release actions | Accept SHA-pinned setup-python 7.1.0 and download-artifact 8.0.2. Keep Python 3.11, existing artifact pattern/path and hosted runners. Reviewed action inputs/runtime; download-artifact defaults to failing digest mismatches. Full desktop packaging and artifact assembly verify the workflow. |

The older #28 renderer failure was the saved-terminal startup sizing race fixed in #42. The #40 macOS failure was a watcher test accepting the first delayed filesystem event after a fixed sleep. The test now checks exact callback-to-space routing deterministically, then separately waits for a real new file and its space's refresh; unrelated setup invalidations do not satisfy or fail that assertion. Both tests retain bounded waits and cleanup.

Local validation of this batch: npm tests, mobile bundle/sync, mobile renderer suite, Android debug native tests/lint/APK, disposable-key release signing rehearsal and build-tool fixture. The refreshed audit reports **zero mobile advisories**, with six moderate desktop build-tool package findings still tracked above; neither lockfile has high/critical findings. CI and production rehearsal evidence belongs in #17 and the merge PR, tied to the final commit.

The following proposals remain open for separate migrations. Owner: repository maintainers under #17; review again by **2026-11-23**, earlier for new security evidence. These are not prerequisites for implementing the updater, and no advisory is suppressed.

| Proposal | Reason and next verification |
| --- | --- |
| #37 Gradle 9.9.1 | Do not merge alone: [the native CI failure](https://github.com/yusufkaraaslan/tote/actions/runs/43859799684) reports removed InternalProblems APIs used by AGP 8.13. [Gradle documents the AGP 8.x incompatibility](https://docs.gradle.org/9.9.1/userguide/upgrading_version_9.html#agp_8x_incompatible). Migrate AGP and compatible Capacitor/build scripts together, then repeat native lint/tests and signed upgrade checks. |
| #34 OkHttp 5.5.1 | Do not merge alone: [AAR metadata validation](https://github.com/yusufkaraaslan/tote/actions/runs/43859729189) requires compile SDK 37, while Tote uses 36. Review SDK/AGP requirements and Java API compatibility together; verify native WebSocket reconnect/consumption behavior before promotion. |
| #39 chokidar 6 | Defer the watcher migration: [upstream rewrites native watching and requires Node 22.22+](https://github.com/paulmillr/chokidar/releases/tag/6.0.0), above Tote's declared 22.12 minimum. Deliberately update the host runtime contract and test real multi-space events, descriptor budgets, Unity pruning and watcher close/rebind on all platforms. Keep existing guards when replacing watcher internals. |
| #33 + #30 xterm 6 | Keep desktop, headless mirror, addons and mobile aligned in one migration. [xterm 6 changes the viewport/scrollbar](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0); Tote currently touches `.xterm-viewport` and the private `syncScrollArea` hook. Verify passive-viewer scrolling, replay, alternate screen, colors/wrapping and phone touch behavior together. Independent green bot PRs do not prove mixed-version behavior. |

### Chokidar 6 migration (2026-11-18)

Supersedes proposal #39. Adopt chokidar 6.0.0 and readdirp 5.1.1 with Node 22.22+ in the manifest, bootstrap and development instructions. The [upstream release](https://github.com/paulmillr/chokidar/releases/tag/6.0.0) changes watcher internals and requires that Node minimum. Tote retains finite depth, shared path budgets, Unity-aware exclusions and awaited close/rebind. Finite depth selects the per-directory backend even on macOS/Windows; native recursive watching is not assumed to enforce Tote's traversal budget.

Local full logic tests, real provider/download fixtures, background viewer quit/crash/relaunch, Linux packaging and copied-runtime/PTy replacement smoke checks pass. Real watcher checks cover generated-cache pruning, ordinary Library source folders, capped traversal, multiple spaces and re-pointing. All-platform CI and physical provider/phone checks remain release gates.

A fresh npm audit on both unchanged main and this candidate reports identical debt: six high and five moderate affected-package entries. The new high chain comes from picomatch's [repeated-extglob ReDoS advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) through build tooling; chokidar introduces no additional findings. Do not treat the older zero-high snapshot as current or accept npm's suggested builder downgrade. Track a compatible upstream build-tool fix under #17.

### Coordinated xterm 6 migration (2026-11-18)

Supersedes #33 and #30 together: desktop xterm/headless 6.0.0, fit 0.11.0, serialize 0.14.0 and mobile xterm 6.0.0. The [upstream release](https://github.com/xtermjs/xterm.js/releases/tag/6.0.0) replaces the viewport/scrollbar. Tote now measures the custom scrollbar and uses public refresh on reveal instead of the removed private syncScrollArea hook. Mobile overscroll styling targets the new scrollable element.

The real two-viewer regression exercises wheel scrolling through the new scrollbar, fractional pane sizing, retained history, hidden output/reveal, ANSI/truecolor replay and oversized passive grids. Run geometry tests under X11 (as CI does); native Wayland can ignore programmatic window resizing. Local full logic, terminal/mobile/provider renderer tests, background-host lifecycle, Linux packaging and packaged copied-runtime checks pass. All-platform CI must establish whether the old #33 Windows startup failure recurs; it is not presumed fixed or flaky. Physical phone touch/scroll/reconnect and real provider acceptance remain release verification. No live sessions or installed runtimes are replaced by this migration.

The first Windows packaging run passed native PTY and copied-host replacement assertions, then failed removing its disposable directory (`ENOTEMPTY`). The packaged test now retries transient cleanup locks with a bounded delay, matching the existing host-test policy. Persistent locks still fail. The previous #33 startup failure did not recur in this run.

### Android toolchain and OkHttp migration (2026-11-18)

Supersedes #37 and #34 together. Move to AGP 9.5.1, Gradle 9.9.1 and compile SDK 37 (SDK package `platforms;android-37.0`), with build tools 36.0.0 in both CI and signing verification. Regenerate the Gradle wrapper and pin its distribution SHA-256. [AGP 9.5 supports API 37 and Gradle 9.6+](https://developer.android.com/build/releases/agp-9-5-0-release-notes). Capacitor stays at 8.6.2 with its existing app plugin: the root AGP classpath builds those modules successfully without editing generated sources or node_modules. Target SDK stays 36 and minimum stays API 33; signing identity and rotation policy are unchanged.

[AGP 9 changes](https://developer.android.com/build/releases/agp-9-0-0-release-notes) required the supported optimize ProGuard template (minification remains disabled) and explicitly retaining release unit tests with `android.onlyEnableUnitTestForTheTestedBuildType=false`. The signing rehearsal initially failed on the missing release-unit task, so that coverage is preserved rather than skipped.

OkHttp 5.5.1 now builds against the required SDK. Native HTTP configuration is shared with a JVM loopback integration test using MockWebServer 5.5.1: real WebSocket Unicode/ANSI frames, cancellation, failed sends after disconnect, fresh connections without old input, and refusal to follow a redirect to another server. Existing SocketBudget and protocol/replay tests retain consumption-acknowledgement coverage. These tests do not claim physical Tailscale or Android WebView lifecycle verification.

Local full npm tests and mobile renderer pass. Debug native tests/lint/APK and release native tests/lint/APK plus disposable-key identity/rotation/wrong-key rejection pass. CI must repeat the final configuration; physical phone upgrade, discovery, reconnect, touch, speech and foreground/background checks remain release gates. No installed application or production signing material is changed.

Combined verification exposed an intermittent macOS fixture startup race: ten watcher-only runs passed, but an immediate file creation after `ready` was missed during the full suite. Node has [no native macOS fs.watch readiness notification](https://github.com/nodejs/node/issues/52601); chokidar's initial-scan completion does not establish OS event delivery. The routing regression now establishes delivery using bounded changes to existing fixture files before creating the asserted new file once. Event/error diagnostics remain on failure; the new-file assertion is not retried or weakened. This test setup change does not claim to remove the underlying OS startup limitation in production.
