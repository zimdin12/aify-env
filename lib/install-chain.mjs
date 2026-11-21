// The guided-install chain (plan guided-install S2): one entry that installs and connects every selected piece.
//
//   aify-env install --connect <service>=<url> ... --client <runtime> ... [--no-prompt]
//
// FIVE PHASES, IN THIS ORDER, and each phase's failure stops the ones after it:
//   1. acquire  the selected services' approved artifacts, through each service's installer in `--acquire-only` mode;
//   2. connect  each service (`aify-wrapper-connect`: spec, keys through aify-env, a locked publish);
//   3. render   each selected client's launcher once, after the last connect, so it bakes the final registry;
//   4. assets   each service's installer in `--assets-only --client <runtime> <url>` mode, for clients whose CLI is present;
//   5. report   what was done, what is pending and why.
//
// INPUTS ARE NEVER INVENTED. Clients come from `--client` (or the operator's answer when asked); PATH is inventory, so
// a client on PATH that nobody selected gets nothing. A selected client whose CLI is absent is reported pending and
// its assets are skipped; under `--no-prompt` that fails the run, naming it. Keys come from a file or stdin, never
// argv. Connect's validated secret requirement and probes must pass before registry publication.
//
// A SERVICE'S INSTALLER is the `install.sh` of an entry checkout (`--installer`) or of its approved git file-set
// artifact; or, for a package artifact, the bin that package declares as `<service>-assets`, run from where connect
// installed it. Each runs in `--acquire-only` (installers only) or `--assets-only --client <runtime> <url>` mode.
//
// ENTERED ONCE. The chain marks its children with AIFY_INSTALL_CHAIN, refuses to start under that mark, and calls a
// service installer only in its two modes, which never hand off. So a service installer that hands off to the chain
// cannot be handed back to.
//
// PURE ORCHESTRATION. Everything that touches the host is an `io` port (`aify-env install`, bin/aify-env-install.mjs, supplies the real
// ones), so each rule is testable without npm, a network or a service.

import { HARNESS_FACTS } from './agent-definition-schema.mjs';

export const CHAIN_MARK = "AIFY_INSTALL_CHAIN";
export const CLIENTS = Object.freeze(Object.entries(HARNESS_FACTS).filter(([, facts]) => facts.install === true).map(([name]) => name));
/** The service whose launchers the chain renders: today every `*-aify` launcher is aify-comms'. */
export const LAUNCHER_SERVICE = "aify-comms";
export const EXIT_OK = 0;
export const EXIT_REFUSED = 78;

export const USAGE = [
  "usage: aify-env install --connect <service>=<url> ... --client <runtime> ... [options]",
  "  --connect <service>=<url>          a service to install and connect; repeatable",
  `  --client <${CLIENTS.join('|')}>     a runtime to set up; repeatable (PATH is never a selection)`,
  "  --secret <service>.<field>=<file>  a key for that service, read from a file; repeatable",
  "  --secret-stdin <service>.<field>   one key, read from stdin",
  "  --approve <digest>                 approve an artifact tuple, exactly as connect printed it; repeatable",
  "  --installer <service>=<install.sh> that service's installer, from a checkout the operator already chose",
  "  --no-prompt                        never ask; anything that needs a person fails",
].join("\n");

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIELD = /^(?:c|[a-z][A-Za-z0-9]*C)redentialRef$/;

