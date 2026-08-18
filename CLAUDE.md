# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tote is an Electron desktop app: web LLM tabs (Kimi, Claude, ChatGPT, …) + a shared **workspace** folder pane + docked CLI-agent terminals (Claude Code, Kimi CLI, Codex, …). The organizing idea is **spaces**: one Global workspace plus project workspaces. The *active* space is the routing context for everything — web-tab downloads land in `<space>/inbox/<provider>/`, native-app downloads are bridged into `<space>/inbox/_desktop/`, and every new terminal spawns with `cwd = <space>`.

The project was renamed from OmniHub to Tote; `migrateFromOmniHub()` in `main.js` moves the old userData folder, renames `omnihub-*` partition dirs and `installer.js` upgrades the `omnihub-workspace` MCP key — keep that migration until users have moved. Plain JavaScript everywhere (CommonJS in main, vanilla browser JS in renderer). No bundler, no TypeScript, no linter. The only tests are `npm test` → `scripts/test-layout.js`, a dependency-free check of the pure tiling engine; everything else is verified by running the app. `AGENTS.md` and `README.md` also describe the project; keep all three in sync when changing architecture.

## Commands

```bash
npm install            # postinstall runs scripts/copy-vendor.js: vendors xterm assets + chmod +x node-pty's spawn-helper
npm start              # electron .
npm rebuild node-pty   # if terminals are disabled ("node-pty unavailable" toast); needs a C++ toolchain
./scripts/install.sh   # prereq checks + npm install + npm start

npm run pack           # electron-builder --dir (unpacked build, fast smoke test)
npm run dist           # installer for current platform → dist/
npm run dist:linux | dist:mac | dist:win
```

There are no automated tests; verify changes by running the app. `main.js` takes a single-instance lock — if `npm start` appears to do nothing, an instance is already running and just got focused; quit it first. Runtime config lives in `<userData>/config/` (Settings → "open config folder"; `<userData>` = `~/Library/Application Support/Tote` on macOS, `~/.config/Tote` on Linux, `%APPDATA%\Tote` on Windows), and the Global workspace defaults to `~/tote/workspace`.

## Architecture

Three Electron layers, strictly separated:

- **`src/main/`** — all Node/OS access.
  - `main.js` — window, per-provider `session` setup (`will-download` hook), Downloads-folder bridge, local-service starter (`ensureLocalService`, e.g. DeepSeek Harness web UI), native-app detection/launcher, and **every `ipcMain` handler**.
  - `workspace.js` — `WorkspaceManager`: spaces registry, `resolveSafe`, tree, text read/write, `ingest()`, chokidar watchers (workspace tree + `~/Downloads`).
  - `config.js` — `ConfigStore`: on first run copies `config/*.json` into `<userData>/config/`, then reads/writes only the userData copies. `views.json` holds per-workspace open web tabs *and* the tiling tree (`{ [wsId]: { tabs: [{id, providerId}], tiling: { tree, focus, zoom } } }`); the legacy `layout` key is migrated to a tree on first read.
  - `ptyManager.js` — node-pty sessions keyed by numeric id; streams `pty:data`/`pty:exit` back to the `sender` webContents.
  - `installer.js` — setup-wizard backend: system checks, Claude Desktop MCP binding (`claude_desktop_config.json`, with `.bak-<ts>` backup), generic MCP snippet.
- **`src/preload/preload.js`** — `contextBridge` exposing `window.tote`. This is the *only* API surface the renderer has. Wrapper names differ from IPC channel names (`tote.tree()` ↔ `workspace:tree`, `tote.ptyRun()` ↔ `pty:run`) — grep preload.js to map one to the other.
- **`src/renderer/`** — `index.html` + `app.js` (single file, one `state` object, section-commented) + `styles.css`. Uses `<webview>` tags for provider tabs and xterm.js for terminals. CSP is `script-src 'self'` — no inline scripts, no CDN; third-party JS must be vendored via `scripts/copy-vendor.js`.

### Invariants that span files

