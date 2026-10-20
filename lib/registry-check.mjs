// `aify-env registry check`: whether a candidate services.json holds anything aify-env would misread.
//
// THE FIELDS ARE THE ONES aify-env READS, AND ONLY THOSE. aify-wrapper's `parseRegistry` validates what it renders
// launchers from, and it drops what it does not normalise -- among them `secretsCredentialRef` and `advertise`, which
// this tier reads (guided-install S1). So a writer needs both answers before it publishes: the wrapper's parser, and
// this. Each field set is DERIVED from this tier's own readers, never listed here:
//   - a stored credential is any field `isCredentialRefField` matches, on the entry or in one of its option objects
//     (`agentState.credentialRef` is read by the sender), checked by the store's own grammar;
//   - two services whose references case-fold together would share one file, so that is refused across services;
//   - `advertise` and `advertisement` mean what `advertisingChoice` says, and a value it ignores is refused here
//     rather than reported later on /health.
//
// ⛔ ABSENT IS NOT A PROBLEM. A service that stores no credential, or leaves an optional one out (the dashboard's
// `secretsCredentialRef`, S1 format freeze item 2), is a working state. Only what an entry SAYS is checked.
//
// PURE. Whether each referenced file is in the store is the caller's question (`bin/aify-env-registry.mjs`), so every
// rule here is tested by calling a function.

import { advertisingChoice } from "./advertise.mjs";
import { credentialRefProblem, isCredentialRefField } from "./credential-store.mjs";
import { SUPPORTED_REGISTRY_VERSION, readServices } from "./services.mjs";

/** The shape of this command's answer, so a caller can refuse an answer it does not know how to read. */
export const REGISTRY_CHECK_VERSION = 1;

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every credential reference an entry names: `{field, ref}`, `ref` as written, whatever its type. PURE. */
function referencesOf(entry) {
  const found = [];
  for (const [field, value] of Object.entries(entry)) {
    if (isCredentialRefField(field)) found.push({ field, ref: value });
    else if (isPlainObject(value)) {
      for (const [inner, ref] of Object.entries(value)) {
        if (isCredentialRefField(inner)) found.push({ field: `${field}.${inner}`, ref });
      }
    }
  }
  return found;
}

/**
 * What is wrong with a candidate registry, as aify-env reads it.
 *
 * @param {string} text  the candidate file's text
 * @returns {{references: Array<{service: string, field: string, ref: string}>,
 *            problems: Array<{code: string, service: string|null, field: string|null, detail: string}>}}
 *   `references` holds every reference that passed the grammar: the set whose files the caller checks.
 */
export function registryCandidateProblems(text) {
  const problems = [];
  const references = [];
  let parsed;
  try { parsed = JSON.parse(String(text ?? "")); } catch { parsed = undefined; }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.services)) {
    problems.push({ code: "unreadable", service: null, field: null, detail: "not a JSON object with a services object" });
    return { references, problems };
  }
  if (Object.hasOwn(parsed, "version") && parsed.version !== SUPPORTED_REGISTRY_VERSION) {
    problems.push({ code: "version", service: null, field: "version",
      detail: `this aify-env reads registry version ${SUPPORTED_REGISTRY_VERSION}` });
    return { references, problems };
  }

  const owners = new Map(); //: folded reference -> the first service that named it
  for (const [service, entry] of Object.entries(parsed.services)) {
    if (!isPlainObject(entry)) continue;
    for (const { field, ref } of referencesOf(entry)) {
      const bad = typeof ref === "string" ? credentialRefProblem(ref) : "not a string";
      if (bad) {
        problems.push({ code: "credential-ref-invalid", service, field, detail: bad });
        continue;
      }
      // ONE FILE PER SERVICE, case-folded as the store resolves it: on Windows `Foo.key` and `foo.key` are one file.
      // Two fields of ONE service may name one file (agentState's key is usually the entry's own).
      const folded = ref.toLowerCase();
      const owner = owners.get(folded);
      if (owner !== undefined && owner !== service) {
        problems.push({ code: "credential-ref-collision", service, field,
          detail: `'${ref}' is also ${owner}'s credential file, so the two services would share one key` });
        continue;
      }
      owners.set(folded, service);
      references.push({ service, field, ref });
    }
  }

  for (const entry of readServices(String(text))) {
    for (const detail of advertisingChoice([entry]).ignored) {
      problems.push({ code: "advertising-ignored", service: entry.name, field: null, detail });
    }
  }
  return { references, problems };
}
