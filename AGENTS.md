# Tote — agent notes

Electron hub app: web LLM tabs + shared workspace folder + docked CLI-agent terminals.

- Run: `npm install && npm start` (postinstall copies xterm assets to src/renderer/vendor).
- Main process: `src/main/` (sessions per provider partition, downloads → ACTIVE workspace's inbox/, Downloads-folder bridge for native apps (macOS only; copies, and only files the quarantine xattr attributes to a known LLM app), app launcher, IPC, node-pty). Setup wizard logic lives in `src/main/installer.js` (system checks, Claude Desktop MCP binding, MCP snippet) + the `#wizard-*` section of `src/renderer/app.js`.
- CLI profiles carry an `install` command (npm -g) used by the wizard; keep package names accurate when adding profiles.
- Workspaces are two-level: one `global` + project spaces in `config/workspaces.json`. All file ops resolve the ACTIVE space at call time via `WorkspaceManager.getRoot()` — never cache the root. Spaces are managed from the top strip's right-click menu and the Workspaces section of Settings (add / rename / change folder / remove → `workspaces:*` IPC); ids are stable across rename/re-point.
- Renderer: `src/renderer/` vanilla JS, no bundler. Bridge surface = `window.tote` (see `src/preload/preload.js`).
- Providers, CLI profiles, workspaces and apps are **data**, not code: defaults in `config/*.json`, runtime copies in userData. Prefer adding entries there over hardcoding.
- Never give the renderer `nodeIntegration`. New capabilities go through ipcMain handlers in `main.js` + preload wrappers.
- Keep all workspace file access inside `WorkspaceManager.resolveSafe` (path-escape guard).
- Terminals must stay real PTYs (node-pty) — piping through child_process breaks TUI agents. node-pty's prebuilt `spawn-helper` must be executable (postinstall chmods it; asarUnpack for packaged builds) or spawns fail with `posix_spawnp failed`.
- A GUI launch (Finder/Dock/`.desktop`) gives the app a minimal PATH, so `codex`/`claude`/`npm` are missing even though they work in a terminal. `ptyManager.js` runs every CLI profile through `$SHELL -l -i -c 'exec …'`, and `adoptLoginShellPath()` in `main.js` adopts the login shell's PATH at startup for the wizard checks and local services. Don't exec profile commands directly on POSIX.
- Webview popups (OAuth) must open in-app so they share the provider partition; only non-http schemes go to the system browser. UA = Electron's real UA minus Electron/Tote tokens — never a hardcoded foreign UA.
- Views are per-workspace: web tabs are instances stored in `views.json` (`+` menu opens providers, duplicates allowed), terminals tagged with `wsId`; `showWorkspaceViews()` restores a space's setup on switch.
- Layout: a **tiling tree of panes**, not docks. Web views, terminals and the files tree are equal leaves in one binary tree; the pure engine is `src/renderer/layout.js` (`window.TileTree`, covered by `npm test`) and `applyTiles()` in app.js turns the tree into rects. `#tiles` is flat: a pane element is created once per content instance and **never reparented** — reparenting a `<webview>` reloads the guest and loses page state.
- Each space holds **groups** — virtual desktops with their own tree (`views.json`: `groups[]` + `activeGroup`), switched from `#group-bar` or Cmd/Ctrl+Alt+1…9. Other groups' webviews and PTYs stay alive and hidden. Walk persisted trees with `groupsOf(V)`, never `V.tiling`.
- The files tree is a **dock**: `insertRoot` pins it to the whole left edge at the width it had when closed (`filesRatio`, per space); `splitTarget()` and `openPane` keep content panes out of it.
- Any splitter or pane drag must toggle `body.dragging` so webviews don't eat mouse events. Fit xterm before `ptySpawn` and `ptyResize` after, or TUIs render at 80×24. Shift+Enter needs the `attachCustomKeyEventHandler` in `spawnTerm` that sends ESC+CR — xterm's default CR is indistinguishable from Enter, so agents submit instead of adding a line.
