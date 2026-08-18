# Tiling layout engine (phase 1)

**Status:** design approved, unimplemented
**Branch:** `feat/tiling-layout`
**Follow-up:** [#2](https://github.com/yusufkaraaslan/tote/issues/2) — move web leaves to `WebContentsView`

## Goal

Replace the fixed dock frame with a tiling layout, so web views, terminals and
the files tree are all equal, arrangeable panes in one tree per space. Today
`#center` is privileged: it cannot be split, moved, hidden or closed, so a web
view cannot sit beside a terminal and cannot be closed at all.

Requirements, in the user's words:

1. Every view is a pane — web, terminal, files alike
2. Opening a view places itself; no manual split step
3. Panes can be resized and rearranged
4. Several views visible at once in the same space

## Non-goals

- Tearing a pane out into a separate OS window. Explicitly out of scope; it is
  the one requirement that would have forced `WebContentsView` up front.
- Tabbed/stacked panes (several views behind one strip). Deferred; the zoom
  toggle is the crowding answer for now.
- Any change to how downloads, sessions, popups, MCP binding or PTYs work.

## Vocabulary

"Workspace" already means a project space in Tote, and means a layout screen in
Hyprland. To keep every future keybinding and doc unambiguous:

- **space** — a project workspace. Unchanged meaning, unchanged UI.
- **pane** — one tiled leaf. Never "window", never "workspace".

## Decisions taken, with rationale

### Panes are positioned by geometry, never by DOM nesting

A spike (throwaway, `scratchpad/spike*`, Electron 37.10.3) measured six live
`<webview>`s holding JS state through a sustained drag:

| | result |
|---|---|
| 3s drag, 6 guests, continuous restyle | 0 reloads, marks stable, unsaved input preserved |
| restyle cost | ~0ms median, 0.2ms worst |
| **reparenting one leaf** | **2 reloads, new mark, input destroyed** |
| DOM overlay above a webview | composites correctly |

So restyling is free and safe; reparenting silently destroys page state. The
engine must therefore never move a webview between DOM parents.

This is enforced structurally rather than by convention: `#tiles` is **flat,
exactly one level deep**. Every pane is a direct child. The tree exists only as
data and never appears in the DOM, so there is no nesting to reparent into.
"Moving a pane" is a tree edit followed by new rects — no DOM mutation at all.

### `<webview>` now, `WebContentsView` later, behind an adapter

Electron's docs recommend against `<webview>`. The spike showed it works today,
and the migration's real cost is nine overlay elements that must paint over
native views. Rather than bundle a discouraged-API migration into a new layout
engine, phase 1 ships on `<webview>` behind a seam and #2 swaps it.

The engine emits `{leafId, rect}` and never touches web content. Each pane kind
implements:

```
mount(container) · setRect({x, y, w, h}) · focus() · destroy()
```

| kind | `setRect` | phase 2 |
|---|---|---|
| `files` | CSS on a div | unchanged |
| `term` | CSS, then `fit()` + `ptyResize` | unchanged |
| `web` | CSS on the `<webview>` | → IPC `setBounds` |

If #2 turns out to need engine changes, this seam was wrong and should be fixed
rather than worked around.

## Data model

One binary tree per space, stored in `views.json` beside that space's tabs.
Binary because dwindle is binary: opening a view splits the focused pane.

```jsonc
{ "tote-mswt38av": {
    "tree": {
      "type": "split", "dir": "row", "ratio": 0.18,
      "a": { "type": "leaf", "id": "L1", "kind": "files" },
      "b": { "type": "split", "dir": "col", "ratio": 0.65,
             "a": { "type": "leaf", "id": "L2", "kind": "web",  "ref": "tab-7" },
             "b": { "type": "leaf", "id": "L3", "kind": "term", "ref": 4 } }
    },
    "focus": "L2",
    "zoom": null,
    "tabs": [ { "id": "tab-7", "providerId": "claude" } ]
} }
```

- `dir: 'row'` splits left/right, `'col'` splits top/bottom. `ratio` is `a`'s
  share, 0..1.
- `ref` points at a `tabs` entry for web panes, a pty id for term panes; `files`
  is a singleton per space and has none.
- Leaf `id` is stable and never reused, so `focus` and `zoom` survive a reload.
- `zoom` holds a leaf id or null.

Nested same-direction splits render identically to three-across; only resize
granularity differs — the inner divider moves the inner pair, the outer moves
everything. This is Hyprland's behaviour and is kept deliberately.

### Migration

Existing spaces have `layout` (`{files:{dock,visible}, terminal:{dock,visible},
sizes}`). On first read, build the equivalent tree so nobody opens the app to a
rearranged space:

- files docked left, visible → `row(files, rest)` with `ratio` from `sizes.left`
- files docked right → `row(rest, files)`
- terminal docked bottom, visible → `col(rest, term)` from `sizes.bottom`
- a hidden panel contributes no leaf
- no web tabs → the tree is whatever panels exist, or a single placeholder pane

`layout` is then dropped from that space's entry. `settings.layout` (the legacy
global seed) stops being read.

## Layout algorithm

One pure function, no DOM:

```
rectsFor(tree, containerRect) -> Map<leafId, rect>
```

