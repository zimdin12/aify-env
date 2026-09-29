// Which aify-env serves this host when the configured address is silent: a `herdr-aify env` daemon.
//
// THE DEFECT (external review of 0.7.6, T3). `aify-env doctor` probed only `AIFY_ENV_ENDPOINT` or
// 8802, and a `herdr-aify env` runs a dedicated aify-env on a port the OS picks (63204 on 2026-09-29).
// So the doctor said "no environment is running" while one ran every managed worker on the host.
//
// THE DAEMON SAYS WHERE IT IS: at readiness it writes `ready.json` into its invocation directory
// (`publishInstanceReady`, instance-bootstrap.mjs) with its endpoint, pid and instance. Invocations
// outlive their daemons, so a receipt is only a candidate. The trust rule is the one aify-comms'
// doctor uses (mcp/stdio/serving-env-endpoint.mjs there):
//   * only a loopback endpoint is a candidate, so a file cannot aim a probe elsewhere;
//   * a receipt counts only when it carries a positive integer pid and a non-empty instance, and
//     that endpoint's /health answers with the SAME pid and instance (review: two empty instances
//     used to match, so a receipt with none authorized any process with its pid);
//   * more than one live daemon among the receipts checked is left unresolved rather than guessed
//     between. NARROWED: uniqueness holds among the receipts checked, not all of them. The operator's
//     host held 15 ready receipts under a cap of 8, so "unresolved whenever one went unchecked" would
//     read unanswered on every run; the caller names the unchecked count instead (review, round 3).
// BOUNDED CONTENT, NOT METADATA: 17 invocations sat on the operator's host that day. Each invocation's
// ready.json is dated by a stat, so an invocation that never became ready is never a candidate (review:
// dating the directories let eight failed launches crowd out an older live one). The newest
// RECEIPT_LIMIT ready.json files are opened, whatever they hold, and the valid ones are probed in
// parallel (review, round 3: capping VALID receipts let 1,000 malformed files cost 1,000 opens). The
// listing and the stats are O(invocations) metadata; content opens and probes are bounded.
// INCOMPLETE IS SAID: when nothing answered and some ready receipts were left unread, the caller is
// told how many, so "no environment" is never claimed from a partial look.

import fs from "node:fs";
import path from "node:path";

/** How many receipts are probed. The live daemon's receipt is the newest one it wrote. */
export const RECEIPT_LIMIT = 8;

const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/** A pid and an instance that can identify a daemon: a positive integer and a non-empty string. */
function identifies(pid, instance) {
  return Number.isInteger(pid) && pid > 0 && typeof instance === "string" && instance.length > 0;
}

/**
 * The valid receipts among the newest `limit` `ready.json` files under `profileRoot`, newest first,
 * and how many ready files were left unopened.
 */
export function readyReceipts(profileRoot, io = fs, limit = RECEIPT_LIMIT) {
  const root = path.join(profileRoot, "invocations");
  let invocations;
  try {
    invocations = io.readdirSync(root);
  } catch {
    return { receipts: [], unread: 0 };
  }
  const ready = [];
  for (const invocation of invocations) {
    const file = path.join(root, invocation, "ready.json");
    try {
      ready.push({ file, writtenMs: io.statSync(file).mtimeMs });
    } catch {
      // Never became ready: not a candidate.
    }
  }
  ready.sort((a, b) => b.writtenMs - a.writtenMs);
  const opened = ready.slice(0, limit);
  const receipts = [];
  for (const { file, writtenMs } of opened) {
    try {
      const receipt = JSON.parse(io.readFileSync(file, "utf8"));
      if (!LOOPBACK_ENDPOINT.test(String(receipt?.endpoint ?? ""))) continue;
      if (!identifies(receipt.pid, receipt.envInstance)) continue;
      receipts.push({ endpoint: receipt.endpoint, pid: receipt.pid, envInstance: receipt.envInstance, writtenMs });
    } catch {
      // Unreadable or malformed: not a candidate.
    }
  }
  return { receipts, unread: ready.length - opened.length };
}

/**
 * The endpoint of the one live daemon the receipts name ("" when none or several answer), and how many
 * ready receipts went unchecked, which is what makes an empty answer incomplete rather than "none".
 *
 * @param fetchHealth  `GET {endpoint}/health` as parsed JSON, or null when it did not answer
 */
export async function discoverServingEndpoint({ receipts, unread = 0, fetchHealth, limit = RECEIPT_LIMIT }) {
  const probed = receipts.slice(0, limit);
  const answers = await Promise.all(probed.map((receipt) => fetchHealth(receipt.endpoint)));
  const live = probed.filter((receipt, i) => identifies(receipt.pid, receipt.envInstance)
    && identifies(answers[i]?.pid, answers[i]?.instance)
    && answers[i].pid === receipt.pid && answers[i].instance === receipt.envInstance);
  return { endpoint: live.length === 1 ? live[0].endpoint : "", unchecked: unread + receipts.length - probed.length };
}
