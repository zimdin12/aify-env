#!/usr/bin/env node
// aify-env: the environment for this host.
//
// Owns processes and terminals so that more than one service can start agents here without two
// spawners fighting over the same PTYs. Knows nothing about messages, dispatch, or whether an agent is
// thinking.
//
// BINDS LOOPBACK ONLY, and that is not a default to be overridden lightly. This process starts programs
// on request; reachable from another machine it is a remote shell with a JSON interface. The host is
// fixed rather than configurable for the same reason a guard that can be turned off is decoration.
//
// WHAT IT ACCEPTS IS IN `lib/usage.mjs`, and `aify-env --help` prints it. It was written out
// here, where nothing could print it and no reader outside the source could reach it -- and
// `--help` itself fell through this file's subcommand guard and STARTED a daemon.
//
// STARTING WHEN ONE IS ALREADY RUNNING TAKES OVER, and the incumbent's agents die with it -- they
// cannot be adopted, because a PTY-backed child is bound to a ConPTY its parent owns. So a takeover
// REFUSES by default when the incumbent reports running processes and names them. `--force` is how
// you say you meant it.
//
// AND THEN IT SHOWS YOU THE ENVIRONMENT IT REFUSED TO REPLACE, in a terminal. The operator's reason
// for starting a second one was *"i had to start because i needed to see what is going on"*, so
// naming a second command to type is one step short of the answer. A pipe or a service manager keeps
// the explanation and exit 69 unchanged; `AIFY_NO_DASHBOARD=1` opts a terminal out.
//
// An IDLE environment is still superseded by a bare run, deliberately: "restart aify-env to pick up
// new code" has to keep working, and attaching whenever anything answered would make that a silent
// no-op.
//
// ONE command on PATH, with subcommands. Three sibling binaries is what collided with aify-comms'
// own `aify-doctor`; a collision is only the loud version of the problem.
//
// There is deliberately no `--host`.
//
// THE VIEW OPENS IN THE TERMINAL THAT STARTS IT, and only there: piped or redirected output keeps the
// plain banner, because escapes in a log are noise and the banner is what a service manager parses.
// `AIFY_NO_DASHBOARD=1` opts out. What the view shows about AGENTS is relayed from each service and
// attributed to it -- this environment knows which processes it started, and alive is not working.

import { postAdvertisement } from "../lib/post-advertisement.mjs";
import { DEFAULT_PORT, portFromArgs } from "../lib/port-argument.mjs";
import { anotherServesAt } from "../lib/serving-endpoint.mjs";
import { instanceContextArgument } from "../lib/instance-context.mjs";
import { prepareInstance } from "../lib/instance-bootstrap.mjs";
import { USAGE, asksForHelp, asksForVersion, refuseUnknownFlag } from "../lib/usage.mjs";
import { createServer } from "node:http";
import { createDaemonHttp } from "../lib/daemon-http.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { hostIsWsl } from "../lib/host-wsl.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleRequest } from "../lib/protocol.mjs";
import { readHostConfig } from "../lib/host-config.mjs";
import { readGrantedRoots } from "../lib/watch-roots.mjs";
import { LaunchRoots, launchRootsPath } from "../lib/launch-roots.mjs";
import { createReaper } from "../lib/reaper.mjs";
import { createShutdown } from "../lib/shutdown.mjs";
import { daemonShutdownHooks } from "../lib/shutdown-hooks.mjs";
import { BootSession, BootCancelled } from '../lib/daemon-boot-session.mjs';
import { startDaemonBoot } from '../lib/daemon-boot.mjs';
import { Runner, terminalSupport } from "../lib/runner.mjs";
import { createOwnershipRecovery } from '../lib/ownership-bootstrap.mjs';
import {
  showViewInsteadOfRefusing,
  workLostToSupersession,
} from "../lib/environment-checks.mjs";
import { askIncumbent } from "../lib/incumbent.mjs";

/** Whether the thing holding our port is an aify-env, and which pid it is. */
const incumbent = () => askIncumbent({ host: HOST, port });
import { homedir, hostname } from "node:os";
import { PackageBuild } from "../lib/build-identity.mjs";
import { aifyLauncherFilesOnPath } from "../lib/launcher-scan.mjs";
import { DefinitionStore } from "../lib/agent-definitions.mjs";
import { readServices } from "../lib/services.mjs";
import { ServicePlugins } from "../lib/service-plugins.mjs";
import { advertisementPathFor, pluginsForServices } from "../lib/plugins/index.mjs";
import { pluginCredential } from "../lib/plugin-bootstrap.mjs";
import { HostAdvertiser } from "../lib/host-advertiser.mjs";
import { credentialRoot } from "../lib/credential-fs.mjs";
import { CredentialAclCache } from "../lib/credential-acl-cache.mjs";
import { createNotices } from "../lib/notices.mjs";
import { credentialForTarget } from "../lib/credential-resolve.mjs";
import { advertisingEnabled, hostIdentityFacts, pluginHeartbeatBody, installedHarnesses } from "../lib/advertise.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readFileSync(join(ROOT, "VERSION"), "utf8").trim();

