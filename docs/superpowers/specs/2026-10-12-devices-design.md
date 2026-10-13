# Devices — every Tote you own, from any Tote you sit at

**Status:** design approved, unimplemented
**Branch:** `feat/devices`

## Goal

Each machine runs its own Tote with its own spaces, groups, layouts, agents
and files. From any Tote, a **Devices** list shows your other machines that
are online with Tote running. Picking one turns this window into *that*
device's Tote exactly as it was left there: same spaces, same groups, same
panes, the same agents still running. Switching back finds your own machine
as you left it too. Nothing migrates; you are looking at each machine natively
from wherever you are sitting.

In the user's words: "I open my Tote. I see remote devices, not remote
workspaces … I see how I left on that machine all workspaces and agents
currently open and working … use all my connected devices as if I open Tote
on them natively, and resume each one on another device."

Decided in discussion:

1. **Everything lives on its own machine.** A device that is closed, asleep or
   not running Tote is simply offline. There is no relay and no sync of
   sessions between machines.
2. **Every device is a full Tote** today: MacBook, `yusyus-mainpc` and
   `yusyusserver` all have a screen. But the design must also allow a
   **host-only** role (a windowless server) and a **client-only** role (a
   mobile app) later, so the host cannot depend on Electron and the wire
   protocol must be speakable by a non-Electron client.
3. **Layout conflicts: last edit wins**, and every viewer sees the change live.
4. **Keep the Mac awake** is a separate, small feature (below).

Remote *spaces* (one project on another machine over ssh) stay as they are.
A device can itself have remote spaces, and viewing it shows them as that
device sees them.

## Non-goals

- Moving a session from one machine to another. An agent runs where it was
  started, forever.
- Sharing web logins. A web tab renders on the machine you sit at, with that
  machine's cookies. You log in once per machine; the conversations are on the
  provider's servers anyway. An unsent draft stays on the machine where it was
  typed.
- Viewing a device outside your own tailnet identity: no sharing with
  teammates in v1.
- Host-only and client-only builds. v1 keeps them *possible*; it does not ship
  them.
- Surviving a Tote quit. Agents still die with their Tote: quit means offline.

## Vocabulary

- **device**: a machine running Tote, identified by its Tailscale node.
- **host**: the half of Tote that *owns* a device's spaces, `views.json`,
  ptys, watchers and remote connections.
- **viewer**: the half that *shows* a host: a window today, a phone later.
- **this device** / **local host**: the host in the same process as the viewer.

A full Tote is a host plus a viewer. Today they are one undivided main
process. This design splits them.

## Architecture

```
 MacBook Tote                                      mainpc Tote
┌────────────────────────────┐                ┌────────────────────────────┐
│ viewer (window)            │                │ viewer (window)            │
│   └ main: router ──────────┼── local ──┐    │   └ main: router ─┐        │
│                            │           │    │                   │        │
│ host (src/host/, no        │◀──────────┘    │ host              │        │
│   electron) ◀──────────────┼──── WebSocket ─┼───────────────────┘        │
│   listener on 100.x:47821  │  over tailnet  │   listener on 100.x:47821  │
└────────────────────────────┘                └────────────────────────────┘
```

### 1. The host: `src/host/`

A new directory whose modules **never require `electron`**. Most of it moves
rather than gets written: `workspace.js`, `ptyManager.js`, `config.js`,
`remote.js`, `scratch.js` and `sshfix.js` are already Electron-free. What moves
out of `main.js` is the *bodies* of the device-owned IPC handlers, into one
method table:

```js
// src/host/methods.js
module.exports = (host) => ({
  'workspaces:list': (ctx) => …,
  'workspace:tree':  (ctx, rel) => …,
  'pty:spawn':       (ctx, { profileId, wsId, cols, rows }) => …,
  …
});
```

`ctx` is `{ viewer, wsId }`: *who* is asking and *which space they are
looking at* (see §4). The guard is a test: `scripts/test-devices.js` requires
every `src/host/` module under plain node with `electron` made unresolvable,
so a stray `require('electron')` fails `npm test` rather than surfacing the
day someone builds host-only.

The few host operations that today reach for Electron get a small injected
**platform** object instead (`trash(path)`, `openExternal(url)`). A full Tote
passes Electron's `shell`. A future host-only build passes a plain-node
fallback (`trash` into `.tote-trash/`, as remote spaces already do).

