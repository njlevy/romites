#!/bin/bash
cd "$(dirname "$0")"

# Start the server, writing output to a temp file
LOGFILE=$(mktemp)
node dev-server.js > "$LOGFILE" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready (up to 5 seconds)
PORT=""
for i in {1..10}; do
  if [ -f "$LOGFILE" ]; then
    PORT=$(grep -m1 '^PORT=' "$LOGFILE" 2>/dev/null | cut -d= -f2)
  fi
  if [ -n "$PORT" ]; then break; fi
  sleep 0.5
done

# Show the server log so far
cat "$LOGFILE"
rm -f "$LOGFILE"

if [ -z "$PORT" ]; then
  echo "Server started (port detection not available)."
  echo "Press Ctrl+C to stop."
  trap "kill $SERVER_PID 2>/dev/null; echo ''; echo 'Server stopped.'; exit 0" INT
  wait $SERVER_PID
  exit 0
fi

# Open in browser
open "http://localhost:${PORT}"

echo ""
echo "Running at http://localhost:${PORT}"
echo "Press Ctrl+C to stop the server."
echo ""

# Wait for Ctrl+C, then kill server
trap "kill $SERVER_PID 2>/dev/null; echo ''; echo 'Server stopped.'; exit 0" INT
wait $SERVER_PID
