// The owned-process record file, read and changed as one object so every change goes through one durable path.
//
// WHAT THIS OWNS. Reading the record into an explicit status, and the three changes a daemon makes to it: a process
// it started, rows it must keep (unresolved recovery work), and exact rows it may forget. It never probes the OS and
// never repairs identity: a row says what its writer captured, or nothing.
//
// ONLY ENOENT MEANS NOTHING IS THERE. Any other read failure is 'unreadable' with reason 'read-failed', and no change
// writes over it: bytes that could not be read cannot be preserved, so replacing them would lose them unseen. Bytes
// that were read but cannot be understood (not UTF-8, not JSON, not a list) are 'corrupt' or 'unsupported'; a change
// that must record something copies those exact bytes aside durably FIRST and replaces the target only if that copy
// succeeded. Retiring never writes over them: there is no row in them it could identify.
//
// A LIST IS UNDERSTOOD EVEN WHEN SOME ROWS ARE NOT. Rows this version cannot read (no string id or integer pid) are
// not reported as entries, and are written back byte for byte on every change, never filtered away: they may name a
// process a newer writer recorded. Recognised rows keep their exact source text too, so unknown fields survive.
//
// WRITES ARE DURABLE AND REPORTED, NEVER THROWN. writeFileDurably replaces the file by rename, so a failure before the
// rename leaves the old bytes. A failure after it (making the rename durable) leaves the new bytes; the result says
// which through targetReplaced. A failure is reported and returned; a daemon managing every process must not be taken
// down by its bookkeeping. The writer may retry a refused Windows rename synchronously for up to two seconds per write.
//
// NOT A LOCK. Each change re-reads the current file and changes only what it names, so a stale snapshot cannot erase
// rows written since or resurrect rows removed since. Two writers interleaving between one change's read and its
// rename can still lose an update; this does not serialise independent instances sharing one path.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeFileDurably } from './durable-file.mjs';
import { linuxStartTokenFrom } from './linux-process-token.mjs';

/** A row this version can act on names a process: a string id and an integer pid. Anything else is kept, not used. */
function isProcessRecord(value) {
  return typeof value === 'object' && value !== null && typeof value.id === 'string' && Number.isInteger(value.pid);
}

/**
 * The source text of each element of a JSON array `text` that already parsed. Pure; for well-formed JSON only.
 * @returns {string[]}
 */
function arrayElementSources(text) {
  const sources = [];
  let depth = 0, inString = false, escaped = false, start = -1;
  const close = (end) => { if (start >= 0) sources.push(text.slice(start, end).trim()); start = -1; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (depth === 1 && start < 0 && !' \t\r\n,]'.includes(c)) start = i;
    if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) close(i); }
    else if (c === ',' && depth === 1) close(i);
  }
  return sources;
}

/** The record's bytes as a document: status, and for a readable list every row with its exact source. Pure. */
function parseOwnedDocument(bytes) {
  const damaged = (reason, problem) => ({ status: 'unreadable', reason, problem, bytes, rows: [] });
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return damaged('unsupported', 'it is not UTF-8 text');
  if (text.trim() === '') return { status: 'readable', rows: [] };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return damaged('corrupt', 'it is not JSON'); }
  if (!Array.isArray(parsed)) return damaged('unsupported', 'it is not a list of processes');
  const sources = arrayElementSources(text);
  const faithful = sources.length === parsed.length
    && sources.every((source, i) => { try { return isDeepStrictEqual(JSON.parse(source), parsed[i]); } catch { return false; } });
  if (!faithful) return damaged('unsupported', 'its rows could not be separated exactly');
  return { status: 'readable', rows: parsed.map((value, i) => ({ raw: sources[i], value, valid: isProcessRecord(value) })) };
}

/** A row for `value`, its source in the file's two-space layout and its value exactly as a reader will see it. */
function rowFrom(value) {
  const json = JSON.stringify(value, null, 2);
  const parsed = JSON.parse(json);
  return { raw: json.replace(/\n/g, '\n  '), value: parsed, valid: isProcessRecord(parsed) };
}

