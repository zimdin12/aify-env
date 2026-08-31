/**
 * Where a service's credential lives and what a valid one looks like. PURE: no filesystem here.
 *
 * WHY A FILE AT ALL. The daemon's advertisement credential came only from its own process
 * environment, and nothing on the host puts it there -- the aify-comms bridge does not start this
 * daemon. So enabling `API_KEY` on that service made every advertisement 401, `advertising` stayed
 * false, the bridge correctly kept describing the host, and the whole chain was silent. The registry
 * cannot carry the value: it is a shared file readable by everything on the host, and it declares
 * WHERE a key lives, never what it is. A confined store beside it is the answer, and the registry
 * gains only a value-free REFERENCE into it.
 *
 * THE REFERENCE IS A BASENAME, NOT A PATH, and that is the whole containment argument. A path in a
 * shared file readable and writable by other tooling is an instruction this daemon would follow;
 * a single token that this daemon resolves under a root IT chooses cannot leave that root, whatever
 * the registry says. So traversal is not defended against after the fact -- it is unrepresentable.
 *
 * The filesystem half (root creation, ACLs, symlink and case checks, atomic write and readback)
 * lives in `credential-fs.mjs`. Splitting them is not tidiness: every rule here can be tested by
 * calling a function, and a rule that can only be tested by writing a file is one that gets tested
 * once and then trusted.
 */

import { createHash } from "node:crypto";

/** The directory under `~/.aify` that holds one file per service. */
export const CREDENTIAL_DIR_NAME = "credentials";

/** Bytes. A key is a token; anything larger is a mistake or an attack, and both should stop here. */
export const MAX_CREDENTIAL_BYTES = 4096;

/**
 * The typed outcomes, all distinct from ABSENT.
 *
 * ABSENT -- no reference and no environment key -- is a VALID configuration: a service that needs no
 * credential. Every state below is a fault, and collapsing any of them into absence is the exact
 * defect this whole carrier exists to end: a failure that reads as "nothing to do".
 */
export const CREDENTIAL_OK = "ok";
export const CREDENTIAL_ABSENT = "absent";
export const CREDENTIAL_MISSING = "CREDENTIAL_MISSING";
export const CREDENTIAL_INVALID = "CREDENTIAL_INVALID";
export const CREDENTIAL_CONFLICT = "CREDENTIAL_CONFLICT";
/** A file this daemon could not read at all -- distinct from one that is absent. */
export const CREDENTIAL_UNREADABLE = "CREDENTIAL_UNREADABLE";
/** A file whose custody means somebody else can read the key. Refused, never warned about. */
export const CREDENTIAL_INSECURE = "CREDENTIAL_INSECURE";

/**
 * Every fault state, closed here.
 *
 * ALL FIVE LIVE IN ONE PLACE EVEN THOUGH TWO ARE PRODUCED ELSEWHERE. The first cut left
 * `UNREADABLE` and `INSECURE` out because `credential-fs.mjs` is what observes them, and the export
 * gate agreed by flagging two constants no test named. That conflated two different questions:
 * WHO OWNS THE VOCABULARY and WHO PRODUCES EACH WORD. A set that calls itself every fault state and
 * is missing two is wrong however good the reason, and a caller checking membership would have got
 * a false answer for exactly the two states that mean "somebody else can read this key".
 *
 * The producers stay where they can observe the condition; the fs tests prove they are reached.
 */
export const CREDENTIAL_FAULTS = Object.freeze([
  CREDENTIAL_MISSING, CREDENTIAL_INVALID, CREDENTIAL_CONFLICT,
  CREDENTIAL_UNREADABLE, CREDENTIAL_INSECURE,
]);

//: One path segment, and deliberately narrower than "a legal filename". No separators, no drive
//: letters, no percent-encoding to decode later. `.` and `..` match this character class and are
//: refused explicitly below -- a charset test alone would accept both, which is the classic way a
//: containment check passes while resolving to the parent directory.
const REF_PATTERN = /^[A-Za-z0-9._-]+$/;

