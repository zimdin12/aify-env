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
  CREDENTIAL_INVALID,
  CREDENTIAL_MISSING,
  CREDENTIAL_OK,
  MAX_CREDENTIAL_BYTES,
  credentialRefProblem,
  decodeCredential,
  encodeCredential,
} from "./credential-store.mjs";
import { aclProblem, icaclsLockdownArgs, parseIcaclsAces } from "./windows-acl.mjs";

const execFileAsync = promisify(execFile);

/** A file this daemon could not read at all -- as distinct from one that is absent. */
export const CREDENTIAL_UNREADABLE = "CREDENTIAL_UNREADABLE";
/** A file whose permissions mean somebody else can read the key. Refused, never warned about. */
export const CREDENTIAL_INSECURE = "CREDENTIAL_INSECURE";

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
    return aclProblem(parseIcaclsAces(aclText), { owner });
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
 * Create the root privately, and verify it. Idempotent.
 *
 * CREATED PRIVATE RATHER THAN CREATED AND THEN TIGHTENED. A directory that exists world-readable for
 * even a moment is a window, and on a busy host the window is enough.
 */
export async function ensureCredentialRoot(root, {
  platform = process.platform, owner = "", run = execFileAsync,
} = {}) {
  await fsp.mkdir(root, { recursive: true, mode: ROOT_MODE });
  if (platform === "win32") {
    const who = owner || currentWindowsOwner();
    if (who) await lockDownWindows(root, who, run);
    return "";
  }
  // `mkdir` honours the process umask, so the mode above is a ceiling rather than a setting. An
  // explicit chmod is what actually makes it 0700 under a permissive umask.
  await fsp.chmod(root, ROOT_MODE);
  return "";
}

/**
 * Write one credential atomically, then READ IT BACK -- bytes and custody -- before reporting
 * success.
 *
 * THE READBACK IS THE POINT. Every step here can report success and leave the wrong thing on disk:
 * a rename onto a Windows device name, a chmod that toggled an attribute, an ACL command that
 * printed nothing and changed nothing. Comparing what came back against what was meant is the only
 * check that covers all of them at once.
 *
 * The temp file is created in the SAME directory so the replace is atomic -- a rename across
 * filesystems is a copy, which is neither atomic nor private -- and with the final mode from the
 * start, so the secret is never briefly world-readable.
 */
export async function writeCredentialFile({
  root, ref, value, platform = process.platform, owner = "", run = execFileAsync,
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

  await ensureCredentialRoot(root, { platform, owner, run });
  const temp = `${resolved.path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await fsp.open(temp, "wx", FILE_MODE);
    try {
      await handle.writeFile(bytes, { encoding: "utf8" });
      // Flushed before the rename, or a crash can leave the new NAME pointing at empty bytes.
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (platform !== "win32") await fsp.chmod(temp, FILE_MODE);
    else {
      const who = owner || currentWindowsOwner();
      if (who) await lockDownWindows(temp, who, run);
    }
    await fsp.rename(temp, resolved.path);
  } catch (failure) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    return { ok: false, state: CREDENTIAL_UNREADABLE, detail: String(failure.message || failure) };
  }

  const readBack = await readCredentialFile({ root, ref, platform, owner, run });
  if (readBack.state !== CREDENTIAL_OK) {
    return { ok: false, state: readBack.state, detail: `readback failed: ${readBack.detail}` };
  }
  if (readBack.value !== value) {
    // Never prints either value.
    return {
      ok: false, state: CREDENTIAL_INVALID,
      detail: "readback returned different bytes than were written",
    };
  }
  return { ok: true, state: CREDENTIAL_OK, path: resolved.path, detail: "" };
}

/**
 * Read one credential, with every fault typed and none of them collapsing into absence.
 *
 * `identity` comes back with a successful read so a caller can cache on CONTENT IDENTITY and
 * re-verify when it changes. Mtime alone is not enough -- an atomic replace can land inside the
 * same clock tick -- so it carries size and inode as well.
 */
export async function readCredentialFile({
  root, ref, platform = process.platform, owner = "", run = execFileAsync, uid = undefined,
} = {}) {
  const resolved = credentialPath(root, ref);
  if (resolved.problem) {
    return { state: CREDENTIAL_INVALID, value: "", detail: resolved.problem, identity: "" };
  }

  let stats;
  try {
    // lstat, NOT stat: `stat` follows a link, so a check for links would run on the target.
    stats = await fsp.lstat(resolved.path);
  } catch (failure) {
    if (failure && failure.code === "ENOENT") {
      return {
        state: CREDENTIAL_MISSING, value: "", identity: "",
        detail: "the registry names a credential file that does not exist",
      };
    }
    return {
      state: CREDENTIAL_UNREADABLE, value: "", identity: "",
      detail: String(failure?.code || failure?.message || failure),
    };
  }

  const aclText = platform === "win32" ? await readAcl(resolved.path, run) : "";
  const effectiveUid = uid !== undefined
    ? uid
    : (typeof process.getuid === "function" ? process.getuid() : -1);
  const insecure = fileSecurityProblem({
    platform, stats, aclText, owner: owner || currentWindowsOwner(), uid: effectiveUid,
  });
  if (insecure) {
    return { state: CREDENTIAL_INSECURE, value: "", detail: insecure, identity: "" };
  }

  let bytes;
  try {
    bytes = await fsp.readFile(resolved.path);
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

