// A plugin is told whether another aify-env serves this host (`shared.servedElsewhere`), because a herdr's dedicated
// instance starts service plugins too and a plugin that must run once per host defers to the ordinary one.
//
// bin/aify-env.mjs is never imported (it runs the daemon), so the property's own expression is taken out of the
// daemon's source and run against both kinds of instance context, as the credential wiring test does.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const daemon = fs.readFileSync(new URL("../bin/aify-env.mjs", import.meta.url), "utf8");

test("only a dedicated instance asks, and it asks the ordinary daemon's default address", async () => {
  const lines = daemon.split(String.fromCharCode(10)).filter((line) => /^\s*servedElsewhere:/.test(line));
  assert.equal(lines.length, 1, "the shared object's servedElsewhere property must remain identifiable");
  const expression = lines[0].replace(/^\s*servedElsewhere:/, "").replace(/,\s*$/, "");
  const asked = [];
  const anotherServesAt = async (endpoint, options) => { asked.push([endpoint, options?.signal]); return true; };
  const evaluate = (instanceContext) => vm.runInNewContext(expression, { instanceContext, anotherServesAt, DEFAULT_PORT: 8802 });
  const stop = new AbortController();
  assert.equal(await evaluate({ root: "/tmp/herdr-instance" })({ signal: stop.signal }), true, "a dedicated instance takes the answer");
  assert.deepEqual(asked, [["http://127.0.0.1:8802", stop.signal]], "it asks the default address, with the plugin's stop");
  assert.equal(await evaluate(null)(), false, "CONTROL: the ordinary daemon, whose context is null, never defers");
  assert.equal(asked.length, 1, "and never asks");
});

test("the property sits in the object handed to every plugin, not somewhere else in the daemon", () => {
  const begin = daemon.indexOf("makeShared: () => ({");
  const end = daemon.indexOf("}),", begin);
  assert.ok(begin > 0 && end > begin, "the daemon's shared-context factory must remain identifiable");
  assert.match(daemon.slice(begin, end), /\n\s*servedElsewhere:/);
  assert.match(daemon, /followServices = await startDaemonPlugins\(\{/);
});
