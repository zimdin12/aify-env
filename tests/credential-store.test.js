// Where a credential lives and what a valid one looks like. Pure: every rule here is a function
// call, which is the point of splitting it from the filesystem half -- a rule that can only be
// tested by writing a file gets tested once and then trusted.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_ABSENT,
  CREDENTIAL_CONFLICT,
  CREDENTIAL_DIR_NAME,
  CREDENTIAL_FAULTS,
  CREDENTIAL_INVALID,
  CREDENTIAL_MISSING,
  CREDENTIAL_OK,
  MAX_CREDENTIAL_BYTES,
  credentialRefIsValid,
  credentialRefProblem,
  credentialOrphans,
  credentialRefsCollide,
  credentialValueProblem,
  decodeCredential,
  defaultCredentialRef,
  encodeCredential,
  resolveCredential,
} from "../lib/credential-store.mjs";

test("a reference is ONE NAME, so traversal is unrepresentable rather than defended against", () => {
  assert.equal(credentialRefProblem("aify-comms.key"), "");
  assert.ok(credentialRefIsValid("ok_1.key"));
  for (const hostile of ["../services.json", "a/b", "a\\b", "/etc/passwd", "C:\\x", "a\0b"]) {
    assert.notEqual(credentialRefProblem(hostile), "", `accepted ${JSON.stringify(hostile)}`);
  }
});

test("`.` and `..` match the character class and are refused ANYWAY", () => {
  // The classic way a containment check passes while resolving to the parent directory: both of
  // these are made only of characters the grammar allows, so a charset test alone accepts them.
  assert.match(credentialRefProblem("."), /not a directory/);
  assert.match(credentialRefProblem(".."), /not a directory/);
  // POSITIVE CONTROL: a name that merely CONTAINS dots is fine, so the rule is about these two
  // names and not about the character.
  assert.equal(credentialRefProblem("a.b.key"), "");
});

test("Windows device names are refused whatever their extension", () => {
  // Writing to `CON` does not create a file, it talks to a device -- so the readback check would
  // compare against something that was never stored, and report success.
  for (const name of ["CON", "con.key", "PRN.key", "aux", "COM1.key", "lpt9.key"]) {
    assert.match(credentialRefProblem(name), /reserved device name/, name);
  }
  assert.equal(credentialRefProblem("console.key"), "", "a name merely STARTING with con is fine");
});

test("a hidden or oversized reference is refused", () => {
  assert.match(credentialRefProblem(".hidden"), /must not start with a dot/);
  assert.match(credentialRefProblem("x".repeat(65)), /too long/);
  assert.match(credentialRefProblem(""), /empty/);
});

test("the default reference makes an accidental collision vanishingly unlikely", () => {
  // NOT "cannot collide", which is what this said. Twelve hex characters is 48 bits -- a bounded
  // improbability, not a guarantee, and certifying uniqueness from a truncated hash is the kind of
  // claim that gets believed and never rechecked. What PREVENTS a collision is the registry closure
  // and the store refusing a colliding write; this only stops two names mangling into one.
  // The first version replaced refused characters with `-` and truncated, so `a/b` and `a-b` both
  // became `a-b.key`: two services sharing one credential file, each overwriting the other's key.
  // Its comment claimed the replacement PREVENTED collapse and demonstrated the opposite.
  assert.notEqual(defaultCredentialRef("a/b"), defaultCredentialRef("a-b"));
  // And any two names sharing their usable prefix collided the same way.
  const long = "x".repeat(40);
  assert.notEqual(defaultCredentialRef(`${long}one`), defaultCredentialRef(`${long}two`));
  // Case differences are different identities here, and the registry closure refuses the pair
  // separately -- see `credentialRefsCollide`.
  assert.notEqual(defaultCredentialRef("Svc"), defaultCredentialRef("svc"));
});