// WHAT IS ACTUALLY LOADED, computed from the files on the way in. `VERSION` says which release
// this claims to be and does not move for a bug fix; BUILD moves whenever the code does, which is
// the question an operator restarting to pick up a fix is actually asking. See
// lib/build-identity.mjs for why it is a content hash rather than a git sha.
//
// BOTH HALVES FROM ONE RECIPE. `boot` is read once, here, and is the identity of the files this
// process actually loaded; `onDisk()` answers the same question about the files that are there NOW.
// They are only comparable because `PackageBuild` computes them the same way, which is why the pair
// lives in the module that owns the concept rather than being written out twice at this call site.
const PACKAGE_BUILD = new PackageBuild({
  root: ROOT,
  // DIRENTS, so the walk can tell a directory from a file. Names alone made it non-recursive,
  // which left the whole of `lib/plugins/` out of the build id for four commits.
  list: (dir) => readdirSync(dir, { withFileTypes: true }),
  read: (path) => readFileSync(path, "utf8"),
  join,
});
const BUILD = PACKAGE_BUILD.boot;

/** Never configurable. See above. */
const HOST = "127.0.0.1";

const args = process.argv.slice(2);
let contextPath = null;
try { contextPath = instanceContextArgument(args); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
// ASKING FOR HELP MUST NEVER BE A SIDE EFFECT, and here it started a daemon. See `lib/usage.mjs`.
if (asksForHelp(args)) {
  process.stdout.write(`${USAGE}
`);
  process.exit(0);
}
if (asksForVersion(args)) {
  // BOTH, because one of them is the useful one. This prints what is on DISK; the running
  // daemon's banner prints what IT loaded. Equal means current, different means restart -- and
  // neither number needs to mean anything on its own for that comparison to be exact.
  process.stdout.write(`aify-env ${VERSION} (build ${BUILD})\n`);
  process.exit(0);
}
// SUBCOMMANDS, not sibling binaries. One product should put one command on PATH: three of them is what
// collided with aify-comms' own `aify-doctor`, and a collision is only the loud version of the problem
// -- the quiet one is a reader having to know which of three commands answers their question.
//
// An UNKNOWN subcommand is refused rather than falling through. Falling through would mean a typo like
// `aify-env doctr` silently STARTS the environment, which supersedes a running daemon and reaps its
// managed workers -- the one mistake here that costs someone their fleet.
const SUBCOMMANDS = {
  doctor: "./aify-env-doctor.mjs",
  tui: "./aify-env-tui.mjs",
  // ATTACH IS A CLIENT, not a second view. `tui` shows every process at once and owns a dashboard;
  // this hands one process the whole terminal, which is what an operator wants when a single lane is
  // misbehaving -- and what makes a resident's PTY hostable here at all.
  attach: "./aify-env-attach.mjs",
  // START AND ATTACH IN ONE STEP, for a launcher that wants its session to outlive the terminal
  // that started it. `claude-aify --shared` is one line calling this.
  run: "./aify-env-run.mjs",
  credential: "./aify-env-credential.mjs",
  registry: "./aify-env-registry.mjs",
  herdr: "./aify-env-herdr.mjs",
  agents: "./aify-env-agents.mjs",
  // WHERE THIS HOST STARTS WORK beyond its start folder (lib/launch-roots.mjs); the only writer of that file.
  roots: "./aify-env-roots.mjs",
  // THE GUIDED-INSTALL CHAIN (lib/install-chain.mjs). It installs and connects; it never starts the environment.
  install: "./aify-env-install.mjs",
};
const firstArg = args[0];
if (firstArg && !firstArg.startsWith("-")) {
  // OWN keys only: `aify-env constructor` must be an unknown subcommand, not Object's own function.
  const target = Object.hasOwn(SUBCOMMANDS, firstArg) ? SUBCOMMANDS[firstArg] : null;
  if (!target) {
    const known = Object.keys(SUBCOMMANDS).join(", ");
    // Its OWN newline, not the module-level `chr10`, which is declared further down and would be in
    // the temporal dead zone here. This file has already shipped that exact bug once, in this exact
    // variable, and it only fired when there was something to report.
    const eol = String.fromCharCode(10);
    process.stderr.write(`aify-env: unknown subcommand '${firstArg}'. Known: ${known}.` + eol);
    process.stderr.write("aify-env with no subcommand starts the environment." + eol);
    process.exit(64);
  }
  // ARGV[1] BECOMES THE SUBCOMMAND'S OWN PATH, which is what a direct `node bin/aify-env-<x>.mjs`
  // would give it. Keeping the DISPATCHER's path here is what broke `aify-env credential`: that
  // module runs its `main()` only when `process.argv[1]` ends with its own filename -- a guard that
  // exists so tests can import its parsing helpers without touching the operator's home directory.
  // Through the dispatcher the guard was false, so `aify-env credential set` STORED NOTHING, PRINTED
  // NOTHING, AND EXITED 0. The installer read that empty output as the credential reference, wrote
  // no `credentialRef` to the registry, and aify-env could not find a key it had never saved: every
  // advertisement 401'd while both sides reported healthy. A subcommand that silently does nothing
  // and reports success is the worst shape available, and only this idiom's argv assumption stood
  // between here and it.
  process.argv = [process.argv[0], fileURLToPath(new URL(target, import.meta.url)), ...args.slice(1)];
  await import(target);
  // AND FLUSH BEFORE EXITING, which is a second, independent hazard on this line: `process.exit()`
  // discards whatever is still buffered on stdout when stdout is a PIPE, and flushes synchronously
  // when it is a TTY -- so an interactive run would look right while the installer, which captures
  // this through a pipe, lost the last line.
  //
  // The subcommand's own status is carried out rather than replaced by 0. Exiting 0 for a subcommand
  // that failed is the same class of lie as losing its output.
  if (process.stdout.writableLength > 0) {
    await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
  process.exit(process.exitCode ?? 0);
}

// AN UNRECOGNISED ARGUMENT IS REFUSED, not ignored -- the same rule the unknown-subcommand branch
// above already applies, extended to the dash-prefixed half it never covered. AFTER the dispatch,
// because a subcommand owns its own flags (`doctor --json`, `tui --once`, `run --service ...`) and
// anything reaching this line is starting a daemon.
refuseUnknownFlag(args, { write: (line) => process.stderr.write(line), exit: (code) => process.exit(code) });

// The operator saying they meant it. Without this a takeover REFUSES when the incumbent is running
// anything, because superseding ends that work and nothing can rescue it.
const force = args.includes("--force");
// PARSED AND JUDGED IN `lib/port-argument.mjs`, which is where it can be tested: importing this
// file starts a daemon. `--port` with nothing after it used to reach `listen()` as NaN and die
// with an uncaught ERR_SOCKET_BAD_PORT -- a stack trace for a typo (external review, Round 8).
const parsedPort = portFromArgs(args, contextPath ? 0 : DEFAULT_PORT);
if (parsedPort.error) {
  process.stderr.write(`aify-env: ${parsedPort.error}` + String.fromCharCode(10));
  process.exit(2);
}
const port = parsedPort.port;
let instanceContext = null;
try { if (contextPath) instanceContext = await prepareInstance(contextPath, process.env); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }

const chr10 = String.fromCharCode(10);
/** SSE frames end with a BLANK line: two newlines. Named so nothing has to escape them. */

// WHAT THIS ENVIRONMENT OWNS, on disk.
//
// The in-memory registry cannot answer for an instance that has already died, and every agent such an
// instance started is still running with nothing able to name them. The record is the authority, and
// the next instance cleans up from it.
const OWNED_FILE = instanceContext?.processRecord ?? (process.env.AIFY_ENV_PROCESS_RECORD || join(homedir(), ".aify", "env-processes.json"));
const ownership = await createOwnershipRecovery({ file: OWNED_FILE, recover: !instanceContext });

// Recover only after binding. Port ownership is not process ownership: the recovery owner verifies
// child/owner identity and holds successor writes until the exact displaced predecessor is gone.
//
// This ran BEFORE listening, and the order was the bug: a second start read the record of the instance
// already running, found its processes alive and verifiably ours, killed them as orphans, and only
// then discovered the port was taken and exited. The incumbent kept serving, robbed of its agents.
// Proven with a real process in tests/a-second-start-does-not-rob-the-first.test.js.
//
// The killing decision still fails CLOSED: a pid that cannot be confirmed as ours is left alone and
// reported. Pid reuse is real, and ending a stranger's process is a worse failure than the leak.
async function reapLeftovers() {
  return ownership.recovery.recover();
}

const boot = new BootSession();
const runner = new Runner({ ownedFile: OWNED_FILE, ownedRecord: ownership.record,
  startGate: () => ownership.recovery.admitStart(), assertOpen: boot.assertOpen,
  managedHost: () => boot.agentState ? { ...boot.agentState, url: `http://${HOST}:${server.address().port}` } : null,
  reportManaged: (problem) => logLine(problem),
  // A process came or went: its agent's word is published now, not on the next sweep (the operator, 2026-10-25).
  onProcessChange: () => evaluateAgentState(),
});

// SERVICE PLUGINS. This host runs processes for whoever asked; a plugin is how a SERVICE teaches it
// to fetch that work. The daemon never names a service -- `pluginsForServices` maps registry entries
// to plugins -- so adding a second `aify-` service changes nothing here.
const servicePlugins = new ServicePlugins({ canStart: () => !boot.cancelled });
// THIS HOST'S AGENT DEFINITIONS (P0 C3, C4, C7, C10), shared by the plugins and `/agents/importable`. Made
// outside the statements the bootstrap tests evaluate, so those hand the plugin a stand-in, never this one.
// A removed definition may leave a session folder to remove (lib/session-folders.mjs).
const definitionStore = new DefinitionStore({ onRemoved: (id) => boot.agentState?.sessionFolders?.notice(id) });

/**
 * WHERE THIS HOST WILL RUN WORK: the directory it was started in, and below, plus the roots the operator added on
 * this host with `aify-env roots add` (lib/launch-roots.mjs), re-read whenever that file changes.
 *
 * THIS IS THE HOST'S OWN BOUND, not a service's. The advertisement deliberately sends no `cwdRoots`
 * -- which directories work MAY run in is the service's policy -- but what this process is willing
 * to launch is ours, and a claim guard with no bound is not a guard. It is the last thing between a
 * service asking for a process and this host starting one anywhere on the machine.
 *
 * The operator's model is exactly this: "i run aify-env at C:\ so whole pc is env where i can spawn
 * managed agents". Where you start it is what it will run.
 */
const LAUNCH_ROOTS = new LaunchRoots({ startFolder: process.cwd(), file: launchRootsPath(homedir()), log: (line) => logLine(line) });

/** The identity a plugin needs to name this environment to its service. The SHAPE of that name is
 *  the service's business, so only the facts travel. */
function currentAdvertisementBody() {
  const { hostname: hostName, kind, machineId } = boot.identity;
  // Identity is shared with lifecycle/publication; disk and grants are still read at each use.
  return pluginHeartbeatBody({ hostname: hostName, kind, machineId, instance: BUILD, codeOnDisk: PACKAGE_BUILD.onDisk(),
    launchRoots: LAUNCH_ROOTS.current() });
}

/** How this daemon reads a stored key: fresh bytes every time, one icacls per change of the file
 *  (credential-acl-cache.mjs; per read, it was 80% of the event loop on 2026-09-28). */
const CREDENTIAL_ACL = new CredentialAclCache();
const credentialReading = () => ({ env: process.env, root: credentialRoot(), acl: CREDENTIAL_ACL });

/** The key for the service a plugin serves, resolved PER CALL through the same store-aware path the
 *  advertiser uses -- so a credential written while this daemon runs reaches a running plugin -- and
 *  from THAT plugin's own registry entry (`pluginCredential`), never the registry's first target. */
async function resolvePluginCredential(service, field) {
  return pluginCredential(service, (target) => credentialForTarget(target, credentialReading()), field);
}

// An escape hatch for anyone who wants the daemon in a terminal without the view taking it over.
// WHERE THE DAEMON'S OWN MESSAGES GO, decided ONCE and used by both the log sink and the view.
//
// The sink used to write to stderr unconditionally. When this process also owns a terminal, that
// stderr line lands in the middle of a frame `frameUpdate` addresses by cursor position -- so the
// row it shifts desyncs every repaint after it. The operator reported exactly that on 2026-09-04:
// three `output not delivered: fetch failed` lines wedged into their view with the layout coming
// apart. Kept and rendered as a NOTICES section instead; a pipe or a service manager keeps stderr,
// which is where those readers expect it.
const NOTICES = createNotices();

const NO_DASHBOARD = ["1", "true", "yes"].includes(
  String(process.env.AIFY_NO_DASHBOARD ?? "").trim().toLowerCase(),
);

/**
 * True only once the view is ACTUALLY drawing, not merely intended.
 *
 * The dashboard can fail to start (`startDashboard` throws and the daemon carries on serving), and
 * a log line that vanished into a ring nobody is rendering would be worse than one printed over a
 * frame. So this flips on success and stays false otherwise.
 */
/** The daemon's own voice: into the view when it owns the screen, to stderr when it does not. */
function logLine(message) {
  if (boot.ownsScreen) {
    NOTICES.add(message);
    return;
  }
  process.stderr.write(`[aify-env] ${message}${chr10}`);
}
// AND DIE TOGETHER — one path, in lib/shutdown.mjs, because there were two here and they disagreed.
//
// The other handler closed the server and exited on the grounds that this environment going down was
// not a reason to kill somebody else's agent. Node runs every listener, so the winner was whichever
// reached process.exit first, and that was the one NOT stopping anything. The operator's rule settles
// it: if aify-env dies, the processes it handles die with it.
//
// The record on disk still covers the hard kill that runs no handler at all. Both halves are needed.
const shutdown = createShutdown(daemonShutdownHooks({
  runner,
  stopView: () => {
    boot.cancel();
    stopAgentStateSending();
    void boot.stop('advertising').catch(error => logLine(`advertising stop: ${error?.message || error}`));
    void boot.stop('view').catch(error => logLine(`view stop: ${error?.message || error}`));
  },
  releaseResidents: () => boot.agentState?.residents?.release(),
  inputSocket: () => ({ stop: () => boot.stop('socket') }),
  servicePlugins: { stopAll: () => boot.finishBootAndStopPlugins(servicePlugins) },
  closeHttpServer: () => server.close(),
  // OURS ONLY, on the way out too. Shutdown emptied the whole file, so an environment stopping
  // normally erased a concurrently-running instance's record exactly as the boot reap did.
  clearOwned: () => runner.retireEndedRecords(),
  exit: (code) => process.exit(boot.failureExitCode ?? code),
  write: (line) => process.stderr.write(line),
  // B5: the managed key's sender, retired once its workers are stopped (lib/agent-state-sender.mjs retire).
  retireAgentState: ({ signal }) => boot.sender?.retire({ signal }),
}));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(signal, () => { void shutdown(signal); });
  } catch {
    // Not every signal exists on every platform; the ones that do are enough.
  }
}