Walk the tree; at each split divide the incoming rect by `ratio` along `dir`,
minus a fixed gutter for the divider. Leaves emit their rect. Pure input →
output means it is unit-testable without Electron, which matters because this is
where the real complexity lives.

Divider positions are derived from the same walk (the boundary between a split's
two child rects), so dividers are never stored — only `ratio` is.

## Interaction

### Auto-placement

Opening a pane splits the **focused** pane in two. Direction is chosen by the
focused pane's aspect ratio: split along its longer axis, so tiles stay roughly
square. Ratio 0.5. The new pane takes the `b` slot and receives focus.

This is Hyprland's dwindle. It satisfies "auto open is good" — there is never a
manual split step.

If no pane is focused (empty space), the new pane becomes the whole tree.

### Focus

Clicking anywhere in a pane focuses it; the focused pane gets an accent border.
Focus is per space and persisted. Focus drives auto-placement, zoom and every
keyboard operation.

### Resize

Dividers are hit targets derived from the layout walk. Dragging one updates that
split's `ratio` and re-emits rects. Minimum pane size clamps the ratio.

The drag **must** set `body.dragging` — an existing invariant, because
`pointer-events: none` on webviews is the only thing stopping the guest from
swallowing `mousemove` mid-drag.

### Rearrange

Drag a pane's header onto another pane:

- **centre** → swap the two panes (swap `ref`/`kind`, ids stay put)
- **edge (left/right/top/bottom quarter)** → re-split the target in that
  direction and move the dragged pane in

Both are tree edits only. No DOM node moves — that distinction is the whole
reason the reload hazard does not apply.

### Zoom

The crowding escape hatch. The focused pane is given the full container rect and
raised above the others; the rest keep their existing rects and are simply
occluded. Nothing is resized, so no reflow churn and no webview thrash. Toggling
restores.

### Close

Closing a pane removes its leaf; the sibling takes the parent split's place.

- **web** — also removes the `tabs` entry and destroys the webview
- **term** — also kills the pty
- **files** — hidden only; reopenable from the workspace strip, since it has no
  underlying instance to destroy

Closing the last pane leaves the space empty, showing the existing welcome copy.

### Keyboard

Deliberately small for v1. Modifier is `Ctrl+Alt` on Linux/Windows and
`Cmd+Alt` on macOS.

| binding | action |
|---|---|
| `mod + ← ↑ ↓ →` | focus the pane in that direction |
| `mod + shift + ← ↑ ↓ →` | move the focused pane in that direction |
| `mod + f` | zoom toggle |
| `mod + w` | close the focused pane |
| `` ctrl + ` `` | focus a terminal pane, spawning one if none exists (rebound; the panel it used to toggle no longer exists) |

Directional focus/move uses the focused pane's rect centre and picks the nearest
pane whose centre lies in that direction — geometric, not tree-based, so it
behaves the way it looks.

## What is deleted

- `#tabbar`, `#tabs`, `#tab-add-wrap` (the `+` moves to the workspace strip)
- `#dock-left`, `#dock-bottom`, `#dock-right`, `#split-left/-bottom/-right`
- `applyLayout()`, `layout()`, `PANELS`, `DOCKS`, `DEFAULT_LAYOUT`
- the `.dock-menu-btn` menu (dock left/bottom/right/hide)
- `togglePanel()`; `#btn-files` / `#btn-terminal` become "add a files/terminal
  pane if the space has none, else focus it"

`ensureWebview()`, `spawnTerm()`, the tree rendering, downloads, sessions,
popups, PTY plumbing and every `ipcMain` handler are untouched.

## Verification

The repo has no test suite and no framework, and this design does not introduce
one. But `rectsFor()` and the tree edits (split, remove, swap, move, resize
clamping) are pure functions where the real bugs will live, and testing them by
launching an Electron GUI is both slow and unreliable.

Proposal, to be confirmed before implementing: a single dependency-free
`node scripts/test-layout.js` that exercises the pure layout module and exits
non-zero on failure — no framework, no devDependency, consistent with the
project's no-bundler/no-tooling stance. Run manually; not wired into CI.

Everything else is verified by running the app:

1. Migration — an existing space opens with its old dock arrangement intact
2. Open four web views and two terminals; all six visible and usable at once
3. Drag every divider; confirm no webview reloads (page state survives)
4. Swap and edge-drop panes; confirm no reloads
5. Zoom toggle, close each pane kind, close the last pane
6. Switch spaces back and forth; each keeps its own tree
7. Restart; trees, focus and zoom restore

## Risks

- **The flat-container rule is load-bearing.** If a future change nests panes for
  any reason, webviews start reloading on every layout change and nothing will
  throw. Belongs in CLAUDE.md's invariants section.
- **All panes visible means all web content runs unthrottled.** Today one webview
  is visible and the rest throttle to roughly a third speed (measured). Tiling
  removes that saving; a space with six web panes will cost noticeably more CPU.
  No mitigation planned for v1 beyond zoom; worth watching.
- **Terminal resize churn.** Every divider drag refits xterm and pushes
  `ptyResize`. The existing spawn-time race (fit before spawn, resize after) has
  to hold for continuous drags too; refits should be throttled to animation
  frames and the pty resize debounced to drag end.
- **This is a large single change.** It replaces the entire layout layer. The
  spec deliberately keeps every other subsystem untouched to bound it.
