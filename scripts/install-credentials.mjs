// Ask for what this host is missing, and only for what it is missing.
//
// RUN BY `install.sh` AFTER the package is installed, because the plan depends on what is registered
// on this host rather than on what is in this checkout. Re-running is the UPDATE path: a credential
// already stored is left exactly as it is.
//
// THE DEFECT IT EXISTS FOR, 2026-09-02: a service key sat in aify-comms' `.env`, this host held no
// credential for it, and nothing asked. Every advertisement 401'd while both daemons reported
// healthy, and a day went to a fleet that would not spawn with no component naming a credential.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { credentialRoot, readCredentialFile } from "../lib/credential-fs.mjs";
import { readServices } from "../lib/services.mjs";
import { servicesWithPlugins } from "../lib/plugins/index.mjs";
import { describePlan, planInstall, planIsIncomplete, WILL_ASK } from "../lib/install-plan.mjs";
import { CREDENTIAL_OK, defaultCredentialRef } from "../lib/credential-store.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY = join(process.env.HOME || process.env.USERPROFILE || "", ".aify", "services.json");
const say = (line) => process.stdout.write(`[aify-env] ${line}\n`);

function registeredServices() {
  try {
    return readServices(readFileSync(REGISTRY, "utf8"));
  } catch {
    // No registry means nobody has asked to be told about this host. Not an error, and not something
    // to ask about either.
    return [];
  }
}

/**
 * Which services this host already holds a usable credential for.
 *
 * ASKED THROUGH THE STORE'S OWN READER, never by looking for a file: a file that exists and cannot
 * be read, or whose ownership is wrong, is not a credential -- and treating its presence as proof is
 * how "configured" and "working" come apart.
 *
 * Resolved for every service up front so `planInstall` stays PURE and synchronous. A plan that had
 * to await inside its loop could not be tested without a filesystem.
 */
async function servicesWithCredentials(services) {
  const held = new Set();
  const root = credentialRoot();
  for (const service of services) {
    const name = String(service?.name || "").trim();
    if (!name) continue;
    try {
      const answer = await readCredentialFile({ root, ref: defaultCredentialRef(name) });
      if (answer && answer.state === CREDENTIAL_OK) held.add(name);
    } catch {
      // Unreadable is NOT held. Failing closed here means the installer offers to fix it rather
      // than assuming a credential nobody can read will work at runtime.
    }
  }
  return held;
}

/** Read a secret without echoing it, and without leaving it in a shell history or an argv. */
async function askSecretly(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = await new Promise((resolve) => {
    // Muting is best-effort: on a terminal that will not mute, a visible key is better than no
    // installer at all, and the operator can see that it is visible.
    const output = rl.output;
    let muted = false;
    const write = output.write.bind(output);
    output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));
    rl.question(prompt, (value) => { output.write = write; process.stdout.write("\n"); resolve(value); });
    muted = true;
  });
  rl.close();
  return String(answer || "").trim();
}

/** Hand the key to the store through its OWN command, so the path resolution, the ACLs and the
 *  atomic write stay in one place. Never written here directly. */
function storeCredential(service, key) {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "bin", "aify-env-credential.mjs"), "set", "--service", service, "--stdin"],
    { input: key, encoding: "utf8" },
  );
  const ref = String(result.stdout || "").trim();
  if (result.status !== 0 || !ref) {
    return { ok: false, detail: String(result.stderr || "").trim() || "the store named no reference" };
  }
  return { ok: true, ref };
}

async function main() {
  const interactive = Boolean(process.stdin.isTTY) && !process.argv.includes("--no-prompt");
  const services = registeredServices();
  const withPlugins = new Set(servicesWithPlugins());
  const held = await servicesWithCredentials(services);
  const plan = planInstall({
    services,
    hasCredential: (name) => held.has(name),
    hasPlugin: (name) => withPlugins.has(name),
    interactive,
  });

  for (const line of describePlan(plan)) say(line);

  for (const step of plan.steps.filter((s) => s.action === WILL_ASK)) {
    const key = await askSecretly(`[aify-env] API key for ${step.service} (input hidden): `);
    if (!key) {
      say(`${step.service}: nothing entered, so no credential was stored`);
      continue;
    }
    const stored = storeCredential(step.service, key);
    say(stored.ok
      ? `${step.service}: credential stored as ${stored.ref}`
      : `${step.service}: the store REFUSED the credential -- ${stored.detail}`);
    if (!stored.ok) process.exitCode = 1;
  }

  // A HOST THAT CANNOT CLAIM MUST NOT EXIT 0. An unattended install reporting success over a host
  // whose every advertisement will be refused is the failure this whole script is about.
  if (planIsIncomplete(plan)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`[aify-env] credential step failed: ${error?.message || error}\n`);
  process.exitCode = 1;
});
