# Changelog

## Unreleased

- Devices: detect stalled connections, bound socket/output/call queues, and acknowledge terminal output after parsing on desktop and Android. An overloaded viewer reconnects with a fresh synchronized replay while its PTYs and other viewers continue; input is never retried automatically.
- Android: bound native-to-WebView message queues and outgoing socket buffers, surface disconnect reasons, and retain reconnect backoff for repeatedly overloaded links.
- Shared layouts: save per workspace with host-checked revisions. Keep conflicting local layouts under an explicit choice, protect unsaved document buffers, and bind delayed saves to the device where the edit happened. Older hosts allow temporary local layout changes only.
- Documents: preserve text typed during an asynchronous file refresh and keep responses on their originating device.
- Configuration: flush and atomically replace JSON saves, keep the preceding valid version in a `.bak` file, and recover missing or damaged files with a visible notice. Damaged files are preserved; unrecoverable configuration stops startup instead of silently resetting it.
- Validation: GitHub Actions checks desktop logic on Linux, macOS and Windows, renderer regressions on Linux, and Android native tests, lint and debug APK builds.
- Windows: keep watching workspace roots named `dist` or another ignored cache name when the watcher normalizes path separators.
- Android: preserve ANSI, 256-color and truecolor foreground/background colors, bold and other text styles in the phone-width wrapped view. Attribute-only redraws now update even when the text is unchanged.
- Shared terminals: synchronize the host grid across desktop and Android viewers, including replay and live size changes. Desktop focus/input takes sizing control; background viewers cannot override it through layout updates.
- Queue terminal parsing, resizing and replay in order so concurrent viewers do not wrap cursor-addressed output at different widths. Smaller passive desktop panes can scroll the host grid.

## 0.4.0 — 2026-11-01

### Android companion

- Connect to desktop Tote over Tailscale as a client, with automatic discovery and reconnect.
- Navigate workspaces, groups and terminals through a side panel.
- Read phone-width wrapped terminal output without changing desktop PTY dimensions; switch to the original terminal grid when needed.
- Send terminal input, keep separate drafts, browse files and preview text or images.
- Dictate into an editable draft using the phone’s speech service. Transcription never sends automatically.
- Fix terminal-query handling that froze output and navigation when viewing Codex and other rich terminal applications.
- Fix workspace-switch races, stale group selection and terminal-output isolation between sessions.

### Desktop and devices

- Advertise shared Tote devices directly to same-owner Android peers over Tailscale; wired desktops and phones on different networks are supported.
- Include peer-directory hints so an updated computer can introduce older reachable Tote hosts.
- Keep host authorization and workspace ownership on the computer. Mobile viewing does not save or rearrange desktop layouts.

### Distribution and validation

- Publish Linux x64 AppImage, Debian and Arch packages alongside an Android debug-signed preview APK, all at version 0.4.0.
- Add Android emulator and live-server test tools, terminal-query regressions, drawer navigation tests and wrapped-output tests.
- Verify the installed APK against the actual main PC using native Android taps, live input/output, group/workspace switching and app background/foreground recovery.

The Android preview does not yet support mobile web-provider tabs, file editing/transfers, PDF previews or background audio recording. macOS and Windows remain available as source builds.