test("the default reference stays readable and stays valid", () => {
  // The prefix is kept only so an operator listing the store can tell which file is whose; the
  // digest is what makes it unique.
  const ref = defaultCredentialRef("aify-comms");
  assert.match(ref, /^aify-comms-[0-9a-f]{12}\.key$/);
  assert.equal(credentialRefProblem(ref), "");
  // A name made ENTIRELY of refused characters still yields a valid, unique reference rather than
  // an empty or dot-leading one.
  const odd = defaultCredentialRef("...");
  assert.match(odd, /^svc-[0-9a-f]{12}\.key$/);
  assert.equal(credentialRefProblem(odd), "");
  // Nothing at all is still nothing: an unnamed service has no default.
  assert.equal(defaultCredentialRef(""), "");
  assert.equal(defaultCredentialRef("   "), "");
});

test("two references that differ only in case are treated as one file", () => {
  // On Windows and on macOS's default volume they ARE one file, so a registry accepting both would
  // have two services silently sharing a credential -- and the host it was tested on might be the
  // one where they are two.
  assert.equal(credentialRefsCollide("Foo.key", "foo.key"), true);
  assert.equal(credentialRefsCollide("a.key", "b.key"), false);
  assert.equal(credentialRefsCollide("", ""), false, "nothing must not collide with nothing");
});

test("the canonical file is the key and exactly one newline", () => {
  assert.equal(encodeCredential("abc123"), "abc123\n");
  assert.throws(() => encodeCredential("has\nnewline"), /control character/);
  assert.throws(() => encodeCredential(""), /empty/);
});

test("decode removes ONE terminal newline and salvages nothing else", () => {
  assert.deepEqual(decodeCredential(Buffer.from("abc123\n")), {
    state: CREDENTIAL_OK, value: "abc123", detail: "",
  });
  // Every one of these is a file this daemon and the issuing service would read differently if
  // either guessed. "We both guessed the same way" is not agreement.
  const rejected = {
    "no trailing newline": "abc123",
    "two newlines": "abc123\n\n",
    "CRLF": "abc123\r\n",
    "interior newline": "ab\ncd\n",
    "empty value": "\n",
    "surrounding spaces": "  abc  \n",
  };
  for (const [why, text] of Object.entries(rejected)) {
    assert.equal(decodeCredential(Buffer.from(text)).state, CREDENTIAL_INVALID, why);
  }
});

test("decode rejects invalid UTF-8 rather than substituting replacement characters", () => {
  // Node's default decoder turns bad bytes into U+FFFD, which would make a corrupt file look like a
  // plausible key that matches nothing -- a 401 with no visible cause on either side.
  assert.equal(decodeCredential(Buffer.from([0xff, 0xfe, 0x0a])).state, CREDENTIAL_INVALID);
});

test("decode bounds the file size", () => {
  assert.equal(decodeCredential(Buffer.alloc(MAX_CREDENTIAL_BYTES + 1, 97)).state, CREDENTIAL_INVALID);
  // POSITIVE CONTROL at the boundary: a file AT the limit still decodes, so the bound is a limit
  // rather than a rejection of everything large.
  const atLimit = Buffer.concat([Buffer.alloc(MAX_CREDENTIAL_BYTES - 1, 97), Buffer.from("\n")]);
  assert.equal(decodeCredential(atLimit).state, CREDENTIAL_OK);
});

test("absent bytes are MISSING, which is not the same answer as invalid", () => {
  assert.equal(decodeCredential(null).state, CREDENTIAL_MISSING);
  assert.equal(decodeCredential(undefined).state, CREDENTIAL_MISSING);
});

