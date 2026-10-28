// The definition store's lock (agent-definitions.mjs), and the process probe it decides a holder's fate by (0.9.9;
// moved out of agent-definitions.mjs).
//
// ONE HOLD PER STORE CALL. The store takes it before recovering and releases it after its call's work; every durable
// step re-reads it (`check`) and stops if it is no longer this hold's. A lock is taken over only when its holder is a
// process ON THIS HOST that is no longer running: `admitStart` holds the lock while a worker's process is made, so an
// aify-env killed during a start left a lock that refused every later call until an operator ran `aify-env agents
// unlock` (external review of 0.8.1). A live holder, or one on another host, is still waited for and reported.
//
// IT IS HANDED THE STORE'S FOLDER and never names it: only the store may (tests/agent-definitions-have-one-writer).
//
// `processState` and `processAlive` live here because the lock is what they were written for; process-probe.mjs and
// serving-endpoint.mjs ask the same question of other pids.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DefinitionStoreError } from "./definition-errors.mjs";
import { createWhole, removeIfStill, sweepDeadGuards } from "./lock-break.mjs";

const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

/**
 * "alive", "gone" or "unknown". A signal-0 probe succeeds, or is refused (EPERM), only for a running
 * process, and ESRCH says there is none (measured on Windows: a protected live pid gives EPERM, an exited
 * one ESRCH). Any other failure proves neither, and a caller that acts must not read it as either (review
 * of 3f1e1ec: it collapsed to "gone").
 */
export function processState(pid, kill = process.kill.bind(process)) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "gone";
  try {
    kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "EPERM") return "alive";
    return error?.code === "ESRCH" ? "gone" : "unknown";
  }
}

/** Whether `pid` may still run: true unless it is proven gone, so a lock is broken only for a proven-dead holder. */
export function processAlive(pid, kill) {
  return processState(pid, kill) !== "gone";
}

/** A JSON file's value, or null when it is missing or torn. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** The store's `.lock`, taken and given back one call at a time. */
export class DefinitionLock {
  #dir;
  #lockPath;
  #pid;
  #waitMs;
  #nonce = null;

  constructor({ dir, pid = process.pid, waitMs = LOCK_WAIT_MS }) {
    this.#dir = dir;
    this.#lockPath = path.join(dir, ".lock");
    this.#pid = pid;
    this.#waitMs = waitMs;
  }

  /** This hold's id, or null when none is held: the store names its temporary files with it. */
  get nonce() { return this.#nonce; }

  async take() {
    fs.mkdirSync(this.#dir, { recursive: true });
    const nonce = randomUUID();
    const lockPath = this.#lockPath;
    const deadline = Date.now() + this.#waitMs;
    for (;;) {
      try {
        createWhole(lockPath, JSON.stringify({ pid: this.#pid, atMs: Date.now(), nonce, host: os.hostname() }));
        this.#nonce = nonce;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (this.#tookOverADeadHolder(lockPath)) continue;
      if (Date.now() >= deadline) {
        const holder = readJson(lockPath);
        const state = holder ? processState(holder.pid) : "gone";
        const alive = state !== "gone";
        throw new DefinitionStoreError(
          !holder && fs.existsSync(lockPath)
            ? `the store's lock is torn: an aify-env died while writing it, or is writing it now (${lockPath}). `
              + "If no aify-env is writing it, `aify-env agents unlock` removes that lock."
            : state === "alive"
              ? `the store is locked by running process ${holder.pid} (${lockPath})`
              : state === "unknown"
                ? `the store is locked by process ${holder.pid}, and whether it still runs could not be told (${lockPath})`
                : `the store is locked by process ${holder?.pid ?? "unknown"}, which is not running (${lockPath}). `
                  + "If no aify-env is writing it, `aify-env agents unlock` removes that lock.",
          { lockPath, holder, holderAlive: alive, holderState: state },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  /**
   * Remove the lock when its holder is a process on this host that is not running, and say so.
   *
   * The inference is safe in the direction that matters: a reused pid reads as RUNNING, which leaves the lock
   * waited for, as before. A lock written before this rule names no host and is this host's, because the store
   * is in this home.
   *
   * A TORN LOCK IS NEVER TAKEN. This version links a lock into place whole (`createWhole`), so it never leaves
   * one torn, but an aify-env from before that may be between its `open` and its `write`: it would then write its
   * still-open file and act under the taker's lock, since `admitStart` awaits its producer without `check`
   * (review of 18624c3). The refusal names `aify-env agents unlock`.
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
  check() {
    const holder = readJson(this.#lockPath);
    if (!holder || holder.nonce !== this.#nonce) {
      throw new DefinitionStoreError("the store's lock was taken from this operation; it stopped, and the next open recovers it");
    }
  }

  release() {
    if (!this.#nonce) return;
    const holder = readJson(this.#lockPath);
    if (holder?.nonce === this.#nonce) fs.unlinkSync(this.#lockPath);
    this.#nonce = null;
  }
}

/**
 * The operator's `unlock` of the store in `dir`: remove the lock only when its holder is not running. Returns what it
 * removed, or throws naming the live holder. Works while the store is locked.
 */
export function breakDefinitionLock(dir) {
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
  // Kept unless the holder is proven gone, and worded as what was observed: "unknown" is not "running".
  const holderState = holder ? processState(holder.pid) : "gone";
  if (holderState !== "gone") {
    throw new DefinitionStoreError(holderState === "alive"
      ? `the lock is held by running process ${holder.pid}; it was not removed`
      : `the lock is held by process ${holder.pid}, and whether it still runs could not be told; it was not removed`,
    { holder });
  }
  // Removed only if it is still the lock that was read, under the break lock: a new holder may have taken it.
  if (!removeIfStill(lockPath, text, { processAlive })) {
    throw new DefinitionStoreError("the lock changed while it was read, or another process is taking it over; nothing removed");
  }
  return holder ?? { torn: text };
}
