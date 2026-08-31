// The credential store on disk. These write real files into a scratch directory, because the rules
// here are ABOUT the filesystem and a mocked one would prove the mock obeys them.
//
// THE CUSTODY VERDICT IS TESTED ON BOTH PLATFORMS FROM EITHER. `fileSecurityProblem` takes a stat
// and, on Windows, the text icacls printed, so the POSIX rules can be driven from Windows and the
// Windows rules from POSIX. Without that split, half of this file would be permanently skipped on
// whichever machine ran it -- and a skipped custody check is the one you find out about later.

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CREDENTIAL_INSECURE,
  CREDENTIAL_UNREADABLE,
  FILE_MODE,
  ROOT_MODE,
  credentialPath,
  credentialRoot,
  currentWindowsOwner,
  ensureCredentialRoot,
  fileSecurityProblem,
  listCredentialFiles,
  readCredentialFile,
  removeCredentialFile,
  writeCredentialFile,
} from "../lib/credential-fs.mjs";
import { CREDENTIAL_INVALID, CREDENTIAL_MISSING, CREDENTIAL_OK } from "../lib/credential-store.mjs";

const KEY = "s3cret-value-1234567890-abcdef";

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aify-cred-"));
}

/** A stat-alike, so the POSIX rules can be driven from a Windows host and vice versa. */
function statLike({ mode = 0o600, uid = 1000, nlink = 1, size = 32, link = false, file = true } = {}) {
  return {
    mode, uid, nlink, size,
    isSymbolicLink: () => link,
    isFile: () => file,
  };
}

test("the root is beside services.json, not anywhere a caller chooses", () => {
  assert.equal(credentialRoot("/home/x"), path.join("/home/x", ".aify", "credentials"));
});

test("a reference resolves inside the root, and a hostile one resolves nowhere", () => {
  const root = path.resolve("/tmp/store");
  assert.equal(credentialPath(root, "aify-comms.key").path,
               path.join(root, "aify-comms.key"));
  for (const hostile of ["../services.json", "a/b", "..", "/etc/passwd"]) {
    const answer = credentialPath(root, hostile);
    assert.equal(answer.path, "", `resolved ${JSON.stringify(hostile)}`);
    assert.notEqual(answer.problem, "");
  }
});