function documentText(rows) {
  return rows.length === 0 ? '[]\n' : `[\n  ${rows.map((row) => row.raw).join(',\n  ')}\n]\n`;
}

const describe = (error) => error?.code ?? error?.message ?? String(error);
const sameAsAny = (value, others) => others.some((other) => isDeepStrictEqual(other, value));

export class OwnedProcessRecord {
  #file; #ownerPid; #ownerIdentity; #io; #writeDurably; #report;

  /**
   * @param {string} file
   * @param {{ownerPid?: number, ownerIdentity?: unknown, io?: typeof fs,
   *   writeDurably?: typeof writeFileDurably, report?: (line: string) => void}} [options]
   */
  constructor(file, { ownerPid = process.pid, ownerIdentity = null, io = fs, writeDurably = writeFileDurably,
    report = (line) => process.stderr.write(line) } = {}) {
    this.#file = file;
    this.#ownerPid = ownerPid;
    this.#ownerIdentity = ownerIdentity;
    this.#io = io;
    this.#writeDurably = writeDurably;
    this.#report = report;
  }

  /**
   * What the file says now. Never writes, never reports, never throws.
   * @returns {{status: 'missing'|'readable'|'unreadable', reason?: 'read-failed'|'corrupt'|'unsupported',
   *   problem?: string, entries: object[], unknownRows: number}}
   */
  load() {
    const { status, reason, problem, rows } = this.#read();
    return { status, ...(reason ? { reason, problem } : {}), entries: rows.filter((row) => row.valid).map((row) => row.value),
      unknownRows: rows.filter((row) => !row.valid).length };
  }