// createReaper rather than an object literal here. This line WAS a literal, wired with
// `remove: () => {}`, so the sweep ran every thirty seconds, classified correctly, and reaped nothing.
// A unit test of the sweep could not see it, because the sweep was never wrong. See lib/reaper.mjs.
const reaper = createReaper(runner);

/** What the last sweep could not answer for. Surfaced through /health so it is never a silent leak. */
let unknown = [];

/**
 * This environment's own io. The only traffic it can honestly report: it has no visibility into what a
 * service does elsewhere, and a number here that meant anything wider would be invented.
 */
const traffic = { requests: 0, bytesOut: 0 };

// The local input socket, once it is listening. Advertised on /health so a client discovers it
// rather than guessing an address, and empty whenever this host has none.
const HOST_CONFIG = readHostConfig({ env: process.env });

const server = createServer(createDaemonHttp({
  runner, traffic, hostConfig: HOST_CONFIG,
  protocolDeps: async () => (
      {
        runner,
        turnEvents: boot.agentState?.turnEvents,
        gateways: boot.agentState?.gateways,
        modelSelections: boot.agentState?.modelSelections,
        stateHost: boot.agentState?.host ?? null,
        lifecycle: boot.agentState?.lifecycle ?? null,
        sessionFolders: boot.agentState?.sessionFolders ?? null,
        residents: boot.agentState?.residents?.report() ?? null,
        observedHarnesses: () => new Set(installedHarnesses(aifyLauncherFilesOnPath()).map((h) => h.client)),
        inputSocket: boot.inputSocket?.address ?? '',
        readFile: (path) => readFileSync(path, "utf8"),
        version: VERSION,
        build: BUILD,
        ownerIdentity: ownership.ownerIdentity,
        ownershipRecovery: ownership.recovery.status(),
        codeOnDisk: PACKAGE_BUILD.onDisk(),
        cwdRoots: LAUNCH_ROOTS.current(),
        launchRootsFile: LAUNCH_ROOTS.read(),
        screens: () => servicePlugins.capabilities("screens"),
        unknown,
        terminals: terminalSupport(),
        // Armed, heard by whom, refused by whom and why: the advertiser's own answer (lib/host-advertiser.mjs).
        ...(await advertiser.healthFields()),
        // WHAT EACH PLUGIN IS ACTUALLY DOING, which is a different question from whether this host
        // is advertising. Advertising DESCRIBES the machine; a plugin CLAIMS work on it, and on
        // 2026-09-02 the first was healthy while the second was refused every time for hours with
        // nothing anywhere able to say so. `/health` reported the half that was fine.
        plugins: servicePlugins.report(),
        serviceContacts: [...servicePlugins.capabilities('serviceContact').map(read => read()).filter(Boolean),
          ...advertiser.contacts()],
        rosterRevision: JSON.stringify([definitionStore.readOnlyRevision(),
          ...servicePlugins.capabilities('agents').map(offer => offer.revision?.() ?? null),
          runner.list().map(({ id, label }) => [id, label])]),
        // STARTING A KNOWN AGENT, offered by whichever plugin can. Resolved per request rather than
        // captured once: plugins start after the server binds, so a reference taken here at module
        // scope would be null for the life of the process. Asking each time also means a plugin that
        // failed to start answers 503 rather than a stale capability answering with a dead api.
        //
        // THE DAEMON NAMES NO SERVICE, which is the whole point of the plugin split: a second
        // `aify-` service offering the same capability needs no change on this line.
        agents: servicePlugins.capability("agents"),
        // EVERY SERVICE'S, for import (P0 C10), and this host's definitions to compare them with.
        agentServices: servicePlugins.capabilities("agents"),
        definitions: definitionStore,
        traffic,
      }
  ),
}));

