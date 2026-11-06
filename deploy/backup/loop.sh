#!/bin/sh
set -eu
child=''
stop() { if [ -n "$child" ]; then kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi; exit 0; }
trap stop TERM INT
while :; do
  sh /opt/replayd-backup/once.sh & child=$!
  if wait "$child"; then delay=86400; else echo 'Database backup failed; retrying in five minutes' >&2; delay=300; fi
  sleep "$delay" & child=$!
  wait "$child" || true
done
