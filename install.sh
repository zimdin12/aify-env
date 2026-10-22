#!/usr/bin/env bash
# Install or update aify-env on this host.
#
# THE SAME COMMAND DOES BOTH, by design. Re-running is the update path: dependencies are refreshed,
# the command is reinstalled, and a credential already stored is left exactly as it is. An installer
# with a separate update path grows a second set of steps that drifts from the first, and the half
# that rots is the one nobody runs by hand.
#
# IT ASKS FOR WHAT IS MISSING. On 2026-09-02 a service key sat in aify-comms' `.env`, this host held
# no credential for it, and nothing asked: every advertisement was refused with 401, both daemons
# reported healthy, and a day went to a fleet that would not spawn with no component naming a
# credential. An installer that silently proceeds with a missing value is how that happens.
#
# UNATTENDED RUNS DO NOT HANG AND DO NOT LIE. With no terminal it prints what is missing, names the
# command that fixes it, and EXITS NON-ZERO -- because a host that cannot claim anything must not
# report success.
#
#   ./install.sh                 install or update, asking for anything missing
#   ./install.sh --no-prompt     never ask; report and fail if something is missing
#   ./install.sh --plan-only     say what would happen; install nothing, ask nothing
#   ./install.sh --connect <service>=<url> --client <runtime> [--secret <service>.<field>=<file>] ...
#                                then run the guided-install chain (bin/aify-env-install.mjs): acquire, connect,
#                                render, assets, report. Its keys are connect's, so the credential step is skipped.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A relative --secret/--installer path names a file where the CALLER stands; it is made absolute before the cd below.
CALLER="$(pwd)"
cd "$HERE"

PLAN_ONLY=false
NO_PROMPT=false
CHAIN=()
while [ $# -gt 0 ]; do
  case "$1" in
    --plan-only) PLAN_ONLY=true ;;
    --no-prompt) NO_PROMPT=true; CHAIN+=("$1") ;;
    --connect|--client|--secret|--secret-stdin|--approve|--installer)
      [ $# -ge 2 ] || { echo "aify-env install: $1 needs a value" >&2; exit 64; }
      value="$2"
      case "$1=$2" in
        --secret=*=/*|--installer=*=/*|--secret=*=[A-Za-z]:[\\/]*|--installer=*=[A-Za-z]:[\\/]*) ;;
        --secret=*=*|--installer=*=*) value="${2%%=*}=$CALLER/${2#*=}" ;;
      esac
      CHAIN+=("$1" "$value"); shift ;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "aify-env install: unknown option '$1'" >&2; exit 64 ;;
  esac
  shift
done
CHAIN_MODE=false
for arg in ${CHAIN[@]+"${CHAIN[@]}"}; do [ "$arg" = "--connect" ] && CHAIN_MODE=true; done

say() { echo "[aify-env] $*"; }

# NODE FIRST, and by RUNNING it rather than by finding it on PATH. A node that is present and cannot
# execute -- a broken shim, a wrong architecture -- fails later, inside npm, with an error about
# something else.
if ! node --version >/dev/null 2>&1; then
  echo "aify-env install: node is required and could not be run." >&2
  echo "  Install Node 20 or newer, then run this again." >&2
  exit 1
fi
say "node $(node --version)"

if [ "$PLAN_ONLY" = true ]; then
  say "plan only: nothing will be installed and nothing will be asked"
  say "would run: npm install"
  say "would run: npm install -g ."
  say "would ensure ~/.aify/config.json has transport.localSocket (an existing value is kept)"
  say "then, for each registered service this host can host work for:"
  node scripts/install-credentials.mjs --no-prompt || true
  exit 0
fi

# DEPENDENCIES BEFORE THE GLOBAL INSTALL. node-pty is optional here on purpose -- a host without a
# compiler still runs, with piped stdio instead of a terminal -- so a failure to build it must not
# stop the install.
say "installing dependencies"
npm install --no-audit --no-fund

# THE COMMAND ITSELF. `npm install -g .` is also how an update lands: it replaces whatever `aify-env`
# resolves to now, including a previous `npm link`.
say "installing the aify-env command"
npm install -g . --no-audit --no-fund

say "installed: $(command -v aify-env || echo 'NOT ON PATH -- check your npm global bin directory')"

# THE HOST'S TRANSPORT DEFAULT, written once into ~/.aify/config.json so the setting is discoverable.
# A value already there is left alone: an operator who switched it off meant it.
node scripts/install-host-config.mjs || true

# THE CHAIN, when a service was named: it connects each one, storing its keys through connect, so the credential
# step below would only ask again for what connect is about to set.
if [ "$CHAIN_MODE" = true ]; then
  exec node "$HERE/bin/aify-env-install.mjs" "${CHAIN[@]}"
fi

# AND THE CREDENTIALS, last, because the plan depends on what is registered on this host rather than
# on what is in this checkout. Its exit status is this script's: a host that cannot claim work has
# not been successfully installed, whatever the file copying did.
if [ "$NO_PROMPT" = true ]; then
  node scripts/install-credentials.mjs --no-prompt
else
  node scripts/install-credentials.mjs
fi

# NO BACKTICKS IN A SHELL STRING. Inside double quotes they are COMMAND SUBSTITUTION, and the
# first draft of this line would have RUN `aify-env` at the end of every install -- starting the
# environment, superseding whatever was serving, and reaping its managed workers. This project
# has had that exact incident once already, from a heredoc.
say "done."
say "  aify-env          starts the environment"
say "  aify-env doctor   checks it"
say "  aify-env tui      shows it"