// A PORT ALREADY IN USE IS AN ORDINARY CONDITION, so it gets an ordinary message.
//
// Without this the process died on an unhandled 'error' event and printed a Node stack trace, for the
// most likely mistake anyone makes with this command: running it twice. The remedy is obvious once
// stated and invisible in a trace, and an operator meeting that dump has no reason to think an
// environment is already up and serving perfectly well.
//
// Exit 69 (EX_UNAVAILABLE) rather than 1: a supervisor restarting on failure should not fight the
// instance that already holds the port.
let superseding = false;
/**
 * Set when this process REFUSED a takeover and became a read-only view.
 *
 * A view describes nothing: it runs no processes and can deliver no capability, so it must not tell
 * the service what this host can do. The service stands its own bridge down when aify-env
 * advertises -- exactly one tier per host, decided from that advertisement -- so an advertisement
 * from here claims capabilities nobody will deliver, and the spawn that follows fails with no cause
 * attached. External review, Round 8 M15.
 */
let viewOnly = false;
// The residents role is tried at the first evaluation and on every sweep while not held, and its population published
// on the same beat (lib/daemon-residents.mjs).
function evaluateAgentState() {
  if (viewOnly || boot.sendingStopped) return;
  void boot.sender?.tick().catch(() => logLine("agent state: evaluation-failed"));
  void boot.agentState?.residents?.tick().catch(() => logLine("residents: evaluation-failed"));
  void boot.paneOpener?.report().catch(() => logLine("herdr: pane reports failed"));
}
function stopAgentStateSending() {
  boot.sendingStopped = true;
  if (boot.evaluationTimer) { clearInterval(boot.evaluationTimer); boot.evaluationTimer = null; }
  boot.sender?.stop();
  void boot.agentState?.residents?.release();
}
server.on("error", async (failure) => {
  if (failure?.code === "EADDRINUSE") {
    if (instanceContext) {
      process.stderr.write(`dedicated_port_in_use: ${HOST}:${port}; incumbent left untouched\n`);
      process.exit(69);
    }
    // TAKE OVER, rather than refuse. Operator ruling: starting the environment means this one serves.
    // The predecessor's processes are not abandoned -- they are in the record, and this instance reaps
    // from it after the port is ours, which is precisely why the reap moved.
    //
    // Only after ASKING. Killing whatever holds a port is how you end somebody else's server, so a
    // holder that does not identify as an aify-env is left alone and reported.
    if (superseding) {
      process.stderr.write(`aify-env: could not take http://${HOST}:${port} even after stopping the previous instance.${chr10}`);
      process.exit(69);
    }
    const holder = await incumbent();
    if (!holder) {
      process.stderr.write(
        `aify-env: ${HOST}:${port} is held by something that is not an aify-env.${chr10}`
        + `  It has been left alone. Free the port, or run with --port <n>.${chr10}`,
      );
      process.exit(69);
    }
    // WHAT THIS WOULD COST, BEFORE IT COSTS IT. The incumbent's processes die with it and cannot be
    // rescued -- see workLostToSupersession for why adoption is impossible here. So the one thing left
    // is to refuse by default and say what is in the way.
    //
    // The operator's own words: "i had to start because i needed to see what is going on". Twice on
    // 2026-09-01 that cost five agents, three of them mid-work, with no warning either time.
    const atRisk = workLostToSupersession(holder.processes, { force });
    if (atRisk.length > 0) {
      const named = atRisk
        .map((entry) => `    ${entry.label || entry.service || "(unnamed)"}  pid ${entry.pid ?? "?"}`)
        .join(chr10);
      // ONE WRITE, THEN THE BRANCH. A second `process.stderr.write` before `process.exit` is
      // DISCARDED when stderr is a pipe -- this file already documents that hazard for stdout, and
      // the first version of this change lost its closing line to it. The existing refusal test
      // pipes stderr, which is why it caught it and a terminal never would have.
      const wantsView = showViewInsteadOfRefusing({
        isTty: process.stdout.isTTY === true,
        noDashboard: process.env.AIFY_NO_DASHBOARD,
      });
      process.stderr.write(
        `aify-env: the environment on ${HOST}:${port} (pid ${holder.pid}) is running ${atRisk.length} `
        + `process${atRisk.length === 1 ? "" : "es"}. Taking over would END ${atRisk.length === 1 ? "it" : "them"}:${chr10}`
        + `${named}${chr10}`
        + `  Nothing has been touched.${chr10}`
        + `  To take over anyway and end the work above, re-run with --force.${chr10}`
        // THE POINTER IS FOR EXACTLY ONE READER. A terminal is about to be SHOWN this environment
        // and needs no instructions; a log, a script or a service manager gets no view, so the
        // command that looks without disturbing has to be named for them or the refusal is a dead
        // end.
        + (wantsView
          ? `  Showing it instead. Press q to leave; nothing here writes.${chr10}`
          : `  To watch this environment without disturbing it, run \`aify-env tui\`.${chr10}`),
      );

      // A4: OPEN THE VIEW INSTEAD OF DESCRIBING IT. The operator asked for this on 2026-08-24 --
      // "bare `aify-env` opens the tui" -- and their reason for starting one in the first place was
      // *"i had to start because i needed to see what is going on"*. Refusing and then naming a
      // second command they must type is one step short of the thing they wanted, and the step is
      // taken at the exact moment they are already frustrated.
      //
      // ONLY WHERE A VIEW BELONGS. A pipe, a redirect or a service manager keeps today's behaviour
      // exactly: the explanation above, exit 69. Escapes in a log are noise, and anything reading
      // this exit status must keep reading the same one. `AIFY_NO_DASHBOARD=1` opts out for a
      // terminal that wants the old shape.
      //
      // THE CONDITION IS UNCHANGED, and that is deliberate. This fires only where a takeover was
      // ALREADY refused -- an incumbent with running agents. An IDLE environment is still superseded
      // by a bare run, so "restart aify-env to pick up new code" keeps working exactly as it does
      // today. Attaching whenever anything answered would have turned that restart into a silent
      // no-op, which is the failure shape this project has spent a night removing.
      if (!wantsView) process.exit(69);
      // THIS PROCESS DESCRIBES NOTHING FROM HERE ON. Both halves are required and the order is why:
      // module evaluation does not wait for this handler, so the advertise block may not have run
      // yet (the flag stops it arming) or may already have (the clear stops it continuing). One
      // without the other is a race that presents as "sometimes it keeps advertising".
      viewOnly = true;
      boot.cancel();
      stopAgentStateSending();
      void boot.stop('advertising').catch(error => logLine(`advertising stop: ${error?.message || error}`));
      process.argv = [
        process.argv[0],
        fileURLToPath(new URL("./aify-env-tui.mjs", import.meta.url)),
      ];
      await import("./aify-env-tui.mjs");
      // The view owns the rest of this process's life: it exits on `q`. Reached only if it returns.
      process.exit(0);
    }
    superseding = true;
    process.stderr.write(
      `aify-env: superseding the environment already running on ${HOST}:${port} (pid ${holder.pid}, `
      + `version ${holder.version ?? "unknown"}).${chr10}`,
    );
    try {
      await ownership.recovery.supersede(holder);
    } catch (error) {
      process.stderr.write(`aify-env: takeover refused: ${error?.message || error}${chr10}`);
      process.exit(69);
      return;
    }
    // Give the socket time to be released before trying again. A tighter loop just spends the same
    // wait in more attempts.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!(await incumbent())) break;
    }
    server.listen(port, HOST);
    return;
  }
  if (failure?.code === "EACCES") {
    process.stderr.write(`aify-env: not allowed to listen on ${HOST}:${port}.${chr10}`);
    process.exit(77);
  }
  // Anything else is genuinely unexpected and keeps its detail, which is what a trace is FOR.
  process.stderr.write(`aify-env: could not listen on ${HOST}:${port}: ${failure?.stack ?? failure}${chr10}`);
  process.exit(70);
});

