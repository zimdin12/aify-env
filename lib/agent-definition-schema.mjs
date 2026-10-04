// What an agent definition file may say, and its canonical bytes. PURE: no filesystem, no clock.
//
// THE CONTRACT IS P0 C1 and C3 (aify-comms docs/superpowers/plans/2026-09-30-aify-env-owns-the-agents-P0.md).
// aify-comms validates the same files in Python, and both suites run one shared fixture,
// tests/fixtures/agent-definitions/cases.json, so a rule here that the other side decides differently
// fails both. Every edge the two languages would split on (code points vs UTF-16 units, lone
// surrogates, what "control" means) is decided in P0 and carried by a fixture case.
//
// A PROBLEM IS A CODE, `<field>: <code>`, the same string in both languages, never prose: the snapshot
// digest covers an invalid entry's problems, and the service recomputes that digest.

import { createHash } from "node:crypto";

//: The agent id and role rule: a FULL-STRING match (no `m` flag, so `agent\n` is refused).
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
//: Windows device names, refused as the whole id or the part before its first dot, in any case.
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
//: The service's spawn-env rules exactly (aify-comms service/api_core/spawn_env.py).
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ENV_VARS = 32;
const MAX_ENV_VALUE_BYTES = 4096;
// The launch's and the launchers' namespaces. HARNESS_EXTRA_ENV's lines are exported by the launcher, so a
// definition could force a session id or an endpoint through it (external review of 0.8.4).
const RESERVED_ENV_PREFIXES = ["AIFY_", "HARNESS_"];

export const SCHEMA_VERSION = 1;
const HARNESSES = Object.freeze(["claude", "codex", "hermes"]);
const MODES = Object.freeze(["managed", "resident"]);
const MAX_NAME_CODE_POINTS = 128;
const MAX_INSTRUCTIONS_BYTES = 65536;
const MAX_APPLIED_REQUEST_CODE_POINTS = 128;
export const UNAVAILABLE_HARNESS = "harness-not-installed";
//: The largest value a counter may hold: JavaScript's safe integers, which Python reads exactly too.
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

//: The file's own fields. The store owns the second group: adoption assigns them from the ledger.
const FILE_FIELDS = new Set(["version", "agent", "appliedRequest"]);
const STORE_OWNED_FIELDS = new Set(["incarnation", "revision", "operation", "updatedAt"]);
const AGENT_FIELDS = Object.freeze([
  "id", "name", "role", "harness", "mode", "workspace", "model", "effort", "instructions", "env", "herdrSpace",
]);

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
//: The store's operation ids: what randomUUID() writes, and nothing else.
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
//: A number token the file may hold: a plain integer literal. Anything with a fraction or an exponent
//: is refused from the TEXT, because JSON.parse rounds 9007199254740990.5 to a safe integer and
//: reads 1.0 as 1, while Python reads 1.0 as a float: the parsed value cannot prove what was written.
const INTEGER_TOKEN = /^-?(0|[1-9][0-9]*)$/;
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;
const UPDATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const codePoints = (text) => [...text].length;
const utf8Bytes = (text) => Buffer.byteLength(text, "utf8");

/** A counter the store may hold: an integer in [1, MAX_COUNTER]. Never rounded, never wrapped. */
export function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/** Whether a value is a store operation id: a lower-case UUID, what randomUUID() writes. */
export const isOperationId = (value) => typeof value === "string" && OPERATION_ID.test(value);

/** The problems with an agent id (or role) on its own, [] when it is admitted. */
export function idProblems(id, field = "id") {
  if (typeof id !== "string") return [`${field}: type`];
  if (!id.isWellFormed()) return [`${field}: malformed-unicode`];
  if (!ID_PATTERN.test(id)) return [`${field}: pattern`];
  if (RESERVED_DEVICE_NAMES.has(id.split(".")[0].toUpperCase())) return [`${field}: reserved-name`];
  return [];
}

/** Problems with one string field: type, well-formedness, then the field's own rule. */
function textProblems(value, field, rule) {
  if (typeof value !== "string") return [`${field}: type`];
  if (!value.isWellFormed()) return [`${field}: malformed-unicode`];
  return rule(value);
}

