// "Did my restart take?" -- asked after every fix, and answerable only by a human with two hashes.
//
// The two numbers existed. The banner showed what the running daemon LOADED, `aify-env --version`
// showed what is on DISK, and `lib/build-identity.mjs` says how they compare: equal means current,
// different means restart. What was missing is that somebody had to run a command and compare eight
// hex characters by eye, and the operator said plainly what that was worth: they would never do it.
//
// FOUR STATES, each sending a reader somewhere different: current, stale, nothing answered, and a
// daemon too old to report the pair. The last is UNANSWERED and not a quiet pass, and it is the one
// most likely to be got wrong -- it lands exactly in the case this row exists for, an operator
// upgrading from a build that predates the field and asking whether the upgrade took. This project
// has shipped a check that reported no evidence as a pass twice.

import { test } from "node:test";
import assert from "node:assert/strict";

import { codeCurrentCheck } from "../lib/environment-checks.mjs";
import { collectEnvironmentChecks } from "../lib/environment-report.mjs";
import { STATE } from "../lib/health.mjs";

test("running the code on disk PASSES, and says which build", () => {
  const check = codeCurrentCheck({ answered: true, build: "aaaa1111", codeOnDisk: "aaaa1111" });
  assert.equal(check.state, STATE.PASSED);
  assert.match(check.detail, /aaaa1111/);
});

test("a daemon behind its own disk FAILS, and prints BOTH identities", () => {
  const check = codeCurrentCheck({ answered: true, build: "aaaa1111", codeOnDisk: "bbbb2222" });
  assert.equal(check.state, STATE.FAILED);
  // Both, because the remedy costs the operator their running agents. Advice with that price on it
  // has to be arguable, and an operator who thinks the row is wrong needs the numbers to check it.
  assert.match(check.detail, /aaaa1111/);
  assert.match(check.detail, /bbbb2222/);
  assert.match(check.fix, /restart/i);
  assert.match(check.fix, /reaps the managed workers/,
    "the fix names a restart without saying it kills the workers, which is the whole cost of taking it");
});

test("no aify-env answering is UNANSWERED, not current", () => {
  const check = codeCurrentCheck({ answered: false });
  assert.equal(check.state, STATE.UNANSWERED);
});

test("a daemon too old to report the pair is UNANSWERED, not current", () => {
  // The trap. This is precisely the state an operator is in while upgrading, and reporting it as a
  // pass would answer "did the upgrade take?" with "yes" on the evidence of nothing.
  for (const half of [
    { build: "aaaa1111" },
    { codeOnDisk: "aaaa1111" },
    { build: "", codeOnDisk: "" },
  ]) {
    const check = codeCurrentCheck({ answered: true, ...half });
    assert.equal(check.state, STATE.UNANSWERED, `${JSON.stringify(half)} did not read as unanswered`);
  }
});

test("THE ROW IS ACTUALLY COLLECTED, in both branches of the report", async () => {
  // A predicate proven in isolation leaves its call site unproven, and that is exactly where this
  // repo's doctor has failed before: an early return answered a case itself and never consulted the
  // verdict. So this drives the collector, not the predicate.
  const base = {
    readRegistry: () => ({ missing: true }),
    terminalSupport: () => ({ supported: true, reason: "" }),
    readCredentialStore: async () => ({ names: [] }),
    endpoint: "http://127.0.0.1:8802",
  };

  const live = await collectEnvironmentChecks({
    ...base,
    knock: async () => ({
      ok: true,
      status: 200,
      body: {
        status: "healthy", pid: 1, instance: "i1", processes: [], unknown: [],
        terminals: {}, build: "aaaa1111", codeOnDisk: "bbbb2222",
      },
    }),
  });
  const stale = live.find((c) => c.id === "code-current");
  assert.ok(stale, "the report carried no code-current row at all");
  assert.equal(stale.state, STATE.FAILED);

  // And when nothing answers, the row is still THERE and unanswered -- absent is the shape this
  // doctor has been burned by: a row that vanishes takes its question with it and an operator
  // counting rows never learns one went missing.
  const silent = await collectEnvironmentChecks({
    ...base,
    knock: async () => ({ ok: false, error: "ECONNREFUSED" }),
  });
  const missing = silent.find((c) => c.id === "code-current");
  assert.ok(missing, "no aify-env answered and the row disappeared rather than reading unanswered");
  assert.equal(missing.state, STATE.UNANSWERED);
});