//: A reference is also a FILENAME on Windows, where these names are devices whatever the extension.
//: Writing to `CON` or `PRN` does not create a file; it talks to a device, and the read-back check
//: would then compare against something that was never stored.
const WINDOWS_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Is this a reference this daemon will resolve?
 *
 * Returns a reason rather than a boolean, because "the registry names a credential I refuse to
 * resolve" has to reach an operator as something more useful than a missing key.
 */
export function credentialRefProblem(ref) {
  const text = String(ref ?? "");
  if (text === "") return "empty";
  if (text.length > 64) return "too long";
  if (!REF_PATTERN.test(text)) {
    return "must be one name of letters, digits, dot, dash or underscore -- no path separators";
  }
  // A charset test accepts both of these, and both resolve outside the file they name.
  if (text === "." || text === "..") return "must name a file, not a directory";
  // A LEADING dot is not traversal, but it hides the file from an operator listing the store while
  // wondering what holds their secrets. The store should be inspectable at a glance.
  if (text.startsWith(".")) return "must not start with a dot";
  const stem = text.split(".")[0].toLowerCase();
  if (WINDOWS_DEVICE_NAMES.has(stem)) return `'${stem}' is a reserved device name on Windows`;
  return "";
}

export function credentialRefIsValid(ref) {
  return credentialRefProblem(ref) === "";
}

/**
 * The reference a service gets when nobody chooses one.
 *
 * IT CARRIES A DIGEST OF THE FULL SERVICE NAME, and the first version did not. That one replaced
 * refused characters with `-` and truncated, so `a/b` and `a-b` both became `a-b.key` -- two
 * services sharing one credential file, each overwriting the other's key. Its test comment claimed
 * the replacement PREVENTED collapse and demonstrated the opposite; the reviewer caught both. Any
 * two names sharing their first 32 usable characters collided the same way.
 *
 * The digest is over the exact service identity, so distinct services cannot collide however their
 * readable prefixes are mangled or truncated. The prefix is kept only so an operator listing the
 * store can still tell which file belongs to what.
 *
 * NOT A SECRET, and not required to be: the reference is public by design -- it is what the registry
 * carries. The digest is here for uniqueness, not for hiding the service name.
 */
export function defaultCredentialRef(serviceName) {
  const identity = String(serviceName ?? "").trim();
  if (identity === "") return "";
  const prefix = identity
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 32)
    .toLowerCase();
  const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 12);
  // The prefix may be empty (a name made entirely of refused characters); the digest alone is still
  // a valid, unique reference, which is why it is not optional.
  const candidate = prefix ? `${prefix}-${digest}.key` : `svc-${digest}.key`;
  return credentialRefIsValid(candidate) ? candidate : "";
}

/**
 * Would these two references land on the same file?
 *
 * CASE-FOLDED, because the filesystems this runs on disagree about whether they are the same name.
 * On Windows and on macOS's default volume `Foo.key` and `foo.key` are ONE file, so a registry that
 * accepted both would have two services silently sharing a credential -- and the host where it was
 * tested might be the one where they are two.
 */
export function credentialRefsCollide(left, right) {
  const a = String(left ?? "").trim().toLowerCase();
  const b = String(right ?? "").trim().toLowerCase();
  return a !== "" && a === b;
}

/**
 * The canonical bytes for a credential file: the key, then exactly one newline.
 *
 * ONE TRAILING NEWLINE, so the file is a well-formed text line an operator can `cat` without their
 * prompt landing mid-line, and so the reader has exactly one thing to remove. Any other whitespace
 * is REJECTED rather than trimmed: a broad `.strip()` would silently accept a key that had picked up
 * a stray CR from a Windows editor and hand a DIFFERENT value to the service than the file holds --
 * which is the same class of invisible mismatch as reading `.env` with the wrong precedence.
 */
