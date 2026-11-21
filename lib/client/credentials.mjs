// No destination discovery, network IO, caches or import-time reads. The adapter binds the request base.
import path from 'node:path';
import { CREDENTIAL_INVALID, CREDENTIAL_OK, credentialRefProblem as storedRefProblem,
  resolveCredential, selectEnvironmentCredential } from '../credential-store.mjs';
import { credentialRoot, readCredentialFile, readCredentialFileSync } from '../credential-fs.mjs';

export { decodeCredential } from '../credential-store.mjs';

export function credentialRefProblem(ref) {
  return typeof ref === 'string' ? storedRefProblem(ref) : 'the credential reference is not a string';
}

const refused = (state, detail) => ({ state, value: '', source: '', detail });

function serviceBase(value) {
  // The actual HTTP adapter must pass its base, not an absolute route that could drop the prefix.
  if (typeof value !== 'string' || /[?#\\\u0000- \u007f]/.test(value)) return null;
  const authority = /^https?:\/\/([^/]+)/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || !url.hostname) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

/** Exact canonical origin and base path. Loopback rewriting, if any, belongs to the actual transport. */
export function sameServiceEndpoint(a, b) {
  const bound = serviceBase(a);
  return bound !== null && bound === serviceBase(b);
}

/** Authorization is a separate guard from precedence. A fault or no-ref entry never authorizes disk IO. */
function prepare(entry, options) {
  const { url, env, home, mode } = options ?? {};
  if (!sameServiceEndpoint(entry?.endpoint, url)) {
    return { result: refused('endpoint-refused', 'the request base does not match an authorized service base') };
  }
  if (mode !== 'explicit-first' && mode !== 'reconcile') {
    return { result: refused(CREDENTIAL_INVALID, 'credential precedence must be explicit') };
  }
  const names = entry.keyEnv === undefined ? [] : entry.keyEnv;
  if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && name.length > 0)) {
    return { result: refused(CREDENTIAL_INVALID, 'invalid credential environment names') };
  }
  const selected = selectEnvironmentCredential(names, env);
  if (selected.state === CREDENTIAL_INVALID || (mode === 'explicit-first' && selected.state === CREDENTIAL_OK)
      || entry.credentialRef === undefined || entry.credentialRef === null || entry.credentialRef === '') {
    return { result: selected };
  }
  return { envValue: selected.value, ref: entry.credentialRef, home };
}

function localReadTarget(ref, home) {
  if (typeof ref !== 'string') return { result: refused(CREDENTIAL_INVALID, 'the credential reference is not a string') };
  const problem = credentialRefProblem(ref);
  if (problem) return { result: refused(CREDENTIAL_INVALID, problem) };
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    return { result: refused(CREDENTIAL_INVALID, 'the credential home must be absolute') };
  }
  return { file: { root: credentialRoot(home), ref } };
}

function select({ envValue }, file) {
  return file.state === CREDENTIAL_OK ? resolveCredential({ envValue, fileValue: file.value })
    : refused(file.state, file.detail);
}

export async function resolveServiceKey(entry, options) {
  const admission = prepare(entry, options);
  if (admission.result) return admission.result;
  const target = localReadTarget(admission.ref, admission.home);
  return target.result ?? select(admission, await readCredentialFile(target.file));
}

export function resolveServiceKeySync(entry, options) {
  const admission = prepare(entry, options);
  return admission.result ?? select(admission, readStoredCredentialSync(admission.ref, { home: admission.home }));
}

/** Checked local configuration read. Not a credential authorization for a network request. */
export function readStoredCredentialSync(ref, { home } = {}) {
  const target = localReadTarget(ref, home);
  if (target.result) {
    const { state, value, detail } = target.result;
    return { state, value, detail };
  }
  const { state, value, detail } = readCredentialFileSync(target.file);
  return { state, value, detail };
}