/** The chain's arguments, or the problem with them. A flag that would carry a key in argv is refused by name. */
export function parseChainArgs(argv) {
  const out = { argv: [...argv], connects: [], clients: [], secretFiles: [], secretStdin: null, approve: [], installers: {}, noPrompt: false, problem: "" };
  const fail = (problem) => ({ ...out, problem });
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (/^--(key|value|password|token)(=|$)/.test(arg) || /^--secret=/.test(arg)) {
      return fail(`${arg.split("=")[0]} would put a key in argv, where every process on this host can read it; use --secret <service>.<field>=<file> or --secret-stdin`);
    }
    if (arg === "--no-prompt") { out.noPrompt = true; continue; }
    const valued = ["--connect", "--client", "--secret", "--secret-stdin", "--approve", "--installer"];
    if (!valued.includes(arg)) return fail(`unknown option ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || String(value).startsWith("--")) return fail(`${arg} needs a value`);
    i += 1;
    if (arg === "--client") {
      if (!CLIENTS.includes(value)) return fail(`unknown client ${value} (${CLIENTS.join(", ")})`);
      if (!out.clients.includes(value)) out.clients.push(value);
    } else if (arg === "--approve") {
      out.approve.push(value);
    } else if (arg === "--secret-stdin") {
      const key = secretKey(value);
      if (!key) return fail(`--secret-stdin takes <service>.<field>, with a credential reference field`);
      // connect reads only a service's key from stdin; any other field would need a file this chain writes, which it
      // does not do (a plaintext file has no Windows ACL custody here).
      if (key.field !== "credentialRef") return fail(`--secret-stdin carries only a service's key (credentialRef); give ${value} with --secret ${value}=<file>`);
      if (out.secretStdin) return fail("only one key can come from stdin");
      out.secretStdin = key;
    } else {
      const at = value.indexOf("=");
      if (at < 1) return fail(`${arg} takes <name>=<value>`);
      const left = value.slice(0, at), right = value.slice(at + 1);
      if (!right) return fail(`${arg} ${left}= has no value`);
      if (arg === "--secret") {
        const key = secretKey(left);
        if (!key) return fail(`--secret takes <service>.<field>=<file>, with a credential reference field`);
        out.secretFiles.push({ ...key, file: right });
      } else if (!NAME.test(left)) {
        return fail(`${left} is not a service name`);
      } else if (arg === "--installer") {
        out.installers[left] = right;
      } else {
        try {
          const url = new URL(right);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
        } catch {
          return fail(`${right} is not an http(s) url without credentials`);
        }
        if (out.connects.some((c) => c.name === left)) return fail(`${left} is connected twice`);
        out.connects.push({ name: left, url: right });
      }
    }
  }
  if (!out.connects.length) return fail("name at least one --connect <service>=<url>");
  const named = new Set(out.connects.map((c) => c.name));
  for (const s of [...out.secretFiles, ...(out.secretStdin ? [out.secretStdin] : [])]) {
    if (!named.has(s.service)) return fail(`a key is given for ${s.service}, which is not connected`);
  }
  for (const s of Object.keys(out.installers)) if (!named.has(s)) return fail(`an installer is given for ${s}, which is not connected`);
  const keys = [...out.secretFiles, ...(out.secretStdin ? [out.secretStdin] : [])].map((s) => `${s.service}.${s.field}`);
  if (new Set(keys).size !== keys.length) return fail("one key is given twice");
  return out;
}

function secretKey(text) {
  const at = String(text).lastIndexOf(".");
  const service = String(text).slice(0, at), field = String(text).slice(at + 1);
  return at > 0 && NAME.test(service) && FIELD.test(field) ? { service, field } : null;
}

/** Copyable argv, never a secret value: POSIX shell or PowerShell quoting, not a fragment to evaluate internally. */
export function installCommand(words, windows = process.platform === "win32") {
  const quote = word => `'${String(word).replaceAll("'", windows ? "''" : "'\\''")}'`;
  return `${windows ? "& " : ""}${words.map(quote).join(" ")}`;
}

/** One run of the chain: its plan, the host's ports, and the report it builds. */
export class InstallChain {
  #plan;
  #io;
  #report = { phases: [], pending: [], pendingEntries: [], problems: [] };
  /** Each service's executable installer; a declared skill tree never replaces it. */
  #installers;
  #skills = new Map();
  /** The tuple digests approved for this run: the plan's --approve, plus what the operator approves when asked. */
  #approve;

  constructor(plan, io) {
    this.#plan = plan;
    this.#io = io;
    this.#installers = { ...plan.installers };
    this.#approve = [...plan.approve];
  }

