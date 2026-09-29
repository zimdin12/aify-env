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
//   * a receipt counts only when that endpoint's /health answers with the SAME pid and instance;
//   * more than one live daemon is left unresolved rather than guessed between.
// BOUNDED: 17 receipts sat on the operator's host that day. Only the newest RECEIPT_LIMIT are probed,
// in parallel, so the doctor waits one probe timeout, not one per stale receipt.

import fs from "node:fs";
import path from "node:path";

/** How many receipts are probed. The live daemon's receipt is the newest one it wrote. */
export const RECEIPT_LIMIT = 8;

const LOOPBACK_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/** The readable `ready.json` receipts under `profileRoot/invocations`, newest first. */
export function readyReceipts(profileRoot, io = fs) {
  let invocations;
  try {
    invocations = io.readdirSync(path.join(profileRoot, "invocations"));
  } catch {
    return [];
  }
  const receipts = [];
  for (const invocation of invocations) {
    const file = path.join(profileRoot, "invocations", invocation, "ready.json");
    try {
      const receipt = JSON.parse(io.readFileSync(file, "utf8"));
      if (!LOOPBACK_ENDPOINT.test(String(receipt?.endpoint ?? ""))) continue;
      receipts.push({ endpoint: receipt.endpoint, pid: Number(receipt.pid),
        envInstance: String(receipt.envInstance ?? ""), writtenMs: io.statSync(file).mtimeMs });
    } catch {
      // Never became ready, or unreadable: not a candidate.
    }
  }
  return receipts.sort((a, b) => b.writtenMs - a.writtenMs);
}

/**
 * The endpoint of the one live daemon the receipts name, or "" when none or several answer.
 *
 * @param fetchHealth  `GET {endpoint}/health` as parsed JSON, or null when it did not answer
 */
export async function discoverServingEndpoint({ receipts, fetchHealth, limit = RECEIPT_LIMIT }) {
  const probed = receipts.slice(0, limit);
  const answers = await Promise.all(probed.map((receipt) => fetchHealth(receipt.endpoint)));
  const live = probed.filter((receipt, i) => answers[i]
    && Number(answers[i].pid) === receipt.pid && String(answers[i].instance ?? "") === receipt.envInstance);
  return live.length === 1 ? live[0].endpoint : "";
}
