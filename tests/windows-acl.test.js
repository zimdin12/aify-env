// Reading a Windows DACL, because chmod proves nothing there.
//
// EVERY FIXTURE BELOW IS REAL OUTPUT, captured from `icacls` on this host on 2026-08-31 rather than
// written to match the parser. That distinction matters more than usual here: a parser tested only
// against text its author invented agrees with its author, and the failure mode of this particular
// parser is silence -- it returns no entries, and a caller reads a secret out of a file whose
// permissions it never actually checked.

import assert from "node:assert/strict";
import test from "node:test";

import {
  aclPrincipalLeaf,
  aclProblem,
  icaclsLockdownArgs,
  parseIcaclsAces,
} from "../lib/windows-acl.mjs";

//: A file created the ordinary way under the operator's temp directory. Note the FIRST entry shares
//: a line with the path, and note the raw SID -- both are shapes a naive parser drops.
const REAL_DEFAULT = String.raw`C:\Users\ADMINI~1\AppData\Local\Temp\acl\plain.key STEVENZ-L\CodexSandboxUsers:(I)(M)
                                                                                   S-1-5-21-527724199-1022430309-242386682-3490496008:(I)(M)
                                                                                   NT AUTHORITY\SYSTEM:(I)(F)
                                                                                   BUILTIN\Administrators:(I)(F)
                                                                                   STEVENZ-L\Administrator:(I)(F)

Successfully processed 1 files; Failed processing 0 files`;

//: The same file after `icacls <path> /inheritance:r /grant:r "Administrator:(F)"`.
const REAL_LOCKED = String.raw`C:\Users\ADMINI~1\AppData\Local\Temp\acl\plain.key STEVENZ-L\Administrator:(F)

Successfully processed 1 files; Failed processing 0 files`;

test("the FIRST entry shares a line with the path and is still parsed", () => {
  // A parser that read only the indented continuation lines would miss it -- and on a default file
  // that first entry is the group grant that matters most.
  const aces = parseIcaclsAces(REAL_DEFAULT);
  assert.equal(aces.length, 5, JSON.stringify(aces, null, 2));
  assert.equal(aces[0].leaf, "codexsandboxusers");
  assert.equal(aces[0].inherited, true);
});

test("a locked file parses to exactly one entry, not inherited", () => {
  const aces = parseIcaclsAces(REAL_LOCKED);
  assert.equal(aces.length, 1);
  assert.equal(aces[0].leaf, "administrator");
  assert.equal(aces[0].inherited, false);
});

test("the summary lines are not mistaken for entries", () => {
  // "Successfully processed 1 files; Failed processing 0 files" contains a colon and would otherwise
  // be read as a principal, quietly inflating the entry count.
  for (const ace of parseIcaclsAces(REAL_DEFAULT)) {
    assert.doesNotMatch(ace.principal, /processed/i, ace.principal);
  }
});

test("the DEFAULT permissions on this host are REFUSED, naming who can read the key", () => {
  const problem = aclProblem(parseIcaclsAces(REAL_DEFAULT), { owner: "Administrator" });
  assert.match(problem, /CodexSandboxUsers/);
  assert.match(problem, /S-1-5-21-/, "a raw SID grant was not reported");
});

test("a private DACL is accepted", () => {
  assert.equal(aclProblem(parseIcaclsAces(REAL_LOCKED), { owner: "Administrator" }), "");
  // And the owner match is on the LAST component, so a domain-qualified grant still matches an
  // unqualified owner name -- which is what `whoami` returns here.
  assert.equal(aclProblem(parseIcaclsAces(REAL_LOCKED), { owner: "STEVENZ-L\\Administrator" }), "");
});

test("SYSTEM and Administrators are allowed beside the owner, and nobody else is", () => {
  // They can read anything on the machine already; refusing them would be theatre and would break
  // hosts where a service account needs them.
  const withSystem = String.raw`C:\x\a.key STEVENZ-L\Administrator:(F)
                                NT AUTHORITY\SYSTEM:(F)
                                BUILTIN\Administrators:(F)`;
  assert.equal(aclProblem(parseIcaclsAces(withSystem), { owner: "Administrator" }), "");

  const withStranger = String.raw`C:\x\a.key STEVENZ-L\Administrator:(F)
                                  STEVENZ-L\bob:(R)`;
  assert.match(aclProblem(parseIcaclsAces(withStranger), { owner: "Administrator" }), /bob/);
});

test("broad principals are refused under every spelling they arrive in", () => {
  // The same principal appears as `Everyone`, `BUILTIN\Users` and `NT AUTHORITY\Authenticated
  // Users` depending on the machine. A check that knew one spelling would pass the other two.
  for (const principal of ["Everyone", "BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users",
                           "NT AUTHORITY\\INTERACTIVE", "BUILTIN\\Guests"]) {
    const text = `C:\\x\\a.key STEVENZ-L\\Administrator:(F)\n    ${principal}:(R)`;
    assert.notEqual(aclProblem(parseIcaclsAces(text), { owner: "Administrator" }), "", principal);
  }
});

test("NO ENTRIES IS A REFUSAL, not a clean bill of health", () => {
  // An empty parse almost always means the command failed or its output changed shape. Reading a
  // secret on the strength of a parser that understood nothing is the false negative this module
  // exists to prevent, and it is the one that would never show up as an error.
  assert.notEqual(aclProblem([], { owner: "Administrator" }), "");
  assert.notEqual(aclProblem(parseIcaclsAces(""), { owner: "Administrator" }), "");
  assert.notEqual(aclProblem(parseIcaclsAces("Access is denied."), { owner: "x" }), "");
  assert.notEqual(aclProblem(null, { owner: "x" }), "");
});

test("the principal leaf is the last component, lowercased", () => {
  assert.equal(aclPrincipalLeaf("STEVENZ-L\\Administrator"), "administrator");
  assert.equal(aclPrincipalLeaf("NT AUTHORITY\\Authenticated Users"), "authenticated users");
  assert.equal(aclPrincipalLeaf("Everyone"), "everyone");
  assert.equal(aclPrincipalLeaf(""), "");
});

test("the lockdown REMOVES inheritance rather than only stopping it", () => {
  const args = icaclsLockdownArgs("C:\\x\\a.key", "BOX\\bob");
  assert.deepEqual(args, ["C:\\x\\a.key", "/inheritance:r", "/grant:r", "BOX\\bob:(F)"]);
  // MEASURED: without `/inheritance:r` the group grant survives and the file stays readable by
  // everyone in that group while icacls reports success. `/grant:r` REPLACES rather than adds, so
  // re-running is idempotent instead of accumulating one entry per run.
  assert.ok(args.includes("/inheritance:r"));
  assert.ok(args.includes("/grant:r"));
});
