/**
 * The credential store on disk: private root, atomic write, readback, and refusal to read a file
 * anyone else can.
 *
 * SPLIT FROM `credential-store.mjs` ON PURPOSE: that module holds every rule that can be checked by
 * calling a function, and this one holds the rules that need a filesystem. Keeping them together
 * would mean the reference grammar and the canonical bytes could only be exercised by writing
 * files, and rules that are expensive to test are rules that get tested once and then trusted.
 *
 * THE SECURITY VERDICT IS PURE AND THE I/O IS NOT. `fileSecurityProblem` takes a stat and, on
 * Windows, the text `icacls` printed; it returns a reason or an empty string. That is what lets both
 * platforms' rules be tested on either platform, which matters because this repo's own measurement
 * showed the POSIX check is meaningless here: `chmod 000` left a file fully readable on this host,
 * and Node's chmod on Windows only toggles the read-only attribute.
 */

import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CREDENTIAL_DIR_NAME,
  CREDENTIAL_INSECURE,
  CREDENTIAL_INVALID,
  CREDENTIAL_MISSING,
  CREDENTIAL_OK,
  CREDENTIAL_UNREADABLE,
  MAX_CREDENTIAL_BYTES,
  credentialRefProblem,
  decodeCredential,
  encodeCredential,
} from "./credential-store.mjs";

// RE-EXPORTED so a caller can reach the whole vocabulary from either module, while `credential-
// store.mjs` remains the one place it is DECLARED. Two declarations would be two sets to keep in
// step, which is what the closed set exists to prevent.
export { CREDENTIAL_INSECURE, CREDENTIAL_UNREADABLE };
import { aclProblem, icaclsLockdownArgs, parseIcaclsAces } from "./windows-acl.mjs";

const execFileAsync = promisify(execFile);

export const ROOT_MODE = 0o700;
export const FILE_MODE = 0o600;

/** `~/.aify/credentials`, beside `services.json` rather than anywhere a caller chooses. */
export function credentialRoot(homeDir = os.homedir()) {
  return path.join(String(homeDir), ".aify", CREDENTIAL_DIR_NAME);
}

/**
 * The absolute path for one reference, or a reason it is refused.
 *
 * THE JOIN IS SAFE BECAUSE THE REFERENCE IS A BASENAME, checked before we get here. This still
 * resolves and re-checks containment afterwards, because `path.join` is not a security boundary and
 * a future caller may reach this with a value the grammar never saw.
 */
export function credentialPath(root, ref) {
  const problem = credentialRefProblem(ref);
  if (problem) return { path: "", problem };
  const base = path.resolve(String(root));
  const full = path.resolve(base, String(ref));
  const inside = full.startsWith(base + path.sep) && path.dirname(full) === base;
  if (!inside) {
    return { path: "", problem: "resolves outside the credential root" };
  }
  return { path: full, problem: "" };
}

/**
 * What is wrong with this file's custody, if anything.
 *
 * PURE, and it takes what the caller already gathered. `stats` must come from an `lstat` -- a `stat`
 * follows a symlink, so the very thing being checked for would be checked on the wrong file.
 */
export function fileSecurityProblem({
  platform = process.platform, stats = null, aclText = "", owner = "", uid = -1,
  aclPath = "",
} = {}) {
  if (!stats) return "no file information";
  if (stats.isSymbolicLink()) {
    // A symlink, junction or reparse point is a pointer to a file whose custody we did NOT check --
    // and following it is how a containment check that passed on the name reads a file elsewhere.
    return "is a link rather than a regular file";
  }
  if (!stats.isFile()) return "is not a regular file";
  if (stats.size > MAX_CREDENTIAL_BYTES) {
    return `is ${stats.size} bytes, over the ${MAX_CREDENTIAL_BYTES} limit`;
  }
  if (platform === "win32") {
    // `chmod` PROVES NOTHING HERE, measured on this host: a file set to 000 stayed fully readable,
    // and Node's chmod on Windows only toggles the read-only attribute. The DACL is the real answer.
    return aclProblem(parseIcaclsAces(aclText, { path: aclPath }), { owner });
  }
  // A hard link means a second name for these bytes, in a directory whose custody we did not check.
  if (typeof stats.nlink === "number" && stats.nlink > 1) {
    return `has ${stats.nlink} hard links, so the same bytes are reachable under another name`;
  }
  if (uid >= 0 && typeof stats.uid === "number" && stats.uid !== uid) {
    return `is owned by uid ${stats.uid}, not by this process`;
  }
  const mode = stats.mode & 0o777;
  if (mode & 0o077) {
    return `mode ${mode.toString(8).padStart(3, "0")} grants access beyond its owner`;
  }
  return "";
}

