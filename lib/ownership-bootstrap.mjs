// Capture this live owner's own identity once; wire persistence/recovery without exposing PID-capture backfill.
import { ProcessIdentityProbe } from './process-identity.mjs';
import { observedBirth } from './process-birth.mjs';
import { OwnedProcessRecord } from './owned-process-record.mjs';
import { RecoveredProcessTermination } from './recovered-process-termination.mjs';
import { SuccessorRecovery } from './successor-recovery.mjs';

export async function createOwnershipRecovery({ file, platform = process.platform, identity = new ProcessIdentityProbe(),
  report = line => process.stderr.write(line), selfPid = process.pid, parentPid = process.ppid, recover = true } = {}) {
  let answer;
  try { answer = (await identity.probe([selfPid])).get(selfPid); } catch { /* A missed owning capture stays unknown. */ }
  const ownerIdentity = observedBirth(selfPid, answer, platform);
  if (!ownerIdentity) {
    try { report('[aify-env] this owner birth could not be captured; its records will not gain a live superseded-owner exception\n'); } catch { /* Nonfatal diagnostic. */ }
  }
  const record = new OwnedProcessRecord(file, { ownerPid: selfPid, ownerIdentity, report });
  const termination = new RecoveredProcessTermination({ identity, platform, selfPid, parentPid });
  const recovery = new SuccessorRecovery({ record, identity, termination, platform, report, selfPid, parentPid, enabled: recover });
  return { record, recovery, ownerIdentity };
}
