// Host policy for cooperative service starts, never a restriction on the operator's raw Runner/POST path.
import { rootsNow, workspaceWithinRoots } from './workspace-roots.mjs';

/** Only this pre-spawn refusal can release lifecycle custody as a known non-start. */
export class LaunchRootRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'LaunchRootRefusal';
    this.code = 'LAUNCH_ROOTS_REFUSED';
  }
}

export class ServiceLaunchPolicy {
  #roots; #windows; #cwd;
  constructor({ roots, windows = process.platform === 'win32', cwd = () => process.cwd() } = {}) {
    this.#roots = roots; this.#windows = windows; this.#cwd = cwd;
  }
  async start(runner, spec) {
    // Preflight protects the ingress itself; do not freeze its fallback cwd across Runner's checkpoint wait.
    await this.checkedCwd(spec?.cwd);
    return runner.start(spec, { admitSpawn: requested => this.checkedCwd(requested) });
  }
  async checkedCwd(requested) {
    let roots, cwd;
    try {
      roots = await rootsNow(this.#roots);
      cwd = requested ?? this.#cwd();
    } catch { throw new LaunchRootRefusal('host launch roots or current folder could not be read; service start refused'); }
    if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string' && root.length > 0))
      throw new LaunchRootRefusal('host launch roots are unavailable; service start refused');
    if (typeof cwd !== 'string' || !cwd || cwd.includes('\0'))
      throw new LaunchRootRefusal('service start has no valid working folder');
    if (!workspaceWithinRoots(cwd, roots, { windows: this.#windows }))
      throw new LaunchRootRefusal(`${cwd} is outside this host's launch roots; add an appropriate root with aify-env roots add`);
    return cwd;
  }
}