/** `icacls <path>`, or empty text when it cannot be run. Never receives or prints the key. */
async function readAcl(target, run = execFileAsync) {
  try {
    const { stdout } = await run("icacls", [target]);
    return String(stdout || "");
  } catch (failure) {
    // Its OWN output on failure, not a throw: an unreadable ACL must reach `aclProblem`, which
    // treats "no entries could be read" as a refusal rather than as an absence of problems.
    return String(failure?.stdout || "");
  }
}

async function lockDownWindows(target, owner, run = execFileAsync) {
  try {
    await run("icacls", icaclsLockdownArgs(target, owner));
    return "";
  } catch (failure) {
    return String(failure?.message || failure);
  }
}

/** The account this process runs as, for a Windows grant. */
export function currentWindowsOwner(env = process.env) {
  const user = String(env.USERNAME || "").trim();
  const domain = String(env.USERDOMAIN || "").trim();
  if (!user) return "";
  return domain ? `${domain}\\${user}` : user;
}

/**
 * Inspect one absolute path: custody first, then bytes. The single reader both callers share.
 *
 * THE STAGED TEMP FILE AND THE PUBLIC READ ASK THE SAME QUESTION, so they ask it through the same
 * function. Two separate checks would be two rule sets to keep in step, and the one that drifted
 * would be whichever is exercised less -- which is the staged one, on the path where being wrong
 * means shipping a readable secret.
 */
export async function inspectCredentialFile({
  target, platform = process.platform, owner = "", run = execFileAsync, uid = undefined,
} = {}) {
  let stats;
  try {
    // lstat, NOT stat: `stat` follows a link, so a check for links would run on the target.
    stats = await fsp.lstat(target);
  } catch (failure) {
    if (failure && failure.code === "ENOENT") {
      return {
        state: CREDENTIAL_MISSING, value: "", identity: "",
        detail: "does not exist",
      };
    }
    return {
      state: CREDENTIAL_UNREADABLE, value: "", identity: "",
      detail: String(failure?.code || failure?.message || failure),
    };
  }

  const aclText = platform === "win32" ? await readAcl(target, run) : "";
  const effectiveUid = uid !== undefined
    ? uid
    : (typeof process.getuid === "function" ? process.getuid() : -1);
  const insecure = fileSecurityProblem({
    platform, stats, aclText, aclPath: target,
    owner: owner || currentWindowsOwner(), uid: effectiveUid,
  });
  if (insecure) return { state: CREDENTIAL_INSECURE, value: "", detail: insecure, identity: "" };

  let bytes;
  try {
    bytes = await fsp.readFile(target);
  } catch (failure) {
    return {
      state: CREDENTIAL_UNREADABLE, value: "", identity: "",
      detail: String(failure?.code || failure?.message || failure),
    };
  }
  const decoded = decodeCredential(bytes);
  return {
    ...decoded,
    identity: `${stats.dev}:${stats.ino}:${stats.size}:${Number(stats.mtimeMs).toFixed(0)}`,
  };
}

