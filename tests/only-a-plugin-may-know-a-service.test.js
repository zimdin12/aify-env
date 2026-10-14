// The boundary, as a measurement rather than a promise.
//
// THE RULE. aify-env spawns processes, owns PTYs, streams output and reaps. None of that is specific
// to any service. A module that names a SERVICE's endpoint or protocol belongs to that service, and
// the only place such a module may live is `lib/plugins/<service>/`.
//
// WHY A GATE AND NOT A PARAGRAPH. aify-comms' `TARGET_ARCHITECTURE.md` said the `aify-comms` command
// "goes when Phase 8 flips", Phase 8 was recorded as flipped on 2026-08-25, and the command stayed
// load-bearing for eight more days while two agents and the operator each concluded the fleet was
// ready. A boundary written in prose is one nobody measures; a document claiming completion is how a
// thing stops being checked. This file is the check.
//
// COMMENTS ARE NOT VIOLATIONS. Naming aify-comms while explaining WHY something is shaped as it is
// carries no coupling -- the history is the reason the code is right. Sixteen of the seventeen files
// mentioning it on 2026-09-02 were exactly that. Stripping comments before searching is what makes
// the count mean something, and a gate that flagged them would be widened within a week.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { advertisementPathFor, servicesWithPlugins } from "../lib/plugins/index.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

//: Where a service's own knowledge is allowed to live.
const PLUGIN_DIR = join("lib", "plugins");

//: What counts as knowing a service. Endpoint shapes and protocol nouns, not the service's NAME --
//: a name appears in prose constantly and proves nothing about coupling.
const SERVICE_KNOWLEDGE = [
  "/api/v1",
  "/spawn-requests",
  "/environments/heartbeat",
  "X-API-Key",
];

//: Files that cross the boundary today, each with the reason it is not yet fixed. THIS LIST MAY ONLY
//: SHRINK -- a test below fails if an entry stops being a violation, so it cannot rot into a set of
//: names nobody re-checks. Adding to it is a decision, not a repair.
const KNOWN_CROSSINGS = {
  // `lib/advertise.mjs` was here until 0.9.7: it built aify-comms' heartbeat path for every entry. The route is now
  // the registry entry's declaration or its plugin's advertisement capability; see the route test below.
  // A pre-existing transport crossing, extracted without changing its protocol.
  "lib/post-advertisement.mjs":
    "Sends the credential as `X-API-Key`. The registry declares which ENV VARS hold a key "
    + "(`keyEnv`) but not the header it travels in, so this host hardcodes aify-comms' choice and a "
    + "service using `Authorization: Bearer` would not be reachable. FOUND BY THIS GATE on its "
    + "first run, which is the argument for having it: the boundary was described in a design note "
    + "the same day and this crossing was not in it. Same fix as the entry above -- the registry "
    + "should declare it.",
};

/** Source with line and block comments removed, so prose about a service is not read as coupling. */
export function codeWithoutComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const relative = join(dir, entry);
    const full = join(ROOT, relative);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "plugins") continue;
      sourceFiles(relative, found);
    } else if (/\.(mjs|js)$/.test(entry)) {
      found.push(relative);
    }
  }
  return found;
}

/** @returns {Map<string, string[]>} file -> the service knowledge found in its CODE. */
function crossings() {
  const found = new Map();
  for (const relative of [...sourceFiles("lib"), ...sourceFiles("bin")]) {
    if (relative.startsWith(PLUGIN_DIR)) continue;
    const code = codeWithoutComments(readFileSync(join(ROOT, relative), "utf8"));
    const hits = SERVICE_KNOWLEDGE.filter((needle) => code.includes(needle));
    if (hits.length) found.set(relative.split("\\").join("/"), hits);
  }
  return found;
}

test("CONTROL: the scanner can see service knowledge where it is allowed to be", () => {
  // Without this, every assertion below passes on a scanner that finds nothing anywhere -- which is
  // the failure mode this repo has hit repeatedly: a zero that agrees with what you expected
  // produces no collision, so nothing prompts you to check the instrument.
  const pluginApi = readFileSync(join(ROOT, "lib/plugins/aify-comms/api.mjs"), "utf8");
  const code = codeWithoutComments(pluginApi);
  assert.ok(code.includes("/spawn-requests"), "the scanner cannot see a path it should find");
  assert.ok(code.includes("X-API-Key"), "the scanner cannot see a header it should find");
});

test("CONTROL: comments are stripped, so prose about a service is not coupling", () => {
  const withProse = [
    "// aify-comms reaches /api/v1/environments/heartbeat, which is why this exists",
    "/* X-API-Key travels on every call to /spawn-requests */",
    "const real = 1;",
  ].join("\n");
  const code = codeWithoutComments(withProse);
  assert.ok(!code.includes("/api/v1"), "a comment was read as code");
  assert.ok(!code.includes("X-API-Key"), "a block comment was read as code");
  assert.ok(code.includes("const real = 1;"), "real code was stripped along with the comments");
});

