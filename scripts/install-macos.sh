#!/usr/bin/env bash
# Build Tote and install it into /Applications, so it launches from Spotlight and
# the Dock like any other app instead of running out of the repo's dist/ folder.
#
# The awkward part this script exists to handle: Tote docks agent terminals, so
# an upgrade is very often run FROM INSIDE THE APP BEING UPGRADED. Two things
# follow, and both are load-bearing:
#
#   1. The build never writes to the running bundle. `npm run pack` starts by
#      deleting dist/, which is where a dev build runs from -- electron-builder
#      would be pulling the floor out from under its own caller. So the build
#      goes to dist-next/ and the running bundle is only ever read.
#
#   2. When the target bundle is RUNNING -- by anyone, not just by this shell --
#      the swap is deferred to a detached watcher that waits for it to quit.
#      Renaming a running .app looks safe (the executable keeps its inode) but
#      Electron reads app.asar by absolute path, so afterwards a lazy `require()`
#      loads code out of the NEW bundle into the OLD process. Mixed versions fail
#      in ways nobody can debug.
#
#      The condition is deliberately "is the target running", NOT "am I inside
#      the target". An earlier version asked only the second question and so
#      swapped a live bundle out from under a running Tote whenever the upgrade
#      was driven from a different terminal app -- which is the normal case.
#
# Usage:
#   scripts/install-macos.sh              build, install, hand over on quit
#   scripts/install-macos.sh --no-build   install whatever is already staged
set -e
cd "$(dirname "$0")/.."

REPO="$(pwd)"
STAGE="$REPO/dist-next"
TARGET="/Applications/Tote.app"
APP="$STAGE/mac-arm64/Tote.app"
[ "$(uname -m)" = "x86_64" ] && APP="$STAGE/mac-x64/Tote.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is macOS-only. On Linux/Windows use: npm run dist"
  exit 1
fi

echo "== Tote → $TARGET =="

# Which bundle is the caller running inside, and which pid owns it? Walk up from
# this shell until a parent's executable path sits inside a .app.
INSIDE=""; OLD_PID=""
pid=$$
for _ in 1 2 3 4 5 6 7 8; do
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') || break
  { [ -z "$pid" ] || [ "$pid" = "0" ] || [ "$pid" = "1" ]; } && break
  exe=$(ps -o comm= -p "$pid" 2>/dev/null)
  case "$exe" in
    *.app/Contents/MacOS/*) INSIDE="${exe%%.app/Contents/MacOS/*}.app"; OLD_PID="$pid"; break ;;
  esac
done
[ -n "$INSIDE" ] && echo "note: running inside $INSIDE (pid $OLD_PID) — it will not be touched"

# Is the bundle we are about to replace running right now, whoever started it?
# This, not INSIDE, is what decides whether the swap can happen immediately.
#
# `-a` is load-bearing, and its absence was a silent hole for exactly the case
# this script exists for: pgrep excludes itself AND ALL ITS ANCESTORS by
# default, so an upgrade run from a terminal docked inside Tote could never see
# that Tote -- TARGET_PID came back empty, the deferral was skipped, and a live
# bundle got renamed out from under the running app. Verified on pid 1449:
# invisible to `pgrep -f`, `pgrep -x` and `pgrep -lf`, visible to `pgrep -a -f`
# and to `ps -Ao comm=` all along.
TARGET_PID=$(pgrep -a -f "^$TARGET/Contents/MacOS/Tote$" 2>/dev/null | head -1)
[ -n "$TARGET_PID" ] && echo "note: $TARGET is running (pid $TARGET_PID) — the swap will wait for it to quit"

# Backups from earlier runs, minus anything still running.
for old in /Applications/Tote.app.backup-*; do
  [ -d "$old" ] || continue
  if pgrep -a -f "^$old/Contents/MacOS/Tote$" >/dev/null 2>&1; then continue; fi
  echo "removing stale backup $(basename "$old")"
  rm -rf "$old"
done

if [ "${1:-}" != "--no-build" ]; then
  echo
  echo "running tests..."
  npm test >/dev/null || { echo "tests failed - refusing to install"; exit 1; }
  echo "tests ✓"
  echo
  echo "building (this takes a minute)..."
  npx electron-builder --dir -c.directories.output=dist-next
fi

[ -d "$APP" ] || { echo "no build found at $APP - run without --no-build"; exit 1; }

# The swap itself, used by both paths below. Staged as a script so the deferred
# case can run it after this shell (and the app it lives in) are long gone.
# BSD mktemp only substitutes X's at the END of the template.
SWAP=$(mktemp /tmp/tote-swap.XXXXXX)
cat > "$SWAP" <<EOF
#!/bin/sh
set -e
# NOTE: this heredoc is unquoted so TARGET and APP expand -- which means a
# backtick or an unescaped dollar in here runs at write time. Keep both out.
#
# Order matters: copy FIRST, then swap by rename. The copy is the slow part and
# the only part that can realistically fail (source deleted, disk full), and
# moving the old app aside before it means a failure leaves the machine with no
# Tote at all. Two renames at the end make the actual cutover near-instant.
if [ ! -d "$APP" ]; then
  echo "staged build is gone: $APP" >&2
  exit 1
fi
rm -rf "$TARGET.incoming"
cp -R "$APP" "$TARGET.incoming"
# Unsigned build (no Developer ID), so a copied bundle would be quarantined.
xattr -dr com.apple.quarantine "$TARGET.incoming" 2>/dev/null || true
if [ -d "$TARGET" ]; then
  mv "$TARGET" "$TARGET.backup-\$(date +%Y%m%d-%H%M%S)"
fi
mv "$TARGET.incoming" "$TARGET"
EOF
chmod +x "$SWAP"

echo
if [ -n "$TARGET_PID" ]; then
  # The target is live -- from this terminal or any other. Defer everything
  # until it exits, then swap and reopen.
  nohup sh -c "while kill -0 $TARGET_PID 2>/dev/null; do sleep 1; done; sleep 1; \
               sh '$SWAP' && open '$TARGET'; rm -f '$SWAP'" >/dev/null 2>&1 &
  echo "Staged. Quit Tote (Cmd+Q) — it will swap in the new build and reopen."
  echo "(Watcher on pid $TARGET_PID; nothing on disk changes until you quit.)"
else
  sh "$SWAP"; rm -f "$SWAP"
  echo "installed ✓  $(du -sh "$TARGET" | cut -f1)"
  # Some OTHER bundle (a dev build in dist/) may still hold Tote's
  # single-instance lock, so the fresh copy cannot start until that one goes.
  OTHER_PID=$(pgrep -a -f "Tote\.app/Contents/MacOS/Tote$" 2>/dev/null | head -1)
  if [ -n "$OTHER_PID" ]; then
    nohup sh -c "while kill -0 $OTHER_PID 2>/dev/null; do sleep 1; done; sleep 1; open '$TARGET'" \
      >/dev/null 2>&1 &
    echo "Another Tote is running and holds the single-instance lock."
    echo "Quit it and the new build opens automatically."
  else
    open "$TARGET"
  fi
fi