  /** Every phase in order; resolves to `{exit, report}`. */
  async run() {
    if (this.#io.env[CHAIN_MARK]) return this.#stop("the install chain is already running in a parent process; it is entered once");
    this.#io.say(`chain: entered for ${this.#plan.connects.map((c) => c.name).join(", ")}`);
    const clients = await this.#selectedClients();
    if (!clients) return this.#finish();
    for (const phase of ["acquire", "connect", "render", "assets"]) {
      if (!(await this.#phase(phase, clients))) return this.#finish();
    }
    return this.#finish();
  }

  async #phase(name, clients) {
    const steps = { acquire: () => this.#acquire(clients), connect: () => this.#connect(), render: () => this.#render(clients), assets: () => this.#assets(clients) };
    const ok = await steps[name]();
    this.#report.phases.push({ phase: name, ok });
    return ok;
  }

  async #selectedClients() {
    if (this.#plan.clients.length) return this.#plan.clients;
    if (this.#plan.noPrompt) return this.#refuse("no --client was selected, and --no-prompt forbids asking (PATH is never a selection)");
    const answer = await this.#io.ask(`which runtimes should be set up? (${CLIENTS.join(", ")}, separated by spaces) `);
    const picked = String(answer ?? "").split(/[\s,]+/).filter(Boolean);
    const unknown = picked.filter((c) => !CLIENTS.includes(c));
    if (!picked.length || unknown.length) return this.#refuse(unknown.length ? `unknown runtime ${unknown.join(", ")}` : "no runtime selected");
    return [...new Set(picked)];
  }

  /** Policy admission stays with the wrapper; consent runs only its policy-only action, never the whole installer. */
  async #policyReady(clients) {
    const result = this.#io.policyReadiness(clients);
    if (result?.state === "ready") return true;
    const action = result?.command;
    if (result?.state !== "needs-action" || typeof action?.file !== "string" || !Array.isArray(action.args)
      || action.args.some(arg => typeof arg !== "string") || typeof action.elevate !== "boolean") return this.#problem(`policy: ${result?.reason || "readiness was not established"}`);
    const command = installCommand([...(action.elevate ? ["sudo"] : []), action.file, ...action.args], this.#io.windows);
    const answer = this.#plan.noPrompt ? null : await this.#io.askTerminal(`prepare only the channel policy with ${command}? [y/N] `);
    if (!/^y(es)?$/i.test(String(answer ?? "").trim())) return this.#problem(`policy: ${result.reason}\n${command}`);
    if (await this.#io.preparePolicy(action) !== 0) return this.#problem(`policy preparation failed\n${command}`);
    return this.#io.policyReadiness(clients)?.state === "ready" || this.#problem("policy: preparation did not establish readiness");
  }

  async #acquire(clients) {
    const packages = await this.#io.ensurePackages();
    if (packages !== true) return this.#problem(`acquire: ${packages?.problem ?? "aify-wrapper could not be installed"}`);
    if (!(await this.#askApprovals(clients)) || !(await this.#policyReady(clients))) return false;
    for (const { name, url } of this.#plan.connects) {
      const installer = this.#installers[name] ?? (await this.#io.approvedInstaller(name, url, this.#approve));
      if (installer?.problem) return this.#problem(`acquire ${name}: ${installer.problem}`);
      if (!installer) continue; // nothing of this service's is acquired by an installer (a package is connect's)
      this.#installers[name] = installer.path ?? installer;
      // The selected url, and no terminal: an installer the chain runs never asks (`--no-prompt` or not, the chain is
      // the one place that asks).
      if ((await this.#io.runInstaller(this.#installers[name], ["--acquire-only", url], { quiet: true })) !== 0) return this.#problem(`acquire ${name}: its installer's --acquire-only failed`);
    }
    return true;
  }

  /**
   * Asks once per artifact nothing approves yet, through the terminal (stdin may carry the key), before anything is
   * acquired. A yes approves exactly that tuple. No terminal or --no-prompt refuses with one complete rerun command.
   */
  async #askApprovals(clients) {
    for (const { name, url } of this.#plan.connects) {
      for (const artifact of await this.#io.unapproved(name, url, this.#approve)) {
        const answer = this.#plan.noPrompt ? null : await this.#io.askTerminal(`approve ${artifact.id} from ${artifact.source} for ${name} (tuple ${artifact.digest})? [y/N] `);
        if (answer === null) {
          const selected = this.#plan.clients.length ? [] : clients.flatMap(client => ["--client", client]);
          const rerun = installCommand(["aify-env", "install", ...this.#plan.argv, ...selected, "--approve", artifact.digest], this.#io.windows);
          return this.#problem(`${name}: ${artifact.id} is not approved\n${rerun}`);
        }
        if (!/^y(es)?$/i.test(String(answer).trim())) return this.#problem(`${name}: ${artifact.id} (${artifact.source}) was not approved`);
        this.#approve.push(artifact.digest);
      }
    }
    return true;
  }

  async #connect() {
    for (const connect of this.#plan.connects) {
      const keys = this.#plan.secretFiles.filter((s) => s.service === connect.name);
      const stdin = this.#plan.secretStdin?.service === connect.name ? this.#plan.secretStdin : null;
      const { status: code, installed, pending = [] } = await this.#io.connect({ ...connect, keys, stdin, approve: this.#approve, noPrompt: this.#plan.noPrompt });
      if (code !== 0) return this.#problem(`connect ${connect.name}: exit ${code}${code === 75 ? " (publish outcome unknown; staged keys kept)" : ""}`);
      this.#report.pendingEntries.push(...pending.map(row => `${connect.name}/${JSON.stringify(row.name)}: ${JSON.stringify(row.reason)}`));
      const skillsOnly = Boolean(this.#installers[connect.name]);
      const accepted = installed ?? {};
      if (skillsOnly && Object.keys(accepted).length === 0) continue;
      // A file-set installer keeps its non-skill work. Only a declaration from a package THIS
      // connect accepted can add skills; it cannot add or replace an executable assets entry.
      const assets = await this.#io.packageAssets(connect.name, connect.url, this.#approve, accepted, { skillsOnly });
      if (assets?.problem) return this.#problem(`assets entry of ${connect.name}: ${assets.problem}`);
      if (assets?.skills) this.#skills.set(connect.name, assets.skills);
      else if (!skillsOnly && assets) this.#installers[connect.name] = assets;
      else if (!skillsOnly) this.#io.say(`assets: ${connect.name} declares no assets entry`);
    }
    return true;
  }

  async #render(clients) {
    const launcher = this.#plan.connects.find((c) => c.name === LAUNCHER_SERVICE);
    if (!launcher) {
      this.#io.say(`render: no launcher rendered, because ${LAUNCHER_SERVICE} is not connected`);
      return true;
    }
    for (const client of clients) {
      if ((await this.#io.render(client, launcher.url)) !== 0) return this.#problem(`render ${client}-aify failed`);
    }
    return true;
  }

  /** Assets write no registry bytes (S2): the registry's hash is read before and after, and a change is a problem. */
  async #assets(clients) {
    const before = await this.#io.registryHash();
    this.#io.say(`registry before assets: ${before}`);
    if (!(await this.#applyAssets(clients))) return false;
    const after = await this.#io.registryHash();
    this.#io.say(`registry after assets: ${after}`);
    return after === before || this.#problem(`assets changed the registry (${before} -> ${after}); assets-only must write none`);
  }

  async #applyAssets(clients) {
    // An assets step registers by the reference connect published (S2): no connected service's key variable reaches it,
    // so no registration can write a key value into argv or a config. Read from the registry, never listed here.
    let without;
    try {
      without = await this.#io.keyEnv(this.#plan.connects.map((c) => c.name));
    } catch (error) {
      return this.#problem(`assets: the key variables to withhold could not be read: ${error.message}`);
    }
    for (const client of clients) {
      if (!this.#io.cliPresent(client)) {
        this.#report.pending.push(`${client}: pending (CLI absent)`);
        continue;
      }
      for (const service of this.#plan.connects) {
        if (!(await this.#serviceAssets(service, client, without))) return false;
      }
    }
    return true;
  }

  async #serviceAssets({ name, url }, client, without) {
    const installer = this.#installers[name];
    // Keep the existing endpoint, credential fence and failure boundary for non-skill assets.
    if (installer && (await this.#io.runInstaller(installer, ["--assets-only", "--client", client, url], { without, quiet: true })) !== 0) {
      return this.#problem(`assets ${name} for ${client} failed`);
    }
    const skills = this.#skills.get(name);
    if (!skills) return true;
    try {
      await this.#io.placeSkills(skills, client, { without });
      return true;
    } catch (error) {
      return this.#problem(`skills ${name} for ${client}: ${error.message}`);
    }
  }

  #problem(text) {
    this.#report.problems.push(text);
    return false;
  }

  #refuse(text) {
    this.#report.problems.push(text);
    return null;
  }

  #stop(text) {
    this.#report.problems.push(text);
    return this.#finish();
  }

  #finish() {
    for (const line of this.#report.problems) this.#io.say(`problem: ${line}`);
    for (const line of this.#report.pending) this.#io.say(`pending: ${line}`);
    const failed = this.#report.problems.length > 0 || (this.#plan.noPrompt && this.#report.pending.length > 0);
    const entries = this.#report.pendingEntries;
    this.#io.say(`${failed ? "chain: not complete" : "chain: complete"}${entries.length ? ` with pending MCP entries: ${entries.join("; ")}; next: rerun aify-env install with the same options after those artifacts are available` : ""}`);
    return { exit: failed ? EXIT_REFUSED : EXIT_OK, report: this.#report };
  }
}
