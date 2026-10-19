#!/bin/bash
# Habitab installer.
#
#   ./install.sh               build, install and start the app
#                              (macOS: /Applications, Linux: ~/.local/lib/habitab)
#   ./install.sh --prefix DIR  install to DIR instead
#   ./install.sh --uninstall   restore client configurations and remove the app
#   ./install.sh --uninstall --yes   same, also delete data without asking
#
# The one setting (chrome-devtools-mcp's global config) happens in the app (Habitab → Setup …).
set -euo pipefail
cd "$(dirname "$0")"

YES=0 UNINSTALL=0 PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --prefix) PREFIX="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { [ "$YES" = 1 ] && return 0; [ -t 0 ] || return 1; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[yY] ]]; }

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) fail "This script supports macOS and Linux." ;;
esac

if [ "$OS" = mac ]; then
  HOME_DIR="${HABITAB_HOME:-$HOME/Library/Application Support/Habitab}"
else
  HOME_DIR="${HABITAB_HOME:-$HOME/.local/share/habitab}"
fi
LAUNCHER="$HOME_DIR/bin/habitab"

# The app's main process only. Launchers of running agent sessions use the same
# executable (in Node mode) and keep running; they are not the app. Chromium's
# helper processes have a --type argument.
app_pids() {
  if [ "$OS" = mac ]; then
    ps -axo pid=,command= | grep '/Habitab\.app/Contents/MacOS/Habitab' | grep -v 'launcher/main\.js' | awk '{print $1}'
  else
    ps -eo pid=,args= | grep -v -e 'launcher/main\.js' -e '--type=' | awk '$2 ~ /\/habitab$/ {print $1}'
  fi
}
app_running() { [ -n "$(app_pids)" ]; }

quit_app() {
  if app_running; then
    say "Quitting running Habitab …"
    if [ "$OS" = mac ]; then
      # Asks for confirmation inside the app if an agent is working.
      osascript -e 'tell application "Habitab" to quit' >/dev/null 2>&1 || true
    else
      # SIGTERM: the app saves its sessions and quits without asking.
      kill $(app_pids) 2>/dev/null || true
    fi
    local waited=0
    while app_running; do
      [ "$waited" = 6 ] && echo "    Waiting for Habitab to quit. Confirm the dialog in the app."
      [ "$waited" -ge 240 ] && fail "Habitab is still running. Quit the app and run the installer again."
      sleep 0.5; waited=$((waited + 1))
    done
  fi
}

find_installed() {
  if [ "$OS" = linux ]; then
    local d="${PREFIX:-$HOME/.local/lib/habitab}"
    [ -x "$d/habitab" ] && echo "$d"
    return 0
  fi
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
  [ "$OS" = linux ] && rm -f "$HOME/.local/share/applications/habitab.desktop"
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
if [ "$OS" = mac ]; then
  npm run --silent dist >/dev/null
  BUILT="$(find release -maxdepth 2 -name Habitab.app -type d | head -1)"
  [ -n "$BUILT" ] || fail "Build failed: release/*/Habitab.app not found."
else
  rm -rf release/linux-*unpacked
  npm run --silent dist:linux >/dev/null
  BUILT="$(find release -maxdepth 1 -name 'linux-*unpacked' -type d | head -1)"
  [ -n "$BUILT" ] && [ -x "$BUILT/habitab" ] || fail "Build failed: release/linux-*unpacked/habitab not found."
fi

# --- install
if [ "$OS" = mac ]; then
  if [ -z "$PREFIX" ]; then
    if [ -w /Applications ]; then PREFIX=/Applications; else PREFIX="$HOME/Applications"; fi
  fi
  TARGET="$PREFIX/Habitab.app"
else
  TARGET="${PREFIX:-$HOME/.local/lib/habitab}"
fi
mkdir -p "$(dirname "$TARGET")"
quit_app
say "Installing to $TARGET"
rm -rf "$TARGET"
cp -R "$BUILT" "$TARGET"
if [ "$OS" = mac ]; then
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
elif [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] || [ "$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null)" = 0 ]; then
  # Chromium's sandbox needs user namespaces. Where the system does not allow
  # them (e.g. Ubuntu 24.04 and newer), it uses its setuid helper instead.
  say "Setting up Chromium's sandbox helper (needs sudo) …"
  sudo chown root:root "$TARGET/chrome-sandbox" && sudo chmod 4755 "$TARGET/chrome-sandbox" \
    || fail "Could not set up $TARGET/chrome-sandbox (owner root, mode 4755)."
fi

# --- start (the app writes the habitab command and the browser script)
say "Starting Habitab …"
if [ "$OS" = mac ]; then
  # `open` does not pass the environment; forward Habitab's own variables
  # (separate test instances use their own HABITAB_HOME).
  OPEN_ENV=()
  while IFS='=' read -r k v; do OPEN_ENV+=(--env "$k=$v"); done < <(env | grep '^HABITAB_' || true)
  open ${OPEN_ENV[@]+"${OPEN_ENV[@]}"} "$TARGET"
else
  nohup "$TARGET/habitab" >/dev/null 2>&1 < /dev/null &
  disown
fi
for _ in $(seq 1 40); do
  [ -x "$LAUNCHER" ] && grep -q "$TARGET" "$LAUNCHER" 2>/dev/null && break
  sleep 0.5
done
[ -x "$LAUNCHER" ] || fail "Habitab did not create the habitab command ($LAUNCHER). Log: $HOME_DIR/logs/app.log"

echo
if [ "$OS" = mac ]; then
  say "Done. Habitab is running. Use its start screen or Habitab → Setup … (⌘,) to route Claude Code and Codex through Habitab."
else
  say "Done. Habitab is running. Use its start screen or Setup in the sidebar to route Claude Code and Codex through Habitab."
fi
