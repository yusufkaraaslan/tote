# Temporary (scratch) spaces

**Status:** design approved, unimplemented
**Branch:** `feat/temp-spaces`

## Goal

Let a space be created with no folder decision, worked in, and then thrown away
— files included — in one click. Today every space demands a destination folder
up front, before you know whether the work matters, so quick throwaway work
either pollutes an existing space or never happens in Tote at all.

Requirements, in the user's words: "temporary workspaces — the minute we're done
we clear the workspace."

Refined in brainstorming to three rules:

1. Clearing is **explicit** (a confirmed discard), with an **age sweep** at
   launch as the anti-clutter net. Nothing is deleted silently, ever.
2. A temp space can be **kept**: promoted to a real space at a folder you pick,
   with its tabs, groups and layout intact.
3. Creation asks for a name only — prefilled with a generated one — and never
   opens a folder picker.

## Non-goals

- Wiping temp spaces on quit. A crash or a restart mid-agent-task must not be a
  data-loss event, so no lifecycle hook deletes anything.
- A separate registry, tree, or pane type for temp spaces. A temp space is a
  space; every existing routing rule (downloads, inbox, `cwd`, watchers,
  `resolveSafe`) applies to it unchanged.
- Trash/undo for a discard. The confirm dialog is the safety mechanism.
- Encrypting, hiding, or excluding scratch folders from Time Machine/backup.

## Vocabulary

- **temp space** (UI: "temp") — a space with `temp: true`, living under the
  scratch root, eligible for discard and sweep.
- **scratch root** — `~/tote/scratch/`, the one directory temp folders may live
  in. Sibling of the existing `~/tote/workspace` Global default.
- **promote** — turn a temp space into a normal one by moving its folder.
- **discard** — unregister a temp space *and* delete its folder.
- **sweep** — the launch-time removal of temp spaces untouched for N days.

## Decisions taken, with rationale

### A temp space is a normal space with two extra fields

`workspaces.json` entries gain `temp: true` and `lastUsed` (epoch ms), set only
on temp spaces. Absent means "normal space", so no migration runs and every
existing reader keeps working. The alternative — a parallel `scratch.json`
registry — would fork the switch/activate/watch paths that everything else in
Tote already routes through, for no gain.

`lastUsed` is bumped in `setActive`, which is the one funnel every space switch
already passes through.

### Deletion lives in exactly one function, behind three guards

`discardTemp(id)` is the only code in Tote that deletes user files. It throws
unless all three hold:

1. the space has `temp: true`;
2. `fs.realpathSync` of its path is strictly inside `fs.realpathSync` of the
   scratch root (realpath on **both** sides, or a symlinked scratch dir — or a
   symlink planted inside it — escapes the check);
3. it is not the last remaining space.

The guard lives in that function, not at its call sites, so a future caller
cannot forget it. `sweepTemp` and the discard IPC handler both go through it.
This is a deliberate, contained exception to the standing invariant that
removing a space never touches files on disk; that invariant continues to hold
for `remove()`, which stays exactly as it is.

### Promotion moves the folder rather than copying it

`promote(id, absPath)` uses `fs.renameSync`, falling back to `fs.cpSync` +
`fs.rmSync` on `EXDEV` (target on another volume). A move keeps the work in one
place and leaves nothing behind in the scratch root to be swept later. On
success the entry drops `temp` and `lastUsed` and gains the new path; the tree
watcher is re-armed if the promoted space is active.

Running terminals keep the `cwd` they were spawned with — the old path — which
is the same behaviour `workspaces:setPath` already has. The confirm text says
so rather than pretending otherwise.

### The sweep reports and never runs mid-session

At startup, after config load, spaces with `temp: true` whose `lastUsed` is
older than `settings.scratchDays` (default 7) are discarded through the same
guarded function, and the renderer is told what went, as a toast. Running it
only at launch means a space you are actively using can never disappear under
you, whatever the clock says.

### Pure helpers live in a tested module

