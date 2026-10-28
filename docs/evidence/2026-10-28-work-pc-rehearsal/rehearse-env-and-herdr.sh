#!/usr/bin/env bash
# Work-PC rehearsal on Linux (WSL stands in as Debian here): a v0.5.7 claude client upgraded through today's chain,
# then what the comms rehearsal stopped short of: starting aify-env, herdr from its own installer, herdr-aify, and a
# stale v0.5 environment bridge. Throwaway containers only. Nothing here touches the host's ~/.claude, ~/.aify,
# services or processes, and no claude or hermes login exists anywhere.
#
# Steps 1-3 are aify-comms' docs/evidence/2026-10-28-upgrade-rehearsal/rehearse-client-upgrade.sh, under names of
# their own so the two rehearsals cannot collide.
#
#   REHEARSE_DIR=<scratch dir> AIFY_COMMS_REPO=<comms checkout> bash rehearse-env-and-herdr.sh
#   KEEP=1 leaves the containers up for a look; run again without it to tear down.
#   AIFY_ENV_TARBALL=<npm pack of an aify-env commit> installs that aify-env through the same chain
#   (AIFY_INSTALL_ENV_SOURCE), in place of GitHub's main: how a release candidate is rehearsed before its tag.
set -uo pipefail
export MSYS_NO_PATHCONV=1
S="${REHEARSE_DIR:?set REHEARSE_DIR to a scratch directory}"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEY=rehearse-key
SVC_NAME=aify-wpc-svc
CLIENT=aify-wpc-client
VOL=aify-wpc-data
NET=aify-wpc-net
# `[-]-environment-bridge`, NOT `--environment-bridge`: these commands run inside `bash -lc '...'`, whose own command
# line holds the pattern, so the plain form finds (and pkill kills) the calling shell. aify-env is stopped by its pid.
say() { printf '\n== %s\n' "$*"; }
in_c() { docker exec -u node -e HOME=/home/node -w /home/node "$CLIENT" bash -lc "$1"; }
teardown() { docker rm -f "$CLIENT" "$SVC_NAME" >/dev/null 2>&1; docker volume rm "$VOL" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
gone() {
  for name in "$CLIENT" "$SVC_NAME"; do printf '%s container: %s\n' "$name" "$(docker ps -a --filter "name=^${name}$" --format '{{.Names}}' | grep -qx "$name" && echo PRESENT || echo gone)"; done
  printf '%s volume: %s\n' "$VOL" "$(docker volume ls --format '{{.Name}}' | grep -qx "$VOL" && echo PRESENT || echo gone)"
  printf '%s network: %s\n' "$NET" "$(docker network ls --format '{{.Name}}' | grep -qx "$NET" && echo PRESENT || echo gone)"
}

say "clean"
teardown
docker network create "$NET" >/dev/null

say "service: today's live image on a fresh volume (the image of the running aify-comms-service)"
NEWIMG=$(docker inspect aify-comms-service --format '{{.Image}}')
docker run -d --name "$SVC_NAME" --network "$NET" -v "$VOL":/data -v "${AIFY_COMMS_REPO:?set AIFY_COMMS_REPO}/config":/app/config:ro \
  -e API_KEY=$KEY -e DATA_DIR=/data -e SERVICE_PORT=8800 "$NEWIMG" >/dev/null
SVC_IP=$(docker inspect "$SVC_NAME" --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}")
SVC="http://$SVC_IP:8800"
for i in $(seq 1 60); do docker exec "$SVC_NAME" curl -sf http://127.0.0.1:8800/health >/dev/null 2>&1 && break; sleep 2; done
SHA=$(docker exec "$SVC_NAME" curl -s http://127.0.0.1:8800/version | grep -oE '"sha":"[0-9a-f]+"' | cut -d'"' -f4)
echo "service $SVC build $SHA"

say "client container (Debian bookworm, node 22, the claude CLI for its mcp config only; never logged in)"
cat > "$S/wpc-client.Dockerfile" <<'EOF'
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 git curl procps ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@latest >/dev/null 2>&1 && chown -R node:node /usr/local/lib/node_modules /usr/local/bin
EOF
docker build -q -t aify-wpc-client -f "$S/wpc-client.Dockerfile" "$S" > "$S/wpc-build.log" 2>&1 || { echo "CLIENT IMAGE BUILD FAILED"; tail -20 "$S/wpc-build.log"; exit 1; }
# --init: PID 1 must reap, as WSL's init does. Under a bare `sleep infinity` a worker that died with the daemon
# stayed as <defunct> under PID 1 and read as still running (first run of this script, 2026-10-28).
docker run -d --init --name "$CLIENT" --network "$NET" aify-wpc-client sleep infinity >/dev/null
in_c 'claude --version; node --version; uname -sm'
ENV_SOURCE=""
if [ -n "${AIFY_ENV_TARBALL:-}" ]; then
  docker cp "$(cygpath -m "$AIFY_ENV_TARBALL" 2>/dev/null || echo "$AIFY_ENV_TARBALL")" "$CLIENT":/tmp/aify-env.tgz >/dev/null && docker exec -u root "$CLIENT" chmod 644 /tmp/aify-env.tgz
  ENV_SOURCE="AIFY_INSTALL_ENV_SOURCE=/tmp/aify-env.tgz"
  echo "aify-env from $(basename "$AIFY_ENV_TARBALL"), sha256 $(sha256sum < "$AIFY_ENV_TARBALL" | cut -c1-16)"
fi

say "1. the OLD install: aify-comms v0.5.7 from GitHub, claude client"
in_c "git clone -q https://github.com/zimdin12/aify-comms.git old && cd old && git checkout -q v0.5.7 && AIFY_API_KEY=$KEY bash install.sh --client claude $SVC > ../old-install.log 2>&1; echo old install exit \$?"
in_c 'echo "--- v0.5 environment bridge after the old install:"; pgrep -af -- "[-]-environment-bridge" || echo "none running"'

say "BONUS setup: a v0.5 environment bridge still running, as the old bare aify-comms left one"
in_c 'cd ~/old && ls mcp/stdio/server.js >/dev/null && (AIFY_SERVER_URL='"$SVC"' AIFY_API_KEY='"$KEY"' nohup node mcp/stdio/server.js --environment-bridge > ~/old-bridge.log 2>&1 &) ; sleep 4; pgrep -af -- "[-]-environment-bridge" || { echo "the v0.5.7 bridge did not stay up; its log:"; tail -15 ~/old-bridge.log; }'

say "2. the UPGRADE through today's chain at the service's commit (three passes, as the comms rehearsal found)"
in_c "git clone -q https://github.com/zimdin12/aify-comms.git new && cd new && git checkout -q $SHA && git log -1 --format='%h %s' && AIFY_API_KEY=$KEY $ENV_SOURCE bash install.sh --client claude $SVC > ../new-install-1.log 2>&1; echo first pass exit \$?"
DIGEST=$(in_c "grep -oE -- '--approve [^ )]+' new-install-1.log | head -1 | cut -d' ' -f2")
echo "approval digest: ${DIGEST:-NONE}"
in_c "cd new && AIFY_API_KEY=$KEY $ENV_SOURCE AIFY_INSTALL_APPROVE=$DIGEST bash install.sh --client claude $SVC > ../new-install-2.log 2>&1; echo second pass exit \$?"
POLICY=$(in_c "grep -E '^sudo -- ' new-install-2.log | head -1")
[ -n "$POLICY" ] && docker exec -u root "$CLIENT" bash -lc "${POLICY#sudo -- }" >/dev/null && echo "channel policy written (the printed sudo step, run as root)"
in_c "cd new && AIFY_API_KEY=$KEY $ENV_SOURCE AIFY_INSTALL_APPROVE=$DIGEST bash install.sh --client claude $SVC > ../new-install-3.log 2>&1; echo third pass exit \$?; grep -E 'chain' ../new-install-3.log | tail -2"
in_c 'for c in aify-comms claude-aify aify-env herdr-aify; do printf "%s -> %s\n" $c "$(command -v $c || echo none)"; done; aify-env --version 2>&1 | head -1'

say "3. before aify-env: the comms doctor's three aify-env rows"
in_c 'env -u AIFY_AGENT_ID aify-comms doctor 2>&1 | grep -E "agent-state-publishers|spawn-delegation|env-bridge|check\(s\)"'

say "BONUS: start aify-env WITH the stale v0.5 bridge still running"
in_c 'pgrep -af -- "[-]-environment-bridge" || echo "(no v0.5 bridge running)"'
in_c 'setsid nohup aify-env > ~/aify-env-1.log 2>&1 < /dev/null & echo $! > ~/aify-env.pid; for i in $(seq 1 30); do curl -sf http://127.0.0.1:8802/health >/dev/null && break; sleep 1; done; curl -s http://127.0.0.1:8802/health | head -c 300; echo; echo "--- aify-env log:"; tail -25 ~/aify-env-1.log'
in_c 'echo "--- comms doctor with both running:"; env -u AIFY_AGENT_ID aify-comms doctor 2>&1 | grep -E "agent-state-publishers|spawn-delegation|env-bridge|tier-version|bridge-running|check\(s\)"'
in_c 'echo "--- the old bridge, still there?"; pgrep -af -- "[-]-environment-bridge" || echo "gone"; echo "--- its log tail:"; tail -8 ~/old-bridge.log'

say "4. the guide's order: stop the old bridge, then restart aify-env"
in_c 'pkill -f -- "[-]-environment-bridge"; sleep 2; pgrep -af -- "[-]-environment-bridge" || echo "v0.5 bridge stopped"'
in_c 'kill $(cat ~/aify-env.pid) 2>/dev/null; sleep 3; setsid nohup aify-env > ~/aify-env-2.log 2>&1 < /dev/null & echo $! > ~/aify-env.pid; for i in $(seq 1 30); do curl -sf http://127.0.0.1:8802/health >/dev/null && break; sleep 1; done; curl -s http://127.0.0.1:8802/health | head -c 200; echo'
in_c 'echo "--- comms doctor:"; env -u AIFY_AGENT_ID aify-comms doctor 2>&1 | grep -E "^  [✓✗–]|check\(s\)"'
in_c 'echo "--- aify-env doctor, every row that is not ok, and the count:"; aify-env doctor 2>&1 | grep -v -E "^  ok " | grep -E "^  [^ ]|passed" | head -12; aify-env doctor 2>&1 | grep -E "claude-login"'

say "5. a spawn, with no claude login: the daemon starts claude-aify for a probe agent, and its screen is read"
in_c 'timeout 40 aify-env run --service aify-comms --launcher "$(command -v claude-aify)" --label wpc-probe -- > ~/run.out 2>&1; echo "aify-env run exit $? (64: it will not attach without a terminal on both ends)"; head -1 ~/run.out'
in_c 'sleep 8; id=$(curl -s http://127.0.0.1:8802/processes | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const p=(JSON.parse(s).processes||[]).find(p=>p.label===\"wpc-probe\");console.log(p?p.id:\"\")})"); echo "worker: ${id:-NONE}"; timeout 6 curl -sN "http://127.0.0.1:8802/processes/$id/output" > ~/probe.stream 2>/dev/null; node -e "
const raw=require(\"fs\").readFileSync(process.env.HOME+\"/probe.stream\",\"utf8\"); let text=\"\";
for (const line of raw.split(/\r?\n/)) { const m=line.match(/^data: (\".*\")$/); if(m) text += JSON.parse(m[1]); }
const clean=text.replace(/\x1b\[[0-9]*C/g,\" \").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,\"\").replace(/\x1b[()][A-Z0-9]/g,\"\").replace(/\x1b[=>]/g,\"\").replace(/\r/g,\"\");
console.log(\"its screen:\"); console.log(clean.split(\"\n\").map(s=>s.replace(/[░▓█▒▄▀▐▌▘▝]+/g,\"\").trim()).filter(s=>/[a-z]{3}/i.test(s)).slice(0,10).map(s=>\"  \"+s).join(\"\n\"));"'
in_c 'echo "--- the worker tree before the stop:"; ps -eo pid,ppid,etimes,args --forest | grep -E "[a]ify-env|[c]laude" | cut -c1-150; kill $(cat ~/aify-env.pid) 2>/dev/null; alive() { ps -eo stat,pid,args | grep -v "^Z" | grep -E "[a]ify-env|[c]laude"; }; for i in $(seq 1 20); do sleep 1; alive >/dev/null || break; done; echo "--- ${i} s after SIGTERM to the daemon, still running (zombies excluded):"; alive | cut -c1-150 || echo "nothing: the worker went with the daemon"'

say "6. herdr from its official installer: the copy reviewed beside this script, run as the node user"
docker cp "$(cygpath -m "$HERE/herdr-install.reviewed.sh" 2>/dev/null || echo "$HERE/herdr-install.reviewed.sh")" "$CLIENT":/tmp/herdr-install.sh >/dev/null && docker exec -u root "$CLIENT" chmod 644 /tmp/herdr-install.sh
in_c 'sha256sum /tmp/herdr-install.sh; sh /tmp/herdr-install.sh 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep -E ">|!|✗"; export PATH="$HOME/.local/bin:$PATH"; command -v herdr; timeout 10 herdr --version'
in_c 'cd ~/new && bash scripts/herdr-state.sh --probe 2>&1 | head -5'

say "7. aify-env herdr on Linux"
in_c 'export PATH="$HOME/.local/bin:$PATH"; timeout 10 aify-env herdr > /tmp/eh.out 2>&1; echo "aify-env herdr exit $?"; cat /tmp/eh.out'

say "8. herdr-aify env: first with no terminal size, then attached again in a 120x40 one, then stopped"
in_c 'export PATH="$HOME/.local/bin:$PATH"; timeout 25 script -qfec "herdr-aify env" /dev/null > ~/hae.typescript 2>&1; echo "herdr-aify env exit $?"; sed "s/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\x1b[()][A-Z0-9]//g; s/\x1b[=>]//g" ~/hae.typescript | tr -s " \r" | grep -a -E "^(herdr|herdr-aify):" | head -8; echo "--- running after it returned:"; ps -eo args | grep -E "^(/home/node/.local/bin/herdr server|node /usr/local/bin/aify-env --instance-context)" || echo none; echo "--- herdr-aify --status:"; herdr-aify --status 2>&1 | grep -E "invocation|spent"'
in_c 'export PATH="$HOME/.local/bin:$PATH"; timeout 15 script -qfec "stty cols 120 rows 40; herdr-aify env" /dev/null > ~/hae2.typescript 2>&1; echo "second herdr-aify env exit $? (124: still attached at the 15 s timeout)"; sed "s/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\x1b[()][A-Z0-9]//g; s/\x1b[=>]//g" ~/hae2.typescript | tr -s " \r" | grep -a -o -E "herdr-aify: attaching[^\x1b]{0,40}|aify-env [0-9][^ ]*|terminals [a-z]+" | sort -u'
in_c 'export PATH="$HOME/.local/bin:$PATH"; herdr-aify env --stop 2>&1 | tail -2; sleep 3; echo "--- left running:"; ps -eo args | grep -E "^(/home/node/.local/bin/herdr server|node /usr/local/bin/aify-env --instance-context)" || echo none'

say "9. the restore plugin aify-wrapper's HERDR.md asks to link once per machine"
in_c 'export PATH="$HOME/.local/bin:$PATH"; aify-herdr-pane install 2>&1 | sed "s/^aify-herdr-pane [^:]*Z: //"; timeout 10 herdr plugin list 2>&1 | head -3'

if [ "${KEEP:-}" = "1" ]; then say "KEEP=1: left running ($CLIENT, $SVC_NAME)"; exit 0; fi
say "teardown"
teardown
gone
