// The agent-definition store: the ONLY code that writes ~/.aify/agent-definitions (P0 C2).
//
// EVERY PUBLIC CALL is one lock hold: take the lock, recover any interrupted operation, adopt hand
// edits, do the call's own work, release. Nothing is cached between calls, so a hand edit or a crash
// between two calls is seen by the next one.
//
// ONE OPERATION IS FOUR DURABLE STEPS -- intent, apply, ledger, delete the intent -- and the file and
// the ledger each carry the operation's id in the same atomic rename that commits them. Recovery reads
// those receipts; `agent-definition-recovery.mjs` decides what they mean, and this module carries the
// decision out. The store never takes a lock over: a lock whose holder died is reported with the
// operator's remedy, `aify-env agents unlock`.
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
  MAX_COUNTER,
  SCHEMA_VERSION,
} from "./agent-definition-schema.mjs";
import { snapshotDigest, snapshotEntry } from "./agent-definition-snapshot.mjs";
import { adoptionPlan, caseCollisions, ledgerEntry, recoveryDecision } from "./agent-definition-recovery.mjs";

const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;
//: Windows refuses a rename over a file another process has open (EPERM, EBUSY); that clears in
//: milliseconds, so the step is retried rather than failed.
const RENAME_RETRY_MS = 2000;
const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);
//: A read that says the entry exists but cannot be read makes the snapshot incomplete, never absent.
const UNREADABLE = new Set(["EACCES", "EIO", "EPERM", "EBUSY"]);

/** Where the store lives: `AIFY_AGENT_DEFINITIONS_DIR` for tests, else ~/.aify/agent-definitions. */
export function definitionsDir(env = process.env) {
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
  #nonce = null;

  constructor({ dir = definitionsDir(), boundary = () => {}, now = () => new Date(), pid = process.pid, lockWaitMs = LOCK_WAIT_MS } = {}) {
    this.#dir = dir;
    this.#boundary = boundary;
    this.#now = now;
    this.#pid = pid;
    this.#lockWaitMs = lockWaitMs;
  }

  get dir() { return this.#dir; }

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
   * Define or change one agent. `expect` is the caller's compare-and-set pair, `{incarnation, revision}`,
   * or null for "must not exist yet"; omitted means the operator's own unconditional edit.
   */
  async set(id, agent, { expect, requestId, installed } = {}) {
    return this.#session((state) => {
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
    });
  }

  /** Remove one agent into `.trash/`, under the same compare-and-set as `set`. */
  async remove(id, { expect, requestId } = {}) {
    return this.#session((state) => {
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
    });
  }

  /** The complete, ordered snapshot (C3). A changed digest advances the collection revision first. */
  async snapshot({ installed } = {}) {
    if (!(installed instanceof Set)) throw new TypeError("snapshot() needs the installed harnesses");
    return this.#session((state) => {
      const entries = state.readings.map((reading) => snapshotEntry(reading, installed));
      const complete = state.unreadable.length === 0 && !state.conflict;
      const digest = snapshotDigest(entries);
      let ledger = state.ledger;
      if (complete && digest !== ledger.snapshotDigest) {
        refuseExhaustion(ledger, {});
        const operation = randomUUID();
        ledger = this.#nextLedger(ledger, operation, { snapshotDigest: digest });
        this.#operate({ op: "observe", id: null, operation, before: "absent", ledgerAfter: ledger });
      }
      return { storeId: ledger.storeId, revision: ledger.revision, complete, snapshotDigest: digest, entries,
        ...(complete ? {} : { incomplete: { unreadable: state.unreadable, conflict: state.conflict } }) };
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
    // Removed only if it is still the lock that was read: a new holder may have taken it meanwhile.
    if (fs.readFileSync(lockPath, "utf8") !== text) throw new DefinitionStoreError("the lock changed while it was read; nothing removed");
    fs.unlinkSync(lockPath);
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
    if (!conflict) {
      ledger = this.#readLedger();
      this.#adopt(ledger);
      ledger = this.#readLedger();
    }
    return { ledger, conflict, recovered: settled ? [settled] : [], ...this.#read(ledger) };
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
          fs.writeSync(fd, JSON.stringify({ pid: this.#pid, atMs: Date.now(), nonce }));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.#nonce = nonce;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
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

  #rename(from, to) {
    const deadline = Date.now() + RENAME_RETRY_MS;
    for (;;) {
      try {
        fs.renameSync(from, to);
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
    const ledger = this.#readJson(ledgerPath);
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
      && fs.readdirSync(this.#path(".trash")).some((name) => name.endsWith(`.${intent.operation}.json`));
    const decision = recoveryDecision(intent, record, { ledgerLastOperation: ledger.lastOperation, file, trashHasOperation });
    const context = { op: intent.op, id: intent.id, operation: intent.operation, arm: decision.arm };
    if (decision.settle === "conflict") {
      return { conflict: { intent, reason: "the files cannot prove whether the operation ran", before: intent.before, current: file } };
    }
    if (decision.settle === "forward") {
      this.#writeDurable(this.#path(".recovered", `${intent.operation}.json`), `${JSON.stringify({ ...intent, outcome: "unknown" }, null, 2)}\n`);
      if (intent.tempName && fs.existsSync(this.#path(intent.tempName))) {
        this.#rename(this.#path(intent.tempName), this.#path(".recovered", `${intent.operation}.body.json`));
      }
      this.#boundary("recovered-record-written", context);
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

  /** Bring the ledger level with the directory, one operation per changed id. */
  #adopt(ledger) {
    const { files, unreadable } = this.#scan(ledger);
    const digests = new Map([...files].map(([id, file]) => [id, { digest: file.digest, valid: file.problems.length === 0 }]));
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
  }

  /** Every `*.json` entry: read, parsed and judged. Unreadable entries are named, never dropped. */
  #scan(ledger) {
    const files = new Map();
    const unreadable = [];
    const invalidNames = [];
    for (const dirent of fs.readdirSync(this.#dir, { withFileTypes: true })) {
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
    return { files, unreadable, invalidNames };
  }

  /** The state after adoption: one reading per entry, for list and snapshot. */
  #read(ledger) {
    const { files, unreadable, invalidNames } = this.#scan(ledger);
    const readings = [
      ...[...files.values()].map((file) => {
        if (file.problems.length) return { id: file.id, problems: file.problems };
        const known = ledgerEntry(ledger.ids, file.id);
        // Only while a conflict stops adoption: a valid file the ledger does not hold yet. It is
        // shown, never counted as defined, and the snapshot is incomplete then anyway.
        if (!known || known.fileDigest !== file.digest) return { id: file.id, problems: ["entry: not-adopted"] };
        return { id: file.id, problems: [], incarnation: known.incarnation, revision: known.revision, agent: file.body.agent };
      }),
      ...invalidNames,
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { readings, unreadable, fileIds: [...files.keys()] };
  }

  #view(state) {
    return { definitions: state.readings, unreadable: state.unreadable, conflict: state.conflict };
  }
}