test("a URL is not mistaken for a comment", () => {
  // `//` inside `http://` must not truncate the line, or every endpoint in the codebase disappears
  // and this gate reports a clean boundary it never looked at.
  const code = codeWithoutComments('const u = "http://127.0.0.1:8800/api/v1/agents";');
  assert.ok(code.includes("/api/v1"), "a URL was swallowed as a comment, blinding the scan");
});

test("only a plugin knows a service", () => {
  const found = crossings();
  const unexpected = [...found.entries()].filter(([file]) => !(file in KNOWN_CROSSINGS));
  assert.deepEqual(
    unexpected.map(([file, hits]) => `${file} (${hits.join(", ")})`), [],
    "a module outside lib/plugins/ now names a service's protocol. aify-env is a general host: a "
    + "module that knows a service belongs to that service's plugin. If this crossing is genuinely "
    + "unavoidable, say why in KNOWN_CROSSINGS -- that is a decision, not a repair.",
  );
});

test("the known crossings still cross, so the list cannot rot", () => {
  // A recorded exception that has silently stopped being one is a name nobody re-checks, and a list
  // of those is how an allowlist becomes permanent.
  const found = crossings();
  for (const file of Object.keys(KNOWN_CROSSINGS)) {
    assert.ok(found.has(file),
      `${file} is recorded as crossing the boundary and no longer does -- remove it from `
      + "KNOWN_CROSSINGS rather than leaving an exemption nothing needs.");
  }
});

test("the boundary is measured against a real population, not an empty one", () => {
  // A scan that walked nothing would pass every assertion above.
  const files = [...sourceFiles("lib"), ...sourceFiles("bin")];
  assert.ok(files.length > 20, `only ${files.length} source files were scanned; the walk is wrong`);
  assert.ok(files.some((f) => f.includes("runner")), "the walk missed the host's core modules");
});

/**
 * Every way a plugin's advertisement route could be written into the core: the whole path and each tail of it that is
 * two segments or more (`/api/v1/environments/heartbeat`, `/v1/environments/heartbeat`, `/environments/heartbeat`),
 * since a core module that joins its own mount to the tail names the route as surely as one that spells it out.
 * DERIVED from the plugins, so a route a plugin changes or a new plugin offers is checked without editing this file.
 */
function advertisementRoutes() {
  const routes = new Set();
  for (const name of servicesWithPlugins()) {
    const segments = advertisementPathFor(name).split("/").filter(Boolean);
    for (let from = 0; from <= segments.length - 2; from += 1) routes.add(`/${segments.slice(from).join("/")}`);
  }
  return [...routes];
}

test("CONTROL: the advertisement routes are derived from a real plugin, and found where they are allowed", () => {
  const routes = advertisementRoutes();
  // Without this the scan below passes on an empty list -- a plugin that stopped offering its route, or a resolver
  // that answers "" for every name, would read as a clean core.
  assert.ok(routes.length > 0, "no plugin offers an advertisement route, so the scan below checks nothing");
  const pluginApi = codeWithoutComments(readFileSync(join(ROOT, "lib/plugins/aify-comms/api.mjs"), "utf8"));
  assert.ok(routes.some((route) => pluginApi.includes(route)), "the scanner cannot see the route in the plugin that owns it");
  // And it can say yes about core-shaped code: the line lib/advertise.mjs held before 0.9.7.
  const before = codeWithoutComments("url: `${service.endpoint}/api/v1/environments/heartbeat`,");
  assert.ok(routes.some((route) => before.includes(route)), "the scanner would not have caught the crossing it exists for");
});

test("the core names no plugin's advertisement route: the route is the service's or its plugin's (0.9.7, D13)", () => {
  const found = [];
  for (const relative of [...sourceFiles("lib"), ...sourceFiles("bin")]) {
    if (relative.startsWith(PLUGIN_DIR)) continue;
    const code = codeWithoutComments(readFileSync(join(ROOT, relative), "utf8"));
    const hits = advertisementRoutes().filter((route) => code.includes(route));
    if (hits.length) found.push(`${relative.split("\\").join("/")} (${hits.join(", ")})`);
  }
  assert.deepEqual(found, [],
    "a core module names a service's heartbeat route. aify-env beats a service only where the registry entry declares "
    + "`advertisement.path` or its plugin offers `advertisementPath` (lib/plugins/index.mjs); building the route "
    + "here is how every service came to be beaten on aify-comms' API.");
});
