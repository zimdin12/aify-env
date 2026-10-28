// The aify-dashboard plugin's parts that another of its modules imports, each asked for the rule its own file states.
//
// The plugin's suites drive these through the plugin as a whole, so a rule could change in the part while the plugin's
// tests still passed for another reason. Asked of the part, each says whether its own rule holds.

import assert from "node:assert/strict";
import { test } from "node:test";

import { PLATFORM_OF } from "../lib/plugins/aify-dashboard/locations.mjs";
import { CONFIG_KEY, RUN_EVERY_MS, SCRIPT, checkoutOf, servableNow } from "../lib/plugins/aify-dashboard/provider-runner.mjs";
import { BATCH_SIZE, RangeReporter } from "../lib/plugins/aify-dashboard/range-reporter.mjs";
import { watchRootsFrom, withinWatchRoots } from "../lib/watch-roots.mjs";

test("PLATFORM_OF: a windows namespace's paths compare as Windows paths, whatever this host runs on", () => {
  const roots = watchRootsFrom(JSON.stringify({ watchRoots: ["C:/Work"] }), PLATFORM_OF.windows).roots;
  assert.equal(withinWatchRoots("c:\\work\\A", roots, PLATFORM_OF.windows), true);
  assert.equal(withinWatchRoots("c:\\work\\A", roots, "linux"), false, "CONTROL: compared as posix paths, it is outside");
});

test("RUN_EVERY_MS: the provider runner's header says once a minute, and this pins the number to those words", () => {
  assert.equal(RUN_EVERY_MS, 60_000);
});

test("checkoutOf: each missing piece is named against CONFIG_KEY, and a checkout holding the script yields it", () => {
  const has = (...paths) => (p) => paths.some((x) => p.replaceAll("\\", "/") === x);
  assert.match(checkoutOf({}).problem, new RegExp(`no ${CONFIG_KEY.replace(/[[\]"]/g, "\\$&")} is set`));
  assert.match(checkoutOf({ providerCheckout: "relative" }).problem, /must be an absolute folder/);
  const root = process.platform === "win32" ? "C:/p" : "/p";
  assert.match(checkoutOf({ providerCheckout: root }, has()).problem, /does not exist/);
  assert.match(checkoutOf({ providerCheckout: root }, has(root)).problem, /has no scripts\/serve-provider-requests\.mjs/);
  const script = `${root}/${SCRIPT.replaceAll("\\", "/")}`;
  assert.equal(checkoutOf({ providerCheckout: root }, has(root, script)).script.replaceAll("\\", "/"), script);
});

test("servableNow: the folder must be the project's, and both its listed path and its real folder inside the grant", () => {
  const roots = ["/grant"];
  const realpath = (p) => (p === "/grant" ? "/real/grant" : p);
  const folder = { projectId: "p1", path: "/grant/app", real: "/real/grant/app", platform: "linux" };
  assert.equal(servableNow(folder, "p1", roots, { realpath }), true);
  assert.equal(servableNow(folder, "p2", roots, { realpath }), false, "another project's folder");
  assert.equal(servableNow({ ...folder, real: "/elsewhere/app" }, "p1", roots, { realpath }), false, "listed inside, really outside");
  assert.equal(servableNow({ ...folder, path: "/other/app" }, "p1", roots, { realpath }), false, "listed outside");
});

/** A git that answers from a fixed history and counts its reads, and an api that records what it was sent. */
function fixtures({ history = ["a", "b", "c"], held = history, state = "complete" } = {}) {
  const reads = { between: 0 };
  const git = {
    hasCommit: async (_, sha) => held.includes(sha),
    contains: async (_, ancestor, descendant) => history.indexOf(ancestor) <= history.indexOf(descendant),
    commitsBetween: async (_, base, head) => {
      reads.between += 1;
      return history.slice(history.indexOf(base) + 1, history.indexOf(head) + 1).map((sha) => ({ sha }));
    },
  };
  const sent = [];
  const api = {
    resync: async (body) => sent.push(["resync", body.reason]),
    openRange: async () => { sent.push(["open"]); return { rangeId: "r1" }; },
    sendBatch: async (_, batch) => { sent.push(["batch", batch.commits.map((c) => c.sha)]); return { state }; },
  };
  return { reads, sent, reporter: new RangeReporter({ api, git, machineId: "m", reporter: "rep" }) };
}

const request = (ackedHead, head) => ({ path: "/w", places: {}, head, cursor: { ackedHead, cursorRevision: 1 } });

test("RangeReporter: a forward range is sent oldest first, a range not finished is resent without reading git again", async () => {
  const covered = fixtures();
  assert.deepEqual(await covered.reporter.sync(request("c", "c")), { kind: "covered" });
  assert.deepEqual(covered.sent, [], "a covered folder sent something");

  const open = fixtures({ state: "open" });
  assert.deepEqual(await open.reporter.sync(request("a", "c")), { kind: "range", commits: 2, state: "open" });
  await open.reporter.sync(request("a", "c"));
  assert.deepEqual(open.sent, [["open"], ["batch", ["b", "c"]], ["open"], ["batch", ["b", "c"]]]);
  assert.equal(open.reads.between, 1, "a retried range read git again");

  const done = fixtures();
  await done.reporter.sync(request("a", "c"));
  await done.reporter.sync(request("a", "c"));
  assert.equal(done.reads.between, 2, "CONTROL: a range the dashboard completed is forgotten, so asking again reads again");
});

test("RangeReporter: no forward range is resynced with the reason the dashboard names, never invented", async () => {
  const back = fixtures();
  assert.deepEqual(await back.reporter.sync(request("c", "a")), { kind: "resync", reason: "reset" });
  const gone = fixtures({ held: ["c"] });
  assert.deepEqual(await gone.reporter.sync(request("a", "c")), { kind: "resync", reason: "missing_object" });
  const apart = fixtures();
  apart.reporter = new RangeReporter({ api: { resync: async () => {} }, machineId: "m", reporter: "rep",
    git: { hasCommit: async () => true, contains: async () => false } });
  assert.deepEqual(await apart.reporter.sync(request("x", "y")), { kind: "resync", reason: "unknown" });
});

test("RangeReporter: a range longer than BATCH_SIZE goes in batches of it", async () => {
  const history = Array.from({ length: BATCH_SIZE + 2 }, (_, i) => `s${i}`);
  const long = fixtures({ history });
  await long.reporter.sync(request("s0", history.at(-1)));
  assert.deepEqual(long.sent.filter(([kind]) => kind === "batch").map(([, shas]) => shas.length), [BATCH_SIZE, 1]);
});