### 2. Channel classification: host vs viewer

Every existing IPC channel is one of three kinds. The table lives in a pure
module (`src/host/channels.js`) so it is tested, and so adding a channel
forces the question.

| kind | channels | when viewing another device |
|---|---|---|
| **host** | `workspaces:*` (except pickers), `workspace:*` (except open/reveal), `remote:*`, `views:get/save`, `pty:spawn/write/resize/kill`, `cli:check`, `config:getCliProfiles/saveCliProfiles`, device settings (`scratchRoot`, `scratchDays`, `keepAwake`) | forwarded to that device's host |
| **viewer** | `config:getProviders/saveProviders`, `apps:*`, `setup:*`, `conn:*`, `pty:run`, `provider:ensureLocal`, `app:openExternal`, `config:openDir`, `workspace:openPath/revealPath`, UI settings | always local; hidden in the UI when it would act on the wrong machine |
| **split** | `workspaces:add/setPath/promote` (folder picker), `tab:sendFile` | picker or injection on the viewer, the operation on the host |

The "adding a capability = three edits" rule becomes four: handler,
**classification**, preload wrapper, call site.

The split channels need care:

- **Folder pickers.** A native dialog can only browse the viewer's disk.
  Viewing another device, "add space" asks for a typed path, the same field
  remote spaces use, validated on the host. A remote folder browser can come
  later.
- **`tab:sendFile`.** The file is read from the host (`readDoc`), and the
  `File` is injected into the webview on the viewer, where the webview lives.

### 3. Events go to subscribers, not to a sender

Today `PtyManager.launch()` sends `pty:data` to the one `sender` that spawned
the pty, and `workspace:changed`, `remote:state` and `download:done` go to
`win.webContents`. The host replaces both with an **event bus**: viewers
subscribe, and the host emits to every subscriber. The local window is one
subscriber and a remote connection is another. That is what lets the Mac's
own window and the mainpc watch the same agent at the same time.

### 4. The active space becomes per viewer

This is the one invariant that has to change. Today "active workspace is
resolved at call time" means the host's single global `active` decides where
downloads land, where a new terminal starts and what the watcher binds. With
two viewers, the mainpc switching space on the Mac's host would yank the
Mac's own window, and route its downloads, to another space.

So the active space moves to the viewer:

- Every host call carries `ctx.wsId`, and the host resolves the root from it.
  `getRoot()`/`inboxDir()`/`localCwd()` take a space instead of reading a
  global. The invariant survives in its new form: **resolved at call time,
  from the caller's space, never cached.**
- `workspaces:setActive` becomes a viewer preference. The host remembers each
  viewer's last space only so that reconnecting restores it, and so that the
  local window still opens where it was.
- **Watchers bind the union** of the spaces currently viewed, by anyone, each
  with its share of `WATCH_BUDGET`. Usually that is one or two spaces. When a
  viewer leaves, its space is unwatched unless another viewer still looks at
  it. The await-close-before-rebind rule and `watchGen` still apply, per
  space.
- **Downloads** carry the space that was active *on the viewer* when the
  download started. That is already the rule for remote spaces.

### 5. Terminals are owned by the host and replay on attach

Today a terminal is born in the renderer (`spawnTerm`), its metadata lives in
the renderer's `state.terms`, and a term leaf refers to a per-run renderer
counter (`termSeq`). A second viewer could not even find out which terminals
exist. So:

- **The host owns session metadata:** `{ id, wsId, profileId, title, cwd,
  host, alive, exitCode }`. New channel `pty:list` (per space), plus
  `pty:attach`/`pty:detach`.
- **Term leaves refer to the host session id.** The renderer's `termSeq` /
  `localId` indirection and `adoptLeafSeq`'s term half go away. Session ids
  are unique per host run, and a host restart kills every session anyway, so a
  stale leaf is pruned through `mountLeaf`'s existing null contract.
- **Replay.** The host keeps a headless mirror per session
  (`@xterm/headless` + `@xterm/addon-serialize`, both pure JS, no DOM). On
  attach it sends the serialized screen and scrollback, then streams live
  output. Without it, a viewer that arrives after the agent has printed for an
  hour sees an empty pane. Scrollback in the mirror is capped (5,000 lines),
  matching the viewer's xterm.
