// Where each harness loads a user's skills from, as the harness itself names it (#12).
//
// A skill copied where its harness does not look is a placement nobody can use, and a guessed root is how that
// happens. So each root comes from the harness's own configuration or its own answer, never from a list of likely
// folders:
//
//   claude  `<CLAUDE_CONFIG_DIR, else <home>/.claude>/skills`. Claude has no read-only command that lists its skill
//           roots, and `claude` is never run from here, so no search root is observed: searchRoots is empty.
//   codex   `<CODEX_HOME, else <home>/.codex>/skills`, accepted only when `codex debug prompt-input` lists that root,
//           or a folder inside it, in its skills roots table. The render calls no model. Measured by aify-dashboard on
//           Codex 0.160 (2026-10-13): it wrote no session and left config.toml alone, though a first render in a fresh
//           Codex home installs Codex's bundled skills under `skills/.system`. A Codex older than the roots table is
//           refused by version; its render names skills by path and the roots cannot be read off it without guessing.
//   hermes  `<get_skills_dir()>/autonomous-ai-agents`, from the selected Hermes' own Python running
//           lib/hermes-skill-roots.py, which refuses writes. searchRoots are get_all_skills_dirs() then the project
//           roots for `cwd`, so a placement can be checked for a copy that shadows it. The root must lie inside one.
//           The Hermes is AIFY_HERMES_AGENT, else <HERMES_HOME>/hermes-agent; with neither it is not found.
//
// Every answer is {root, searchRoots, problem}: a root with problem null, or root null with a named refusal. A
// harness that cannot answer, answers in a shape this does not read, or is not one of the three, is refused.
// Its own text is never carried into a refusal: a failing Codex can quote its config, and a config can hold a key.

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExecutable } from './interpreter.mjs';

/** The Hermes category aify-installed skills are filed under. */
export const HERMES_CATEGORY = 'autonomous-ai-agents';

/** A skill name that cannot exist: a Codex render that offers it is not an observation. */
export const CODEX_CONTROL_NAME = 'aify-env-skill-root-control-that-cannot-exist';

/** The earliest Codex measured rendering a roots table (0.160 and 0.166 do, 0.135 does not). */
const CODEX_ROOTS_TABLE_MEASURED = '0.160';

// Preserve the existing runtime probe bounds from the dashboard installer.
const CODEX_DEADLINE_MS = 60_000;
const HERMES_DEADLINE_MS = 120_000;

export const HERMES_PROBE = fileURLToPath(new URL('./hermes-skill-roots.py', import.meta.url));

const RESOLVERS = { claude: claudeRoot, codex: codexRoot, hermes: hermesRoot };

/** The harnesses a skill root can be resolved for, derived from the resolvers so the two cannot drift. */
export const SKILL_CLIENTS = Object.freeze(Object.keys(RESOLVERS));

/**
 * Where `client` loads user skills from.
 *
 * @param {string} client
 * @param {object} io
 * @param {string} io.home  the user's home, absolute
 * @param {Record<string, string|undefined>} io.env  the environment the harness runs under
 * @param {boolean} io.windows  whether paths are Windows paths (separators, case folding)
 * @param {string} [io.cwd]  the folder a session would start in; Codex and Hermes are asked from it
 * @param {(name: string) => string} [io.find]  an absolute executable on PATH, or ''; Codex only
 * @param {(file: string, args: string[], options: {cwd?: string, env: object, timeout: number}) =>
 *   {status: number|null, stdout?: string, stderr?: string, error?: Error}} [io.run]  spawnSync-shaped
 * @returns {{root: string|null, searchRoots: string[], problem: string|null}}
 */
export function resolveSkillRoot(client, io) {
  if (typeof client !== 'string' || !Object.hasOwn(RESOLVERS, client)) {
    return refused(`${JSON.stringify(client)} has no known skill root; skills are placed for ${SKILL_CLIENTS.join(', ')}`);
  }
  const paths = io.windows ? path.win32 : path.posix;
  if (typeof io.home !== 'string' || !paths.isAbsolute(io.home)) return refused('the home folder is not an absolute path');
  if (typeof io.env !== 'object' || io.env === null) return refused('no environment was given to read the harness home from');
  return RESOLVERS[client]({ ...io, paths });
}

function claudeRoot({ home, env, paths }) {
  const configured = homeVariable(env, 'CLAUDE_CONFIG_DIR', paths);
  if (configured.problem) return refused(configured.problem);
  return answer(normal(paths.join(configured.value ?? paths.join(home, '.claude'), 'skills'), paths), []);
}

const batchShim = /\.(cmd|bat)$/i;