/**
 * Create the root privately and PROVE it, before any secret exists on disk.
 *
 * THE FIRST VERSION COULD LEAVE THE KEY BROADLY READABLE WHILE REPORTING FAILURE. It ignored what
 * `icacls` returned, never read the root's own permissions back, and only checked custody AFTER the
 * rename -- so on Windows the sequence was: create a root that may still be inherited-wide, write
 * the secret into it, attempt a lockdown whose error was discarded, rename, and only then discover
 * the file was readable by a group. The command exited non-zero and the secret stayed on disk.
 *
 * So the order is inverted: the root is locked down and VERIFIED first, and nothing is written until
 * it passes. `mode 0600` is not evidence on Windows -- measured on this host, `chmod 000` left a
 * file fully readable -- so the proof has to be the DACL, read back.
 *
 * OWNER IDENTITY IS REQUIRED, not best-effort. Without a name to grant to there is nothing to lock
 * down TO, and proceeding would create the store with whatever the parent hands down.
 */
export async function ensureCredentialRoot(root, {
  platform = process.platform, owner = "", run = execFileAsync, uid = undefined,
  env = process.env,
} = {}) {
  // `env` is injectable so the no-owner branch can be DRIVEN. Without it a test on a host that has
  // a USERNAME can never reach the refusal, and the guard would be asserted only by reading it.
  const who = platform === "win32" ? (owner || currentWindowsOwner(env)) : "";
  if (platform === "win32" && !who) {
    return "cannot determine which account to grant the credential store to";
  }

  // THE ROOT ITSELF IS CHECKED BEFORE IT IS USED. A pre-existing symlink, junction or reparse point
  // at this path is followed by `mkdir -p` and by every write after it, which puts the whole store
  // wherever it points -- a directory whose custody nobody checked. lstat sees the link; stat would
  // see the target and report everything fine.
  let existing = null;
  try {
    existing = await fsp.lstat(root);
  } catch (failure) {
    if (!failure || failure.code !== "ENOENT") {
      return `cannot inspect the credential root: ${failure?.code || failure}`;
    }
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      return "the credential root is a link, so the store would live somewhere unverified";
    }
    if (!existing.isDirectory()) return "the credential root exists and is not a directory";
  }

  await fsp.mkdir(root, { recursive: true, mode: ROOT_MODE });

  if (platform === "win32") {
    const failed = await lockDownWindows(root, who, run);
    if (failed) return `could not restrict the credential root: ${failed}`;
    const problem = aclProblem(parseIcaclsAces(await readAcl(root, run), { path: root }), { owner: who });
    if (problem) return `the credential root is ${problem}`;
    return "";
  }

  // `mkdir` honours the umask, so the mode above is a ceiling rather than a setting.
  await fsp.chmod(root, ROOT_MODE);
  const after = await fsp.lstat(root);
  const effectiveUid = uid !== undefined
    ? uid
    : (typeof process.getuid === "function" ? process.getuid() : -1);
  if ((after.mode & 0o077) !== 0) {
    return `the credential root is mode ${(after.mode & 0o777).toString(8)}, not ${ROOT_MODE.toString(8)}`;
  }
  if (effectiveUid >= 0 && typeof after.uid === "number" && after.uid !== effectiveUid) {
    return `the credential root is owned by uid ${after.uid}, not by this process`;
  }
  return "";
}

/**
 * Write one credential, proving custody at every point where the secret could become visible.
 *
 * THE ORDER IS THE FIX. Root verified before anything is written; the temp file locked down and its
 * custody AND bytes verified while it is still a temp file; only then the rename. A failure at any
 * point deletes the temp and leaves the previous good credential exactly as it was -- a rotation
 * that fails must not also destroy the key that was working.
 */
