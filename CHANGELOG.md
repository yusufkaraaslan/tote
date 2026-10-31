# Changelog

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
