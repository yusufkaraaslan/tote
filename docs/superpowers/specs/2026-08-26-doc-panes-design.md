# Doc panes — viewing and editing files as tiles

**Status:** design approved, unimplemented
**Branch:** `feat/doc-panes`

## Goal

Make a file something you can *look at* inside Tote. Today clicking a text file
in the workspace tree opens `#editor-modal` — a bare `<textarea>` floating over
the whole app, one file at a time, save-or-cancel — and anything not in
`TEXT_EXT` is handed to the system app and leaves Tote entirely.

Requirements, in the user's words: "file view like let's say I click text file I
can see simple text editor or I press md file I can see md renderer etc."

Refined in brainstorming to four rules:

1. A file opens as a **pane**, not a modal — a leaf in the tiling tree, equal to
   web tabs and terminals, so a rendered README can sit beside the agent that is
   rewriting it.
2. A click **reuses** the file pane you already have; Cmd/Ctrl-click (or a
   context-menu item) opens a second one for side-by-side.
3. Editing is **explicit save** with a dirty marker, and an external edit — an
   agent in the next pane — reloads a clean pane silently and *asks* on a dirty
   one.
4. Markdown opens **rendered**, with a `src`/`view` toggle to edit.

Four kinds ship in v1: text/code (editable), markdown (rendered), images, PDF.

## Non-goals

- An IDE. No syntax highlighting, find/replace, multi-cursor, undo history
  beyond the textarea's native one, or git integration. This is a viewer that
  can save.
- Autosave. An agent and a human writing the same file need a visible conflict,
  not a silent last-writer-wins.
- Rendering `.html`. Executing a workspace file's markup inside the renderer
  that holds `window.tote` is the one thing this design exists to avoid.
- A guard on app *quit* with unsaved edits. Closing or reusing a dirty pane
  prompts; quitting loses the buffer, exactly as today's modal does.
- Markdown completeness. Footnotes, reference links, and raw-HTML passthrough
  are out; see "Markdown subset" below for why that is a feature.
- A new dependency. See "Approach" below.

## Vocabulary

- **doc pane** — a pane showing one file. Leaf kind `'doc'`.
- **doc instance** — the persisted `{ id, path, mode }` record a doc leaf
  references. Its `path` is mutable; that is the whole point.
- **kind** — how a file is displayed: `text`, `md`, `image`, `pdf`, `binary`.
  Decided in the main process from the extension.
- **mode** — `view` or `src`, for the two kinds that have both (`md`, `.svg`).

The existing vocabulary holds: **space** = project workspace, **pane** = a tile.
The files tree remains the **dock**, kind `'files'` — a doc pane is not it.

## Approach

The rendering half was chosen against two alternatives:

- **Vendoring `marked` + `DOMPurify`** buys full CommonMark+GFM for ~40 lines of
  glue, but doubles the runtime dependency count (currently three: xterm ×2,
  node-pty, chokidar), adds ~70 KB through `copy-vendor.js`, is invisible to
  `npm test`, and puts the app permanently on the `innerHTML` + sanitizer path.
  One DOMPurify misconfiguration and a downloaded README runs script in a
  renderer that has `tote.*` on the window.
- **Vendoring a real editor** (CodeMirror 6, Monaco) is a bigger change than the
  feature: CM6 is ESM-only and assumes a bundler this repo does not have, Monaco
  needs web workers under `script-src 'self'`.

Chosen: **a dependency-free parser in this repo**, `src/renderer/markdown.js`,
pure and unit-tested, with a DOM builder that never touches `innerHTML`. This
matches how the repo already works — `layout.js` and `scratch.js` are pure,
tested engines with thin DOM/IO wrappers — and makes XSS structurally impossible
rather than a property of a sanitizer staying correctly configured. If the
subset ever bites, swapping in `marked` later is contained behind one function
signature.

## Data model

A new leaf kind `'doc'` — deliberately not `'file'`, because the dock kind
`'files'` already exists and a one-character difference in a string compare is a
bug waiting to happen.

Instances live in `views.json` under the space, beside `tabs`:

```json
"ws-1": {
  "tabs":   [{ "id": "t…", "providerId": "claude" }],
  "docs":   [{ "id": "d…", "path": "docs/README.md", "mode": "view" }],
  "groups": [ { "id": "G1", "name": "1", "tree": { "type": "leaf", "kind": "doc", "ref": "d…" }, … } ],
  "filesRatio": 0.22
}
```

Ids come from the existing `newId('d')` — the same generator as tabs, so
`adoptLeafSeq` needs no change (it exists for `term`, whose refs are a per-run
counter). `mode` is persisted so a restart brings back what you were looking at.

Runtime state is a parallel `state.docs` map, `docId → { path, kind, savedText,
mtimeMs, size, mode, stale }`. **Only `{ id, path, mode }` is persisted** — an
unsaved buffer never reaches `views.json`.

### Why an instance, not the path, as the ref

