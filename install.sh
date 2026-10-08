#!/bin/bash
# Habitab installer.
#
#   ./install.sh               build, install to /Applications and start the app
#   ./install.sh --prefix DIR  install to DIR instead of /Applications
#   ./install.sh --uninstall   restore client configurations and remove the app
#   ./install.sh --uninstall --yes   same, also delete data without asking
#
# The MCP setup of Claude Code and Codex happens in the app (Habitab → Setup …).
set -euo pipefail
cd "$(dirname "$0")"

YES=0 UNINSTALL=0 PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --prefix) PREFIX="$2"; shift ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { [ "$YES" = 1 ] && return 0; [ -t 0 ] || return 1; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[yY] ]]; }

[ "$(uname -s)" = "Darwin" ] || fail "This script currently supports macOS only. Linux and Windows are prepared in the architecture but not packaged yet."

HOME_DIR="${HABITAB_HOME:-$HOME/Library/Application Support/Habitab}"
LAUNCHER="$HOME_DIR/bin/habitab"

# The app process only. Launchers of running agent sessions use the same
# executable (in Node mode) and keep running; they are not the app.
app_running() {
  ps -axo command= | grep '/Habitab\.app/Contents/MacOS/Habitab' | grep -vq 'launcher/main\.js'
}

quit_app() {
  if app_running; then
    say "Quitting running Habitab …"
    # Asks for confirmation inside the app if sessions are connected.
    osascript -e 'tell application "Habitab" to quit' >/dev/null 2>&1 || true
    local waited=0
    while app_running; do
      [ "$waited" = 6 ] && echo "    Waiting for Habitab to quit. Confirm the dialog in the app."
      [ "$waited" -ge 240 ] && fail "Habitab is still running. Quit the app and run the installer again."
      sleep 0.5; waited=$((waited + 1))
    done
  fi
}

find_installed() {
  for d in "$PREFIX" /Applications "$HOME/Applications"; do
    [ -n "$d" ] && [ -d "$d/Habitab.app" ] && { echo "$d/Habitab.app"; return; }
  done
}

if [ "$UNINSTALL" = 1 ]; then
  if [ -x "$LAUNCHER" ]; then
    say "Restoring MCP configurations …"
    "$LAUNCHER" uninstall || fail "Restore failed; the app stays installed."
  fi
  quit_app
  APP="$(find_installed || true)"
  if [ -n "$APP" ]; then say "Removing $APP"; rm -rf "$APP"; fi
  if [ -d "$HOME_DIR" ] && ask "Also delete settings, logs and backups in \"$HOME_DIR\"?"; then
    rm -rf "$HOME_DIR"
  else
    echo "Data stays in \"$HOME_DIR\" (configuration backups are in backups/)."
  fi
  say "Habitab is uninstalled."
  exit 0
fi

# --- prerequisites
command -v node >/dev/null || fail "Node.js is missing. Install Node 20 or newer (e.g. with fnm, nvm or Homebrew)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node $(node -v) is too old; Habitab needs Node 20 or newer."
command -v npm >/dev/null || fail "npm is missing."
command -v npx >/dev/null || fail "npx is missing (chrome-devtools-mcp is started via npx)."

# --- build
say "Installing dependencies …"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
say "Building Habitab …"
npm run --silent dist >/dev/null
BUILT="$(find release -maxdepth 2 -name Habitab.app -type d | head -1)"
[ -n "$BUILT" ] || fail "Build failed: release/*/Habitab.app not found."

# --- install
if [ -z "$PREFIX" ]; then
  if [ -w /Applications ]; then PREFIX=/Applications; else PREFIX="$HOME/Applications"; fi
fi
mkdir -p "$PREFIX"
quit_app
say "Installing to $PREFIX/Habitab.app"
rm -rf "$PREFIX/Habitab.app"
cp -R "$BUILT" "$PREFIX/Habitab.app"
xattr -dr com.apple.quarantine "$PREFIX/Habitab.app" 2>/dev/null || true

# --- start (the app writes the launcher script that client configs call)
say "Starting Habitab …"
# `open` does not pass the environment; forward Habitab's own variables
# (separate test instances use their own HABITAB_HOME).
OPEN_ENV=()
while IFS='=' read -r k v; do OPEN_ENV+=(--env "$k=$v"); done < <(env | grep '^HABITAB_' || true)
open ${OPEN_ENV[@]+"${OPEN_ENV[@]}"} "$PREFIX/Habitab.app"
for _ in $(seq 1 40); do
  [ -x "$LAUNCHER" ] && grep -q "$PREFIX/Habitab.app" "$LAUNCHER" 2>/dev/null && break
  sleep 0.5
done
[ -x "$LAUNCHER" ] || fail "Habitab did not create the launcher script ($LAUNCHER). Log: $HOME_DIR/logs/app.log"

echo
say "Done. Habitab is running. Use its start screen or Habitab → Setup … (⌘,) to route Claude Code and Codex through Habitab."
