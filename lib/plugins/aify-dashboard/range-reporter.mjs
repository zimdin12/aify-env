// Reporting the commits between the head aify-dashboard has accepted and the head a folder is at.
//
// A RANGE ONLY GOES FORWARD. When the accepted head is in the new head's history, the commits between
// them are sent as one range, oldest first, in batches of 50. When it is not (a reset, a rebase, a
// branch switched to unrelated history, or a commit this clone no longer holds), there is no forward
// range to send, and the dashboard is told to resync instead: coverage moves to the new head, and the
// history in between is recorded as a gap rather than invented.
//
// GIT LOG RUNS ONCE PER RANGE, not once per tick. The commits for a (base, target) pair are kept until a
// different pair is asked for, so a range the dashboard refused for a moment is retried without reading
// the history again.
//
// A RETRIED BATCH IS THE SAME BATCH. The dashboard keys a batch by its index and a hash of its content,
// answers an identical retry from storage, and refuses a different one; batches are cut from the kept
// commits, so a retry cannot differ.
//
// The ids it reads between come from the dashboard and are checked by the git reader before git sees them.

/** How many commits one batch carries. The dashboard's contract (DESIGN-SLICES-4-6, "Commit reports"). */
export const BATCH_SIZE = 50;

/** The batches of one range: index from 0, each after the previous batch's last commit, the last one closing it. */
export function batchesOf(commits, size = BATCH_SIZE) {
  const batches = [];
  for (let start = 0; start < commits.length; start += size) {
    const slice = commits.slice(start, start + size);
    batches.push({
      batchIndex: batches.length,
      afterSha: start === 0 ? null : commits[start - 1].sha,
      commits: slice,
      hasMore: start + size < commits.length,
    });
  }
  return batches;
}

export class RangeReporter {
  #api;
  #git;
  #machineId;
  #reporter;
  /** path -> the commits read for one (base, target), so a retry does not read them again */
  #read = new Map();

  /**
   * @param {object} deps
   * @param {import("./dashboard-api.mjs").DashboardApi} deps.api
   * @param {import("./git-reader.mjs").GitReader} deps.git
   * @param {string} deps.machineId
   * @param {string} deps.reporter  this daemon's reporter id; the dashboard lets only a range's opener send to it
   */
  constructor({ api, git, machineId, reporter }) {
    this.#api = api;
    this.#git = git;
    this.#machineId = machineId;
    this.#reporter = reporter;
  }

  /**
   * Bring the dashboard's coverage of one folder up to `head`.
   *
   * @param {{path: string, head: string, cursor: {ackedHead: string, cursorRevision: number}, signal?: AbortSignal}} request
   * @returns {Promise<{kind: "covered"} | {kind: "range", commits: number, state: string} | {kind: "resync", reason: string}>}
   */
  async sync({ path, head, cursor, signal }) {
    const { ackedHead, cursorRevision } = cursor;
    if (ackedHead === head) return { kind: "covered" };

    const reason = await this.#cannotGoForward(path, ackedHead, head, signal);
    if (reason !== null) {
      await this.#api.resync({ machineId: this.#machineId, path, oldHead: ackedHead, newHead: head, reason, cursorRevision, reporter: this.#reporter }, { signal });
      this.#read.delete(path);
      return { kind: "resync", reason };
    }

    const commits = await this.#commits(path, ackedHead, head, signal);
    const range = await this.#api.openRange({ machineId: this.#machineId, path, baseHead: ackedHead, targetHead: head, cursorRevision, reporter: this.#reporter }, { signal });
    let state = "open";
    for (const batch of batchesOf(commits)) {
      const receipt = await this.#api.sendBatch(range.rangeId, { reporter: this.#reporter, ...batch }, { signal });
      state = receipt.state;
    }
    this.#read.delete(path);
    return { kind: "range", commits: commits.length, state };
  }

  /** Why no forward range exists from `ackedHead` to `head`, as the dashboard names it, or null when one does. */
  async #cannotGoForward(path, ackedHead, head, signal) {
    if (!(await this.#git.hasCommit(path, ackedHead, { signal }))) return "missing_object";
    if (await this.#git.contains(path, ackedHead, head, { signal })) return null;
    // Backwards along the same history is a reset; anything else (a rebase, another branch) cannot be told apart
    // from here with certainty, and the dashboard has a word for that.
    return (await this.#git.contains(path, head, ackedHead, { signal })) ? "reset" : "unknown";
  }

  async #commits(path, base, target, signal) {
    const kept = this.#read.get(path);
    if (kept && kept.base === base && kept.target === target) return kept.commits;
    const commits = await this.#git.commitsBetween(path, base, target, { signal });
    if (commits.length === 0) throw new Error(`git found no commits between ${base} and ${target}, though one is in the other's history`);
    this.#read.set(path, { base, target, commits });
    return commits;
  }
}
