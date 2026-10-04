// The agent-definition store: the ONLY code that writes ~/.aify/agent-definitions (P0 C2).
//
// EVERY PUBLIC CALL is one lock hold: take the lock, recover any interrupted operation, adopt hand
// edits, do the call's own work, release. Nothing is cached between calls, so a hand edit or a crash
// between two calls is seen by the next one.
//
// ONE OPERATION IS FOUR DURABLE STEPS -- intent, apply, ledger, delete the intent -- and the file and
// the ledger each carry the operation's id in the same atomic rename that commits them. Recovery reads
// those receipts; `agent-definition-recovery.mjs` decides what they mean, and this module carries the
// decision out. A lock is taken over only when its holder is a process ON THIS HOST that is no longer
// running: `admitStart` holds the lock while a worker's process is made, so an aify-env killed during a
// start left a lock that refused every later call until an operator ran `aify-env agents unlock`
// (external review of 0.8.1). A live holder, or one on another host, is still waited for and reported.
//
// `boundary(name, context)` is called after every durable step. The tests pass one that kills the
// process there, which is how every interruption below is exercised for real.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  definitionBytesProblems,
  definitionProblems,
  formatDefinitionFile,
  idProblems,
  isCounter,
  isOperationId,
  numberProblems,
  MAX_COUNTER,
  SCHEMA_VERSION,
} from "./agent-definition-schema.mjs";
import { snapshotDigest, snapshotEntry } from "./agent-definition-snapshot.mjs";
import { adoptionPlan, caseCollisions, ledgerEntry, recoveryDecision } from "./agent-definition-recovery.mjs";
import { isRemoval, mergePatch, requestDecision, startRefusal, trashedPair } from "./agent-definition-requests.mjs";
import { removeIfStill, sweepDeadGuards } from "./lock-break.mjs";

const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;
//: Windows refuses a rename over a file another process has open (EPERM, EBUSY); that clears in
//: milliseconds, so the step is retried rather than failed.
const RENAME_RETRY_MS = 2000;
const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
//: A read that says the entry exists but cannot be read makes the snapshot incomplete, never absent.
const UNREADABLE = new Set(["EACCES", "EIO", "EPERM", "EBUSY"]);

/**
 * Where the store lives: `AIFY_AGENT_DEFINITIONS_DIR` for tests, else ~/.aify/agent-definitions.
 * NOT EXPORTED, and nothing the module exports hands the path back: a module that cannot obtain the
 * path from the store cannot relay it, however it imports (tests/agent-definitions-have-one-writer).
 */
function definitionsDir(env = process.env) {
  return env.AIFY_AGENT_DEFINITIONS_DIR || path.join(os.homedir(), ".aify", "agent-definitions");
}

/** A refusal the caller reports: the store is fine, this request is not. */
export class DefinitionRefused extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = "DefinitionRefused";
    Object.assign(this, detail);
  }
}

/** The store cannot work: a held lock, a lost lock, an unreadable ledger, an unresolved conflict. */
export class DefinitionStoreError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "DefinitionStoreError";
    Object.assign(this, detail);
  }
}

const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Whether a process id is running. EPERM means it is, and belongs to someone else. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function ledgerProblem(ledger) {
  if (ledger === null || typeof ledger !== "object" || Array.isArray(ledger)) return "not an object";
  if (ledger.version !== SCHEMA_VERSION) return "unsupported version";
  if (typeof ledger.storeId !== "string" || !ledger.storeId) return "no storeId";
  if (!isCounter(ledger.revision) || !isCounter(ledger.nextIncarnation)) return "a counter is not a safe integer from 1";
  if (typeof ledger.snapshotDigest !== "string") return "no snapshotDigest";
  if (ledger.lastOperation !== null && typeof ledger.lastOperation !== "string") return "lastOperation is not a string";
  if (ledger.ids === null || typeof ledger.ids !== "object" || Array.isArray(ledger.ids)) return "ids is not an object";
  for (const [id, entry] of Object.entries(ledger.ids)) {
    if (!isCounter(entry?.incarnation) || !isCounter(entry?.revision) || typeof entry?.fileDigest !== "string") {
      return `the entry for ${JSON.stringify(id)} is malformed`;
    }
  }
  return "";
}

