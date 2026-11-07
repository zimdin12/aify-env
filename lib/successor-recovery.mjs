// Event/request-driven recovery. The listener is not proof that the old writer can no longer change the record.
import { isDeepStrictEqual } from 'node:util';
import { isSelfProtected } from './kill-tree.mjs';
import { observedBirth, originalBirthState } from './process-birth.mjs';
import { planOrphanReap, ownerReapState, defaultVerify } from './orphan-reap.mjs';
import { RecoveryPending } from './start-admission-refusal.mjs';

const contains = (rows, entry) => rows.some(row => isDeepStrictEqual(row, entry));
const union = (...populations) => populations.flat().filter((row, index, all) => !contains(all.slice(0, index), row));
const confirmsScope = (entry, outcome, platform) => outcome?.state === 'gone' && (platform === 'win32'
  ? outcome.scope === 'reachable-held-tree'
  : platform === 'linux' && outcome.scope === 'recorded-posix-group'
    && entry.groupScope?.kind === 'posix-process-group' && entry.groupScope.pgid === entry.pid);

export class SuccessorRecovery {
  #record; #identity; #termination; #platform; #report; #self; #parent;
  #displaced = null; #snapshot = []; #confirmedGone = []; #unresolved = [];
  #started = false; #ready = false; #ownerGone = false; #running = null; #problem = 'startup recovery has not completed';
  constructor({ record, identity, termination, platform = process.platform,
    report = line => process.stderr.write(line), selfPid = process.pid, parentPid = process.ppid, enabled = true } = {}) {
    if (typeof enabled !== 'boolean') throw new TypeError('recovery policy must be explicit');
    if (!enabled) { this.#ready = true; this.#problem = ''; }
    this.#record = record; this.#identity = identity; this.#termination = termination; this.#platform = platform;
    this.#report = report; this.#self = selfPid; this.#parent = parentPid;
  }
  #say(message) { try { this.#report(`[aify-env] ${message}\n`); } catch { /* Diagnostics cannot become a daemon crash. */ } }
  #held(reason) {
    this.#problem = reason;
    this.#say(`${reason}. No new managed/raw starts admitted. The operator can inspect the incumbent in its owning terminal, finish its work and stop it there, then retry their ordinary launch/start request. Never kill an unverified numeric PID.`);
  }
  async #probe(pids, groups = false) {
    try { return await this.#identity.probe(pids, { groups }); }
    catch { return new Map(); }
  }
  status() {
    return { ready: this.#ready, state: this.#ready ? 'ready' : 'held', problem: this.#problem,
      displacedPid: this.#displaced?.pid ?? null, unresolvedRecords: this.#unresolved.length };
  }

  /** Called only after shape identification/work-loss refusal. The incumbent need not publish any birth field. */
  async supersede(holder) {
    const pid = holder?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1 || isSelfProtected(pid, this.#self, this.#parent)) {
      this.#held('takeover refused: protected or invalid incumbent PID');
      throw new RecoveryPending(this.#problem);
    }
    const answer = (await this.#probe([pid])).get(pid);
    const birth = observedBirth(pid, answer, this.#platform);
    if (!birth) {
      this.#held(`takeover refused: original identity of incumbent pid ${pid} could not be captured`);
      throw new RecoveryPending(this.#problem);
    }
    this.#displaced = birth;
    // Capture before the first effect: a legacy predecessor may clear the shared record as it retires.
    this.#snapshot = union(this.#snapshot, this.#record.load().entries);
    let outcome;
    try { outcome = await this.#termination.incumbent(birth); }
    catch (error) { outcome = { state: 'unknown', problem: error?.message || String(error) }; }
    if (outcome?.state !== 'gone') this.#held(outcome?.problem || 'incumbent cleanup was not confirmed');
    return { birth, outcome };
  }

  /** Reached once after binding, and on an explicit later start request if the original owner remained uncertain. */
  recover() {
    if (this.#ready) return Promise.resolve({ ready: true, retained: this.#unresolved });
    if (this.#running) return this.#running;
    this.#started = true;
    const attempt = this.#perform();
    this.#running = attempt;
    attempt.then(() => { this.#running = null; }, () => { this.#running = null; });
    return attempt;
  }
  async admitStart() {
    if (this.#ready) return;
    if (this.#started) await this.recover();
    if (!this.#ready) throw new RecoveryPending(this.#problem);
  }

  async #perform() {
    const loaded = this.#record.load();
    if (loaded.status === 'unreadable') this.#say(`owned process record is unreadable (${loaded.problem}); original bytes remain held, cleanup is unknown`);
    this.#snapshot = union(this.#snapshot, loaded.entries);
    const entries = this.#snapshot.filter(entry => !contains(this.#confirmedGone, entry));
    const pids = entries.flatMap(entry => [entry.pid, entry.owner]);
    const observed = await this.#probe(pids, true);
    const permission = entry => ownerReapState(entry, { observed, displaced: this.#displaced, platform: this.#platform });
    const plan = planOrphanReap(entries, {
      isAlive: pid => observed.get(pid)?.alive ?? null, ownerState: permission,
      verify: entry => defaultVerify(entry, { platform: this.#platform, answer: observed.get(entry.pid) }),
    });
    const unresolved = [];
    const remember = (entry, outcome) => {
      if (confirmsScope(entry, outcome, this.#platform)) {
        this.#confirmedGone = union(this.#confirmedGone, [entry]);
        this.#say(`confirmed ${outcome.scope} cleanup for pid ${entry.pid} (${entry.service})`);
      } else {
        unresolved.push(entry);
        this.#say(`left pid ${entry.pid} (${entry.service}) recorded: ${outcome?.problem || 'cleanup is unconfirmed'}`);
      }
    };
    for (const { entry, state, reason } of plan.skipped) {
      // Another live/unknown owner stays protected even when this sample says its child root is absent.
      if (state === 'gone' && permission(entry) === 'allowed') remember(entry, this.#termination.absentRoot(entry));
      else remember(entry, { state: 'unknown', problem: reason });
    }
    for (const entry of plan.reap) {
      let outcome;
      try { outcome = await this.#termination.child(entry, observed.get(entry.pid)); }
      catch (error) { outcome = { state: 'unknown', problem: error?.message || String(error) }; }
      remember(entry, outcome);
    }
    this.#unresolved = unresolved;

    // No successor write before the original writer is positively gone, including a legacy clear callback.
    if (this.#displaced && !this.#ownerGone) {
      const answer = (await this.#probe([this.#displaced.pid])).get(this.#displaced.pid);
      const state = originalBirthState(this.#displaced, answer, this.#platform);
      this.#ownerGone = state === 'gone';
      if (!this.#ownerGone) {
        this.#held(`ownership recovery held: original incumbent pid ${this.#displaced.pid} is ${state}`);
        return { ready: false, retained: unresolved, confirmedGone: this.#confirmedGone };
      }
    }
    // Two aggregate deltas, never a keep-snapshot replacement. Confirmed rows are never reclassified/resurrected
    // when a later request releases the fence after the first recovery attempt already ended their groups.
    const retained = this.#record.retain(unresolved);
    const retired = this.#record.retire(this.#confirmedGone);
    if (!retained.ok || !retired.ok) this.#say('recovery bookkeeping could not be made durable; unresolved evidence remains in memory and file errors were reported');
    this.#ready = true;
    this.#problem = '';
    return { ready: true, retained: unresolved, confirmedGone: this.#confirmedGone, recorded: retained.ok && retired.ok };
  }
}
