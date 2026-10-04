// The hard-link refusal (git-dir-contents.mjs) names maintenance commands that MAY clear it. This runs them, as
// written in the row, in the refused folder, on both sides of a local clone, and looks again.
//
// A local clone hard-links BOTH sides, so the original is refused as well, and the first row's "re-clone it" sent
// its owner toward deleting a repository that may hold unpushed work (0.8.5 review, F7). Measured on git 2.54:
// when the original was already packed, `git gc` alone on either side leaves objects/info/packs shared, and the
// folder is still refused; `git update-server-info --force` rewrites it. What this proves is these two layouts on
// this git, which is why the row says "may".
//
// ITS OWN FILE: two real-git layouts take over a minute under the full suite, and beside the other object-store
// tests they ran that file past its 180-second budget.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { onlyWindows, git, layout, look } from "./_nested-grant-fixture.mjs";

test("the commands the row names, run as written, clear either side of a local clone of a packed repository", { skip: onlyWindows }, async () => {
  for (const side of ["original", "clone"]) {
    const l = layout();
    git(side === "original" ? l.folder : l.outside, "gc", "-q");
    if (side === "original") git(l.grant, "clone", "-q", l.folder, join(l.grant, "its-clone"));
    else {
      rmSync(l.folder, { recursive: true, force: true });
      git(l.grant, "clone", "-q", l.outside, l.folder);
    }
    const refused = await look(l);
    assert.deepEqual(refused.reported, [], `${side}: refused before the commands`);
    const commands = [...refused.problems.matchAll(/`git ([^`]+)`/g)].map((m) => m[1].split(" "));
    assert.equal(commands.length, 2, `${side}: the row names the commands to run: ${refused.problems}`);
    for (const args of commands) git(l.folder, ...args);
    // The row says the folder is judged again on its next look: this is that look.
    const seen = await look(l);
    assert.equal(seen.problems, "", side);
    assert.deepEqual(seen.reported, [git(l.folder, "rev-parse", "HEAD")], side);
  }
});
