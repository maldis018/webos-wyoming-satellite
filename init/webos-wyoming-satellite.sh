#!/bin/sh
# Starts webos-wyoming-satellite at boot and keeps it running.
#
# Use it as a boot hook on a rooted LG webOS TV: copy it (or symlink it) into the init.d directory
# that runs executable scripts at boot (for the Homebrew Channel root tooling that is
# /var/lib/webosbrew/init.d/) and make it executable. See the README for the full steps.
#
#   webos-wyoming-satellite.sh [start|stop|restart|status]    (no argument = start)
#
# Settings through the environment (defaults in brackets):
#   WWS_DIR     directory with bin/ and src/ of the satellite     [/media/developer/webos-wyoming-satellite]
#   WWS_CONFIG  configuration file                                [$WWS_DIR/config.json]
#   WWS_NODE    node executable                                   [node from PATH, else /usr/bin/node]
#   WWS_LOG     log file (rotated at 256 kB, one old copy)        [$WWS_DIR/satellite.log]
#   WWS_RUN     directory for the pid file                        [/tmp]
#
# When this file is a symlink or a copy, set WWS_DIR in the file itself or in the hook's environment.

WWS_DIR="${WWS_DIR:-/media/developer/webos-wyoming-satellite}"
WWS_CONFIG="${WWS_CONFIG:-$WWS_DIR/config.json}"
WWS_LOG="${WWS_LOG:-$WWS_DIR/satellite.log}"
WWS_RUN="${WWS_RUN:-/tmp}"
if [ -z "$WWS_NODE" ]; then
  WWS_NODE="$(command -v node 2>/dev/null)"
  [ -n "$WWS_NODE" ] || WWS_NODE=/usr/bin/node
fi
PIDFILE="$WWS_RUN/webos-wyoming-satellite.pid"

alive() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

rotate() {
  [ -f "$WWS_LOG" ] || return 0
  size=$(wc -c < "$WWS_LOG" 2>/dev/null || echo 0)
  [ "$size" -gt 262144 ] && mv -f "$WWS_LOG" "$WWS_LOG.1"
  return 0
}

# The supervisor: runs the satellite, starts it again 5 s after it ends, except for a bad
# configuration (exit code 2), which another start would not fix.
supervise() {
  while :; do
    rotate
    "$WWS_NODE" "$WWS_DIR/bin/webos-wyoming-satellite.js" --config "$WWS_CONFIG" >> "$WWS_LOG" 2>&1
    code=$?
    if [ "$code" = 2 ]; then
      echo "$(date) configuration rejected, not restarting (see above)" >> "$WWS_LOG"
      rm -f "$PIDFILE"
      exit 2
    fi
    sleep 5
  done
}

case "${1:-start}" in
  start)
    if alive; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    if [ ! -f "$WWS_CONFIG" ]; then echo "no configuration file at $WWS_CONFIG" >&2; exit 1; fi
    "$0" supervise >/dev/null 2>&1 &
    echo $! > "$PIDFILE"
    echo "started (pid $!), log: $WWS_LOG"
    ;;
  supervise)
    supervise
    ;;
  stop)
    if alive; then
      pid="$(cat "$PIDFILE")"
      # Find the children (node, or the sleep between restarts) before the supervisor goes: once it is gone
      # they belong to init, and `pkill -P` would find nothing. BusyBox on webOS 5 may lack pkill -P anyway.
      children=""
      for s in /proc/[0-9]*/stat; do
        set -- $(cat "$s" 2>/dev/null)
        [ "$4" = "$pid" ] && children="$children $1"
      done
      kill "$pid" 2>/dev/null
      for c in $children; do kill -TERM "$c" 2>/dev/null; done
      echo "stopped"
    else
      echo "not running"
    fi
    rm -f "$PIDFILE"
    ;;
  restart)
    "$0" stop; sleep 1; "$0" start
    ;;
  status)
    if alive; then echo "running (pid $(cat "$PIDFILE"))"; else echo "not running"; exit 1; fi
    ;;
  *)
    echo "usage: $0 [start|stop|restart|status]" >&2
    exit 64
    ;;
esac
