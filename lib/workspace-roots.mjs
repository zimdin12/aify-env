// Where this host will run work: the folders it was started in, and below. One containment check, used by
// a spawn claim (lib/plugins/aify-comms/claim.mjs) and by the report of defined agents this host cannot
// start (lib/definition-checks.mjs). It is not any service's knowledge, so it lives here rather than in a
// plugin.

/**
 * Is this workspace inside what the environment advertised?
 *
 * THE RISKIEST STEP IN THE WHOLE PASS. A spawn request names a cwd, and this is what stops a
 * service launching a process anywhere on the host. It is answered against the roots THIS
 * environment declared, not against the request.
 *
 * PURE, and case-folded on Windows only: `C:/Users` and `c:/users` are one directory there and two
 * everywhere else, and folding unconditionally would let `/home/Bob` pass for a root of `/home/bob`
 * on a case-sensitive filesystem.
 */
export function workspaceWithinRoots(workspace, roots = [], { windows = false } = {}) {
  const normalise = (value) => {
    const slashed = String(value || "").replace(/\\/g, "/");
    const text = slashed.replace(/\/+$/, "") || (slashed.startsWith("/") ? "/" : "");
    return windows ? text.toLowerCase() : text;
  };
  const target = normalise(workspace);
  if (!target) return false;
  return roots.some((root) => {
    const base = normalise(root);
    if (!base) return false;
    // The separator matters: without it a root of `/home/bo` would admit `/home/bob`.
    return target === base || target.startsWith(base === "/" ? "/" : `${base}/`);
  });
}
