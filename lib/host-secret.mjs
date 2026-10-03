// What proves to a service that a request comes from this machine's aify-env, and not from anything else
// holding the service's API key (external review of 0.8.1, HIGH 2).
//
// Every agent on a host holds the API key, and the service's host routes trusted it alone: a key holder
// could push a machine's agent definitions (rewriting another agent's instructions, model and environment)
// or take the environment row by registering as the host tier with a later start time. So this host keeps
// one secret, in `~/.aify/host-secret`, created on first use and never rotated by this code, and sends each
// service a proof derived from it: HMAC(secret, service name). A service that learns its proof cannot use
// it at another service. The service records the first proof a machine presents and requires it after.
//
// WHAT IT DOES NOT DO. A process running as this user can read the file, as it can read every key here.
// This stops a caller that holds only the API key, which is every agent and every other host.

import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 32 random bytes, base64url: what a whole secret file holds, and all it may hold. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Where this host's secret lives. */
export function hostSecretFile(env = process.env) {
  return env.AIFY_HOST_SECRET_FILE || path.join(homedir(), ".aify", "host-secret");
}

/**
 * This host's secret, made on first use. Two instances starting together agree on one: each writes a
 * whole temporary file and links it into place, which fails for every writer but the first, and the rest
 * read the winner's. A file that is not one whole secret is refused rather than replaced: replacing it
 * would change this host's proof, and the service would then refuse the host until an operator reset it.
 */
export function readOrCreateHostSecret(file = hostSecretFile(), { fsImpl = fs } = {}) {
  try {
    return checked(fsImpl.readFileSync(file, "utf8"), file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fsImpl.writeFileSync(temp, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  try {
    fsImpl.linkSync(temp, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    fsImpl.rmSync(temp, { force: true });
  }
  return checked(fsImpl.readFileSync(file, "utf8"), file);
}

function checked(text, file) {
  const secret = String(text).trim();
  if (!SECRET_SHAPE.test(secret)) throw new Error(`${file} is not a host secret; remove it and ask the operator to reset this machine's host proof`);
  return secret;
}

/** PURE. The proof this host sends one service: never the secret itself. */
export function hostProof(secret, serviceName) {
  return createHmac("sha256", secret).update(`aify-host-proof:${serviceName}`).digest("base64url");
}

/** The proof for `serviceName`, read when asked, so a plugin built before the file existed still finds it. */
export function hostProofFor(serviceName, { file = hostSecretFile() } = {}) {
  return hostProof(readOrCreateHostSecret(file), serviceName);
}
