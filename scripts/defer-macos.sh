#!/bin/bash
# launchd owns the waiter so closing Tote or the invoking agent cannot kill it.
# Usage: bash scripts/defer-macos.sh PID LOG COMMAND [ARG ...]
set -euo pipefail
WAIT_PID=$1
LOG=$2
shift 2
[[ "$WAIT_PID" =~ ^[0-9]+$ ]] || { echo 'Invalid process id' >&2; exit 1; }
LABEL="com.tote.install.$WAIT_PID.$$.${RANDOM}"
mkdir -p "$(dirname "$LOG")"
launchctl submit -l "$LABEL" -o "$LOG" -e "$LOG" -- /bin/sh -c '
  label=$1
  pid=$2
  shift 2
  while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  sleep 1
  echo "Tote deferred update started: $(date)"
  "$@"
  result=$?
  echo "Tote deferred update finished with status $result: $(date)"
  # submit jobs restart on exit unless explicitly removed.
  /bin/launchctl remove "$label"
' tote-deferred "$LABEL" "$WAIT_PID" "$@"
# Fail visibly if launchd did not accept the job. Do not promise an update
# based solely on starting a shell in the background.
launchctl list "$LABEL" >/dev/null
printf '%s\n' "$LABEL"