This falls out of click-reuses. Clicking `AGENTS.md` while `README.md` is open
keeps the *same pane element* and rebuilds only its body: `doc.path` changes,
the leaf never moves, the tree is never edited, the split ratio the user dragged
is preserved. Keying panes by path would instead mean removing a leaf and
inserting another at the same position on every click — tree surgery, focus
churn, lost ratio.

So `paneKey = 'doc:' + docId`, and the standing invariant — one pane element per
content instance, created once, never reparented — holds untouched. A doc pane's
element is never moved between parents; only its `.pane-body` content is rebuilt.

Space ownership comes free: `docs` sits under the space's key, so `applyTiles`
hides another space's doc panes with no special case, and a doc path is relative
to *its* space's root, which is what `resolveSafe` expects.

## Reading: one IPC channel

`workspace:readDoc(rel)` → `tote.readDoc(rel)`, one shape:

```js
{ kind: 'text'|'md'|'image'|'pdf'|'binary', text?, dataUrl?, fileUrl?, mtimeMs, size, error? }
```

One channel rather than four means one place enforcing `resolveSafe` and the
size caps, and one shape for the reload path to compare against.

| kind | extensions | payload | cap |
|---|---|---|---|
| `md` | `.md`, `.markdown` | `text` | 2 MB (`MAX_READ_BYTES`) |
| `text` | the rest of `TEXT_EXT` | `text` | 2 MB |
| `image` | `.png .jpg .jpeg .gif .webp .bmp .ico .svg` | `dataUrl` | 25 MB |
| `pdf` | `.pdf` | `fileUrl` | none — never copied |
| `binary` | anything else | — | — |

`.svg` is in `TEXT_EXT` today and stays there: it is served as `image` kind with
`text` also populated, which is what gives it both modes.

PDFs are handed a `file://` URL rather than base64 because they get large and a
`<webview>` needs no copy. Images use a data URL because `img-src 'self' data:`
already permits it and no CSP relaxation is required.

## Rendering: four bodies, one shell

- **text** — monospace `<textarea>`, editable.
- **md** — rendered fragment in `view`; the same textarea in `src`.
- **image** — fit-to-pane `<img>`; `.svg` also offers `src`.
- **pdf** — `<webview src="file://…">`. Out-of-process, so the host CSP does not
  apply to it. `webviewTag` is already enabled.

`paneShell` grows one optional slot before the `✕` for per-kind head controls.
The `src|view` toggle appears only for `md` and `.svg`. The dirty marker reuses
the existing `pane-dot` element, hidden today for non-web panes.

`.html` gets no rendered mode, by design.

### Markdown subset

`src/renderer/markdown.js` is dual-exported the way `layout.js` is
(`window.Markdown` + `module.exports`) and exposes one pure function:

```js
Markdown.parse(text) → blocks[]
```

Blocks: `heading{level, spans}`, `paragraph{spans}`, `code{lang, text}`,
`list{ordered, items:[{spans, checked, blocks}]}`, `quote{blocks}`,
`table{align, head, rows}`, `hr`.
Inline spans: `text`, `strong`, `em`, `strike`, `code`, `link{href, spans}`,
`image{src, alt}`.

Two rules make the result safe by construction:

1. **Raw HTML never passes through.** A `<script>` line in a downloaded README
   renders as literal text.
2. **Hrefs are filtered at parse time** to `http:`, `https:`, `mailto:`, and
   workspace-relative paths. A `javascript:` or `data:` link degrades to plain
   text, never an anchor.

`renderBlocks(blocks) → DocumentFragment` stays in `app.js`: a `createElement`
switch, roughly 50 lines, never `innerHTML`. Same split as `layout.js` (tested
engine) versus `applyTiles` (DOM application, verified by running the app).

### Links and images inside a rendered doc

- `http(s)` link → `tote.openExternal`, which already refuses non-http(s) in
  main (`main.js:648`).
- Relative link to a text/md file → `openDoc(resolvedRel)`, so a README's links
  are click-through inside the pane.
- Relative `![image]` → fetched lazily through the same `readDoc` and swapped in
  as a data URL. A `../../../.ssh/id_rsa` source is therefore rejected by
  `resolveSafe` like everything else, and the CSP needs no `file:` relaxation.

## Opening: one entry point

`openDoc(relPath, { newPane })`:

1. Already open in this group → focus that pane; do not load it twice.
2. `newPane` (Cmd/Ctrl-click, or "Open in new pane" in the context menu) → new
   instance + `openPane(T.leaf(newLeafId(), 'doc', id))`, which splits the
   focused pane by the existing dwindle rule.
3. Otherwise → reuse the focused doc leaf, or the most recently focused doc leaf
   in this group; if the space has none, create one.
4. Reuse target is dirty → prompt rather than silently discarding the buffer.

Tree clicks call `openDoc(node.path, { newPane: e.metaKey || e.ctrlKey })` for
any kind the pane can show. `binary` keeps today's behaviour and goes to
`openPath`. The context menu's "Open" routes into the same function, and gains
"Open in new pane".