/** A shell lookup may find npm's extensionless script, which a native Windows process cannot start. */
function findProbeExecutable(name, env, windows) {
  const read = key => windows ? Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] : env[key];
  const pathExt = windows ? String(read('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
    .map(ext => ext.trim().toLowerCase()).filter(ext => batchShim.test(ext) || /^\.(com|exe)$/.test(ext)) : [''];
  const found = resolveExecutable(name, { sep: windows ? ';' : ':', pathExt, pathValue: read('PATH') ?? '',
    exists: file => statSync(file, { throwIfNoEntry: false })?.isFile() });
  return found === name ? '' : found;
}

function codexRoot({ home, env, windows, cwd, find = name => findProbeExecutable(name, env, windows), run, paths }) {
  const configured = homeVariable(env, 'CODEX_HOME', paths);
  if (configured.problem) return refused(configured.problem);
  const root = normal(paths.join(configured.value ?? paths.join(home, '.codex'), 'skills'), paths);
  const codex = find('codex');
  if (typeof codex !== 'string' || codex === '') return refused('Codex was not found on PATH');
  if (!paths.isAbsolute(codex)) return refused('the Codex found on PATH is not an absolute path');
  const render = run(codex, ['debug', 'prompt-input'], { cwd, env, timeout: CODEX_DEADLINE_MS });
  if (render.error || render.status !== 0) return refused(`codex debug prompt-input ${failure(render, CODEX_DEADLINE_MS)}`);
  const offer = parseCodexRoots(String(render.stdout ?? ''), paths);
  if (offer.format === 'no-roots-table') return refused(olderCodex(run(codex, ['--version'], { cwd, env, timeout: CODEX_DEADLINE_MS })));
  if (offer.problem) return refused(offer.problem);
  // Codex lists only roots that exist, so before the first install a fresh home shows only `<root>/.system`.
  if (!offer.roots.some((searched) => within(searched, root, windows))) {
    return refused(`Codex does not search ${root}; it searches ${offer.roots.join(', ')}`);
  }
  return answer(root, offer.roots);
}

function hermesRoot({ env, windows, cwd, run, paths }) {
  const agent = selectedHermes(env, paths);
  if (agent.problem) return refused(agent.problem);
  if (typeof cwd !== 'string' || !paths.isAbsolute(cwd)) return refused('the folder Hermes is asked from is not an absolute path');
  const python = paths.join(agent.value, 'venv', ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const ran = run(python, ['-B', HERMES_PROBE, '--cwd', cwd], { cwd: agent.value, env, timeout: HERMES_DEADLINE_MS });
  if (ran.error?.code === 'ENOENT') return refused(`Hermes' Python is not at ${normal(python, paths)}`);
  if (ran.error) return refused(`the Hermes skill probe ${failure(ran, HERMES_DEADLINE_MS)}`);
  const report = parseHermesReport(String(ran.stdout ?? ''), ran.status, paths);
  if (report.problem) return refused(report.problem);
  const root = normal(paths.join(report.skillsDir, HERMES_CATEGORY), paths);
  if (!report.searchRoots.some((searched) => within(root, searched, windows))) {
    return refused(`Hermes does not search ${root}; it searches ${report.searchRoots.join(', ')}`);
  }
  return answer(root, report.searchRoots);
}

/**
 * The skill roots a Codex prompt render declares, in its order, or why the render cannot be read.
 * A render that cannot be read is the instrument broken, never an absence.
 *
 * @returns {{roots: string[]} | {problem: string, format?: 'no-roots-table'}}
 */
export function parseCodexRoots(render, paths = path.posix) {
  let parsed;
  try {
    parsed = JSON.parse(render);
  } catch {
    return { problem: "Codex's prompt render is not JSON" };
  }
  if (!Array.isArray(parsed)) return { problem: "Codex's prompt render is not a list of messages" };
  const text = parsed
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .join('\n');
  const block = /<skills_instructions>([\s\S]*?)<\/skills_instructions>/.exec(text)?.[1];
  if (block === undefined) return { problem: "Codex's prompt has no skills block" };
  const roots = new Map();
  const offered = new Set();
  for (const line of block.split('\n')) {
    const root = /^- `(r\d+)` = `(.+)`\s*$/.exec(line);
    if (root !== null) {
      roots.set(root[1], normal(root[2], paths));
      continue;
    }
    const skill = /^- ([^:]+): .*\(file: (r\d+)\/([^)]+)\)\s*$/.exec(line);
    if (skill === null) continue;
    if (!roots.has(skill[2])) return { problem: `Codex offers a skill through ${skill[2]}, a root its table does not declare` };
    offered.add(skill[1]);
  }
  if (roots.size === 0) return { problem: "Codex's skills block has no roots table", format: 'no-roots-table' };
  if (offered.has(CODEX_CONTROL_NAME)) return { problem: `Codex offers ${CODEX_CONTROL_NAME}, a name that cannot exist` };
  const declared = [...roots.values()];
  if (!declared.every((root) => paths.isAbsolute(root))) return { problem: "Codex's roots table names a root that is not an absolute path" };
  return { roots: declared };
}

/**
 * What the Hermes probe answered, or why it cannot be read. Only named fields leave: whatever else it printed
 * goes no further, and a fatal line contributes its exception type and step only when each is a plain name.
 *
 * @returns {{hermesHome: string, skillsDir: string, searchRoots: string[]} | {problem: string}}
 */
function parseHermesReport(stdout, status, paths = path.posix) {
  const line = stdout.trim().split('\n').pop() ?? '';
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { problem: `the Hermes skill probe exited ${status ?? 'by signal'} without a report` };
  }
  if (isRecord(parsed) && 'error' in parsed) {
    const name = (value, otherwise) => (typeof value === 'string' && PLAIN_NAME.test(value) ? value : otherwise);
    return { problem: `the Hermes skill probe stopped in its ${name(parsed.phase, 'unnamed')} step with ${name(parsed.exception, 'an unnamed exception')}` };
  }
  if (status !== 0) return { problem: `the Hermes skill probe exited ${status ?? 'by signal'}` };
  const absolute = (value) => typeof value === 'string' && paths.isAbsolute(value);
  if (!isRecord(parsed) || !absolute(parsed.hermesHome) || !absolute(parsed.skillsDir)
    || !Array.isArray(parsed.searchRoots) || !parsed.searchRoots.every(absolute)) {
    return { problem: "the Hermes skill probe's report is not the shape this reads" };
  }
  return {
    hermesHome: normal(parsed.hermesHome, paths),
    skillsDir: normal(parsed.skillsDir, paths),
    searchRoots: parsed.searchRoots.map((root) => normal(root, paths)),
  };
}

