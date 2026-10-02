// Where an aify-env instance keeps its own files: `~/.aify/env/<instance>.<extension>` (0.9 plan P0 C3, C4, C5).
//
// The instance name becomes part of a file name, so it must be one: a name that could leave the directory is refused
// rather than cleaned up.

import path from "node:path";

const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @returns {string} the path of this instance's file with that extension, under `aifyHome`/env */
export function instanceFile(aifyHome, instance, extension) {
  if (typeof instance !== "string" || !INSTANCE.test(instance)) throw new TypeError(`not an instance name: ${JSON.stringify(instance)}`);
  return path.join(aifyHome, "env", `${instance}.${extension}`);
}
