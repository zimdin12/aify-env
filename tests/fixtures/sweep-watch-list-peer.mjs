// An opt-in scratch receiver for the two composed sweep tests. The real watch-list, HEAD and
// history routes are never intercepted. The tests still own the provider poll and APG subprocess.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { machineIdFor } from "../../lib/client/machine-id.mjs";
import { hostIsWsl } from "../../lib/host-wsl.mjs";
import { readWslLocation } from "../../lib/plugins/aify-dashboard/wsl-location.mjs";

const URL_VAR = "AIFY_TEST_WATCH_LIST_SCRATCH";
const KEY_VAR = "AIFY_TEST_WATCH_LIST_KEY_FILE";
const SHA_VAR = "AIFY_TEST_WATCH_LIST_RECEIVER_SHA";
const RECEIPTS_VAR = "AIFY_TEST_WATCH_LIST_RECEIPTS";

export function sweepWatchListSkip() {
  if (process.platform === "win32") return false;
  if (!hostIsWsl()) return "the paired native watch-list fixture is run on WSL";
  return process.env[URL_VAR] ? false : `paired WSL proof requires a scratch dashboard (${URL_VAR})`;
}

function scratchEndpoint() {
  const url = new URL(process.env[URL_VAR]);
  const ip = url.hostname.split(".").map(Number);
  const privateIp = ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168);
  assert.ok(url.protocol === "http:" && isIP(url.hostname) === 4 && privateIp && url.port === "9794"
    && url.href === `${url.origin}/`, "the paired test requires the dedicated private scratch endpoint on port 9794");
  return url.origin;
}

const gitPlacementRoute = path => path === "/reports/head" || path === "/reports/file-list"
  || /^\/instances\/[^/]+\/(commit-ranges|resync)$/.test(path) || /^\/commit-ranges\/[^/]+\/batches$/.test(path);

export async function sweepWatchListPeer(folder) {
  if (process.platform === "win32") return null;
  const endpoint = scratchEndpoint();
  const sha = process.env[SHA_VAR] ?? "";
  assert.match(sha, /^[0-9a-f]{40}$/, "the scratch receiver's exact commit must be named");
  const health = await fetch(`${endpoint}/health`, { redirect: "error" });
  assert.equal(health.status, 200, "private scratch receiver must answer health");
  assert.equal((await health.json()).gitSha, sha, "scratch receiver exact build must match");
  const key = readFileSync(process.env[KEY_VAR], "utf8").trim();
  assert.ok(key.length >= 32, "scratch key file must contain the fixture key");
  const wsl = readWslLocation();
  assert.ok(hostIsWsl() && wsl, "native WSL and local placement facts are required");
  const hostKey = `env35-${randomUUID()}`;
  const machineId = machineIdFor({ platform: process.platform, hostname: hostKey, isWsl: hostIsWsl() });
  const watchList = `/api/v1/host/${hostKey}/watch-list`;

  const register = async (name, path, machineId, wsl) => {
    const made = await fetch(`${endpoint}/api/v1/projects`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ name, root: { raw: path, canonical: path, machineId, ...(wsl ? { wsl } : {}) } }) });
    assert.equal(made.status, 201, `fresh scratch registration: ${name}`);
    return (await made.json()).id;
  };
  const canonical = realpathSync.native(folder);
  const projectId = await register("Own WSL fixture", canonical, machineId, wsl);
  const windows = await register("Windows control", "C:/env35-fixture", `win32:${hostKey}`);
  const other = await register("Other distro control", canonical, machineId,
    { ...wsl, distroId: `other-${randomUUID()}` });
  const linux = await register("Native Linux control", canonical, `linux:${hostKey}`);
  const outside = await register("Outside grant control", join(dirname(dirname(canonical)), `${hostKey}-outside`), machineId, wsl);
  const expected = [projectId, windows, other, linux, outside].sort();
  assert.equal(new Set(expected).size, 5, "distinct fixture locations must not merge");

  const acknowledgements = new Map();
  const completedRanges = [];
  let listed = false;
  const transport = async (url, options, scripted) => {
    const at = new URL(url);
    assert.equal(at.origin, endpoint, "fixtures never send the scratch key to another endpoint");
    const path = at.pathname;
    if (path !== watchList && !gitPlacementRoute(path)) return scripted(at, options);
    const response = await fetch(url, options);
    assert.ok(response.ok, `scratch ${options.method} ${path} refused with ${response.status}`);
    const answer = await response.clone().json();
    if (path === watchList) {
      assert.deepEqual(answer.projects.map(project => project.projectId).sort(), expected);
      listed = true;
    } else if (path === "/reports/head") {
      const { head } = JSON.parse(options.body);
      assert.equal(answer.projectId, projectId, "HEAD lands on the registered distro's project");
      acknowledgements.set(head, { ackedHead: answer.ackedHead, cursorRevision: answer.cursorRevision });
    } else if (path.endsWith("/batches") && answer.state === "complete") {
      completedRanges.push(answer.rangeId);
    }
    return response;
  };
  const receipt = (label, head, next = null) => {
    assert.ok(listed, "the real peer returned the five registered rows");
    assert.equal(acknowledgements.get(head)?.ackedHead, head, "the real peer acknowledged the first head");
    if (next !== null) {
      assert.equal(acknowledgements.get(next)?.ackedHead, next, "the real peer read back the new head and cursor");
      assert.equal(completedRanges.length, 1, "one real range completed");
    }
    if (process.env[RECEIPTS_VAR]) writeFileSync(join(process.env[RECEIPTS_VAR], `${label}.json`), JSON.stringify({
      receiver: sha, projectId, windows, other, linux, outside, head, next, accepted: acknowledgements.get(next ?? head), completedRanges,
    }, null, 2));
  };
  return { endpoint, key, hostKey, machineId, projectId, transport, receipt,
    acknowledged: head => acknowledgements.get(head)?.ackedHead === head };
}
