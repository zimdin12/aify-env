// A plugin is told whether it runs in a herdr's dedicated instance (`shared.dedicated`), because dedicated
// instances start service plugins too and a plugin that must run once per host has to decline there.
//
// bin/aify-env.mjs is never imported (it runs the daemon), so the property's own expression is taken out of the
// daemon's source and run against both kinds of instance context, as the credential wiring test does.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const daemon = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");

test("the daemon's shared.dedicated is true exactly when an instance context was prepared", () => {
  const lines = daemon.split(String.fromCharCode(10)).filter((line) => /^\s*dedicated:/.test(line));
  assert.equal(lines.length, 1, "the shared object's dedicated property must remain identifiable");
  const expression = lines[0].replace(/^\s*dedicated:/, "").replace(/,\s*$/, "");
  const evaluate = (instanceContext) => vm.runInNewContext(expression, { instanceContext });
  assert.equal(evaluate({ root: "/tmp/herdr-instance" }), true, "a dedicated instance says so");
  assert.equal(evaluate(null), false, "CONTROL: the ordinary daemon, whose context is null, is not dedicated");
});

test("the property sits in the object handed to every plugin, not somewhere else in the daemon", () => {
  const begin = daemon.indexOf("makeShared: () => ({");
  const end = daemon.indexOf("}),", begin);
  assert.ok(begin > 0 && end > begin, "the daemon's shared-context factory must remain identifiable");
  assert.match(daemon.slice(begin, end), /\n\s*dedicated:/);
  assert.match(daemon, /followServices = await startDaemonPlugins\(\{/);
});