- **Active workspace is resolved at call time, never cached.** Every download handler, bridge callback, and `pty:spawn` calls `workspace.getRoot()` / `workspace.inboxDir()` when the event fires, so switching spaces re-routes instantly. Don't capture the root in a closure.
- **All workspace file access goes through `WorkspaceManager.resolveSafe(rel)`** (path-escape guard). Renderer only ever passes relative paths.
- **Session partition names must match in two places**: `partitionFor()` in `main.js` and the `partition` attribute set in `ensureWebview()` in `app.js` (`persist:tote-<providerId>`). The `will-download` interception only works because both agree.
- **Adding a capability = three edits**: `ipcMain.handle`/`ipcMain.on` in `main.js` → wrapper in `preload.js` → call site in `app.js`. Never enable `nodeIntegration` or weaken `contextIsolation`.
- **Providers, CLI profiles, workspaces, apps, settings are data, not code** — defaults in `config/*.json`, live copies in userData. Add entries there rather than hardcoding. Note: editing `config/*.json` does **not** affect an existing install (the userData copy wins); delete the userData file to re-seed when testing default changes.
- **Terminals must stay real PTYs** (node-pty). Piping through `child_process` breaks TUI agents. `pty:run` (wizard installs) and `pty:spawn` (agent tabs) both go through `PtyManager`.
- **CLI profiles carry an `install` command** (`npm i -g <pkg>`) used by the wizard's one-click install; keep package names accurate. An empty `command` means "user's default shell"; optional `hint` is printed (yellow) into the terminal at spawn. DeepSeek Harness is deliberately *not* a CLI profile (it only has `web`/`headless` modes) — it's the `dsh-local` web provider.
- **Setup wizard is split**: backend in `installer.js` + IPC in `main.js` (`setup:*`, `conn:*`, `pty:run`); UI in the "setup wizard" section of `app.js` (`wiz*` / `renderWz*` functions, `wizTerm` xterm for install output) and `#wizard-modal` in `index.html`. It auto-opens while `settings.setupDone === false`.
- **Native apps are launched, never embedded.** `launchApp()` special-cases `kind: 'claude'` to write the MCP binding before spawning; other apps rely on the Downloads-folder bridge (`applyBridgeSetting`, toggled by `settings.bridgeDownloads`). `detectApps()` seeds `apps.json` from `KNOWN_APPS` only while the list is empty — once a user has any entry it never re-seeds.
- **Workspace watcher must be re-armed on every active-space change.** `workspace.watch()` binds chokidar to the current root; every IPC handler that changes the active workspace (`workspaces:add/setActive/remove`) calls it again. A new handler that switches spaces must do the same or the tree stops refreshing.
- **"Send to active tab" is best-effort DOM injection.** `tab:sendFile` takes the webview's `getWebContentsId()`, base64s the file (≤15 MB) and `executeJavaScript`s a `File` into the page's `input[type=file]` (fallback: synthetic drop). It only works after the webview has been created/attached, and it will break silently when a provider changes its upload markup.
- **Webview popups stay in-app.** `web-contents-created` allows every http(s) popup as a child window so it shares the provider's session partition — OAuth (Google/GitHub login) only works if the cookies land in that partition. Never route login popups to the system browser. Only non-web schemes go external.
- **UA must stay truthful.** `chromeUA()` takes Electron's real UA and strips only the `Electron/…` and `Tote/…` tokens. Hardcoding a UA with a different Chrome version/platform makes Cloudflare-fronted sites (claude.ai) render blank.
- **A GUI launch has a minimal PATH.** Started from Finder/Dock/`.desktop`, the app only gets `/usr/bin:/bin:/usr/sbin:/sbin` — no `npm`, no version-manager shims (fnm/nvm/asdf/volta), nothing in `~/.local/bin`. It works in dev only because `npm start` inherits the terminal's PATH. Two defenses, keep both: `adoptLoginShellPath()` in `main.js` reads the real PATH from `$SHELL -l -i` once at startup (fixes `cli:check`, `installer.js`'s `cmdVersion`, `ensureLocalService`), and `shellCommand()` in `ptyManager.js` runs every profile as `$SHELL -l -i -c 'exec <cmd>'` so each terminal resolves its own live env. Terminals can't use the startup snapshot — fnm builds a per-shell bin dir and can switch node version by directory. Never go back to exec'ing `profile.command` directly on POSIX.
- **node-pty `spawn-helper` needs the exec bit.** npm strips it on extract → every spawn fails with `posix_spawnp failed`. `scripts/copy-vendor.js` (postinstall) restores it; `build.asarUnpack` keeps node-pty outside the asar so packaged builds can exec it too.
- **Views belong to the workspace.** Web tabs are *instances* (`wsViews().tabs`, several of one provider allowed), opened from the `+ web` menu on the workspace strip and persisted in `views.json`; each becomes a pane. Terminals carry `wsId`. `showWorkspaceViews()` runs on every workspace switch/add/remove and calls `applyTiles()`, which hides every pane not in the active space's tree. Other spaces' webviews and PTYs stay alive in the background. Never show a view from another workspace.
- **Layout = a tiling tree, per workspace (`wsViews().tiling = {tree, focus, zoom}`, persisted in `views.json`).** Web views, terminals and the files tree are all equal **panes** (leaves) in one binary tree per space; there are no docks and no global tab strip. The pure engine is `src/renderer/layout.js` (`window.TileTree`, also `require`-able) — tree edits, `rectsFor`, `dividersFor`, `clampRatio`, geometric `neighbour`, and `migrate` from the old dock layout — covered by `npm test` (`scripts/test-layout.js`, no framework). `applyTiles()` in `app.js` turns the tree into rects and applies them; `openPane`/`closePane`/`focusPane`/`toggleZoom` are the entry points. Opening a pane splits the focused one along its longer axis (dwindle). Vocabulary: **space** = project workspace, **pane** = a tile — never "window" or "workspace" for tiling.
- **`#tiles` is FLAT and a pane element is created once per content instance.** A pane's DOM node is a direct child of `#tiles`, built once per web tab / pty / files tree, and **never reparented** — a tree edit changes which *rect* an element receives, never which parent it has. This is load-bearing, not stylistic: reparenting a `<webview>` detaches its guest and reloads the page, destroying scroll position and unsent chat drafts, silently and without throwing. Measured both ways in a spike (`docs/superpowers/specs/2026-08-18-tiling-layout-design.md`) and re-confirmed in the running app: 6 live webviews survived 60 divider resizes plus a pane swap with page state intact. Never write `someContainer.appendChild(paneEl)`.
- **Divider and pane drags must add `body.dragging`** (sets `pointer-events: none` on webviews) or the guest view swallows `mousemove` mid-drag.
- **Terminal size race**: `spawnTerm` fits xterm synchronously *before* `ptySpawn` and pushes `ptyResize` right after — the PTY must be created at the real size, not 80×24. A `ResizeObserver` on `#term-container` refits on any layout change.