test("the environment overrides the file, but a DISAGREEMENT is refused", () => {
  // `keyEnv` stays a manual-launch override: an operator exporting a key is making a choice.
  assert.deepEqual(resolveCredential({ envValue: "k", fileValue: "" }),
                   { state: CREDENTIAL_OK, value: "k", source: "env", detail: "" });
  assert.equal(resolveCredential({ envValue: "", fileValue: "k" }).source, "file");
  assert.equal(resolveCredential({ envValue: "k", fileValue: "k" }).state, CREDENTIAL_OK);

  // Two DIFFERENT non-empty values is the shape where clients hold one key and the service runs on
  // another, and every call 401s with both halves looking correctly configured. Neither is used.
  const conflict = resolveCredential({ envValue: "a", fileValue: "b" });
  assert.equal(conflict.state, CREDENTIAL_CONFLICT);
  assert.equal(conflict.value, "", "a conflict still handed back a key to present");
});

test("no credential anywhere is ABSENT, a valid configuration and not a fault", () => {
  const answer = resolveCredential({ envValue: "", fileValue: "" });
  assert.equal(answer.state, CREDENTIAL_ABSENT);
  assert.ok(!CREDENTIAL_FAULTS.includes(answer.state),
            "absent was classed as a fault, which would make every keyless service look broken");
});

test("every fault state is distinct from ABSENT and from each other", () => {
  // The whole carrier exists because a failure that reads as "nothing to do" is invisible. A
  // duplicate or an absent-valued fault would put one back.
  assert.equal(new Set(CREDENTIAL_FAULTS).size, CREDENTIAL_FAULTS.length);
  assert.ok(!CREDENTIAL_FAULTS.includes(CREDENTIAL_ABSENT));
  assert.ok(!CREDENTIAL_FAULTS.includes(CREDENTIAL_OK));
  // Three of the five declared states are produced HERE. `CREDENTIAL_UNREADABLE` and
  // `CREDENTIAL_INSECURE` are answers about a file and arrive with `credential-fs.mjs`,
  // which is the code that can observe them.
  assert.ok(CREDENTIAL_FAULTS.length >= 3, CREDENTIAL_FAULTS);
});

test("a value with a control character or surrounding whitespace is never stored", () => {
  assert.match(credentialValueProblem("a\rb"), /control character/);
  assert.match(credentialValueProblem(" a"), /whitespace/);
  assert.match(credentialValueProblem("a "), /whitespace/);
  assert.equal(credentialValueProblem("a-Z_0.9~+/="), "", "a realistic key was refused");
});

test("the store directory name is fixed, so two readers cannot look in different places", () => {
  assert.equal(CREDENTIAL_DIR_NAME, "credentials");
});

test("an orphan is a secret nothing references; a dangling ref is a service that will fail", () => {
  // TWO PROBLEMS, TWO OWNERS. An orphan sits on disk and will never be presented -- left by a removed
  // service or a rotation that changed the reference. A dangling reference is the urgent half:
  // something IS pointed at a file that is not there, so that service cannot advertise.
  const answer = credentialOrphans({
    storeNames: ["a.key", "stale.key"],
    registryRefs: ["a.key", "gone.key"],
  });
  assert.deepEqual(answer.orphans, ["stale.key"]);
  assert.deepEqual(answer.dangling, ["gone.key"]);
});

test("matching is CASE-FOLDED, so a live key is never reported as unreferenced", () => {
  // On a case-insensitive volume `Foo.key` and `foo.key` are ONE file. Reporting the file as an
  // orphan because the registry spelled it differently would invite somebody to delete a live key.
  const answer = credentialOrphans({ storeNames: ["Foo.key"], registryRefs: ["foo.key"] });
  assert.deepEqual(answer.orphans, []);
  assert.deepEqual(answer.dangling, []);
});

test("an empty store and an empty registry agree without complaint", () => {
  const answer = credentialOrphans({ storeNames: [], registryRefs: [] });
  assert.deepEqual(answer.orphans, []);
  assert.deepEqual(answer.dangling, []);
  // Blank references are not references: a service with no credential must not read as dangling.
  assert.deepEqual(credentialOrphans({ storeNames: [], registryRefs: ["", "  "] }).dangling, []);
});
