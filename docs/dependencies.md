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
4. Require Release packaging on dependency/lockfile changes: Linux formats, Apple Silicon macOS DMG, Windows installer, Android APK, packaged Electron asset/version/real-PTY checks and checksum assembly. Run production signature verification after credential provisioning as described in [releases](releases.md). A passing source-level PTY test alone cannot validate Electron's native ABI. The existing Python 3.11 pin supports builder 25's node-gyp; reassess it when upgrading builder.
5. Before approving a runtime upgrade, perform and record these actual-device checks. Mark unavailable checks as pending, not passed:

| Surface | Required evidence |
| --- | --- |
| Provider session | Existing login persists; fresh login and OAuth popup stay in the provider partition; non-http redirects open correctly; logout works. |
| Downloads | Download from two spaces/windows lands in each initiating space's inbox; native Downloads bridge copies only allowed app exports on macOS and leaves unrelated files alone. |
| Web panes | Focus, typing, splitter drag, group/space/device switch and closing a tab retain other provider drafts; overlays remain usable. |
| Terminals | Spawn a real CLI, Shift+Enter, alternate-screen TUI, two differently sized viewers, mobile wrapping/colors, reconnect replay, no repeated input. |
| Android | Install/upgrade with the existing signing identity, Tailscale discovery/reconnect, voice draft, file save permission/cancellation and background/foreground cycle. |

6. Retain the prior release and a configuration backup for rollback. Follow the release checklist before publishing. Closing/updating desktop Tote still stops its host PTYs until [#6](https://github.com/yusufkaraaslan/tote/issues/6) lands.

The WebContentsView migration in #2 must carry the same provider/overlay/session evidence. It is not a prerequisite for proposing security updates, and maintenance work must not silently mix that migration into a version bump.

## Decision log

Record date, evidence, action, owner/follow-up and verification before accepting or deferring an upgrade. Deferrals need a review date; do not globally ignore a major version or allowlist an advisory without an exposure assessment.

| Date | Evidence and decision | Follow-up |
| --- | --- | --- |
| 2026-11-16 | Locked Electron 37.10.3 and builder 25.1.8. Official feed reports supported lines 45/44/43. Root audit reports 16 high and 1 critical affected packages (including transitive builder tooling); mobile reports 3 moderate, no high/critical. These counts are package findings, not distinct exploitable vulnerabilities. Keep the maintenance automation separate from runtime upgrades; the health report correctly fails on this existing debt. | Repository maintainers, #17: prioritize an Electron upgrade and a separate builder upgrade. Evaluate current advisory paths, breaking changes and the full matrix above before merge. Review by 2026-11-23; expedite exposed high/critical paths. |

Sources: [Dependabot configuration](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference), [dependency review action](https://github.com/actions/dependency-review-action), [Electron releases](https://releases.electronjs.org/). Live reports take precedence over this dated snapshot.

### Electron 45 upgrade candidate (2026-11-16)

Target 45.3.3, the current stable npm release, from 37.10.3. Reviewed [breaking changes through 45](https://www.electronjs.org/docs/latest/breaking-changes): the preload only imports Electron and does not use removed Node shims; clipboard IPC now returns the asynchronous write and native menu copy handles rejection; provider guests remain sandboxed with Node integration disabled. Native PTYs stay unpacked, avoiding ASAR file-descriptor changes. No removed tracing, capture, certificate-selection or login-item APIs are used. PDF behavior, real OAuth and native downloads still need the physical checks above.

This raises the desktop minimum to macOS 13 and keeps 64-bit Windows/Linux builds. Development requires Node 22.12+. Electron now downloads its binary on first CLI/use, so its obsolete postinstall approval is removed; node-pty's explicit script approval remains. Builder remediation is a separate change; this Electron update does not claim all dependency advisories are resolved.
