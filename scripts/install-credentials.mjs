// The standalone credential step. The chain has its own registration phase and does not run this after assets.
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialRoot } from '../lib/credential-fs.mjs';
import { registryPath } from '../lib/install-chain-host.mjs';
import { InstallCredentialRegistration } from '../lib/install-credential-registration.mjs';
import { InstallCredentialReadiness } from '../lib/install-credential-readiness.mjs';
import { InstallCredentials } from '../lib/install-credentials.mjs';
import { servicesWithPlugins } from '../lib/plugins/index.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const say = line => process.stdout.write(`[aify-env] ${line}\n`);

/** Read the literal token without echo; the credential owner's validation decides whether it is usable. */
async function askSecretly(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const output = rl.output, write = output.write;
  let muted = false;
  output.write = (chunk, ...args) => muted ? true : write.call(output, chunk, ...args);
  try {
    return await new Promise(resolve => {
      rl.once('close', () => resolve(''));
      rl.question(prompt, value => resolve(String(value)));
      muted = true;
    });
  } finally { rl.close(); output.write = write; process.stdout.write('\n'); }
}

async function main() {
  const env = process.env, home = os.homedir(), registry = path.resolve(registryPath(env, home));
  const registration = new InstallCredentialRegistration({ env, home, envRoot: ROOT, registry });
  const readiness = new InstallCredentialReadiness({ env, root: credentialRoot(home), registration });
  const installer = new InstallCredentials({ registry, registration, readiness, plugins: new Set(servicesWithPlugins()), ask: askSecretly, say });
  const result = await installer.run({ interactive: Boolean(process.stdin.isTTY) && !process.argv.includes('--no-prompt') });
  process.exitCode = result.exit === 0 ? 0 : 1;
}

process.exitCode = 1; // Only a completed readiness result may report success.
main().catch(() => { process.stderr.write('[aify-env] credential readiness step failed; no success is assumed\n'); process.exitCode = 1; });
