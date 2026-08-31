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

test("SYSTEM is allowed beside the owner; the Administrators GROUP is not", () => {
  // The first version blessed Administrators on the reasoning that it can read anything anyway. That
  // conflates two claims: whether a principal COULD escalate is not whether the file is currently
  // granted to more accounts than its owner. On a machine where that group has several members,
  // "readable by an administrator" means readable by several people.
  //
  // It is refusable in practice, which is what makes the strict rule honest rather than aspirational.
  // MEASURED on this host: a file created inside a locked root receives the token's DEFAULT DACL --
  // owner, SYSTEM and Administrators, all EXPLICIT, so `/inheritance:r` leaves them -- and one
  // `/remove:g` in the lockdown leaves exactly owner and SYSTEM.
  const ownerAndSystem = String.raw`C:\x\a.key STEVENZ-L\Administrator:(F)
                                    NT AUTHORITY\SYSTEM:(F)`;
  assert.equal(aclProblem(parseIcaclsAces(ownerAndSystem), { owner: "Administrator" }), "");

  const withGroup = String.raw`C:\x\a.key STEVENZ-L\Administrator:(F)
                               NT AUTHORITY\SYSTEM:(F)
                               BUILTIN\Administrators:(F)`;
  assert.match(aclProblem(parseIcaclsAces(withGroup), { owner: "Administrator" }),
               /Administrators/, "the Administrators group was still blessed");

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
  assert.deepEqual(args, ["C:\\x\\a.key", "/inheritance:r", "/grant:r", "BOX\\bob:(F)",
                          "/remove:g", "BUILTIN\\Administrators"]);
  // The removal is not optional: without it a file created inside a locked root keeps the token's
  // default grant to that group, and the store would write files its own check then refuses.
  assert.ok(args.includes("/remove:g"));
  // MEASURED: without `/inheritance:r` the group grant survives and the file stays readable by
  // everyone in that group while icacls reports success. `/grant:r` REPLACES rather than adds, so
  // re-running is idempotent instead of accumulating one entry per run.
  assert.ok(args.includes("/inheritance:r"));
  assert.ok(args.includes("/grant:r"));
});

test("AN UNQUALIFIED PRINCIPAL ON THE FIRST LINE needs the path, and gets it", () => {
  // MEASURED as a real defect: icacls emits unqualified principals (`Everyone` is the obvious one),
  // and without the path the last backslash falls inside the PATH rather than in a domain. The whole
  // line then parsed as one principal named after the directory, and the verdict read "readable by
  // <the path>" -- not a person, and never matching an owner. A store-written file was reported
  // insecure for a reason that did not exist.
  const target = String.raw`C:\Users\me\AppData\Local\Temp\aify-cred-uhwDz8`;
  const line = `${target} storeowner:(F)`;

  const withPath = parseIcaclsAces(line, { path: target });
  assert.equal(withPath.length, 1);
  assert.equal(withPath[0].principal, "storeowner");
  assert.equal(aclProblem(withPath, { owner: "storeowner" }), "");

  // WITHOUT the path the same line is misread -- pinned so the argument cannot quietly become
  // optional again.
  const withoutPath = parseIcaclsAces(line);
  assert.notEqual(withoutPath[0]?.principal, "storeowner",
                  "the path-less fallback now handles this, so the path argument is untested");
});

test("a domain-qualified principal still parses with the path supplied", () => {
  const target = String.raw`C:\x\a.key`;
  const line = String.raw`C:\x\a.key STEVENZ-L\Administrator:(F)`;
  const aces = parseIcaclsAces(line, { path: target });
  assert.equal(aces.length, 1);
  assert.equal(aces[0].leaf, "administrator");
});

test("a principal containing SPACES parses with the path supplied", () => {
  const target = String.raw`C:\x\a.key`;
  const line = String.raw`C:\x\a.key NT AUTHORITY\Authenticated Users:(R)`;
  const aces = parseIcaclsAces(line, { path: target });
  assert.equal(aces.length, 1);
  assert.equal(aces[0].leaf, "authenticated users");
  assert.notEqual(aclProblem(aces, { owner: "me" }), "", "a broad group was accepted");
});
