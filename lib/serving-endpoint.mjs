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
//   * more than one live daemon is left unresolved rather than guessed between.
// BOUNDED: 17 invocations sat on the operator's host that day. The invocation directories are dated
// by their own mtime, which writing ready.json moves, and only the newest RECEIPT_LIMIT receipts are
// READ and probed, in parallel. The directory listing and its stats are metadata; no file past the
// limit is opened (review: every ready.json used to be read before the cap applied).

import fs from "node:fs";
import path from "node:path";

/** How many receipts are probed. The live daemon's receipt is the newest one it wrote. */
export const RECEIPT_LIMIT = 8;

const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/** A pid and an instance that can identify a daemon: a positive integer and a non-empty string. */
function identifies(pid, instance) {
  return Number.isInteger(pid) && pid > 0 && typeof instance === "string" && instance.length > 0;
}

/** The valid `ready.json` receipts of the newest `limit` invocations under `profileRoot`, newest first. */
export function readyReceipts(profileRoot, io = fs, limit = RECEIPT_LIMIT) {
  const root = path.join(profileRoot, "invocations");
  let invocations;
  try {
    invocations = io.readdirSync(root);
  } catch {
    return [];
  }
  const dated = [];
  for (const invocation of invocations) {
    try {
      dated.push({ invocation, writtenMs: io.statSync(path.join(root, invocation)).mtimeMs });
    } catch {
      // Gone between the listing and the stat: not a candidate.
    }
  }
  const receipts = [];
  for (const { invocation, writtenMs } of dated.sort((a, b) => b.writtenMs - a.writtenMs).slice(0, limit)) {
    try {
      const receipt = JSON.parse(io.readFileSync(path.join(root, invocation, "ready.json"), "utf8"));
      if (!LOOPBACK_ENDPOINT.test(String(receipt?.endpoint ?? ""))) continue;
      if (!identifies(receipt.pid, receipt.envInstance)) continue;
      receipts.push({ endpoint: receipt.endpoint, pid: receipt.pid, envInstance: receipt.envInstance, writtenMs });
    } catch {
      // Never became ready, or unreadable: not a candidate.
    }
  }
  return receipts;
}

/**
 * The endpoint of the one live daemon the receipts name, or "" when none or several answer.
 *
 * @param fetchHealth  `GET {endpoint}/health` as parsed JSON, or null when it did not answer
 */
export async function discoverServingEndpoint({ receipts, fetchHealth, limit = RECEIPT_LIMIT }) {
  const probed = receipts.slice(0, limit);
  const answers = await Promise.all(probed.map((receipt) => fetchHealth(receipt.endpoint)));
  const live = probed.filter((receipt, i) => identifies(receipt.pid, receipt.envInstance)
    && identifies(answers[i]?.pid, answers[i]?.instance)
    && answers[i].pid === receipt.pid && answers[i].instance === receipt.envInstance);
  return live.length === 1 ? live[0].endpoint : "";
}