- **Size: the last viewer to type or focus wins.** A pty has one size. When a
  viewer focuses a term pane or sends input, it pushes its `ptyResize`. The
  other viewer's xterm may then be wider or narrower than the pty until it
  takes the size back. This is tmux's `window-size latest` behaviour, and
  fine for one person at a time.
- Shift+Enter→LF, the scrollback keys, Alt+Up/Down, file drop and
  `repairViewport` stay in the renderer and work unchanged: they act on the
  viewer's xterm and the bytes it writes.

### 6. Wire protocol

A WebSocket carrying JSON messages, so a phone can speak it with no Node
underneath:

```
→ { "t": "hello", "v": 1, "role": "viewer", "device": "<node name>" }
← { "t": "hello", "v": 1, "role": "host", "device": "…", "tote": "<version>" }
→ { "t": "call",  "id": 7, "m": "workspace:tree", "ctx": {"wsId":"w3"}, "a": [""] }
← { "t": "ret",   "id": 7, "ok": true, "r": … }   |   { "ok": false, "e": "…" }
← { "t": "ev",    "e": "pty:data", "a": [{ "id": 4, "data": "…" }] }
```

- **Versioned.** A `v` mismatch closes the connection with a reason, and the
  device shows as "needs Tote update" rather than failing in odd ways.
- **Only classified host methods** are callable remotely; anything else is an
  error. This is the same table as §2, so the allow-list cannot drift from the
  router.
