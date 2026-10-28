// Which aify-wrapper this aify-env installs, and was tested against (0.9.9): ONE value, package.json's `aifyWrapper`.
//
// AN INSTALL NOBODY COULD REPRODUCE. `aify-env install` put `github:zimdin12/aify-wrapper` on a host that had none:
// whatever its main was that day, and nothing recorded which commit it got. A rehearsal on 2026-10-28 could only say
// its herdr-aify was "83f5712 or later". So the source names a full commit, the one aify-env's cross-repo suites last
// ran against, and the installer prints it.
//
// A FIELD, NOT A DEPENDENCY: as a dependency, npm would install a second aify-wrapper inside aify-env on every install.
// AIFY_INSTALL_WRAPPER_SOURCE still overrides it, for a test or a rehearsal that names its own package.

import fs from "node:fs";

//: aify-wrapper at one commit: never a branch, a tag or a short id, any of which can come to mean another commit.
const PINNED = /^github:zimdin12\/aify-wrapper#[0-9a-f]{40}$/;

/** package.json's pin, or a refusal naming what is wrong with it. */
export function pinnedWrapperSource(manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"))) {
  const source = manifest?.aifyWrapper;
  if (typeof source !== "string" || !PINNED.test(source)) {
    throw new Error(`package.json's aifyWrapper must name aify-wrapper at a full commit (github:zimdin12/aify-wrapper#<40 hex>), not ${JSON.stringify(source)}`);
  }
  return source;
}

/** Where `aify-env install` gets aify-wrapper: the caller's override, else the pin. */
export function wrapperInstallSource(env = process.env) {
  return env.AIFY_INSTALL_WRAPPER_SOURCE || pinnedWrapperSource();
}
