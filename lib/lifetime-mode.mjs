// Managed registration owns a Runner handle. Resident adoption owns a launcher and a pinned identity.
import { linuxStartTokenFrom } from './linux-process-token.mjs';

/** The resident's comparable identity, never a Linux token relabeled as an epoch timestamp. */
export function residentIdentityPin(witness) {
  if (Object.hasOwn(witness ?? {}, 'startToken')) return linuxStartTokenFrom(witness.startToken, witness.pid);
  return Number.isSafeInteger(witness?.createdAtUs) && witness.createdAtUs > 0 ? witness.createdAtUs : null;
}

/** Both or neither are ambiguous; never choose an adapter from the next-start definition. */
export function lifetimeMode(witness) {
  const managed = typeof witness?.handle === 'string' && witness.handle.trim() !== '';
  const resident = typeof witness?.launcher === 'string' && witness.launcher.trim() !== ''
    && residentIdentityPin(witness) !== null;
  return managed === resident ? null : managed ? 'managed' : 'resident';
}