export function encodeCredential(value) {
  const problem = credentialValueProblem(value);
  if (problem) throw new Error(`refusing to store an invalid credential: ${problem}`);
  return `${String(value)}\n`;
}

/**
 * What is wrong with this credential VALUE, if anything. Empty string means nothing.
 *
 * Deliberately strict about control characters. A key travels as an HTTP header value, and a CR or
 * LF inside one is header injection; a NUL truncates in some readers and not others, which is how
 * two components come to disagree about what the key even is.
 */
export function credentialValueProblem(value) {
  if (typeof value !== "string") return "not a string";
  if (value === "") return "empty";
  if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES) {
    return `larger than ${MAX_CREDENTIAL_BYTES} bytes`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return "contains a control character";
  if (value.trim() !== value) return "has leading or trailing whitespace";
  return "";
}

/**
 * The key out of a credential file's bytes, or a typed fault.
 *
 * Returns `{state, value, detail}` rather than throwing, because every caller has to REPORT the
 * distinction and a thrown error tempts a caller into one catch that flattens all of them back into
 * "no credential" -- the failure this carrier exists to make impossible.
 *
 * EXACTLY ONE TERMINAL NEWLINE is removed. A file with two, or with a CRLF, or with an interior
 * line break, is INVALID rather than salvaged: this daemon and the service that issued the key must
 * agree byte for byte, and "we both guessed the same way" is not agreement.
 */
export function decodeCredential(bytes) {
  if (bytes === null || bytes === undefined) {
    return { state: CREDENTIAL_MISSING, value: "", detail: "no bytes" };
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  if (buffer.byteLength > MAX_CREDENTIAL_BYTES) {
    return {
      state: CREDENTIAL_INVALID, value: "",
      detail: `file is ${buffer.byteLength} bytes, over the ${MAX_CREDENTIAL_BYTES} limit`,
    };
  }
  let text;
  try {
    // STRICT UTF-8. Node's default decoder substitutes U+FFFD for invalid bytes, which would turn a
    // corrupt file into a plausible-looking key that matches nothing.
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { state: CREDENTIAL_INVALID, value: "", detail: "not valid UTF-8" };
  }
  if (!text.endsWith("\n")) {
    return { state: CREDENTIAL_INVALID, value: "", detail: "does not end with a newline" };
  }
  const value = text.slice(0, -1);
  const problem = credentialValueProblem(value);
  if (problem) return { state: CREDENTIAL_INVALID, value: "", detail: problem };
  return { state: CREDENTIAL_OK, value, detail: "" };
}

/**
 * Which key wins when the environment and the store both name one.
 *
 * `keyEnv` stays a MANUAL-LAUNCH OVERRIDE: an operator who exports a key is making a choice, and a
 * file must not silently overrule it. But two DIFFERENT non-empty values is not a preference
 * question -- it is the shape where clients hold one key and the service runs on another, and every
 * call 401s with both halves looking correctly configured. It is refused, exactly as the aify-comms
 * installer refuses a shell/.env disagreement.
 *
 * PURE, and it takes the already-decoded file value rather than reading anything.
 */
export function resolveCredential({ envValue = "", fileValue = "" } = {}) {
  const fromEnv = String(envValue ?? "");
  const fromFile = String(fileValue ?? "");
  if (fromEnv && fromFile && fromEnv !== fromFile) {
    return {
      state: CREDENTIAL_CONFLICT, value: "", source: "",
      detail: "the environment and the credential file name different keys, so neither is used",
    };
  }
  if (fromEnv) return { state: CREDENTIAL_OK, value: fromEnv, source: "env", detail: "" };
  if (fromFile) return { state: CREDENTIAL_OK, value: fromFile, source: "file", detail: "" };
  return { state: CREDENTIAL_ABSENT, value: "", source: "", detail: "no credential configured" };
}
