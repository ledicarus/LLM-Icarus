#!/bin/bash
# Stops the LLM Icarus server (and unloads the model).
PORT="${PORT:-3210}"
if curl -fsS -m 5 -X POST "http://127.0.0.1:$PORT/api/shutdown" >/dev/null 2>&1; then
  echo "LLM Icarus stopped."
else
  echo "LLM Icarus was not running."
fi