export async function writeCredentialFile({
  root, ref, value, platform = process.platform, owner = "", run = execFileAsync, uid = undefined,
  env = process.env,
} = {}) {
  const resolved = credentialPath(root, ref);
  if (resolved.problem) return { ok: false, state: CREDENTIAL_INVALID, detail: resolved.problem };

  let bytes;
  try {
    bytes = encodeCredential(value);
  } catch (failure) {
    // The message names the PROBLEM, never the value.
    return { ok: false, state: CREDENTIAL_INVALID, detail: String(failure.message || failure) };
  }

  const rootProblem = await ensureCredentialRoot(root, { platform, owner, run, uid, env });
  if (rootProblem) {
    // NOTHING HAS BEEN WRITTEN YET, which is the point of checking here.
    return { ok: false, state: CREDENTIAL_INSECURE, detail: rootProblem };
  }

  const who = platform === "win32" ? (owner || currentWindowsOwner(env)) : "";
  const temp = `${resolved.path}.${process.pid}.${Date.now()}.tmp`;
  const abandon = async (state, detail) => {
    await fsp.rm(temp, { force: true }).catch(() => {});
    return { ok: false, state, detail };
  };

  try {
    const handle = await fsp.open(temp, "wx", FILE_MODE);
    try {
      await handle.writeFile(bytes, { encoding: "utf8" });
      // Flushed before the rename, or a crash can leave the new NAME pointing at empty bytes.
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (failure) {
    return abandon(CREDENTIAL_UNREADABLE, String(failure.message || failure));
  }

  // THE TEMP FILE IS SECURED AND PROVEN BEFORE IT BECOMES THE CREDENTIAL. On Windows it was created
  // with whatever the directory hands down, and `wx` with a mode argument buys nothing there.
  try {
    if (platform === "win32") {
      const failed = await lockDownWindows(temp, who, run);
      if (failed) return abandon(CREDENTIAL_INSECURE, `could not restrict the new file: ${failed}`);
    } else {
      await fsp.chmod(temp, FILE_MODE);
    }
  } catch (failure) {
    return abandon(CREDENTIAL_INSECURE, String(failure.message || failure));
  }

  const staged = await inspectCredentialFile({
    target: temp, platform, owner: who, run, uid,
  });
  if (staged.state !== CREDENTIAL_OK) {
    return abandon(staged.state, `the staged file ${staged.detail}`);
  }
  if (staged.value !== value) {
    // Never prints either value.
    return abandon(CREDENTIAL_INVALID, "the staged file holds different bytes than were written");
  }

  try {
    await fsp.rename(temp, resolved.path);
  } catch (failure) {
    return abandon(CREDENTIAL_UNREADABLE, String(failure.message || failure));
  }

  // One last read through the PUBLIC path, so what a reader will actually get is what was meant.
  const readBack = await readCredentialFile({ root, ref, platform, owner: who, run, uid });
  if (readBack.state !== CREDENTIAL_OK) {
    return { ok: false, state: readBack.state, detail: `readback failed: ${readBack.detail}` };
  }
  if (readBack.value !== value) {
    return {
      ok: false, state: CREDENTIAL_INVALID,
      detail: "readback returned different bytes than were written",
    };
  }
  return { ok: true, state: CREDENTIAL_OK, path: resolved.path, detail: "" };
}

/**
 * Read one credential by reference, with every fault typed and none collapsing into absence.
 *
 * `identity` comes back with a successful read so a caller can cache on CONTENT IDENTITY and
 * re-verify when it changes. Mtime alone is not enough -- an atomic replace can land inside the same
 * clock tick -- so it carries size and inode as well.
 */
export async function readCredentialFile({
  root, ref, platform = process.platform, owner = "", run = execFileAsync, uid = undefined,
} = {}) {
  const resolved = credentialPath(root, ref);
  if (resolved.problem) {
    return { state: CREDENTIAL_INVALID, value: "", detail: resolved.problem, identity: "" };
  }
  const answer = await inspectCredentialFile({ target: resolved.path, platform, owner, run, uid });
  if (answer.state === CREDENTIAL_MISSING) {
    return { ...answer, detail: "the registry names a credential file that does not exist" };
  }
  return answer;
}

/** Remove one credential. Used by uninstall, which checks the registry first. */
export async function removeCredentialFile({ root, ref } = {}) {
  const resolved = credentialPath(root, ref);
  if (resolved.problem) return { ok: false, detail: resolved.problem };
  try {
    await fsp.rm(resolved.path, { force: true });
    return { ok: true, detail: "" };
  } catch (failure) {
    return { ok: false, detail: String(failure?.message || failure) };
  }
}

/** Every credential file present in the store, for the orphan check the ruling asks the doctor for. */
export async function listCredentialFiles(root) {
  try {
    const names = await fsp.readdir(root);
    return names.filter((name) => credentialRefProblem(name) === "").sort();
  } catch {
    return [];
  }
}