server.listen(port, HOST, async () => {
  try {
    await startDaemonBoot({
      session: boot, bound: server.address(), host: HOST, home: homedir(), instanceContext,
      runner, definitions: definitionStore, plugins: servicePlugins, version: VERSION, build: BUILD, pid: process.pid,
      env: process.env, node: process.execPath, script: fileURLToPath(import.meta.url), windows: process.platform === 'win32',
      identity: () => {
        const name = hostname();
        return { hostname: name, ...hostIdentityFacts({ platform: process.platform, hostname: name,
          env: process.env, exists: existsSync, isWsl: hostIsWsl() }) };
      },
      roots: () => LAUNCH_ROOTS.current(),
      installed: () => new Set(installedHarnesses(aifyLauncherFilesOnPath()).map(row => row.client)),
      readRegistry: () => readFileSync(REGISTRY_FILE, 'utf8'),
      readServices: () => readServices(readFileSync(REGISTRY_FILE, 'utf8')), buildPlugins: pluginsForServices,
      credential: (service, field) => resolvePluginCredential(service, field), credentialReading,
      advertisement: currentAdvertisementBody, readGrantedRoots,
      servedElsewhere: ({ signal } = {}) => anotherServesAt(`http://127.0.0.1:${DEFAULT_PORT}`, { signal }),
      localSocket: HOST_CONFIG.localSocket, handleRequest, registryPath: REGISTRY_FILE,
      noDashboard: NO_DASHBOARD, notices: NOTICES, shutdown,
      recover: reapLeftovers, evaluate: evaluateAgentState, viewOnly: () => viewOnly,
      advertiser, advertising: ADVERTISE,
      log: logLine, report: line => process.stderr.write(`[aify-env] ${line}${chr10}`),
      write: line => process.stdout.write(line),
    });
  } catch (error) {
    if (error instanceof BootCancelled) return;
    boot.failureExitCode = error?.exitCode ?? 1;
    process.stderr.write(`${error?.message || error}${chr10}`);
    void shutdown('boot-failed');
  }
});

