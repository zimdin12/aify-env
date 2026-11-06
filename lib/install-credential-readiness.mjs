// Installation readiness uses the runtime credential resolver; absence alone says nothing about service auth.
import path from 'node:path';
import { credentialForTarget } from './credential-resolve.mjs';
import { CREDENTIAL_ABSENT, CREDENTIAL_FAULTS, CREDENTIAL_INVALID, CREDENTIAL_OK } from './credential-store.mjs';
import { serviceIdentity } from './services.mjs';

const verdict = (ready, kind, reason, state = '', source = '') => ({ ready, kind, reason, state, source });
const unknown = () => verdict(false, 'unknown', 'credential readiness is unknown; the declared authentication requirement could not be established');

export class InstallCredentialReadiness {
  #env; #root; #registration; #resolve;
  constructor({ env, root, registration, resolve = credentialForTarget }) {
    if (!env || typeof env !== 'object' || Array.isArray(env) || typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new TypeError('credential readiness needs an explicit environment and absolute credential root');
    }
    this.#env = env; this.#root = root; this.#registration = registration; this.#resolve = resolve;
  }

  async inspect(target, { expectedValue, requirePublishedRef = false } = {}) {
    if (!serviceIdentity(target).admitted) return unknown();
    if (target.credentialRef != null && typeof target.credentialRef !== 'string') {
      return verdict(false, 'fault', `${CREDENTIAL_INVALID}: the configured credential reference is not usable`, CREDENTIAL_INVALID);
    }
    if (requirePublishedRef && (typeof target.credentialRef !== 'string' || !target.credentialRef)) return unknown();
    let answer;
    try { answer = await this.#resolve(target, { env: this.#env, root: this.#root }); }
    catch { return unknown(); }
    if (answer?.state === CREDENTIAL_OK) {
      if (typeof answer.value !== 'string' || answer.value === '') return unknown();
      if (expectedValue !== undefined && answer.value !== expectedValue) return unknown();
      return verdict(true, 'credential', 'a usable credential is configured', answer.state, answer.source);
    }
    if (answer?.state !== CREDENTIAL_ABSENT) {
      return CREDENTIAL_FAULTS.includes(answer?.state)
        ? verdict(false, 'fault', `${answer.state}: the configured credential is not usable; inspect its credential status`, answer.state)
        : unknown();
    }
    if (expectedValue !== undefined || requirePublishedRef) return unknown();
    try {
      const spec = await this.#registration.readSpec(target);
      const secret = spec.secrets.find(row => row.field === 'credentialRef');
      if (secret?.required === false) return verdict(true, 'keyless', 'the service spec declares its credential optional', CREDENTIAL_ABSENT);
      const probe = secret?.probe && spec.verify?.probes?.[secret.probe];
      if (!probe) return unknown();
      const status = await this.#registration.probeWithoutCredential(target, probe);
      if (!Number.isInteger(status)) return unknown();
      if (status >= 200 && status < 300) return verdict(true, 'keyless', 'the declared API probe accepts a request without a credential', CREDENTIAL_ABSENT);
      if (status === 401 || status === 403) return verdict(false, 'required', 'a required service credential is missing', CREDENTIAL_ABSENT);
      return unknown();
    } catch { return unknown(); }
  }
}