/**
 * The real `run`: spawnSync with stdin closed and a deadline. A `.cmd` or `.bat` shim, which is how npm installs
 * Codex on Windows, starts only through the shell; the arguments here are this module's own constants and paths.
 */
export function spawnRun(file, args, { cwd, env, timeout } = {}) {
  const options = { cwd, env, input: '', encoding: 'utf8', timeout, windowsHide: true };
  const ran = batchShim.test(file)
    ? spawnSync(`"${file}" ${args.map((arg) => `"${arg}"`).join(' ')}`, { ...options, shell: true })
    : spawnSync(file, args, options);
  return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', error: ran.error };
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function olderCodex(version) {
  const seen = version.status === 0 ? /\b(\d+\.\d+\.\d+)\b/.exec(String(version.stdout ?? ''))?.[1] : undefined;
  const which = seen === undefined ? 'a Codex whose version could not be read' : `Codex ${seen}`;
  return `${which} renders skills without a roots table, so where it loads skills from cannot be read; skills are placed for Codex ${CODEX_ROOTS_TABLE_MEASURED} or later`;
}

/** The Hermes checkout chosen by the caller's environment: AIFY_HERMES_AGENT, else <HERMES_HOME>/hermes-agent. */
function selectedHermes(env, paths) {
  const named = homeVariable(env, 'AIFY_HERMES_AGENT', paths);
  if (named.problem || named.value) return named;
  const home = homeVariable(env, 'HERMES_HOME', paths);
  if (home.problem) return home;
  if (!home.value) return { problem: 'Hermes was not found: set HERMES_HOME, or AIFY_HERMES_AGENT to its checkout' };
  return { value: paths.join(home.value, 'hermes-agent') };
}

/** A home a variable sets: unset or empty is null, a relative path is refused rather than resolved against anything. */
function homeVariable(env, name, paths) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (value === '') return { value: null };
  if (!paths.isAbsolute(value)) return { problem: `${name} is not an absolute path` };
  return { value };
}

/** Whether `inner` is `outer` or a folder inside it. Windows paths fold case. */
function within(inner, outer, windows) {
  const fold = (value) => (windows ? value.toLowerCase() : value);
  const a = fold(inner);
  const b = fold(outer);
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

/** Forward slashes, normalized, no trailing separator except on a filesystem root. */
function normal(value, paths) {
  const joined = paths.normalize(value);
  const forward = paths === path.win32 ? joined.replace(/\\/g, '/') : joined;
  return forward.length > 1 && forward.endsWith('/') && !/^[A-Za-z]:\/$/.test(forward) ? forward.slice(0, -1) : forward;
}

function failure(ran, deadline) {
  if (ran.error?.code === 'ETIMEDOUT') return `did not answer within ${deadline / 1000} s`;
  if (ran.error) return `did not run (${typeof ran.error.code === 'string' ? ran.error.code : 'no error code'})`;
  return ran.status === null ? 'ended by a signal' : `exited ${ran.status}`;
}

function answer(root, searchRoots) {
  return { root, searchRoots: [...searchRoots], problem: null };
}

function refused(problem) {
  return { root: null, searchRoots: [], problem };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