const SWEEP_MS = Number(process.env.AIFY_SWEEP_MS || 30_000);
const sweepTimer = setInterval(() => {
  unknown = reaper.sweep().unknown;
  evaluateAgentState();
}, SWEEP_MS);
sweepTimer.unref();

// ── telling every registered service what this host can do (lib/host-advertiser.mjs) ─────────────

// AN INSTANCE DESCRIBES THE HOST LIKE ANY OTHER: an instance context binds a LIFETIME to a Herdr, it
// does not make this a lesser environment. Was `!instanceContext && ...`; see the dedicated tests.
const ADVERTISE = advertisingEnabled(process.env.AIFY_ADVERTISE);
const REGISTRY_FILE = instanceContext?.serviceRegistry ?? (process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json"));
const advertiser = new HostAdvertiser({
  enabled: ADVERTISE,
  everyMs: Number(process.env.AIFY_ADVERTISE_MS || 30_000),
  redetectMs: Number(process.env.AIFY_ADVERTISE_REDETECT_MS || 300_000),
  readRegistry: () => readFileSync(REGISTRY_FILE, "utf8"),
  onServices: (services) => { if (!boot.cancelled) boot.followServices?.(services); },
  stopped: () => viewOnly || boot.cancelled,
  host: () => {
    // Stable identity is the same boot value used by lifecycle, senders and service plugins.
    const { hostname: hostName, kind, os: hostOs, machineId } = boot.identity;
    const support = terminalSupport();
    // WHAT IS ON DISK NOW, beside what this process loaded at boot. Cached, so a beat every 30 seconds does not re-hash.
    return { hostname: hostName, kind, os: hostOs, machineId, terminal: support.available, terminalReason: support.reason,
      version: VERSION, instance: BUILD, codeOnDisk: PACKAGE_BUILD.onDisk(), launchRoots: LAUNCH_ROOTS.current() };
  },
  harnesses: () => installedHarnesses(aifyLauncherFilesOnPath()),
  pathFor: advertisementPathFor,
  pluginTargets: () => servicePlugins.capabilities('heartbeatTarget').map(read => read()).filter(Boolean),
  post: postAdvertisement,
  credentialReading,
  say: (line) => process.stderr.write(`[aify-env] ${line}${chr10}`),
});

// Advertising is acquired by startDaemonBoot only after a successful bind and nonthrowing boot.