- **Large payloads.** `readDoc` images (≤25 MB) go base64 inside JSON as they
  do over IPC today. Uploads (a download pushed to the host's inbox) and PDF
  or HTML fetches are chunked (`up:begin/chunk/end`, 512 KB) so one transfer
  never stalls the socket for everything else.
- **Library:** `ws` (pure JS) becomes the one new runtime dependency besides
  the xterm headless pair. Node 22 has a WebSocket client but no server.

Framing, validation and the allow-list check are pure (`src/host/protocol.js`)
and covered by `scripts/test-devices.js`.

### 7. Transport and trust: Tailscale

The Mac runs **Tailscale.app**, the macOS GUI build, which cannot be a
Tailscale SSH *server*. So devices do not ssh into each other. Each host
listens itself:

- **Bound only to the device's Tailscale address** (`tailscale ip -4`), never
  `0.0.0.0`. Port `47821` by default, in `settings.json`. The traffic is
  inside WireGuard already, so plain `ws://` is encrypted end to end on the
  tailnet.
- **Every connection is identified by Tailscale.** On accept, the host asks
  `tailscale whois --json <peer ip>`, and admits the peer only if its
  `UserProfile.LoginName` equals this node's own owner (from `tailscale
  status --json`). There are no passwords and no pairing step, and nothing
  expires, so the Tailscale SSH re-auth timer does not touch devices at all.
  The decision (`authorize(self, whois) → { ok, reason }`) is pure and tested
  against captured JSON, including a node shared *into* the tailnet by
  someone else, which must be refused.
- **Finding the CLI.** `tailscale` is on PATH here (`/usr/local/bin`), but the
  App Store build only has
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Try both. No
  Tailscale means no Devices: the menu says why, and this device's host does
  not listen.
- **A listener is opt-in:** `settings.shareDevice`, default off, toggled from
  the Devices menu. A machine you never meant to expose does not become
  reachable because Tote updated.

### 8. Discovery

`tailscale status --json` → peers with `Online: true` and the same owner →
probe each with a `hello` (2 s timeout) → the Devices list: name, OS, online
or offline, "Tote not running", "needs update". Refreshed when the menu opens
and every 30 s while any remote device is being viewed. The status parser is
pure and tested against captured output from this tailnet.

### 9. The viewer: devices sit above spaces

The levels become **device → space → group → pane**. Switching device works
the way switching space does today, one level up:

- **UI:** a device chip at the left end of the workspace strip, showing the
  device name and a status dot, opening the Devices menu. While another
  device is in view, the strip takes an accent colour, so you can always tell
  whose Tote you are driving.
- **State per device.** `app.js`'s `state.workspaces`, `state.views`,
  `state.terms` and `state.tabs` become the *current device's* slice of
  `state.devices[deviceId]`. Pane keys gain a device prefix
  (`<dev>:term:<id>`), so the other devices' panes stay alive and hidden,
  exactly like another space's panes. Switching back costs no reload and no
  replay. `#tiles` stays flat and nothing is reparented.
- **Web tabs** in another device's views are rendered by *this* machine's
  webviews and partitions. A provider id this machine does not know shows a
  placeholder pane ("not configured on this device") rather than being
  pruned, because pruning would delete it from the other device's
  `views.json` (last edit wins).
- **Doc panes.** Text, markdown and images come through `readDoc` as they do
  now. PDF and HTML need a real local path, so they are fetched once into
  `<userData>/devices/<dev>/<hash>/`, keyed by mtime: the same trick, and the
  same reasons, as remote spaces' PDF cache.
- **Downloads** from a web tab while viewing device X are staged locally and
  pushed into X's inbox for the space you were in, the same mechanics as
  `ingestInto()` for remote spaces.
- **Remote spaces on device X.** X's host owns the ssh connection. When it
  needs a human, the `remote:state` event carries the auth URL, and *the
  viewer* opens it in its browser, because that is where the human is.
- **Offline.** A device that drops shows a banner over its panes
  ("yusyus-mainpc went offline — last seen 14:02"), never empty panes, for
  the same reason a disconnected remote space never shows an empty tree. Its
  panes are kept, and on reconnect they re-attach with replay.

### 10. Roles

`settings.role`: `"full"` (default, the only one in v1), `"host"`, `"client"`.

- **host** (later): `src/host/` started by a small plain-node entry point,
  with no window. This is what §1's no-Electron rule protects.
- **client** (later): a viewer with no local host. Its Devices list simply
  has no "this device". The protocol in §6 is the whole contract it needs.

## Keep awake (separate feature)

`settings.keepAwake` is a **device** setting, so you can turn the Mac's on
while viewing it from the mainpc. While it is on, the host holds
`powerSaveBlocker.start('prevent-app-suspension')`. That stops *idle* sleep.
It cannot stop lid-close sleep, which only clamshell mode (power plus an
external display) prevents, and the toggle says so instead of pretending.
`powerSaveBlocker` is Electron, so it goes through the platform object from
§1. It does not depend on anything else here and can ship first.

## Phases

Each phase leaves Tote working and is verified before the next one starts.

1. **Keep awake.** Small and independent.
2. **Host extraction, on one machine.** `src/host/`, the method table, the
   channel classification, the event bus, per-viewer active space, host-owned
   terminals with replay. No network yet. Verified by opening a **second
   window** on the same Mac, which is a second viewer of the same host: both
   show the same agents live, each in its own space.
3. **Protocol and listener.** `ws` server bound to the tailnet, `whois`
   authorization, the client connection in the router. Verified Mac ↔ mainpc
   with no UI beyond a dev menu item.
4. **Devices UI.** The device chip and menu, per-device state, offline
   banners, doc caching, download push, auth URLs opening on the viewer.
5. **Later:** host-only and client-only roles.

## Tests

New `scripts/test-devices.js`, dependency-free like the others, added to
`npm test`:

- every `src/host/` module loads with `electron` unresolvable
- the channel table: every `ipcMain` channel in `main.js` is classified
  (parsed from the source, so a new unclassified handler fails), and the
  remote allow-list equals the host set
- protocol framing: hello, version mismatch, call/ret/ev, unknown method,
  malformed JSON, chunked upload reassembly
- `authorize()` against captured `whois` and `status` JSON: same owner,
  different owner, shared-in node, missing fields
- the `tailscale status` parser: online, offline and expired peers, and this
  node excluded
- per-viewer active space: two viewers, two spaces, routing, watcher union

Everything else, as always, is verified by running the app. Phase 2's second
window is what makes that possible before any network exists.

## Risks

- **Phase 2 is a large refactor of `main.js` and `app.js`'s terminal code.**
  It touches the busiest invariants (active space, watcher re-arming, term
  leaf ownership). That is why it is verified on one machine before any
  networking is added.
- **Replay fidelity.** `addon-serialize` covers the screen, colours and
  modes, but a TUI agent mid-redraw may look briefly off until its next
  frame. That is acceptable, and the same as reattaching tmux.
- **Two viewers fighting over pty size** if both are actively used at once.
  Last-active-wins keeps it usable, but it is not side-by-side co-editing.

## Open questions

- Device naming: Tailscale node name (`yusufs-macbook-pro-1`) or a friendly
  name set per device in Settings? Proposed: node name by default, renamable,
  stored on that device's host.
- Should "this device" in the Devices list allow turning *other* devices'
  `shareDevice` on remotely? Proposed: no. Exposing a machine is decided at
  that machine.
