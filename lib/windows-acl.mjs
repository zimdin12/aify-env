/**
 * Reading a Windows DACL, because `chmod` proves nothing there.
 *
 * MEASURED ON THIS HOST, 2026-08-31, not assumed. A file created normally under the operator's temp
 * directory came back from `icacls` as:
 *
 *     <path> STEVENZ-L\CodexSandboxUsers:(I)(M)
 *            S-1-5-21-...-3490496008:(I)(M)
 *            NT AUTHORITY\SYSTEM:(I)(F)
 *            BUILTIN\Administrators:(I)(F)
 *            STEVENZ-L\Administrator:(I)(F)
 *
 * -- a GROUP with Modify, inherited. That is exactly the broad access a credential file must not
 * have, and `fs.chmod(0o600)` does not remove it: Node's chmod on Windows only toggles the read-only
 * attribute. The same host also demonstrated the other half of that: `chmod 000` left the file fully
 * readable. So a POSIX mode check is not evidence here and this parser exists to get a real one.
 *
 * After `icacls <path> /inheritance:r /grant:r "<user>:(F)"` the same file reported one ACE and no
 * `(I)` flag, which is the shape this module accepts.
 *
 * PURE. The parsing and the judgement take text and return a verdict; running `icacls` is the
 * caller's job. That is what lets both platforms' rules be tested on either platform.
 */

//: Principals that mean "more than one person". A credential file granting any of these is readable
//: by somebody the operator did not choose, whether or not the grant was inherited.
//:
//: MATCHED ON THE LAST COMPONENT, case-insensitively, because the same principal appears as
//: `Everyone`, `BUILTIN\Users` and `NT AUTHORITY\Authenticated Users` depending on the machine --
//: and a check that only knew one spelling would pass the other two.
const BROAD_PRINCIPALS = new Set([
  "everyone",
  "users",
  "authenticated users",
  "interactive",
  "network",
  "batch",
  "service",
  "terminal server user",
  "remote desktop users",
  "guests",
  "guest",
]);

//: Allowed beside the owner. SYSTEM and the local Administrators group can read anything on the
//: machine already -- refusing them would be theatre, and would make the store unusable on hosts
//: where a service account needs them.
//: OWNER PLUS SYSTEM, and nothing else by default.
//:
//: The first version also blessed `Administrators` and `TrustedInstaller` on the reasoning that they
//: can read anything on the machine anyway, so refusing them would be theatre. The reviewer's ruling
//: says owner plus SYSTEM if required, and they are right that the two are different claims: whether
//: a principal COULD escalate to read the file is not the same question as whether the file is
//: currently granted to more accounts than its owner. A machine where the Administrators group has
//: several members is one where "readable by an administrator" means readable by several people, and
//: that is a decision for the operator to make rather than one for this check to assume.
//:
//: SYSTEM stays because a service account genuinely needs it on hosts where the daemon runs as one.
const ALWAYS_ALLOWED = new Set(["system"]);

/** The last component of `DOMAIN\Name`, lowercased. `Everyone` has no domain and survives as-is. */
export function aclPrincipalLeaf(principal) {
  const text = String(principal ?? "").trim();
  const cut = text.lastIndexOf("\\");
  return (cut === -1 ? text : text.slice(cut + 1)).trim().toLowerCase();
}

/**
 * Every access-control entry in `icacls` output.
 *
 * The FIRST line carries the path and then the first entry; continuation lines are indented and
 * carry one entry each. A parser that read only the indented lines would miss the first ACE
 * entirely -- which on a default-permission file is the group grant that matters most.
 */
