#!/bin/bash
# Starts LLM Icarus and opens it in its own window (macOS).
# Closing the window stops the server and unloads the model, unless the server was already running.
#   start.sh              start and open the window
#   start.sh --no-window  just make sure the server is running

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPPORT_DIR="$(dirname "$APP_DIR")"
export CLUI_DATA_DIR="${CLUI_DATA_DIR:-$SUPPORT_DIR/data}"
export PORT="${PORT:-3210}"
URL="http://127.0.0.1:$PORT"
NODE="$APP_DIR/runtime/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"
mkdir -p "$CLUI_DATA_DIR"

alert() {
  osascript -e "display dialog \"$1\" with title \"LLM Icarus\" buttons {\"OK\"} default button \"OK\" with icon caution" >/dev/null 2>&1 || echo "$1" >&2
}
server_up() { curl -fsS -m 2 "$URL/api/settings" >/dev/null 2>&1; }

# A server that was just closed takes a few seconds to unload its model and exit, answering 503 meanwhile.
# Wait for it to finish rather than attaching to a server that is about to disappear.
closing() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$URL/api/settings")" = "503" ]; }
for _ in $(seq 1 40); do closing || break; sleep 0.5; done

STARTED=0
if ! server_up; then
  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    alert "Node.js was not found. Re-run the LLM Icarus installer."
    exit 1
  fi
  (cd "$APP_DIR" && nohup "$NODE" server/index.js >>"$CLUI_DATA_DIR/server.log" 2>&1 & echo $! >"$CLUI_DATA_DIR/server.pid")
  STARTED=1
  for _ in $(seq 1 40); do server_up && break; sleep 0.5; done
  if ! server_up; then
    alert "The LLM Icarus server did not start. Details are in: $CLUI_DATA_DIR/server.log"
    exit 1
  fi
fi

[ "$1" = "--no-window" ] && exit 0

# A Chromium-based browser can show the page as an app window (no tabs or address bar).
BROWSER=""
for name in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if [ -d "/Applications/$name.app" ] || [ -d "$HOME/Applications/$name.app" ]; then BROWSER="$name"; break; fi
done

if [ -n "$BROWSER" ]; then
  # A private profile folder makes this its own browser instance, so `open -W` returns when the window closes.
  open -n -W -a "$BROWSER" --args --app="$URL" --user-data-dir="$CLUI_DATA_DIR/app-profile" \
    --window-size=1320,880 --no-first-run --no-default-browser-check --disable-sync
  if [ "$STARTED" = 1 ]; then
    curl -fsS -m 5 -X POST "$URL/api/shutdown" >/dev/null 2>&1
  fi
else
  # No Chrome/Edge/Brave: open the default browser (a normal tab). The server keeps running until stop.sh is used.
  open "$URL"
  alert "LLM Icarus opened in your default browser. For a cleaner app window, install Google Chrome. To stop LLM Icarus later, run stop.sh in: $APP_DIR"
fi