const AGENT_RULES = {
  id: (value, fileId) => {
    const problems = idProblems(value, "agent.id");
    if (problems.length === 0 && value !== fileId) problems.push("agent.id: mismatch");
    return problems;
  },
  name: (value) => textProblems(value, "agent.name", (text) => [
    ...(codePoints(text) < 1 || codePoints(text) > MAX_NAME_CODE_POINTS ? ["agent.name: length"] : []),
    ...(CONTROL.test(text) ? ["agent.name: control"] : []),
  ]),
  role: (value) => idProblems(value, "agent.role"),
  harness: (value) => (HARNESSES.includes(value) ? [] : ["agent.harness: unsupported"]),
  mode: (value) => (MODES.includes(value) ? [] : ["agent.mode: unsupported"]),
  workspace: (value) => textProblems(value, "agent.workspace", (text) => (
    ABSOLUTE_PATH.test(text) ? [] : ["agent.workspace: not-absolute"]
  )),
  model: (value) => textProblems(value, "agent.model", () => []),
  effort: (value) => textProblems(value, "agent.effort", () => []),
  instructions: (value) => textProblems(value, "agent.instructions", (text) => (
    utf8Bytes(text) > MAX_INSTRUCTIONS_BYTES ? ["agent.instructions: too-large"] : []
  )),
  env: (value) => envProblems(value),
  herdrSpace: (value) => (typeof value === "boolean" ? [] : ["agent.herdrSpace: type"]),
};

function envProblems(env) {
  if (!isPlainObject(env)) return ["agent.env: type"];
  const names = Object.keys(env);
  const problems = names.length > MAX_ENV_VARS ? ["agent.env: too-many"] : [];
  for (const name of names) {
    if (!ENV_NAME_PATTERN.test(name)) { problems.push("agent.env: bad-name"); continue; }
    const field = `agent.env.${name}`;
    if (RESERVED_ENV_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix))) { problems.push(`${field}: reserved`); continue; }
    problems.push(...textProblems(env[name], field, (text) => [
      ...(text.includes("\u0000") ? [`${field}: nul`] : []),
      ...(utf8Bytes(text) > MAX_ENV_VALUE_BYTES ? [`${field}: too-large`] : []),
    ]));
  }
  return problems;
}

//: A key a problem may name. Anything else is reported without its name, so a problem is always ASCII:
//: a lone surrogate or an astral character in one would encode or sort differently in the two languages.
const NAMEABLE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** `<key>: unknown-field` (`agent.<key>` inside agent), or the parent's name when the key is not nameable. */
function unknownField(parent, key) {
  if (!NAMEABLE_KEY.test(key)) return `${parent}: unknown-field`;
  return parent === "agent" ? `agent.${key}: unknown-field` : `${key}: unknown-field`;
}

/**
 * Every problem with a number token in raw JSON text: a fraction or exponent, or an integer outside
 * the safe range. Checked on the text before anything reads the parsed values. `text` must parse.
 */
export function numberProblems(text) {
  const problems = new Set();
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c !== "-" && (c < "0" || c > "9")) continue;
    let end = i;
    while (end < text.length && /[-+0-9.eE]/.test(text[end])) end += 1;
    const token = text.slice(i, end);
    if (!INTEGER_TOKEN.test(token)) problems.add("file: non-integer-number");
    else if (!Number.isSafeInteger(Number(token))) problems.add("file: unsafe-integer");
    i = end - 1;
  }
  return [...problems];
}

/**
 * The problems with a definition file's TEXT, for a population (see `definitionProblems`): not JSON,
 * a number the text does not state exactly, or the parsed body's own problems. A number problem stops
 * there, because what the parsed body says is then language-dependent.
 */
function definitionTextProblems(text, fileId, options = {}) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return [...idProblems(fileId), "file: not-json"].sort();
  }
  const numbers = numberProblems(text);
  if (numbers.length) return [...idProblems(fileId), ...numbers].sort();
  return definitionProblems(body, fileId, options);
}

/**
 * The problems with a definition file's BYTES: they must be UTF-8 (strictly, as Python reads them:
 * Node's default decoder would turn a bad byte into U+FFFD and pass it), then the text's problems.
 * Returns the parsed body too when there are none.
 */