test("a written credential reads back exactly, and carries a content identity", async () => {
  const root = scratch();
  try {
    const written = await writeCredentialFile({ root, ref: "aify-comms.key", value: KEY });
    assert.ok(written.ok, written.detail);
    const read = await readCredentialFile({ root, ref: "aify-comms.key" });
    assert.equal(read.state, CREDENTIAL_OK, read.detail);
    assert.equal(read.value, KEY);
    // Mtime alone cannot invalidate a cache: an atomic replace can land inside one clock tick. The
    // identity carries size and inode too, so a same-tick replacement still looks different.
    assert.match(read.identity, /:\d+:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A FILE WITH ORDINARY PERMISSIONS IS REFUSED, not read with a warning", async () => {
  // MEASURED ON THIS HOST: a file written the normal way inherits a group grant
  // (`STEVENZ-L\\CodexSandboxUsers:(I)(M)`) plus a raw SID, both with Modify. Anyone in that group
  // holds the key. The custody ruling is explicit that this is a refusal.
  // THE ROOT IS DELIBERATELY NOT CREATED BY THE STORE HERE. Measured while writing this test: a root
  // the store created is already private, and a file written into it INHERITS that -- which is
  // exactly why the store creates its own root, and also why pre-locking it made this test pass for
  // the wrong reason on the first attempt. The hostile shape is a credential sitting in a directory
  // nobody locked down.
  const root = scratch();
  try {
    fs.writeFileSync(path.join(root, "loose.key"), `${KEY}\n`);
    if (process.platform === "win32") {
      const loose = await readCredentialFile({ root, ref: "loose.key" });
      assert.equal(loose.state, CREDENTIAL_INSECURE, loose.detail);
      assert.equal(loose.value, "", "an insecure file still handed back its key");
      assert.match(loose.detail, /readable by/);
    }
  } finally {
    // Its own root, and cleanup that tolerates Windows: locking a directory down can leave a file
    // created before the lockdown undeletable by this process, which is a teardown artifact rather
    // than anything about the store.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* the OS kept a file we no longer need */ }
  }

  // POSITIVE CONTROL, in a SEPARATE root so the lockdown above cannot decide its result: one
  // written THROUGH the store is accepted, so the refusal is about permissions rather than about
  // every file in the directory.
  const clean = scratch();
  try {
    await writeCredentialFile({ root: clean, ref: "tight.key", value: KEY });
    assert.equal((await readCredentialFile({ root: clean, ref: "tight.key" })).state, CREDENTIAL_OK);
  } finally {
    try {
      fs.rmSync(clean, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* as above */ }
  }
});

test("a missing file is MISSING, which is not the same answer as absent or unreadable", async () => {
  const root = scratch();
  try {
    const answer = await readCredentialFile({ root, ref: "nothing.key" });
    assert.equal(answer.state, CREDENTIAL_MISSING);
    assert.match(answer.detail, /does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a reference the grammar refuses never reaches the filesystem", async () => {
  const root = scratch();
  try {
    assert.equal((await readCredentialFile({ root, ref: "../escape" })).state, CREDENTIAL_INVALID);
    const write = await writeCredentialFile({ root, ref: "../escape", value: KEY });
    assert.equal(write.state, CREDENTIAL_INVALID);
    assert.equal(fs.existsSync(path.join(path.dirname(root), "escape")), false,
                 "a refused reference still wrote a file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a value that cannot be encoded is refused BEFORE anything is written", async () => {
  const root = scratch();
  try {
    const write = await writeCredentialFile({ root, ref: "x.key", value: "has\nnewline" });
    assert.equal(write.state, CREDENTIAL_INVALID);
    assert.equal(fs.existsSync(path.join(root, "x.key")), false);
    // And the refusal never names the value it refused.
    assert.ok(!write.detail.includes("has"), write.detail);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no temp file survives a write", async () => {
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "a.key", value: KEY });
    const leftovers = fs.readdirSync(root).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "an interrupted-looking temp file was left beside the secret");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the custody rules refuse a link, a non-file, an oversized file and a shared one", () => {
  // Driven through the pure verdict so these hold on every platform, including the ones where
  // creating a symlink needs privileges this process may not have.
  assert.match(fileSecurityProblem({ platform: "linux", stats: statLike({ link: true }) }), /link/);
  assert.match(fileSecurityProblem({ platform: "linux", stats: statLike({ file: false }) }),
               /not a regular file/);
  assert.match(fileSecurityProblem({ platform: "linux", stats: statLike({ size: 99999 }) }), /over the/);
  assert.match(fileSecurityProblem({ platform: "linux", stats: statLike({ nlink: 2 }) }), /hard links/);
  assert.equal(fileSecurityProblem({ platform: "linux", stats: statLike(), uid: 1000 }), "",
               "a private, owned, single-linked regular file was refused");
});

test("POSIX modes beyond the owner are refused, and 0600 is not", () => {
  // 0o700 is NOT in this list: the execute bit is odd on a key file but grants nothing to anyone
  // else, and this check is about who can read the secret. Asserting it should be refused was my
  // error, and the test said so before I did.
  for (const mode of [0o644, 0o640, 0o604, 0o666, 0o660, 0o606]) {
    const problem = fileSecurityProblem({ platform: "linux", stats: statLike({ mode }), uid: 1000 });
    assert.notEqual(problem, "", `mode ${mode.toString(8)} was accepted`);
  }
  assert.equal(fileSecurityProblem({ platform: "linux", stats: statLike({ mode: 0o600 }), uid: 1000 }), "");
});

test("a file owned by another uid is refused even when its mode is right", () => {
  const problem = fileSecurityProblem({
    platform: "linux", stats: statLike({ mode: 0o600, uid: 4242 }), uid: 1000,
  });
  assert.match(problem, /owned by uid 4242/);
});

test("on Windows the DACL decides, and an unreadable one is a refusal", () => {
  // Real output shapes, taken from this host rather than invented.
  const broad = String.raw`C:\x\a.key STEVENZ-L\CodexSandboxUsers:(I)(M)
                                     NT AUTHORITY\SYSTEM:(I)(F)
                                     STEVENZ-L\Administrator:(I)(F)`;
  const tight = String.raw`C:\x\a.key STEVENZ-L\Administrator:(F)`;
  const stats = statLike({ mode: 0o777, uid: 4242 });
  assert.match(
    fileSecurityProblem({ platform: "win32", stats, aclText: broad, owner: "Administrator" }),
    /CodexSandboxUsers/);
  assert.equal(
    fileSecurityProblem({ platform: "win32", stats, aclText: tight, owner: "Administrator" }), "",
    "a private DACL was refused");
  // NO ENTRIES IS NOT PRIVACY. An empty parse means the command failed or its output changed shape,
  // and reading a secret on the strength of a parser that understood nothing is the false negative
  // this whole check exists to avoid.
  assert.notEqual(
    fileSecurityProblem({ platform: "win32", stats, aclText: "", owner: "Administrator" }), "");
});

test("the POSIX mode check is NOT applied on Windows, where it proves nothing", () => {
  // Measured on this host: `chmod 000` left a file fully readable, and Node's chmod on Windows only
  // toggles the read-only attribute. A mode-based verdict there would be confident and wrong.
  const tight = String.raw`C:\x\a.key STEVENZ-L\Administrator:(F)`;
  assert.equal(fileSecurityProblem({
    platform: "win32", stats: statLike({ mode: 0o777 }), aclText: tight, owner: "Administrator",
  }), "");
});

test("the root is created private and the modes are the documented ones", async () => {
  const parent = scratch();
  const root = path.join(parent, "nested", "credentials");
  try {
    await ensureCredentialRoot(root);
    assert.ok(fs.existsSync(root));
    if (process.platform !== "win32") {
      assert.equal((await fsp.stat(root)).mode & 0o777, ROOT_MODE);
      await writeCredentialFile({ root, ref: "a.key", value: KEY });
      assert.equal((await fsp.stat(path.join(root, "a.key"))).mode & 0o777, FILE_MODE);
    }
    assert.equal(ROOT_MODE, 0o700);
    assert.equal(FILE_MODE, 0o600);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("listing shows only names the grammar accepts, so junk cannot be read as a credential", async () => {
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "b.key", value: KEY });
    await writeCredentialFile({ root, ref: "a.key", value: KEY });
    fs.writeFileSync(path.join(root, ".hidden"), "x\n");
    assert.deepEqual(await listCredentialFiles(root), ["a.key", "b.key"]);
    // A root that does not exist lists nothing rather than throwing: the orphan check runs on hosts
    // that have never written a credential.
    assert.deepEqual(await listCredentialFiles(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("removing a credential is exact, and removing an absent one is not an error", async () => {
  const root = scratch();
  try {
    await writeCredentialFile({ root, ref: "a.key", value: KEY });
    assert.ok((await removeCredentialFile({ root, ref: "a.key" })).ok);
    assert.equal(fs.existsSync(path.join(root, "a.key")), false);
    assert.ok((await removeCredentialFile({ root, ref: "a.key" })).ok, "a second remove errored");
    // A refused reference removes nothing rather than resolving somewhere.
    assert.equal((await removeCredentialFile({ root, ref: "../services.json" })).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the Windows owner is domain-qualified when the environment says so", () => {
  assert.equal(currentWindowsOwner({ USERNAME: "bob", USERDOMAIN: "BOX" }), "BOX\\bob");
  assert.equal(currentWindowsOwner({ USERNAME: "bob" }), "bob");
  assert.equal(currentWindowsOwner({}), "", "an unknown owner must not become an empty grant");
});

test("UNREADABLE and INSECURE are distinct states, and neither is absence", () => {
  assert.notEqual(CREDENTIAL_UNREADABLE, CREDENTIAL_INSECURE);
  for (const state of [CREDENTIAL_UNREADABLE, CREDENTIAL_INSECURE]) {
    assert.notEqual(state, CREDENTIAL_MISSING);
    assert.notEqual(state, CREDENTIAL_OK);
  }
});