/**
 * Refuse, before anything is written, an operation whose counters would leave the safe range: the
 * collection revision, the id's own revision, and -- only when it makes a new id -- the store-wide
 * incarnation, which must still have room for the next one.
 */
function refuseExhaustion(ledger, { revision, newId = false } = {}) {
  if (ledger.revision >= MAX_COUNTER || (revision !== undefined && revision > MAX_COUNTER)
    || (newId && ledger.nextIncarnation >= MAX_COUNTER)) {
    throw new DefinitionStoreError("a store counter is exhausted; nothing was written");
  }
}

export class DefinitionStore {
  #dir;
  #boundary;
  #now;
  #pid;
  #lockWaitMs;
  #renameSync;
  #readdirSync;
  #nonce = null;

  /**
   * `renameSync` and `readdirSync` are the two calls whose failures the store must survive (a Windows
   * rename refused while another process has the file open; a directory that cannot be listed), so a
   * test can make them fail exactly. The directory's path is never handed back out: a caller that
   * could read it could write it, and this is the only writer.
   */
  constructor({
    dir = definitionsDir(), boundary = () => {}, now = () => new Date(), pid = process.pid, lockWaitMs = LOCK_WAIT_MS,
    renameSync = fs.renameSync, readdirSync = fs.readdirSync,
  } = {}) {
    this.#dir = dir;
    this.#boundary = boundary;
    this.#now = now;
    this.#pid = pid;
    this.#lockWaitMs = lockWaitMs;
    this.#renameSync = renameSync;
    this.#readdirSync = readdirSync;
  }

  #path(...parts) { return path.join(this.#dir, ...parts); }

  // ---- the public calls, each one lock hold ----------------------------------------------------

