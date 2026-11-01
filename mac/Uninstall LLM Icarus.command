#!/bin/bash
# Removes LLM Icarus from this Mac. Asks before deleting your models, chats and generated files.
SUPPORT="$HOME/Library/Application Support/LLM Icarus"
BUNDLE="$HOME/Applications/LLM Icarus.app"
DATA="$SUPPORT/data"

# stop the server if it is running
curl -fsS -m 5 -X POST "http://127.0.0.1:3210/api/shutdown" >/dev/null 2>&1 && sleep 2

echo "This removes LLM Icarus (the app and its program files)."
rm -rf "$BUNDLE" "$SUPPORT/app" "$SUPPORT/Download components.command"

if [ -d "$DATA" ]; then
  SIZE="$(du -sh "$DATA" 2>/dev/null | awk '{print $1}')"
  ans=""
  if [ -r /dev/tty ]; then
    read -r -p "Also delete your downloaded models, Python tools, chats and images ($SIZE in $DATA)? [y/N] " ans </dev/tty
  fi
  ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
  if [ "$ans" = "y" ] || [ "$ans" = "yes" ]; then rm -rf "$DATA"; echo "Data deleted."; else echo "Data kept in: $DATA"; fi
fi

# remove the support folder if nothing is left in it
rm -f "$SUPPORT/Uninstall LLM Icarus.command"
rmdir "$SUPPORT" 2>/dev/null
echo "LLM Icarus has been uninstalled."
