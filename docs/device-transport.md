# Device connection limits and recovery

Shared-device connections use the existing v1 protocol over Tailscale. Both the
Node host and desktop client send WebSocket pings every 15 seconds and allow 15
seconds for the matching pong. Android's native OkHttp client also sends pings.
A missed deadline closes that connection; the desktop/phone reconnect loop
retains its panes and drafts. Repeated short-lived connections retain their
backoff, up to 30 seconds, rather than resetting it on every successful hello.

## Terminal consumption

Updated viewers offer `flow: 1` in their hello; updated hosts echo it. Only then
does the host put a positive `seq` on each `pty:data` event and expect
`{t: "ack", seq}`. An acknowledgement releases that exact frame, not all earlier
frames. Unknown or duplicate acknowledgements release nothing.

On desktop, main forwards a unique delivery token through IPC and waits for the
owning window to acknowledge it after xterm parsing. On Android, `hostEvent`
returns the terminal stream's parsing promise. Messages for a detached/unopened
terminal may be acknowledged immediately because a subsequent attach requests
a fresh snapshot. Disposing a stream releases pending consumers. Reconnect
snapshots supersede queued old output, but wait for an active parse before
resetting the terminal, preserving screen and size ordering.

Each remote connection has these defaults:

| Limit | Default |
| --- | --- |
| Unacknowledged live terminal output | 8 MiB |
| Outstanding terminal frames | 4,096 |
| Output consumption deadline | 30 seconds |
| Total outbound socket queue / outstanding output including replay | 72 MiB |
| Maximum protocol frame, including a replay or file response | 64 MiB |
| Pending host calls | 64 |
| Desktop/Android outgoing call buffer | 8 MiB |
| Viewer hello deadline at host | 5 seconds |
| Close-handshake grace before forced termination | 1 second |

A replay has additional allowance within the 72 MiB total so a large existing
scrollback can be attached without immediately consuming the live-output budget.
Limits count encoded UTF-8 bytes at the Node transport. Android additionally
bounds strings pending in its native-to-WebView bridge to 72 MiB of UTF-16 data
and 4,096 messages; it releases them after the JavaScript handler completes.
These are queue accounting limits, not promises about total process heap usage.

## Overload and input

If a queue or consumption deadline is exceeded, the connection closes with code
1013 and a reason shown by the viewer. The host immediately detaches that viewer
and stops sending to it. It does not pause or kill a shared PTY, or slow another
viewer. Closing during replay cannot re-add a detached subscriber.

The reconnect path creates a new viewer and attaches its terminals again. Each
attach sends a reset/replay from the authoritative headless mirror, including
the host grid. Bytes are never silently skipped in the middle of an ongoing
terminal stream. Host sessions continue while Tote's host is running.

Transport calls are never retried automatically. An input call may have reached the PTY
even if its reply was lost, so the error tells the user to check the terminal
before sending again. Calls rejected locally by the pending-call or outgoing
buffer limit are not sent. Host overload closes the connection and rejects
outstanding callers rather than building an unlimited request queue.

## Compatibility and verification

Older viewers do not receive sequence fields or need application acknowledgements.
They still get host socket limits and WebSocket heartbeats, but host enforcement
of parser progress requires updates on both sides. Updated desktops also bound
their own parser backlog against older hosts, and updated Android builds bound
their native bridge queues. Discovery probes keep their short hello-only behavior.

`npm test` includes fake-socket deadline/byte accounting checks and real loopback
WebSocket stress tests: one stalled and one healthy viewer, cursor-addressed
output and resizing, replay after overload, lost input replies, concurrent-call
limits, old/new peers, and shutdown with a non-reading peer. Mobile protocol
tests cover parsing acknowledgements, pending calls, asynchronous native-send
failures and replay. Native Java tests check bridge accounting. UI suites cover
terminal rendering and reconnect behavior. Physical Android/Tailscale testing
is still needed for real network loss, OS sleep and device-specific performance.
