#!/usr/bin/env node
// Every binding this view has is one an operator can find out about, and every key it advertises does
// something.
//
// THE DEFECT THIS WAS BUILT FROM, measured 2026-09-08 while adding `s`. Three places tell an operator
// what the view accepts -- the hint line on screen, `aify-env --help`, and the README table -- and
// `--help` was ALREADY missing `p` and `m`, both shipped weeks earlier. A third of the bindings
// existed only for somebody who had read the source. `keys.mjs`'s own header says it: bindings that
// are not written down are bindings nobody has.
//
// AND THE OTHER DIRECTION IS WORSE, because it is invisible from the source. The hint line offered
// `q quit` in the new start mode, where `q` is deliberately swallowed so the list behind cannot be
// acted on. A hint that is wrong is how an operator learns to stop reading the line -- that argument
// is written in `tui.mjs` and the line broke it within one commit of being extended.
//
// SO BOTH DIRECTIONS ARE DRIVEN BY BEHAVIOUR, NOT BY A SOURCE REGEX. Keys are PRESSED through
// `routeKey`, and hints are read out of a RENDERED frame. A regex would prove a line was written,
// which is not the same as proving the binding is reachable or the promise is kept -- a distinction
// this project has paid for more than once.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { MODES, VIEW_KEYS, initialFocus, routeKey } from "../lib/keys.mjs";
import { USAGE } from "../lib/usage.mjs";
import { renderDashboard, width } from "../lib/tui.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const README = fs.readFileSync(path.join(HERE, "..", "README.md"), "utf8");

/**
 * Keys that are how ANY list works rather than named features: movement, jumping, leaving.
 *
 * Declared so the sweep below can tell "a binding nobody documented" from "an arrow key". Adding to
 * this list is how a future key opts OUT of being documented, which is a decision somebody has to
 * write down rather than something that happens by not noticing.
 */
