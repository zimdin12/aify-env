#!/usr/bin/env bash
# Resident-style owner: a foreground callback, then an async callback.
set -eu
observer="$AIFY_WRAPPER_REPO/bin/aify-tool-event.mjs"
printf '%s' '{"session_id":"lifetime-fixture-session","cwd":"C:/fixture/project","tool_name":"Read","tool_input":{"file_path":"before-end.txt"}}' | "$ACTIVITY_NATIVE_NODE" "$observer" success
printf '%s' '{"session_id":"lifetime-fixture-session","cwd":"C:/fixture/project","tool_name":"Read","tool_input":{"file_path":"after-end.txt"}}' | "$ACTIVITY_NATIVE_NODE" --import "$ACTIVITY_LIFETIME_PRELOAD" "$observer" success >/dev/null 2>"$ACTIVITY_LIFETIME_BOX/observer-stderr.log" &
end=$((SECONDS+5))
while [ ! -f "$ACTIVITY_LIFETIME_BOX/writer-ready.json" ]; do
  [ "$SECONDS" -lt "$end" ] || exit 2
  sleep 0.01
done
end=$((SECONDS+60))
while [ ! -f "$ACTIVITY_LIFETIME_BOX/exit-owner" ]; do
  [ "$SECONDS" -lt "$end" ] || exit 3
  sleep 0.01
done
exit 0
