// A backtick in a shell string is command substitution, and this project has now met that twice.
//
// THE FIRST TIME, in the sibling repo: backticks inside an unquoted heredoc EXECUTED, running a bare
// `aify-comms` and reaping seven managed gateway hosts.
//
// THE SECOND TIME, in the first draft of this repo's own `install.sh`, caught before it shipped. The
// closing line read:
//
//     say "done. `aify-env` starts the environment; `aify-env doctor` checks it"
//
// Inside double quotes those are not decoration. Every successful install would have RUN `aify-env`
// -- starting the environment, superseding whatever was already serving, and reaping its managed
// workers -- as the last thing it did, with the operator reading "done."
//
// It survived a dry run because the dry run exits before that line. That is the shape worth pinning:
// the dangerous statement was on the path nothing routine reaches.
//
// COMMENTS ARE FINE. A `#` line is never evaluated, and the explanation of why a backtick is
// dangerous necessarily contains one. Stripping comments before looking is what makes the count mean
// something -- four of this file's five backticks are in comments, including the one above.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BACKTICK = String.fromCharCode(96);

/** Shell source with comment lines removed. Deliberately conservative: a line whose first
 *  non-blank character is `#` is a comment, and nothing else is assumed. */
export function shellWithoutComments(source) {
  return String(source)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function shellFiles() {
  const found = [];
  for (const entry of readdirSync(ROOT)) {
    if (entry.endsWith(".sh")) found.push(entry);
  }
  const scripts = join(ROOT, "scripts");
  if (existsSync(scripts)) {
    for (const entry of readdirSync(scripts)) {
      if (entry.endsWith(".sh")) found.push(join("scripts", entry));
    }
  }
  return found;
}

test("CONTROL: the stripper keeps code and drops comments", () => {
  // Without this, a stripper that returned nothing would pass every assertion below while looking at
  // an empty string -- which is the failure mode this project keeps meeting.
  const source = [
    `# a comment mentioning ${BACKTICK}aify-env${BACKTICK} is fine`,
    "echo hello",
    `  # an indented comment with ${BACKTICK}backticks${BACKTICK}`,
  ].join("\n");
  const code = shellWithoutComments(source);
  assert.ok(code.includes("echo hello"), "real code was stripped");
  assert.ok(!code.includes(BACKTICK), "a comment survived the strip");
});

test("CONTROL: the stripper can still SEE a backtick in real code", () => {
  const code = shellWithoutComments(`echo "run ${BACKTICK}danger${BACKTICK} now"`);
  assert.ok(code.includes(BACKTICK), "the scanner cannot see the thing it exists to find");
});

test("no shell script here contains command substitution by backtick", () => {
  const offenders = [];
  for (const relative of shellFiles()) {
    const code = shellWithoutComments(readFileSync(join(ROOT, relative), "utf8"));
    const lines = code.split("\n");
    lines.forEach((line, index) => {
      if (line.includes(BACKTICK)) offenders.push(`${relative}:${index + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [],
    "a backtick in shell code is command substitution. Use $(...) when you mean to run something, "
    + "and single quotes or no quoting when you mean to show a command name. The last one of these "
    + "would have started the environment at the end of every install.");
});

test("the scan looked at a real population", () => {
  const files = shellFiles();
  assert.ok(files.includes("install.sh"), `install.sh was not scanned; found ${JSON.stringify(files)}`);
});