const UNNAMED = new Set(["j", "k", "q", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

const dash = (count = 3) => ({ ...initialFocus(count), count, selected: 0 });

test("POSITIVE CONTROL: every declared key actually does something when pressed", () => {
  // Everything below asks whether keys are DOCUMENTED. If a declared key had no router branch at all,
  // those checks would still pass and the documentation would describe a control that does nothing --
  // which is the defect this codebase keeps finding from the other end.
  assert.ok(Object.keys(VIEW_KEYS).length > 0, "the declaration is empty, so every sweep below is vacuous");
  for (const [key, what] of Object.entries(VIEW_KEYS)) {
    const { action } = routeKey(key, dash());
    assert.ok(action, `\`${key}\` (${what}) is declared and does nothing when pressed`);
  }
});

test("EVERY KEY THE ROUTER BINDS TO A FEATURE IS DECLARED", () => {
  // THE SWEEP THAT CATCHES THE NEXT ONE. Pressing every printable character finds a binding added
  // with a router branch and no entry -- by behaviour, so it cannot be defeated by how the branch was
  // written. `p` and `m` were undocumented for weeks precisely because nothing asked this question.
  const undeclared = [];
  for (let code = 0x20; code < 0x7f; code += 1) {
    const key = String.fromCharCode(code);
    if (UNNAMED.has(key) || key in VIEW_KEYS) continue;
    const { action } = routeKey(key, dash());
    if (action) undeclared.push(`${JSON.stringify(key)} -> ${action}`);
  }
  assert.deepEqual(undeclared, [],
    `these keys do something and are in neither VIEW_KEYS nor the unnamed set: ${undeclared.join(", ")}`);
});

test("EVERY DECLARED KEY IS IN `aify-env --help` AND IN THE README", () => {
  // The two documents an operator reaches for without running the view. `--help` is the one that
  // rotted, because adding a binding touches neither file and nothing complained.
  for (const key of Object.keys(VIEW_KEYS)) {
    assert.ok(new RegExp(`^\\s+${key}\\s{2,}`, "m").test(USAGE),
      `\`${key}\` is bound and \`aify-env --help\` does not list it`);
    assert.ok(README.includes(`| \`${key}\` |`),
      `\`${key}\` is bound and the README key table does not list it`);
  }
});

// ── the other direction: a hint must not promise a key that does nothing ─────────────────────────

const SNAPSHOT = {
  version: "0.6.3", build: "", endpoint: "http://127.0.0.1:8802",
  processes: [{ id: "p1", label: "sc-coder", service: "aify-comms", terminal: true, uptimeMs: 1000, title: "" }],
  services: [], checks: [], history: { startedTotal: 1 }, terminals: { available: true },
};

/** The hint line a mode renders, or "" when it draws none. */
function hintFor(mode, extra = {}) {
  const lines = renderDashboard(SNAPSHOT, {
    columns: 200, color: false, keys: { enabled: true, canQuit: true },
    view: {
      rows: SNAPSHOT.processes, selected: 0, mode, query: "", paneHidden: true,
      menuActions: ["attach", "stop"], confirming: mode === "confirm" ? "stop" : null,
      start: { agents: [{ id: "a", name: "a" }], at: 0, problem: "", asked: true },
      ...extra,
    },
  });
  return lines.find((line) => line.includes("  ·  ")) || "";
}

test("A HINT NEVER NAMES A KEY THAT DOES NOTHING IN THAT MODE", () => {
  // MEASURED: the start mode's hint offered `q quit` while `q` was swallowed there. Every other key
  // in that line worked, which is what makes this kind of wrongness survive a reading.
  //
  // Only the single-character promises are checked. `↑↓`, `enter`, `ctrl+]`, `type` and `any other
  // key` are names for inputs rather than characters, and pressing the literal string would prove
  // nothing about the input it stands for.
  const failures = [];
  for (const mode of MODES) {
    if (mode === "pty") continue;   // everything reaches the process there, by design
    const hint = hintFor(mode);
    if (!hint) continue;
    for (const [, promised] of hint.matchAll(/(?:^|·)\s{2}(\S)\s/g)) {
      const state = { ...dash(), mode, menuActions: ["attach", "stop"], startCount: 1, confirming: mode === "confirm" ? "stop" : null };
      const { action } = routeKey(promised, state);
      if (!action) failures.push(`${mode}: the hint offers \`${promised}\` and it does nothing`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("NEGATIVE CONTROL: the hint reader can actually see a key in a hint", () => {
  // Every assertion above passes if the regex matched nothing. This proves it finds the keys that
  // ARE there, so an empty match set would be a red test rather than a quiet green.
  const dashboardHint = hintFor("dashboard");
  const promised = [...dashboardHint.matchAll(/(?:^|·)\s{2}(\S)\s/g)].map((m) => m[1]);
  assert.ok(promised.includes("g"), `the reader found ${JSON.stringify(promised)} in ${JSON.stringify(dashboardHint)}`);
  assert.ok(promised.includes("s"), "the start key is not offered on the dashboard");
});

test("AN IDLE HOST IS STILL OFFERED THE ONE KEY THAT HELPS IT", () => {
  // With no processes the list is empty and the hint used to offer `find` alone -- on exactly the
  // host where every agent needs starting. `s` acts on something the list is not showing, which is
  // why it is the one key that belongs there.
  const lines = renderDashboard({ ...SNAPSHOT, processes: [] }, {
    columns: 200, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: [], selected: -1, mode: "dashboard", query: "", paneHidden: true },
  });
  const hint = lines.find((line) => line.includes("  ·  ")) || "";
  assert.match(hint, /s start/, `an empty host was offered: ${JSON.stringify(hint)}`);
});

console.log("the-keys-are-documented.test.js: all assertions passed");

// ── the hint line drops whole items rather than being cut ───────────────────────────────────────
//
// MEASURED AT THE DEFAULT WIDTH OF 100 COLUMNS, 2026-09-08: adding `s start` took the line to 105,
// and the one-guarantee clip at the end of `tui.mjs` takes the TAIL -- so `q quit` vanished. The key
// that says how to leave was lost to the key that says how to start something, silently, on an
// ordinary terminal. This is the same rule the pane title now follows: a qualification cut in half
// says nothing while looking like it said something.

const widthsToCheck = [30, 40, 60, 80, 100, 140];

/** The hint line at a given width, or "" if none was drawn. */
function hintAt(columns) {
  const lines = renderDashboard(SNAPSHOT, {
    columns, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: SNAPSHOT.processes, selected: 0, mode: "dashboard", query: "", paneHidden: true },
  });
  return lines.find((line) => line.includes("quit") || line.includes("start")) || "";
}

test("NO HINT IS EVER CUT MID-ITEM, at any width a terminal can be", () => {
  // A cut item reads as a rendering fault rather than as a shorter line. Checked by requiring every
  // separated piece to be one this view actually produces, which cannot miss a shape nobody
  // predicted -- unlike hunting for a trailing ellipsis.
  const WHOLE = new Set(["↑↓ move", "1-9 jump", "g find", "p show console", "p hide console",
    "enter attach", "m actions", "s start", "q quit"]);
  for (const columns of widthsToCheck) {
    const hint = hintAt(columns);
    assert.ok(hint, `no hint at all was drawn at ${columns} columns`);
    for (const piece of hint.trim().split("  ·  ")) {
      assert.ok(WHOLE.has(piece.trim()),
        `at ${columns} columns the hint carries a fragment: ${JSON.stringify(piece)} in ${JSON.stringify(hint)}`);
    }
  }
});

test("`q quit` SURVIVES EVERY WIDTH, because it is the one that says how to leave", () => {
  for (const columns of widthsToCheck) {
    assert.match(hintAt(columns), /q quit/, `at ${columns} columns there was no way out on screen`);
  }
});

test("THE UNDISCOVERABLE KEYS OUTLAST THE OBVIOUS ONES", () => {
  // Arrows and digits are how any list works and an operator finds them by trying. The lettered
  // features exist nowhere else on the screen, so dropping THEM first would leave a hint that
  // teaches nothing while still occupying a row.
  const narrow = hintAt(40);
  assert.match(narrow, /s start/);
  assert.doesNotMatch(narrow, /1-9 jump/, "the digits outlived a lettered feature");

  // AND THE ORDER AMONG THE OBVIOUS ONES IS PINNED WHERE IT SHOWS. At 40 columns both the arrows and
  // the digits are gone whichever way they are ranked, so that width proves nothing about their
  // relative order -- a mutant that dropped items in plain display order survived exactly this test.
  // 100 columns is the width where one of them fits and the other does not.
  //
  // ARROWS OUTRANK DIGITS because they are the more universal of the two: `1-9` only reaches the
  // first nine rows, and an operator who knows the arrows can get everywhere.
  const middling = hintAt(100);
  assert.match(middling, /↑↓ move/, "the arrows were dropped before the digits");
  assert.doesNotMatch(middling, /1-9 jump/, "both movement hints fit, so this width proves nothing");
  // POSITIVE CONTROL: given room, everything is there — so this is a fitting rule and not a deletion.
  const wide = hintAt(140);
  for (const piece of ["↑↓ move", "1-9 jump", "g find", "enter attach", "m actions", "s start", "q quit"]) {
    assert.ok(wide.includes(piece), `a wide terminal is missing ${piece}: ${JSON.stringify(wide)}`);
  }
});

test("THE HINT NEVER EXCEEDS THE TERMINAL, which is what a wrapped row costs here", () => {
  // One wrapped row shifts every row below it out from under `frameUpdate`'s absolute addressing, so
  // this is the difference between a diff that describes the screen and one that does not.
  for (const columns of widthsToCheck) {
    const hint = hintAt(columns);
    assert.ok(width(hint) <= columns, `at ${columns} columns the hint is ${width(hint)} wide`);
  }
});

// ── the host tier names no service, including in what it prints ──────────────────────────────────
//
// `docs/AIFY_ENV_BOUNDARY.md` puts service knowledge inside a service PLUGIN and nowhere else: the
// host runs processes for whoever asked and does not know who that is. The operator's own ruling,
// 2026-08-24: "aify-env should not ask stuff from aify-comms, there should not be requirement, it is
// not aify-env's concern."
//
// THE START LIST IS THE FIRST FEATURE THAT STRAINS THAT, and the operator asked for it by name --
// through the plugin, which is the sanctioned route. The plugin knows the service; the host reaches
// its capability by CAPABILITY name and never by service name.
//
// AND THE VIEW BROKE IT ANYWAY, in one string. `asking aify-comms…` was hardcoded in the renderer --
// which is the host tier -- so a second `aify-` service offering the same capability would have been
// announced under the wrong name, in the most confusing direction: naming the service that is NOT
// the one failing to answer. The name now travels with the answer.

test("THE WAIT NAMES WHOEVER ANSWERED, and nobody when it was not told", () => {
  const named = renderDashboard(SNAPSHOT, {
    columns: 200, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: SNAPSHOT.processes, selected: 0, mode: "start", query: "",
      start: { agents: [], at: 0, problem: "", asked: false, service: "some-other-service" } },
  }).join("\n");
  assert.match(named, /asking some-other-service…/,
    "the renderer did not use the name it was given");
  // SCOPED TO THE SENTENCE, not to the frame. `aify-comms` appears legitimately elsewhere on screen
  // -- it is the `service` column of a process this host is running, which is data the daemon was
  // handed rather than a name it knows. Asserting on the whole frame confused the two and failed
  // against a correct fix.
  assert.doesNotMatch(named, /asking aify-comms/, "the host tier hardcodes a service name in its own output");

  // A capability that did not say produces an UNATTRIBUTED wait, never a guess.
  const unnamed = renderDashboard(SNAPSHOT, {
    columns: 200, color: false, keys: { enabled: true, canQuit: true },
    view: { rows: SNAPSHOT.processes, selected: 0, mode: "start", query: "",
      start: { agents: [], at: 0, problem: "", asked: false } },
  }).join("\n");
  assert.match(unnamed, /asking…/);
  assert.doesNotMatch(unnamed, /asking [a-z]/, "a service was invented for a capability that named none");
});