export function parseIcaclsAces(text, { path = "" } = {}) {
  const out = [];
  const target = String(path ?? "");
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^Successfully processed|^Failed processing/i.test(line)) continue;
    // THE PATH IS REMOVED BY NAME, not guessed at. The first line is `<path> <principal>:(flags)`
    // with no unambiguous delimiter between them: a Windows path contains backslashes, so a
    // domain-qualified principal cannot be found by "the last backslash", and a path may contain
    // spaces, so it cannot be found by "the last space" either.
    //
    // MEASURED, and it is why this argument exists: with an UNQUALIFIED principal -- which icacls
    // does emit, `Everyone` being the obvious one -- the last backslash falls inside the PATH and
    // the whole line parsed as a single principal named after the directory. The verdict then read
    // "readable by <the path>", which is not a person and would never match an owner. The caller
    // always knows the path it asked about, so the ambiguity is removed rather than resolved.
    if (target && line.startsWith(target)) line = line.slice(target.length).trim();
    // A principal is followed by `:(` and one or more parenthesised flag groups. Anchoring on that
    // shape is what lets a path -- which contains colons on Windows -- sit on the same line.
    const match = line.match(/([^:]+):((?:\([^)]*\))+)\s*$/);
    if (!match) continue;
    let principal = match[1].trim();
    const flags = match[2];
    if (!target) {
      // BEST EFFORT WITHOUT THE PATH, which is right for a continuation line (it carries no path)
      // and wrong for a first line with an unqualified principal. Callers pass the path.
      const domainCut = principal.lastIndexOf("\\");
      const before = domainCut === -1 ? principal : principal.slice(0, domainCut);
      const space = before.lastIndexOf(" ");
      if (space !== -1) principal = principal.slice(space + 1).trim();
    }
    if (!principal) continue;
    out.push({
      principal,
      leaf: aclPrincipalLeaf(principal),
      flags,
      inherited: flags.includes("(I)"),
    });
  }
  return out;
}

/**
 * What is wrong with this DACL, if anything. Empty string means nothing is.
 *
 * REFUSED, NOT WARNED ABOUT. A credential file whose permissions are wrong is not a credential file
 * that happens to be untidy: anyone who can read it holds the key. The custody ruling is explicit
 * that a wrong ACL is a refusal, and warn-and-read would leave the secret in use while reporting a
 * problem nobody acts on.
 */
export function aclProblem(aces, { owner = "" } = {}) {
  const entries = Array.isArray(aces) ? aces : [];
  if (entries.length === 0) {
    // NOT "no grants, therefore private". An empty parse is far more likely to mean the output
    // changed shape or the command failed, and reading a secret on the strength of a parser that
    // understood nothing is exactly the false-negative this module exists to avoid.
    return "no access-control entries could be read, so the permissions are unknown";
  }
  const ownerLeaf = aclPrincipalLeaf(owner);
  const offenders = [];
  for (const ace of entries) {
    const leaf = String(ace?.leaf ?? aclPrincipalLeaf(ace?.principal));
    if (leaf && leaf === ownerLeaf) continue;
    if (ALWAYS_ALLOWED.has(leaf)) continue;
    if (BROAD_PRINCIPALS.has(leaf)) {
      offenders.push(`${ace.principal} (a group)`);
      continue;
    }
    // A principal that is neither the owner, nor a machine-wide authority, nor a name we recognise
    // as broad. It is still somebody else, and a raw SID is the commonest way one arrives.
    offenders.push(String(ace.principal));
  }
  if (offenders.length) {
    return `readable by ${offenders.join(", ")}`;
  }
  return "";
}

/** The `icacls` arguments that make a path private to one account. */
export function icaclsLockdownArgs(path, owner) {
  // `/inheritance:r` REMOVES inherited entries rather than merely stopping further inheritance --
  // measured: without it the group grant above survives, and the file stays readable by everyone in
  // that group while `icacls` reports success. `/grant:r` replaces rather than adds, so re-running
  // this is idempotent instead of accumulating an entry per run.
  //
  // AND IT REMOVES `BUILTIN\Administrators`, which the plain lockdown does NOT. Measured on this
  // host: a file created inside a root whose inheritance was already removed gets the creating
  // token's DEFAULT DACL -- owner, SYSTEM, AND Administrators -- and those entries are EXPLICIT, so
  // `/inheritance:r` leaves them alone and `/grant:r owner` only replaces the owner's own entry. The
  // result looked locked down and still granted a group. Without this the store would have written
  // files its own custody check then refused, which is how the strict rule was found in the first
  // place. One `/remove:g` leaves exactly owner and SYSTEM, verified by reading the DACL back.
  return [
    String(path), "/inheritance:r", "/grant:r", `${String(owner)}:(F)`,
    "/remove:g", "BUILTIN\\Administrators",
  ];
}
