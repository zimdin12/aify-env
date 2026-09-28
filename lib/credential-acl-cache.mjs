// A credential file's ACL, read once per change of the file instead of once per read of the key.
//
// WHY. `inspectCredentialFile` asks `icacls` for the DACL on every read, and the daemon reads the key
// on every call the aify-comms plugin makes and on every HTTP request it answers. On Windows the spawn
// itself runs on the event loop. Profiled on the operator's daemon 2026-09-28 (30 s, three workers):
// 80% of the main thread's wall time was the native `spawn` under `readAcl`, and every request and
// every keystroke echo queued behind it -- stalls of 250-300 ms about twice a second, up to 3 s. That
// is the lag the operator saw in every herdr-aify pane, worse when an agent's subagents made output.
//
// WHAT IS REUSED IS THE ACL TEXT, NEVER THE KEY. The key's bytes are still read on every call, so a
// rotated key is presented the moment it is on disk (credential-resolve.mjs says why a cache of the
// value was removed: it saved nothing and could serve a stale key). The verdict is recomputed from
// the text every time too; only the `icacls` answer is kept.
//
// KEYED ON WHAT AN ACL CHANGE MOVES. Measured on this host 2026-09-28 with lstat: an ACL-only grant or
// removal moves `ctime` (NTFS ChangeTime) and nothing else; an atomic replacement moves `ino` and
// `ctime`; doing nothing moves neither. So device, inode and ctime together change whenever the answer
// could. The TTL is the backstop for a filesystem that keeps no ChangeTime: the check exists to refuse
// a key others could read, and a widened ACL is caught within a minute at worst. MONOTONIC, and an age
// below zero counts as expired, so a wall clock set back cannot stretch that minute (review 2026-09-29).
//
// FAILURES ARE NOT KEPT. An empty answer (icacls could not run) already refuses the key; keeping it
// would go on refusing after the cause had passed, so the next read asks again.

import { performance } from "node:perf_hooks";

import { readAcl } from "./credential-fs.mjs";

/** How long one `icacls` answer is trusted for an unchanged file. */
export const ACL_CACHE_MS = 60_000;

export class CredentialAclCache {
  #read;

  #ttlMs;

  #now;

  /** target -> {fingerprint, at, text: Promise<string>} */
  #entries = new Map();

  constructor({ read = readAcl, ttlMs = ACL_CACHE_MS, now = () => performance.now() } = {}) {
    this.#read = read;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /**
   * The ACL text for `target`, whose `lstat` is `stats`. Concurrent reads of a cold entry share one
   * `icacls`.
   */
  async read(target, stats) {
    const fingerprint = `${stats.dev}:${stats.ino}:${stats.ctimeMs}`;
    const at = this.#now();
    const held = this.#entries.get(target);
    const age = held ? at - held.at : -1;
    if (held && held.fingerprint === fingerprint && age >= 0 && age < this.#ttlMs) return held.text;
    // Never rejects: a reader that throws answers empty, which refuses the key like icacls failing.
    const text = Promise.resolve().then(() => this.#read(target))
      .then((answer) => String(answer || ""), () => "");
    const entry = { fingerprint, at, text };
    this.#entries.set(target, entry);
    const answer = await text;
    if (!answer && this.#entries.get(target) === entry) this.#entries.delete(target);
    return answer;
  }
}
