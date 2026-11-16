#!/bin/zsh
# Serves the ambient machine on http://localhost:8781 (with ElevenLabs drum generation) and opens it.
# Close this Terminal window (or press ctrl-C) to stop the server.
cd "$(dirname "$0")"
PORT=8781
if ! curl -sf -o /dev/null "http://localhost:$PORT/api/status"; then
  python3 server.py --port "$PORT" &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT INT TERM
  until curl -sf -o /dev/null "http://localhost:$PORT/api/status"; do sleep 0.2; done
fi
open "http://localhost:$PORT/"
wait