  /**
   * Record a process this owner started, replacing a recognised row with the same id. `entry` is returned exactly as
   * written, or as attempted when the write failed, so the caller keeps the identity either way.
   */
  started(entry) {
    const owner = Number(entry?.owner ?? this.#ownerPid);
    // The owner's birth identity belongs to the owner PID it was captured for, never to a row recorded for another.
    const ownerIdentity = Object.hasOwn(entry ?? {}, 'ownerIdentity') ? entry.ownerIdentity
      : owner === this.#ownerPid ? this.#ownerIdentity : null;
    const attempted = {
      id: String(entry?.id), pid: Number(entry?.pid), service: String(entry?.service ?? ''),
      launcher: String(entry?.launcher ?? ''), owner,
      ...(ownerIdentity != null ? { ownerIdentity } : {}),
      startedAt: Number(entry?.startedAt ?? Date.now()),
      ...(entry?.groupScope !== undefined ? { groupScope: entry.groupScope } : {}),
      // Supplied by the live spawn owner; this writer never reads a PID's current token to repair an old record.
      ...(Object.hasOwn(entry ?? {}, 'startToken') ? { startToken: linuxStartTokenFrom(entry.startToken, Number(entry.pid)) } : {}),
    };
    const action = 'record a started process';
    let row;
    try { row = rowFrom(attempted); } catch (error) { return { ...this.#failed(action, `it is not JSON (${describe(error)})`), entry: attempted }; }
    if (!row.valid) return { ...this.#failed(action, 'it does not name a process (string id, integer pid)'), entry: row.value };
    const outcome = this.#change(action, (rows) => [...rows.filter((r) => !(r.valid && r.value.id === row.value.id)), row]);
    return { ...outcome, entry: row.value };
  }

  /**
   * Keep `entries` recorded: append each one no current row equals exactly, in one write. Current rows, including
   * unknown ones and rows sharing an id, are never replaced; nothing is rebuilt from an id.
   */
  retain(entries) {
    const action = 'retain unresolved processes';
    if (!Array.isArray(entries)) return { ...this.#failed(action, 'entries is not a list'), added: [], rejected: [] };
    const wanted = [], rejected = [];
    for (const entry of entries) {
      let row = null;
      try { row = rowFrom(entry); } catch { /* rejected below */ }
      // Exactly as given or not at all: a row JSON would change could not later be retired by equality.
      if (!row?.valid || !isDeepStrictEqual(row.value, entry)) rejected.push(entry);
      else if (!sameAsAny(row.value, wanted.map((w) => w.value))) wanted.push(row);
    }
    let added = [];
    const outcome = this.#change(action, (rows) => {
      added = wanted.filter((w) => !sameAsAny(w.value, rows.filter((r) => r.valid).map((r) => r.value)));
      return added.length ? [...rows, ...added] : null;
    });
    if (rejected.length) this.#say(`could not retain ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} in ${this.#file}: not an exact process row`);
    return { ...outcome, ok: outcome.ok && rejected.length === 0, added: outcome.ok ? added.map((r) => r.value) : [], rejected };
  }

  /**
   * Forget exactly `expectedEntries`: every recognised current row structurally equal to one of them, in one write.
   * Rows added or changed since the caller's snapshot, and unknown rows, stay. A row already gone is `unmatched`.
   */
  retire(expectedEntries) {
    const action = 'retire processes';
    if (!Array.isArray(expectedEntries)) return { ...this.#failed(action, 'expectedEntries is not a list'), removed: [], unmatched: [] };
    const doc = this.#read();
    if (doc.status === 'unreadable') {
      return { ...this.#failed(action, `${doc.problem}; nothing was removed or written`), removed: [], unmatched: expectedEntries };
    }
    const kept = doc.rows.filter((row) => !(row.valid && sameAsAny(row.value, expectedEntries)));
    const removed = doc.rows.filter((row) => !kept.includes(row)).map((row) => row.value);
    const unmatched = expectedEntries.filter((expected) => !sameAsAny(expected, removed));
    if (removed.length === 0) return { ok: true, written: false, removed, unmatched };
    const outcome = this.#write(action, kept);
    return { ...outcome, removed: outcome.ok ? removed : [], unmatched: outcome.ok ? unmatched : expectedEntries };
  }

  /** Read, compose the next rows (null: no change), copy damaged bytes aside if replacing them, then write. */
  #change(action, compose) {
    const doc = this.#read();
    if (doc.reason === 'read-failed') return this.#failed(action, `${doc.problem}; nothing was written`);
    const next = compose(doc.rows);
    if (next === null) return { ok: true, written: false };
    let aside;
    if (doc.status === 'unreadable') {
      aside = this.#preserve(doc);
      if (!aside.ok) return this.#failed(action, `${doc.problem}, and its bytes could not be kept aside (${aside.problem}); the record was not replaced`);
    }
    return this.#write(action, next, aside?.path);
  }

  #read() {
    let bytes;
    try {
      bytes = this.#io.readFileSync(this.#file);
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing', rows: [] };
      return { status: 'unreadable', reason: 'read-failed', problem: `it could not be read (${describe(error)})`, rows: [] };
    }
    return parseOwnedDocument(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes)));
  }

  #preserve(doc) {
    const aside = `${this.#file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    try {
      this.#writeDurably(aside, doc.bytes);
    } catch (error) {
      return { ok: false, problem: describe(error) };
    }
    this.#say(`${this.#file} could not be read as a process record (${doc.problem}). Its exact bytes are kept at ${aside} `
      + 'before it is replaced; any process it named is untracked and must be ended by hand.');
    return { ok: true, path: aside };
  }

  #write(action, rows, aside) {
    let renamed = false;
    const renameSync = (from, to) => { this.#io.renameSync(from, to); renamed = true; };
    try {
      this.#io.mkdirSync(path.dirname(this.#file), { recursive: true });
      this.#writeDurably(this.#file, documentText(rows), { renameSync });
      return { ok: true, written: true, ...(aside ? { aside } : {}) };
    } catch (error) {
      const problem = renamed ? `the new record is in place but could not be made durable (${describe(error)})`
        : `the record was not replaced (${describe(error)})`;
      return { ...this.#failed(action, problem), targetReplaced: renamed, ...(aside ? { aside } : {}) };
    }
  }

  #failed(action, problem) {
    this.#say(`could not ${action} in ${this.#file}: ${problem}`);
    return { ok: false, written: false, targetReplaced: false, problem };
  }

  #say(text) {
    try { this.#report(`[aify-env] ${text}\n`); } catch { /* a report that cannot be made must not become the failure */ }
  }
}