`src/main/scratch.js` holds the logic worth testing away from the filesystem:
slugging a name, generating the default name, picking a non-colliding folder,
the containment check, and the expiry predicate. `scripts/test-scratch.js`
covers it and `npm test` runs it alongside the layout suite. The repo's rule is
"everything but the pure engine is verified by running the app"; an `rm -rf`
path earns the exception.

## Data model

`<userData>/config/workspaces.json` — temp entries only differ by two fields:

```json
{
  "active": "scratch-2026-08-19-1-l8yz3k",
  "list": [
    { "id": "global", "name": "Global", "path": "~/tote/workspace" },
    { "id": "scratch-2026-08-19-1-l8yz3k", "name": "scratch-2026-08-19-1",
      "path": "~/tote/scratch/scratch-2026-08-19-1",
      "temp": true, "lastUsed": 1755600000000 }
  ]
}
```

`<userData>/config/settings.json` gains one key:

```json
{ "bridgeDownloads": true, "setupDone": false, "scratchDays": 7 }
```

`config/settings.json` (the seed copy) gains it too. Note the userData copy wins
for existing installs, so `scratchDays` must be read with a `?? 7` default
rather than assumed present.

## API surface

Adding a capability is three edits — `main.js`, `preload.js`, `app.js` — per
repo rule. All four channels follow it.

**`WorkspaceManager` (`src/main/workspace.js`)**

| method | behaviour |
|---|---|
| `scratchRoot()` | `~/tote/scratch`, created on demand |
| `addTemp(name)` | slug → non-colliding dir under scratch root, `mkdir -p <dir>/inbox`, push `{id, name, path, temp: true, lastUsed: now}`, return id |
| `discardTemp(id)` | three guards → `fs.rmSync(path, {recursive: true, force: true})` → unregister → return new active state |
| `promote(id, absPath)` | rename (EXDEV → copy+remove) → clear `temp`/`lastUsed` → set path |
| `sweepTemp(days, now)` | discard every expired temp space, return `[{name, path}]` removed |
| `setActive(id)` | unchanged, plus: bump `lastUsed` when the target is temp |

**IPC (`src/main/main.js`)** — `workspaces:addTemp` (name),
`workspaces:discard` (id, termLabels — measures, confirms via
`dialog.showMessageBox`, then deletes; returns `{canceled: true}` or the new
state), `workspaces:promote` (id, folder picker), and a `workspace:swept` push
to the renderer with the sweep report.
`workspaces:discard` and `workspaces:promote` call `watchActive()` after,
matching every other handler that can change the active space.

**Preload (`src/preload/preload.js`)** — `tote.wsAddTemp`, `tote.wsDiscard`,
`tote.wsPromote`, `tote.onWorkspacesSwept`.

**Renderer (`src/renderer/app.js`)** — a `+ temp` control beside the existing
add; `renderWorkspaceSwitcher` marks temp chips; the chip context menu gains
`keep… (make permanent)` and `discard… (deletes files)` in place of `remove
workspace (keeps files on disk)`.

## Flows

### Create

1. `+ temp` → the repo's existing `askInput` modal (Electron has no
   `window.prompt`; `renameWorkspace` already uses `askInput`), prefilled with
   `scratch-<YYYY-MM-DD>-<n>`, where `n` is the lowest integer with no existing
   folder or space of that name. Enter accepts; any other name is taken as typed.
2. `addTemp` slugs it (`[^a-z0-9]+` → `-`), resolves collisions by suffixing
   `-2`, `-3`, …, creates `<scratch>/<slug>/inbox/`.
3. The space is registered, activated, the watcher re-armed, and the strip
   re-rendered — the same tail as `workspaces:add`.

### Discard

1. The renderer calls `tote.wsDiscard(id, termLabels)`, passing the names of the
   terminals it owns — only the renderer knows which PTY belongs to which space.
2. Main runs the three guards, measures the folder (file count, total size), and
   shows `dialog.showMessageBox` itself — the confirm belongs in main because
   that is where the native dialog API lives, and a destructive delete deserves a
   real dialog rather than the renderer's `confirm()` used by `remove()`. The
   dialog names the path, the size, and every terminal about to be killed;
   `defaultId`/`cancelId` both point at Cancel. Cancel returns `{canceled: true}`
   and nothing has happened yet — no files touched, no panes closed.
