// Strict ending for a currently owned child. Recovered PID consumers use the separate verified legacy adapter.
import { isSelfProtected } from './kill-tree.mjs';
import { heldKill } from './held-process-tree.mjs';
import { endPosixGroup, PosixProcessGroup } from './posix-process-group.mjs';

/** Resolve only on confirmed cleanup; reject even when a best-effort own-handle kill was possible. */
export async function endOwnedChildTree(pid, { platform = process.platform, held = heldKill, stillOurs = null,
  own = null, group = null, timeoutMs } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || isSelfProtected(pid)) throw new Error('protected or invalid owned process id');
  if (own !== null && own.pid !== pid) throw new Error('the child handle does not own this process id');
  if (platform === 'win32') {
    if (typeof stillOurs === 'function') return Promise.resolve().then(() => held(pid, { stillOurs }));
    if (own !== null) own.kill('SIGKILL');
    throw new Error(own === null
      ? 'nothing could tell whether the pid was still the client\'s, so nothing was killed by it'
      : 'only the client itself was killed, through its own handle: nothing could tell whether its pid was still its own, so its tree was not walked');
  }
  if (!(group instanceof PosixProcessGroup) || group.pid !== pid) throw new Error('a matching owned POSIX group is required');
  try { await endPosixGroup(group, { timeoutMs, force: true }); }
  catch (error) {
    // An own child handle cannot be a later numeric-PID lookup. Its best effort never certifies the group.
    try { own?.kill('SIGKILL'); } catch { /* Preserve the group failure. */ }
    throw error;
  }
}