  /**
   * Every definition as the store now holds it, after recovery and adoption. `recovered` is the
   * interrupted operation this call settled, with its outcome, when there was one.
   */
  async list() {
    // Not an operation: a conflict is shown here, and every operation refuses until it is settled.
    return this.#session((state) => ({ storeId: state.ledger.storeId, revision: state.ledger.revision, recovered: state.recovered, ...this.#view(state) }),
      { allowConflict: true });
  }

  /**
   * Run `produce` only if `launch` was built from what this host's file now holds, and HOLD THE STORE
   * until it returns (P0 C7). `produce` is the call that makes the worker's process, so a write commits
   * either before this reads (and the start is refused) or after the process exists (and is a change
   * for the next start). A check that released the store before `produce`, or ran earlier, let a set or
   * a removal land in between, and an old revision's worker started (review of P4, N1).
   *
   * A launch built from no definition is produced without the store.
   * @returns {Promise<{refused: string}|{produced: *}>}
   */
  async admitStart(launch, produce) {
    if (!launch?.definition) return { produced: await produce() };
    await this.#lock();
    try {
      const state = this.#open();
      const refused = startRefusal(launch, { storeId: state.ledger.storeId, ...this.#view(state) });
      return refused ? { refused } : { produced: await produce() };
    } finally {
      this.#unlock();
    }
  }

  /**
   * Define or change one agent. `expect` is the caller's compare-and-set pair, `{incarnation, revision}`,
   * or null for "must not exist yet"; omitted means the operator's own unconditional edit.
   */
  async set(id, agent, { expect, requestId, installed } = {}) {
    return this.#session((state) => this.#setIn(state, id, agent, { expect, requestId, installed }));
  }

  /** Remove one agent into `.trash/`, under the same compare-and-set as `set`. */
  async remove(id, { expect, requestId } = {}) {
    return this.#session((state) => this.#removeIn(state, id, { expect, requestId }));
  }

  /**
   * Apply one change request the service handed this host (P0 C4), as ONE lock hold: the decision
   * (`requestDecision`, steps 1 to 4) and the write it leads to (step 5) see the same state. Never
   * throws for a refusal: it returns the report the service takes, `{status, outcome}` with the
   * resulting pair for `done`.
   */
  async applyRequest(request, { installed } = {}) {
    if (!(installed instanceof Set)) throw new TypeError("applyRequest() needs the installed harnesses");
    return this.#session((state) => {
      const current = state.readings.find((reading) => reading.id === request.agentId);
      const trashed = trashedPair(this.#readdirSync(this.#path(".trash")), request.agentId, request.id);
      const decision = requestDecision({ request, storeId: state.ledger.storeId, current, trashed });
      if (decision.verdict === "refused") return { status: "refused", outcome: decision.reason };
      if (decision.verdict === "done") {
        return { status: "done", outcome: "already applied", resultIncarnation: decision.incarnation, resultRevision: decision.revision };
      }
      // No compare-and-set on the write: `requestDecision` checked the expected pair against this same
      // lock hold's state, so a second check here could never answer differently.
      try {
        const written = isRemoval(request.patch)
          ? this.#removeIn(state, request.agentId, { requestId: request.id })
          : this.#setIn(state, request.agentId, mergePatch(current.agent, request.patch), { requestId: request.id, installed });
        return { status: "done", outcome: "", resultIncarnation: written.incarnation, resultRevision: written.revision };
      } catch (error) {
        if (!(error instanceof DefinitionRefused)) throw error;
        const detail = error.problems?.length ? ` (${error.problems.join("; ")})` : "";
        return { status: "refused", outcome: `${error.message}${detail}` };
      }
    });
  }

  #setIn(state, id, agent, { expect, requestId, installed }) {
    const refusal = idProblems(id);
    if (refusal.length) throw new DefinitionRefused(`the id is not admitted (${refusal.join(", ")})`, { problems: refusal });
    const collision = [...state.fileIds, ...Object.keys(state.ledger.ids)].find((other) => other !== id && other.toLowerCase() === id.toLowerCase());
    if (collision) throw new DefinitionRefused(`${collision} already exists, and ids are compared without case`);
    if (state.readings.some((r) => r.id === id && r.problems.includes("entry: not-a-regular-file"))) {
      throw new DefinitionRefused(`${id}.json is not a regular file (a link or a directory); remove it by hand first`);
    }
    if (!(installed instanceof Set)) throw new TypeError("set() needs the installed harnesses");
    const known = ledgerEntry(state.ledger.ids, id);
    this.#compareAndSet(known, expect);
    const incarnation = known ? known.incarnation : state.ledger.nextIncarnation;
    const revision = known ? known.revision + 1 : 1;
    refuseExhaustion(state.ledger, { revision, newId: !known });
    const operation = randomUUID();
    const body = {
      version: SCHEMA_VERSION, incarnation, revision, operation, updatedAt: this.#now().toISOString(),
      agent: { ...agent, id }, ...(requestId ? { appliedRequest: requestId } : {}),
    };
    // NORMALIZED: what the store writes carries its identity, and must carry it exactly.
    const problems = definitionProblems(body, id, { population: "normalized" });
    if (problems.length) throw new DefinitionRefused("the definition is not valid", { problems });
    // After validity, so a definition missing its harness is told so rather than about a launcher.
    if (!installed.has(agent.harness)) throw new DefinitionRefused(`the ${agent.harness} launcher is not installed on this host`);
    const text = formatDefinitionFile(body);
    const ledgerAfter = this.#nextLedger(state.ledger, operation, {
      ids: { ...state.ledger.ids, [id]: { incarnation, revision, fileDigest: sha256Bytes(Buffer.from(text, "utf8")) } },
      nextIncarnation: known ? state.ledger.nextIncarnation : state.ledger.nextIncarnation + 1,
    });
    this.#operate({ op: "set", id, operation, requestId, before: this.#currentDigest(id), text, ledgerAfter });
    return { outcome: "committed", operation, id, incarnation, revision };
  }

  #removeIn(state, id, { expect, requestId }) {
    const known = ledgerEntry(state.ledger.ids, id);
    if (!known) throw new DefinitionRefused(`${id} is not defined`);
    this.#compareAndSet(known, expect);
    refuseExhaustion(state.ledger, {});
    const operation = randomUUID();
    const { [id]: _removed, ...ids } = state.ledger.ids;
    const trashName = `${id}.${known.incarnation}.${known.revision}.${requestId || "local"}.${operation}.json`;
    const ledgerAfter = this.#nextLedger(state.ledger, operation, { ids });
    this.#operate({ op: "remove", id, operation, requestId, before: this.#currentDigest(id), trashName, ledgerAfter });
    return { outcome: "committed", operation, id, incarnation: known.incarnation, revision: known.revision, trashName };
  }

  /**
   * The complete, ordered snapshot (C3). A changed digest advances the collection revision first, and
   * so does `fresh`: the service answers an id refused at a revision it has already seen only at a new
   * one (a released id is taken at this host's next fresh revision).
   */
  async snapshot({ installed, fresh = false } = {}) {
    if (!(installed instanceof Set)) throw new TypeError("snapshot() needs the installed harnesses");
    return this.#session((state) => {
      const entries = state.readings.map((reading) => snapshotEntry(reading, installed));
      // Complete only when every entry was listed, read and adopted: `enumerationFailed` carries a
      // failed listing from adoption as well as from the read (#open).
      const complete = state.unreadable.length === 0 && !state.conflict && !state.enumerationFailed;
      const digest = snapshotDigest(entries);
      let ledger = state.ledger;
      if (complete && (fresh || digest !== ledger.snapshotDigest)) {
        refuseExhaustion(ledger, {});
        const operation = randomUUID();
        ledger = this.#nextLedger(ledger, operation, { snapshotDigest: digest });
        this.#operate({ op: "observe", id: null, operation, before: "absent", ledgerAfter: ledger });
      }
      return { storeId: ledger.storeId, revision: ledger.revision, complete, snapshotDigest: digest, entries,
        ...(complete ? {} : { incomplete: { unreadable: state.unreadable, conflict: state.conflict, enumerationFailed: state.enumerationFailed } }) };
    }, { allowConflict: true });
  }

  /**
   * The operator settling a RECOVERY CONFLICT: `committed` writes the operation's ledger, `not-committed`
   * discards it. The choice is recorded first, and the file on disk is adopted either way.
   */
  async settleConflict(choice) {
    if (choice !== "committed" && choice !== "not-committed") throw new TypeError("choice is committed or not-committed");
    return this.#session((state) => {
      if (!state.conflict) throw new DefinitionRefused("there is no recovery conflict to settle");
      const intent = state.conflict.intent;
      if (!isOperationId(intent?.operation)) {
        // Nothing to record a choice against: the intent itself is unreadable.
        throw new DefinitionRefused(`the pending operation's intent cannot be read, so there is nothing to settle it as; read ${this.#path(".intent.json")} and remove it by hand`);
      }
      this.#writeDurable(this.#path(".recovered", `${intent.operation}.json`), `${JSON.stringify({ ...intent, outcome: choice, settledBy: "operator" }, null, 2)}\n`);
      this.#boundary("recovered-record-written", { operation: intent.operation, settle: "operator" });
      return { settled: intent.operation, outcome: choice };
    }, { allowConflict: true, thenRecover: true });
  }

  /**
   * What became of an operation: its `.recovered/` record first, then the ledger's receipt. The
   * receipt answers only until the next operation replaces it, adoption included; the settlement a
   * recovery returns (`list().recovered`) is the answer at the moment it happens.
   */
  async outcomeOf(operation) {
    // Only an operation id reaches a path: anything else names no operation this store ran.
    if (!isOperationId(operation)) return null;
    return this.#session((state) => {
      const record = this.#readJson(this.#path(".recovered", `${operation}.json`));
      if (record) return record.outcome;
      return state.ledger.lastOperation === operation ? "committed" : null;
    }, { allowConflict: true });
  }

  /**
   * The operator's `unlock`: remove the lock only when its holder is not running. Returns what it
   * removed, or throws naming the live holder. Static: it must work while the store is locked.
   */
  static unlock({ dir = definitionsDir() } = {}) {
    const lockPath = path.join(dir, ".lock");
    // A breaker that died holding a guard left it; each is removed under its own guard, so a live one is kept.
    if (fs.existsSync(dir)) sweepDeadGuards(dir, { processAlive });
    let text;
    try {
      text = fs.readFileSync(lockPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    let holder = null;
    try { holder = JSON.parse(text); } catch { /* a torn lock: its holder died writing it */ }
    if (holder && processAlive(holder.pid)) {
      throw new DefinitionStoreError(`the lock is held by running process ${holder.pid}; it was not removed`, { holder });
    }
    // Removed only if it is still the lock that was read, under the break lock: a new holder may have taken it.
    if (!removeIfStill(lockPath, text, { processAlive })) {
      throw new DefinitionStoreError("the lock changed while it was read, or another process is taking it over; nothing removed");
    }
    return holder ?? { torn: text };
  }

  // ---- one lock hold -------------------------------------------------------------------------

  async #session(work, { allowConflict = false, thenRecover = false } = {}) {
    await this.#lock();
    try {
      const state = this.#open();
      if (state.conflict && !allowConflict) throw new DefinitionStoreError("a recovery conflict is unresolved", { conflict: state.conflict });
      const result = work(state);
      if (thenRecover) this.#open();
      return result;
    } finally {
      this.#unlock();
    }
  }

  /** Recovery, then adoption, then a fresh read: the state every call works from. */
  #open() {
    fs.mkdirSync(this.#path(".trash"), { recursive: true });
    fs.mkdirSync(this.#path(".recovered"), { recursive: true });
    let ledger = this.#readLedger();
    const { conflict = null, settled = null } = this.#recover(ledger);
    let adoption = { enumerationFailed: null };
    if (!conflict) {
      ledger = this.#readLedger();
      adoption = this.#adopt(ledger);
      ledger = this.#readLedger();
    }
    const read = this.#read(ledger);
    // EITHER listing failing leaves the state unproven: a read that succeeds after an adoption that
    // could not list the directory has seen files the ledger was never brought level with.
    return { ledger, conflict, recovered: settled ? [settled] : [], ...read, enumerationFailed: adoption.enumerationFailed || read.enumerationFailed };
  }

  #compareAndSet(known, expect) {
    if (expect === undefined) return;
    if (expect === null) {
      if (known) throw new DefinitionRefused("it already exists", { current: { incarnation: known.incarnation, revision: known.revision } });
      return;
    }
    if (!known || known.incarnation !== expect.incarnation || known.revision !== expect.revision) {
      throw new DefinitionRefused("changed on the host since you asked",
        { current: known ? { incarnation: known.incarnation, revision: known.revision } : null });
    }
  }

  #nextLedger(ledger, operation, changes) {
    return { ...ledger, ...changes, revision: ledger.revision + 1, lastOperation: operation };
  }

  // ---- the lock ------------------------------------------------------------------------------

  async #lock() {
    fs.mkdirSync(this.#dir, { recursive: true });
    const nonce = randomUUID();
    const lockPath = this.#path(".lock");
    const deadline = Date.now() + this.#lockWaitMs;
    for (;;) {
      try {
        const fd = fs.openSync(lockPath, "wx");
        try {
          fs.writeSync(fd, JSON.stringify({ pid: this.#pid, atMs: Date.now(), nonce, host: os.hostname() }));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.#nonce = nonce;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (this.#tookOverADeadHolder(lockPath)) continue;
      if (Date.now() >= deadline) {
        const holder = this.#readJson(lockPath);
        const alive = holder ? processAlive(holder.pid) : false;
        throw new DefinitionStoreError(
          alive
            ? `the store is locked by running process ${holder.pid} (${lockPath})`
            : `the store is locked by process ${holder?.pid ?? "unknown"}, which is not running (${lockPath}). `
              + "If no aify-env is writing it, `aify-env agents unlock` removes that lock.",
          { lockPath, holder, holderAlive: alive },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  /**
   * Remove the lock when its holder is a process on this host that is not running, and say so.
   *
   * The inference is safe in the direction that matters: a reused pid reads as RUNNING, which leaves the lock
   * waited for, as before. A torn lock is never taken: it may be a live writer between `open` and `write`.
   * A lock written before this rule names no host and is this host's, because the store is in this home.
   * The removal itself is `removeIfStill`: under its guard, and only while `.lock` is still the judged one.
   */
  #tookOverADeadHolder(lockPath) {
    let text;
    try {
      text = fs.readFileSync(lockPath, "utf8");
      const holder = JSON.parse(text);
      if (!holder || processAlive(holder.pid) || (holder.host ?? os.hostname()) !== os.hostname()) return false;
    } catch {
      return false;
    }
    return removeIfStill(lockPath, text, { processAlive, pid: this.#pid });
  }

  /** Every durable step re-reads the lock and aborts if it is no longer this call's. */
  #checkLock() {
    const holder = this.#readJson(this.#path(".lock"));
    if (!holder || holder.nonce !== this.#nonce) {
      throw new DefinitionStoreError("the store's lock was taken from this operation; it stopped, and the next open recovers it");
    }
  }

  #unlock() {
    if (!this.#nonce) return;
    const holder = this.#readJson(this.#path(".lock"));
    if (holder?.nonce === this.#nonce) fs.unlinkSync(this.#path(".lock"));
    this.#nonce = null;
  }

  // ---- durable primitives --------------------------------------------------------------------

  /**
   * A rename, retried while Windows refuses it. The lock is re-read before EVERY attempt, not once
   * before the first: a retry that lands after the lock was taken would apply this operation under
   * someone else's lock.
   */
  #rename(from, to) {
    const deadline = Date.now() + RENAME_RETRY_MS;
    for (;;) {
      this.#checkLock();
      try {
        this.#renameSync(from, to);
        break;
      } catch (error) {
        if (!RETRYABLE_RENAME.has(error.code) || Date.now() >= deadline) throw error;
        sleepSync(20);
      }
    }
    this.#syncDirectory(path.dirname(to));
  }

  /** POSIX makes a rename durable by fsyncing the directory; Windows has no such call from Node. */
  #syncDirectory(dir) {
    if (process.platform === "win32") return;
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  #writeTemp(tempPath, text) {
    const fd = fs.openSync(tempPath, "w");
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  #writeDurable(target, text) {
    const temp = `${target}.${this.#pid}.${this.#nonce}.tmp`;
    this.#checkLock();
    this.#writeTemp(temp, text);
    this.#rename(temp, target);
  }

  #readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  #readLedger() {
    const ledgerPath = this.#path(".collection.json");
    if (!fs.existsSync(ledgerPath)) {
      // A new store, but only on an empty slate: an intent with no ledger is a store that lost its
      // ledger, and inventing a fresh one would give it a new identity mid-operation.
      if (fs.existsSync(this.#path(".intent.json"))) throw new DefinitionStoreError("an operation is pending but the ledger is missing");
      const ledger = { version: SCHEMA_VERSION, storeId: randomUUID(), revision: 1, nextIncarnation: 1, snapshotDigest: "", lastOperation: null, ids: {} };
      this.#writeDurable(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      return ledger;
    }
    // The ledger's counters are authority, so the raw-number law applies to its TEXT as to a file's:
    // JSON.parse would read 9007199254740990.5 as a safe integer.
    const text = fs.readFileSync(ledgerPath, "utf8");
    const numbers = numberProblems(text);
    if (numbers.length) throw new DefinitionStoreError(`the ledger ${ledgerPath} is not usable: ${numbers.join(", ")}`);
    let ledger = null;
    try { ledger = JSON.parse(text); } catch { /* reported below as not an object */ }
    const problem = ledgerProblem(ledger);
    if (problem) throw new DefinitionStoreError(`the ledger ${ledgerPath} is not usable: ${problem}`);
    return ledger;
  }

  /** The raw bytes' digest of `<id>.json`, or "absent". */
  #currentDigest(id) {
    try {
      return sha256Bytes(fs.readFileSync(this.#path(`${id}.json`)));
    } catch (error) {
      if (error.code === "ENOENT") return "absent";
      throw error;
    }
  }

  // ---- the four-step operation ---------------------------------------------------------------

  #operate({ op, id, operation, requestId, before, text, trashName, ledgerAfter }) {
    const tempName = op === "set" ? `${id}.json.${this.#pid}.${this.#nonce}.tmp` : undefined;
    const intent = { operation, op, id, ...(requestId ? { requestId } : {}), before, tempName, trashName, ledgerAfter };
    const context = { op, id, operation };
    this.#writeDurable(this.#path(".intent.json"), `${JSON.stringify(intent, null, 2)}\n`);
    this.#boundary("intent-written", context);
    if (op === "set") {
      this.#checkLock();
      this.#writeTemp(this.#path(tempName), text);
      this.#boundary("temp-written", context);
      this.#checkLock();
      this.#rename(this.#path(tempName), this.#path(`${id}.json`));
    } else if (op === "remove") {
      this.#checkLock();
      this.#rename(this.#path(`${id}.json`), this.#path(".trash", trashName));
    }
    this.#boundary("applied", context);
    this.#writeDurable(this.#path(".collection.json"), `${JSON.stringify(ledgerAfter, null, 2)}\n`);
    this.#boundary("ledger-written", context);
    this.#checkLock();
    fs.unlinkSync(this.#path(".intent.json"));
    this.#boundary("intent-deleted", context);
  }

  // ---- recovery --------------------------------------------------------------------------------

  /** Settle a pending operation: `{settled}` with its outcome, or `{conflict}` when the bytes cannot prove it. */
  #recover(ledger) {
    const intentPath = this.#path(".intent.json");
    if (!fs.existsSync(intentPath)) return {};
    const intent = this.#readJson(intentPath);
    if (!intent?.operation || !intent.ledgerAfter) return { conflict: { intent, reason: "the pending operation's intent cannot be read" } };
    const record = this.#readJson(this.#path(".recovered", `${intent.operation}.json`));
    const file = this.#fileReceipt(intent.id);
    const trashHasOperation = intent.op === "remove"
      && this.#readdirSync(this.#path(".trash")).some((name) => name.endsWith(`.${intent.operation}.json`));
    const decision = recoveryDecision(intent, record, { ledgerLastOperation: ledger.lastOperation, file, trashHasOperation });
    const context = { op: intent.op, id: intent.id, operation: intent.operation, arm: decision.arm };
    if (decision.settle === "conflict") {
      return { conflict: { intent, reason: "the files cannot prove whether the operation ran", before: intent.before, current: file } };
    }
    if (decision.settle === "forward") {
      this.#writeDurable(this.#path(".recovered", `${intent.operation}.json`), `${JSON.stringify({ ...intent, outcome: "unknown" }, null, 2)}\n`);
      this.#boundary("recovered-record-written", context);
    }
    // THE BODY IS ARCHIVED WHENEVER A RECORD GOVERNS, not only in the call that wrote the record: a
    // crash between the record and this move reopens through the record arm, which must finish it.
    if (decision.settle === "forward" || decision.arm === "record") {
      const temp = intent.tempName ? this.#path(intent.tempName) : null;
      const body = this.#path(".recovered", `${intent.operation}.body.json`);
      if (temp && fs.existsSync(temp) && !fs.existsSync(body)) this.#rename(temp, body);
      this.#boundary("recovered-body-archived", context);
    }
    if (decision.writeLedger === "after") {
      this.#writeDurable(this.#path(".collection.json"), `${JSON.stringify(intent.ledgerAfter, null, 2)}\n`);
    } else if (decision.writeLedger === "not-committed") {
      // Discarded, but the incarnation it was handed is still spent.
      const kept = this.#nextLedger(ledger, intent.operation, { nextIncarnation: Math.max(ledger.nextIncarnation, intent.ledgerAfter.nextIncarnation) });
      this.#writeDurable(this.#path(".collection.json"), `${JSON.stringify(kept, null, 2)}\n`);
    }
    this.#boundary("settle-ledger-written", context);
    this.#checkLock();
    fs.unlinkSync(intentPath);
    this.#boundary("settle-intent-deleted", context);
    return { settled: { operation: intent.operation, op: intent.op, id: intent.id, arm: decision.arm, outcome: decision.outcome } };
  }

  /** What `<id>.json` says about an operation: present or not, its digest, its receipt. */
  #fileReceipt(id) {
    if (typeof id !== "string") return { present: false };
    let bytes;
    try {
      bytes = fs.readFileSync(this.#path(`${id}.json`));
    } catch (error) {
      if (error.code === "ENOENT") return { present: false };
      throw error;
    }
    let operation = null;
    try { operation = JSON.parse(bytes.toString("utf8"))?.operation ?? null; } catch { /* not JSON: no receipt */ }
    return { present: true, digest: sha256Bytes(bytes), operation };
  }

  // ---- adoption and reading ------------------------------------------------------------------

  /** Bring the ledger level with the directory, one operation per changed id. Returns whether it could list it. */
  #adopt(ledger) {
    const { files, unreadable, invalidNames, enumerationFailed } = this.#scan(ledger);
    // A directory that could not be listed says nothing about which files exist: adopting from it
    // would read every definition as removed by hand.
    if (enumerationFailed) return { enumerationFailed };
    const digests = new Map([...files].map(([id, file]) => [id, { digest: file.digest, valid: file.problems.length === 0 }]));
    // A present entry that is not a regular file is invalid, not absent: the ledger keeps its last
    // good identity for that id, as for any invalid edit.
    for (const { id } of invalidNames) digests.set(id, { digest: null, valid: false });
    for (const action of adoptionPlan(ledger, digests, new Set(unreadable))) {
      const current = this.#readLedger();
      refuseExhaustion(current, { revision: action.revision, newId: action.kind === "new" });
      const operation = randomUUID();
      if (action.kind === "hand-removal") {
        const { [action.id]: _gone, ...ids } = current.ids;
        this.#operate({ op: "observe", id: action.id, operation, before: "absent", ledgerAfter: this.#nextLedger(current, operation, { ids }) });
        continue;
      }
      const file = files.get(action.id);
      const body = { ...file.body, incarnation: action.incarnation, revision: action.revision, operation, updatedAt: this.#now().toISOString() };
      const text = formatDefinitionFile(body);
      const ledgerAfter = this.#nextLedger(current, operation, {
        ids: { ...current.ids, [action.id]: { incarnation: action.incarnation, revision: action.revision, fileDigest: sha256Bytes(Buffer.from(text, "utf8")) } },
        nextIncarnation: action.kind === "new" ? Math.max(current.nextIncarnation, action.incarnation + 1) : current.nextIncarnation,
      });
      this.#operate({ op: "set", id: action.id, operation, before: file.digest, text, ledgerAfter });
    }
    return { enumerationFailed: null };
  }

  /** Every `*.json` entry: read, parsed and judged. Unreadable entries are named, never dropped. */
  #scan(ledger) {
    const files = new Map();
    const unreadable = [];
    const invalidNames = [];
    let entries;
    try {
      entries = this.#readdirSync(this.#dir, { withFileTypes: true });
    } catch (error) {
      if (!UNREADABLE.has(error.code)) throw error;
      return { files, unreadable, invalidNames, enumerationFailed: error.code };
    }
    for (const dirent of entries) {
      const name = dirent.name;
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const full = this.#path(name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch (error) {
        if (UNREADABLE.has(error.code)) { unreadable.push(id); continue; }
        throw error;
      }
      if (!stat.isFile()) { invalidNames.push({ id, problems: ["entry: not-a-regular-file"] }); continue; }
      let bytes;
      try {
        bytes = fs.readFileSync(full);
      } catch (error) {
        if (UNREADABLE.has(error.code)) { unreadable.push(id); continue; }
        throw error;
      }
      // A CANDIDATE: whatever identity the file states is untrusted; adoption assigns it.
      const { problems, body } = definitionBytesProblems(bytes, id);
      files.set(id, { id, digest: sha256Bytes(bytes), body, problems });
    }
    for (const id of caseCollisions(files.keys(), ledger.ids)) {
      files.get(id).problems = [...files.get(id).problems, "id: case-collision"].sort();
    }
    return { files, unreadable, invalidNames, enumerationFailed: null };
  }

  /** The state after adoption: one reading per entry, for list and snapshot. */
  #read(ledger) {
    const { files, unreadable, invalidNames, enumerationFailed } = this.#scan(ledger);
    const readings = [
      ...[...files.values()].map((file) => {
        const known = ledgerEntry(ledger.ids, file.id);
        // An invalid entry still shows the last good identity the ledger keeps for it, so a caller's
        // compare-and-set can name what it saw.
        if (file.problems.length) return { id: file.id, problems: file.problems, ...(known ? { incarnation: known.incarnation, revision: known.revision } : {}) };
        // Only while a conflict stops adoption: a valid file the ledger does not hold yet. It is
        // shown, never counted as defined, and the snapshot is incomplete then anyway.
        if (!known || known.fileDigest !== file.digest) return { id: file.id, problems: ["entry: not-adopted"] };
        return { id: file.id, problems: [], incarnation: known.incarnation, revision: known.revision, agent: file.body.agent,
          // Which change request wrote this file, so applying it again is recognised (C4 step 2).
          ...(file.body.appliedRequest ? { appliedRequest: file.body.appliedRequest } : {}) };
      }),
      ...invalidNames.map((reading) => {
        const known = ledgerEntry(ledger.ids, reading.id);
        return known ? { ...reading, incarnation: known.incarnation, revision: known.revision } : reading;
      }),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { readings, unreadable, enumerationFailed, fileIds: [...files.keys()] };
  }

  #view(state) {
    return { definitions: state.readings, unreadable: state.unreadable, conflict: state.conflict };
  }
}