`#editor-modal`, `#editor-text`, `#editor-save`, `#editor-cancel` and the
`editorPath` global are deleted.

## Save and external change

Cmd/Ctrl+S on a focused doc pane writes through `tote.writeFile`, resets
`savedText`, clears the dot, and for `md`/`.svg` flips back to `view`.

The reload rule, driven by the existing debounced `onWorkspaceChanged` ping
(which carries no path, so each open pane re-reads its own file):

| | pane clean | pane dirty |
|---|---|---|
| content differs from `savedText` | replaces silently, keeps scroll position | `⚠ changed on disk [reload] [keep mine]` bar |
| file gone | "no longer on disk" + close | keeps the text, offers to write it back |
| image/pdf, `mtimeMs`+`size` differ | re-reads the data URL / reloads the webview | only `.svg` can be dirty; it takes the text row above |

Two consequences:

- **A save needs no suppression flag.** After a write, disk content equals
  `savedText`, so the resulting watcher tick is naturally a no-op.
- **The watcher binds only the active space's root.** Doc panes in a background
  space are re-checked on switch, in `showWorkspaceViews`.

"Keep mine" sets `stale` on the instance so the next Cmd+S overwrites without a
second prompt — that is what clicking it means.

## Error handling

Errors are pane states, not toasts:

- Over the cap → "2.4 MB, larger than the 2 MB view limit" + `[open externally]`.
- Unreadable (permissions, deleted mid-read) → the message plus the same button.
- `binary` never opens a pane at all; the click routes to `openPath`.
- Write failure → toast, and the pane stays dirty.

## Keybindings

Added to the single `keydown` listener at the bottom of `app.js`:

- **Cmd/Ctrl+S** — save the focused doc pane. A new modifier pattern in that
  listener (`MOD` is Cmd+Alt / Ctrl+Alt for pane keys) but it collides with
  nothing.
- **MOD+E** — toggle `src`/`view` on the focused doc pane.

## Files touched

| File | Change |
|---|---|
| `src/main/workspace.js` | `readDoc(rel)`, extension→kind map, caps |
| `src/main/main.js` | `ipcMain.handle('workspace:readDoc')` |
| `src/preload/preload.js` | `readDoc` wrapper |
| `src/renderer/markdown.js` | **new** — pure parser |
| `scripts/test-markdown.js` | **new** — joins `npm test` |
| `src/renderer/app.js` | "doc panes" section; `mountLeaf` and `closePane` branches; tree click and context menu; delete modal handlers; keydown |
| `src/renderer/index.html` | delete `#editor-modal`, load `markdown.js` |
| `src/renderer/styles.css` | `.doc-*` prose, code, tables, stale bar, toggle |
| `CLAUDE.md`, `AGENTS.md`, `README.md` | new invariant, feature line |
| `archlens.model.yaml` | entries for `markdown.js` **and** the still-missing `layout.js` |

### Two existing spots that must change

- `closePane`'s trailing `else` assumes "not web, not term ⇒ files dock"
  (`app.js:1141`). It becomes an explicit `else if (lf.kind === 'files')`, plus a
  `doc` branch that destroys the pane element and splices the instance out of
  `V.docs` — what `closeTabInstance` does for web.
- `mountLeaf` gets a `doc` branch returning `null` when `V.docs` holds no such
  id, so a stale leaf from a previous run is pruned by the contract already
  there.

## Testing

`scripts/test-markdown.js` joins `npm test` using the same hand-rolled
`describe`/`test` harness as the other two suites (no framework, no filter flag,
non-zero exit on failure). Roughly 40–60 cases covering: nested and lazy lists,
ordered lists with arbitrary start, tilde fences, an unclosed fence, `*` versus
`_` emphasis, escaped characters, inline code containing asterisks, a table with
missing cells and each alignment, a `javascript:` href, a `<script>` tag, a link
whose text contains brackets, and an empty document.

Everything else is verified by running the app, as is the repo's norm. Manual
checklist:

1. Click a `.md` → renders; toggle to `src`, edit, Cmd+S → saves and flips back.
2. Click another file → same pane swaps. Cmd-click a third → second pane.
3. Have a terminal agent rewrite the open file → clean pane reloads silently.
4. Type into the pane first, then let the agent write → the stale bar appears;
   both buttons behave.
5. Delete the file on disk → the gone state; "write it back" recreates it.
6. Open a PNG, an SVG (both modes), a PDF, and a `.zip` (goes external).
7. Switch spaces and back; restart the app → doc panes and modes come back,
   pointing at the right space's files.
8. Close a dirty pane → prompts.

## Risk to check first

Electron's bundled PDF viewer inside a `<webview>` may need `plugins` enabled on
the tag. This is a ten-minute check at the start of implementation. If it does
not render, the PDF body degrades to an "open externally" button and nothing
else in the design changes.
