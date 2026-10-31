# Tote for Android

A client-only Android app for Tote's existing device host. The phone never shares a device, starts a local shell, or owns workspace files. It connects to the desktop's v1 JSON WebSocket protocol over Tailscale.

## Install and connect

1. Build the debug APK below, then transfer `android/app/build/outputs/apk/debug/app-debug.apk` to your phone and open it. Android may ask you to allow installation from the app opening the APK.
2. Install and connect Tailscale on the phone using the **same owner account** as the computer.
3. In desktop Tote, enable **Share device** under device settings. Keep Tote running and the computer awake.
4. Open Tote on the phone and choose your computer. Desktop Tote sends discovery announcements directly to its owner's online Android devices through Tailscale. **No same-network requirement, address entry, QR pairing, API key, or second login.** A wired desktop and a phone on mobile data work through the same path. Both apps need this updated discovery implementation. A first discovery can take a few seconds; verified computers are remembered. Address entry remains an optional troubleshooting fallback under **Connect by address instead**.
5. Pick a workspace, then a group and pane. The group and pane dropdowns stay above the terminal. Use the microphone beside the input to record; Stop transcribes into an editable draft and opens the keyboard. Send is always a separate action.

The host still enforces its existing same-owner `tailscale whois` authorization. No public server or relay is introduced. Plain WebSocket traffic is carried inside Tailscale's encrypted network; native code only accepts literal addresses in `100.64.0.0/10`, never arbitrary URLs or redirects. The WebView keeps its normal mixed-content policy and a restrictive CSP. Do not publish the desktop port on the internet.

## Build

Requirements: Node 22+, JDK 21, Android SDK platform 36, and the normal Android build tools. Android Studio can manage these. Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to your SDK (or set `sdk.dir` in untracked `android/local.properties`).

From the repository root:

```sh
npm ci
npm ci --prefix mobile
npm run mobile:apk
```

Or inside `mobile`:

```sh
npm run android  # sync assets and open the native project in Android Studio
npm run apk      # sync and assemble a debug APK
```

Debug APK: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

With a phone connected and USB debugging enabled:

```sh
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

This is a debug build for testing, not a Play Store release. Release signing and store packaging are intentionally unconfigured.

## Included

- Automatic Tailscale-computer discovery, remembered computers, per-viewer workspaces, persisted desktop groups, terminal/pane selection. Connecting to an updated host also discovers its same-owner Tailscale peers; each candidate must pass a Tote probe before it is saved.
- Real xterm output and PTY input, screen replay, automatic reconnect, and foreground resume. Leaving the app detaches the viewer; host sessions keep running while Tote remains running.
- Per-session in-memory drafts. Reconnect never resends an unacknowledged input. Android process termination clears unsent drafts.
- Desktop terminal dimensions preserved by default; horizontal/vertical scrolling on the phone. **Fit to phone** explicitly resizes the shared PTY and affects other viewers.
- Esc, Tab, arrows, Enter and Ctrl+C; multiline composer; separate Send.
- New terminals use host CLI profiles and appear under **Other terminals** until arranged into a group on desktop. Mobile never writes `views.json`.
- Read-only file tree, text/source and image previews. Workspace paths are resolved by the host's existing safe file API. HTML is shown as source; host content never executes in the Android WebView.
- Native Android `SpeechRecognizer`: runtime microphone permission, recording popup, Stop, Cancel, service errors, and editable transcription. Uses the phone's current language and configured recognition service, which may require a network connection. A service can finish automatically on silence; this inserts its final transcript without submitting. No audio files are retained by Tote.

Not yet included: mobile provider web sessions, PDF/binary previews, file editing/upload/download, desktop app launch, creating/rearranging groups, agent-status notifications, or background audio recording.

## Validation

```sh
npm test                         # desktop suite plus mobile protocol/model tests
npm run test:mobile-ui            # isolated Electron renderer; fake network/speech only
cd mobile/android
./gradlew testDebugUnitTest lintDebug
```

The mobile protocol tests use the real `DeviceServer` and headless session mirror over loopback. They check reconnect replay, disconnect survival, host allow-list enforcement, pending-call rejection, and no automatic resize/input retry. UI tests exercise group switching, separate drafts, voice stop/cancel, keyboard focus requests, reconnection, literal file rendering, new terminals and narrow-screen layout. Native Java tests check the Tailscale address boundary.

Physical-phone checks still matter: Tailscale authorization, microphone service availability, Turkish/other language dictation, soft keyboard resizing, long scrollback, alternate-screen TUIs, and background/foreground recovery. Desktop renderer tests cannot establish these Android-specific behaviors.

## Code map

- `src/client.js`: transport-independent protocol client.
- `src/model.js`: groups, selection and destination validation.
- `src/discovery.js`: bounded, deduplicated Tailscale probes for discovered computers.
- `android/.../ToteDiscoveryPlugin.java`: receive-only UDP discovery over the Tailscale VPN.
- `src/app.js`: mobile viewer UI; `src/native.js`: Capacitor bridge adapter.
- `android/.../ToteNativePlugin.java`: bounded native WebSocket transport and keyboard request.
- `android/.../ToteSpeechPlugin.java`: microphone permission and speech lifecycle.
- `scripts/build.mjs`: bundle client and reuse the desktop terminal-report filter.

The desktop update sends a small JSON connection announcement every five seconds, only to online same-owner Android peers returned by `tailscale status`. UDP source sockets are bound to the host's Tailscale IPv4; destinations are validated Tailscale IPv4 addresses and fixed UDP port `47822`. No LAN multicast or public registry is used. Sharing off stops announcements. A failed discovery lookup never disables the terminal server.

Android listens for at most 20 seconds while looking for computers and stops on backgrounding or connection. This is a receive-only discovery socket, not a host: there is no file, terminal, or HTTP service on the phone, and packets never receive replies. It rejects non-Tailscale sources, oversized/malformed packets, protocol mismatches and a claimed address different from the packet source. Candidates are deduplicated and bounded, then independently verified by the existing authenticated WebSocket `probe` handshake before listing or saving. `device:peers` also lets a connected host suggest other own devices.

The existing Tailscale app supplies connectivity; Tote does not read its private peer-list API or run a second VPN. Normal Tailscale access rules apply. A custom policy blocking desktop-to-phone UDP 47822, or “block incoming connections” on the phone, will block new discovery; remembered hosts can still be contacted through the usual TCP device port. No router port forwarding is needed.

For development, `node scripts/mobile-discovery.js` temporarily adds these announcements to an already-running older desktop host. It first probes the existing authenticated server, never attaches to sessions, and exits when the host becomes unavailable. Updated desktop builds include announcements directly and need no helper.

Discovery announcements also introduce online computers owned by the same Tailscale account. The phone verifies the announcing host first, then probes each computer directly; older Tote servers can appear without upgrading or restarting them. Directory probes use the announcing host’s device port (47821 by default).

### Live server simulation

Run `npm --prefix mobile run simulate -- 100.x.y.z` to open the actual mobile UI in a phone-sized Electron window and test a real shared Tote host through Tailscale. This is an opt-in integration test: it creates two temporary shell sessions in two existing local workspaces, checks streamed output, workspace switching, replay, reconnect and file listing, then kills only its own sessions and restores the host registry’s initial active workspace. It does not save desktop layouts. A screenshot is saved to `dist/mobile/server-simulation.png`.

The simulator replaces Android plugin calls with an Electron transport; it does not validate Android networking, discovery reception, the keyboard or speech recognition. Those require a phone or Android emulator.

### Android APK checks

The 0.3.4 fix was reproduced and verified in a Pixel 6 / Android 35 emulator using the installed APK, native picker taps, native OkHttp sockets and the actual main PC. Check rich terminal sessions as well as plain shells: terminal device queries exercise the response filter and previously stalled xterm’s parser. The UI regression fixture now emits those queries during replay and live output.

For APK debugging, forward port 18765 to `localabstract:webview_devtools_remote_<app-pid>` with adb, then run `node mobile/scripts/android-debug.mjs inspect`. The helper also supports `tap <CSS selector>`, `pick <native option label>`, `type <text>` and `wait <JavaScript condition>`. It defaults to `emulator-5554` and the Pixel 6 status-bar offset; override `TOTE_ADB_SERIAL`, `TOTE_WEBVIEW_TOP`, and `ANDROID_HOME` for other configurations. These commands use real Android taps; they do not dispatch synthetic select change events.