export function definitionBytesProblems(bytes, fileId, options = {}) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { problems: [...idProblems(fileId), "file: not-utf8"].sort(), body: null };
  }
  const problems = definitionTextProblems(text, fileId, options);
  return { problems, body: problems.length ? null : JSON.parse(text) };
}

//: The store's own fields: absent or anything in a candidate, required and exact once normalized.
const STORE_FIELD_RULES = {
  incarnation: (value) => (isCounter(value) ? [] : ["incarnation: not-a-counter"]),
  revision: (value) => (isCounter(value) ? [] : ["revision: not-a-counter"]),
  operation: (value) => (isOperationId(value) ? [] : ["operation: format"]),
  updatedAt: (value) => textProblems(value, "updatedAt", (text) => (UPDATED_AT.test(text) ? [] : ["updatedAt: format"])),
};

/**
 * Every problem with a parsed definition file whose name says it is `fileId`, sorted; [] when valid.
 *
 * TWO POPULATIONS. A `candidate` is what a person wrote, or a file waiting to be adopted: its
 * incarnation, revision and operation are untrusted and do not decide validity, because adoption
 * assigns them from the ledger (`updatedAt` is still checked when present). A `normalized` file is
 * what the store writes and publishes: all four are required and exact, since they are identity.
 */
export function definitionProblems(body, fileId, { population = "candidate" } = {}) {
  if (population !== "candidate" && population !== "normalized") throw new TypeError(`unknown population ${population}`);
  const problems = [...idProblems(fileId)];
  if (!isPlainObject(body)) return [...problems, "file: not-an-object"].sort();
  for (const key of Object.keys(body)) {
    if (!FILE_FIELDS.has(key) && !STORE_OWNED_FIELDS.has(key)) problems.push(unknownField("file", key));
  }
  if (body.version !== SCHEMA_VERSION) problems.push(body.version === undefined ? "version: missing" : "version: unsupported");
  for (const [field, rule] of Object.entries(STORE_FIELD_RULES)) {
    if (population === "normalized") problems.push(...(Object.hasOwn(body, field) ? rule(body[field]) : [`${field}: missing`]));
    else if (field === "updatedAt" && Object.hasOwn(body, field)) problems.push(...rule(body[field]));
  }
  if (Object.hasOwn(body, "appliedRequest")) {
    problems.push(...textProblems(body.appliedRequest, "appliedRequest", (text) => [
      ...(codePoints(text) < 1 || codePoints(text) > MAX_APPLIED_REQUEST_CODE_POINTS ? ["appliedRequest: length"] : []),
      ...(CONTROL.test(text) ? ["appliedRequest: control"] : []),
    ]));
  }
  const agent = body.agent;
  if (agent === undefined) problems.push("agent: missing");
  else if (!isPlainObject(agent)) problems.push("agent: type");
  else {
    for (const key of Object.keys(agent)) {
      if (!AGENT_FIELDS.includes(key)) problems.push(unknownField("agent", key));
    }
    for (const field of AGENT_FIELDS) {
      if (!Object.hasOwn(agent, field)) problems.push(`agent.${field}: missing`);
      else problems.push(...AGENT_RULES[field](agent[field], fileId));
    }
  }
  return problems.sort();
}

/**
 * Canonical JSON: object keys sorted at every depth, no whitespace. Strings are escaped exactly as
 * JSON.stringify escapes them, which is also what Python's json.dumps(ensure_ascii=False) writes.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    // A float or an unsafe integer would print differently in the two languages; nothing the
    // contract digests may hold one.
    throw new TypeError(`canonical JSON holds integers only, not ${value}`);
  }
  return JSON.stringify(value);
}

export const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** The sha-256 of the canonical JSON of a valid definition's `agent`. */
export const definitionDigest = (agent) => sha256Hex(canonicalJson(agent));

/**
 * The file the store writes, the same layout every time: the one formatting a hand edit is adopted
 * into. Sorted keys, two-space indent, a final newline.
 */
export function formatDefinitionFile(body) {
  return `${JSON.stringify(JSON.parse(canonicalJson(body)), null, 2)}\n`;
}
