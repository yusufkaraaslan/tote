# Background host

The desktop is a viewer. A separate process owns this computer's spaces,
terminal PTYs and replay buffers, saved layouts, SSH connections, file watchers,
Downloads bridge, keep-awake request and Tailscale listener/discovery announcements.
Opening Tote starts the host if its private endpoint refuses connections; later
launches attach to the same host. Each window still has its own selected space.

Closing a window or quitting the desktop disconnects its viewer. The host and
agents continue. Other desktops and phones can keep using the shared host.
Setup-wizard installers belong to the desktop and stop with it.

## Controls

Settings → About → Background host always controls **this computer**, even when
the window is viewing another device. It shows host version, connection state,
active terminals and keep-awake failures. Start host launches it explicitly;
Stop host confirms if any session is alive, including sessions used by phones.
After a stop, reconnect loops only probe: they never silently restart the host.
Opening the desktop again or choosing Start host starts it.

Start the host when I sign in is opt-in. It registers a per-user LaunchAgent on
macOS, an XDG autostart entry on Linux, or a Startup entry on Windows. It does not
install a machine-wide service or request administrator access. Linux requires
a desktop session supporting XDG autostart; a server administrator can instead
supervise the foreground command below. Registration takes effect at next sign-in;
it does not restart the current host. Turning it off removes only Tote's entry.

Reboot, sign-out, host crash or explicit stop ends the running programs. The next
host does not recreate shells from old terminal input. Saved panes can show a
dead session; resume an agent using its own documented resume command. Unsaved
desktop document buffers and provider-page drafts do not live in the host.

## Runtime and updates

Packaged Tote copies its executable and resources into an immutable, content-keyed
`host-runtimes/` directory under the Tote profile before starting a new host. This
costs an additional application-sized copy. Existing copies are reused and are not
automatically deleted. The desktop installer can replace its own files while an
older host keeps running from its copy. A new UI attaches to an existing compatible
host; it never upgrades or kills that host automatically.

To upgrade the host, finish agents, choose Stop host, then Start host from the new
desktop. Re-enable sign-in startup from the new desktop to update its launch path.
Remove obsolete cached runtime directories only after stopping the host and
checking that no startup entry points at them. Development launches use the source
checkout directly; stop the development host before changing its dependencies.
Production signing and physical signed-upgrade checks are still release work.

## Headless operation

From a source checkout with dependencies installed and a suitable Node runtime:

```sh
npm run host -- --data-dir /absolute/path/to/Tote-profile
```

This runs in the foreground without Electron APIs or a display. Use the same
profile as the desktop to share its spaces. SIGTERM/SIGINT gracefully stop the
host and terminals; SSH control masters intentionally persist. A fresh profile
uses the normal default configuration. Do not run an old in-process Tote against
the same profile at the same time.

Keep-awake uses `caffeinate` on macOS, a Windows power request, or `systemd-inhibit`
on Linux. The inhibitor ends with the host, including a lost parent pipe. It does
not override lid closure or OS sign-out policy. The Downloads bridge retains its
macOS provenance allowlist and copies only known native-app downloads. With no
window, it uses the last focused workspace, falling back to the registry's active
space. Files trashed through the windowless host move into the workspace's
`.tote-trash/` directory rather than being permanently deleted.

## Connection boundary and failures

Local connections bind only `127.0.0.1`, independently of Share device. The port
is a deterministic hash of the canonical profile path (20000–59999). Binding it
before opening config prevents two host owners; an occupied port fails closed.
The random bearer in `host/token` has owner-only POSIX permissions and inherits
the user's profile ACL on Windows. It is never exposed to the renderer or put in
a URL. Browser Origin requests are rejected. Tailscale's own-node authorization
and public host-method allowlist are unchanged; it cannot call local admin methods.

Do not delete a token or kill an unknown process to resolve an occupied port.
Identify the process first. If it belongs to another application, stop or
reconfigure that application, or use a different Tote profile. An authentication
or protocol error is not treated as permission to start another host.

Disconnected panes retain their last screen under a banner. Local and remote
viewers use the same bounded output transport, parser acknowledgements, grid
ownership and replay. Reconnect restores the window's workspace, reads sessions
and reattaches; input and file mutations are never automatically retried.
Downloads use a private staging folder and pin their host workspace when they
start. A removed workspace or failed transfer leaves the staged file for recovery.

## Verification

`npm test` covers authentication, remote admin refusal, singleton startup,
independent viewer workspaces, stop protection, real PTY survival after a parent
process dies, reconnect without input retry, startup generation and runtime copies.
`npm run test:background-ui` uses disposable configuration and real Electron
windows to check pane restoration and shell state after normal quit and crash.
The all-platform packaged smoke test boots a copied host with its real native PTY.
Physical sign-in startup, OS power behavior, signed upgrades and provider/phone
acceptance still need release verification on the target machines.