3. On confirm, main deletes (`rm -rf`), unregisters, falls the active space back
   to the first in the list, calls `watchActive()`, and returns the new state.
4. The renderer then tears the space down through the path that already exists
   for space removal: close its panes, kill its PTYs, drop its `views.json`
   entry. Teardown runs after deletion so a cancel can never leave a half-closed
   space; killing a PTY whose `cwd` has just been removed is safe on POSIX.
5. Toast names what was deleted.

### Promote

1. `keep… (make permanent)` → folder picker (`openDirectory`,
   `createDirectory`), defaulting outside the scratch root.
2. `promote(id, target)` moves the folder; the space keeps its id, so
   `views.json` — tabs, groups, layout, focus — survives untouched.
3. The chip loses its temp styling; the context menu reverts to the normal one.
4. Toast: kept at `<path>`; running terminals still sit in the old `cwd`.

### Sweep

1. At startup, after `ConfigStore` load: `sweepTemp(settings.scratchDays ?? 7,
   Date.now())`.
2. Each expired space goes through `discardTemp`, so a space whose folder was
   already deleted by hand unregisters cleanly (`force: true`).
3. The report is pushed to the renderer once the window is ready and shown as a
   toast: "swept 2 temp spaces (14 days idle)".

## Error handling and edge cases

| case | behaviour |
|---|---|
| Discard the active space | Allowed; active falls back to the first remaining space, exactly like `remove()` |
| Discard the last space | Refused — "Keep at least one workspace", the existing rule |
| Discard a non-temp space | Refused by guard 1; the UI never offers it |
| Space path outside scratch root (hand-edited JSON) | Refused by guard 2; nothing deleted, error surfaced as a toast |
| Folder already gone | `rmSync({force: true})` succeeds; the entry unregisters |
| Folder busy / permission denied | Error propagates to a toast; the space stays registered, nothing half-deleted |
| Promote across volumes | `EXDEV` → `cpSync` + `rmSync` |
| Promote onto an existing non-empty folder | Refused before moving, with the target named |
| Promote into the scratch root | Refused — it would be swept later |
| Name collides with an existing folder | `-2`, `-3`, … suffix; the space name keeps what the user typed |
| Agent running in the space at discard | Its PTY is killed in step 2 and the confirm dialog names it first |
| `scratchDays` missing (existing install) | `?? 7` |
| `scratchDays: 0` or negative | Sweep disabled, not "sweep everything" |

## Testing

`scripts/test-scratch.js`, dependency-free like the layout suite, run by
`npm test`:

- slug: spaces/punctuation/unicode → safe folder names; empty result rejected
- default name: `scratch-<date>-1`, then `-2` when `-1` exists
- collision: `uniqueDir` suffixes rather than reusing an occupied name
- containment: inside root ✓; the root itself ✗; sibling with a shared prefix
  (`~/tote/scratch-evil`) ✗; `..` traversal ✗; symlinked path resolved before
  comparison ✗ when it lands outside
- expiry: older than N days ✓; exactly N days ✗; `lastUsed` missing ✗;
  `days <= 0` disables

Verified by running the app (repo convention): create → agent lands in the
scratch `cwd`; a download routes to `<scratch>/inbox/<provider>`; discard with a
live terminal; promote across a volume; relaunch with a back-dated `lastUsed`
to see the sweep report.

## Docs to update

- `CLAUDE.md` — new invariant bullet: deletion happens in one guarded function,
  only for `temp: true` spaces inside the scratch root; `remove()` still never
  touches files.
- `AGENTS.md`, `README.md` — temp spaces in the spaces section.
- `archlens.model.yaml` — entry for `src/main/scratch.js` and the new
  `WorkspaceManager` methods (the model already lags; do not widen the gap).

## Follow-ups, explicitly deferred

- Auto-promote prompt when a temp space gets a git repo or exceeds a size
  threshold.
- A "recently swept" undo buffer (move to trash instead of `rm -rf`).
- Per-space scratch retention overriding `scratchDays`.
