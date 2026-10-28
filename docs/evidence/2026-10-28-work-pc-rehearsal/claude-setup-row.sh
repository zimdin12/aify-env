#!/bin/bash
# Inside a throwaway node container: /repo is the dev worktree, read-only. A home where claude was never run.
set -u
export HOME=/tmp/h AIFY_ENV_ENDPOINT=http://127.0.0.2:1 AIFY_PROBE_TIMEOUT_MS=300 AIFY_SERVICE_REGISTRY=/tmp/none.json
mkdir -p "$HOME"
row() {
  node /repo/bin/aify-env-doctor.mjs --json > /tmp/d.json; echo "doctor exit $?"
  node -e 'const r=require("/tmp/d.json"); const c=r.checks.find(x=>x.id==="claude-login"); console.log(`  ${c.state} ${c.code} | ${c.detail.replace(/\d+(\.\d+)?h/g,"Nh")}`); if (c.fix) console.log(`  fix: ${c.fix}`)'
}
echo "== 1. no claude agent defined, claude never run"
row
echo "== 1b. no definition, but claude-aify on PATH (the rehearsal's ad-hoc case)"
mkdir -p /tmp/launchers && printf '#!/bin/sh\nHARNESS_WRAPPER_VERSION="1"\nexit 64\n' > /tmp/launchers/claude-aify && chmod +x /tmp/launchers/claude-aify
PATH="/tmp/launchers:$PATH" row
echo "== 2. one managed claude agent defined, claude never run"
node --input-type=module -e '
import { DefinitionStore } from "/repo/lib/agent-definitions.mjs";
const store = new DefinitionStore({ dir: process.env.HOME + "/.aify/agent-definitions" });
await store.set("probe", { id: "probe", name: "probe", role: "worker", harness: "claude", mode: "managed", workspace: process.env.HOME,
  model: "", effort: "", instructions: "", env: {}, herdrSpace: false }, { installed: new Set(["claude"]) });
console.log("  defined probe");'
row
echo "== 3. setup completed (hasCompletedOnboarding), no login"
echo '{"hasCompletedOnboarding":true}' > "$HOME/.claude.json"
row
echo "== 4. and a login fixture good for 240h"
mkdir -p "$HOME/.claude"
node -e 'const t=Date.now()+240*3600000; require("fs").writeFileSync(process.env.HOME+"/.claude/.credentials.json", JSON.stringify({claudeAiOauth:{accessToken:"fixture",refreshToken:"fixture",expiresAt:t,refreshTokenExpiresAt:t}}))'
row
