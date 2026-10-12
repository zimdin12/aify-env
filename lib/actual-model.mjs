// The model an agent's current session actually runs, read from the harness's own record of that session
// (0.9.1; aify-comms plan 2026-10-04-configured-vs-actual-model.md). READ-ONLY.
//
// A session is named by its native handle, which aify-comms reports per agent: Claude's transcript file name,
// hermes' `state.db` session id. A reading that cannot be made is `{unknown: <why>}`, never a guess and never
// compared: a directory holds several agents' sessions, so nothing here picks a session by its workspace. A
// session is found by its own id, which is unique.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

//: How much of a transcript's end is read. Transcripts reach 1.6 GB (measured 2026-10-04); the newest answer
//: is at the end.
export const TAIL_BYTES = 256 * 1024;

/** Claude's project folder name for a working directory: every character but a letter or digit becomes `-`. */
export function claudeProjectSlug(workspace) {
  return String(workspace || "").replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * The newest model that answered in a transcript's text, or null. PURE.
 * A tail can start mid-line, so a line that does not parse is skipped; `<synthetic>` marks a message Claude
 * wrote itself, not a model's answer.
 */
export function latestClaudeAnswer(text) {
  const lines = String(text || "").split("\n");
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    let line;
    try { line = JSON.parse(lines[at]); } catch { continue; }
    const model = line?.type === "assistant" ? line.message?.model : undefined;
    if (typeof model === "string" && model && model !== "<synthetic>") return { model, at: String(line.timestamp || "") };
  }
  return null;
}

function tail(file, bytes) {
  const handle = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Where Claude keeps a session's transcript: `<config>/projects/<slug of the folder it started in>/<handle>.jsonl`.
 * The workspace aify-comms reports is where the agent registered from, which is not always where Claude started
 * (2 of 25 agents on 2026-10-12: a scratch folder, and the router beside its repo), so a transcript not under it is
 * found by its session id under any project folder.
 */
function claudeTranscript({ workspace, handle, env = process.env, homedir = os.homedir() }) {
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir, ".claude"), "projects");
  const expected = path.join(projects, claudeProjectSlug(workspace), `${handle}.jsonl`);
  if (fs.existsSync(expected)) return expected;
  let folders;
  try { folders = fs.readdirSync(projects); } catch { return expected; }
  return folders.map((folder) => path.join(projects, folder, `${handle}.jsonl`)).find((file) => fs.existsSync(file)) ?? expected;
}

/** What a Claude session answered with last, from its transcript. */
export function claudeActual({ workspace, handle, env = process.env, homedir = os.homedir() }) {
  if (!handle) return { unknown: "no session handle" };
  const file = claudeTranscript({ workspace, handle, env, homedir });
  let text;
  try { text = tail(file, TAIL_BYTES); } catch (failure) { return { unknown: `no transcript at ${file} (${failure.code || failure.message})` }; }
  return latestClaudeAnswer(text) ?? { unknown: `no model answered in the last ${TAIL_BYTES / 1024} KB of ${file}` };
}

/** Where hermes keeps `state.db`: HERMES_HOME, else the platform default (hermes 0.21.5 hermes_constants.py). */
export function hermesStateDb({ env = process.env, platform = process.platform, homedir = os.homedir() }) {
  if (env.HERMES_HOME?.trim()) return path.join(env.HERMES_HOME.trim(), "state.db");
  const base = platform === "win32" ? (env.LOCALAPPDATA?.trim() || path.join(homedir, "AppData", "Local")) : homedir;
  return path.join(base, platform === "win32" ? "hermes" : ".hermes", "state.db");
}

// node:sqlite announces itself as experimental on first load; that line is not this command's to print.
async function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => (/SQLite/.test(String(warning)) ? undefined : emit.call(process, warning, ...rest));
  try { return await import("node:sqlite"); } finally { process.emitWarning = emit; }
}

/**
 * What a hermes session's own turns ran on last: the newest `session_model_usage` row with `task = ''`. Side
 * tasks (`compression`, `title_generation`) run other models, and `sessions.model` is not what ran (M7, M10).
 */
export async function hermesActual({ handle, file = hermesStateDb({}), sqlite = loadSqlite }) {
  if (!handle) return { unknown: "no session handle" };
  if (!fs.existsSync(file)) return { unknown: `no hermes state at ${file}` };
  let module;
  try { module = await sqlite(); } catch { return { unknown: "this node has no node:sqlite to read hermes state with" }; }
  let db;
  try {
    db = new module.DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT model, last_seen FROM session_model_usage WHERE session_id = ? AND task = '' "
      + "ORDER BY last_seen DESC LIMIT 1").get(handle);
    if (!row) return { unknown: `no turn of session ${handle} in ${file}` };
    return { model: String(row.model), at: new Date(Number(row.last_seen) * 1000).toISOString() };
  } catch (failure) {
    return { unknown: `could not read ${file}: ${failure.message}` };
  } finally {
    db?.close();
  }
}

/** The actual model for one agent's harness and session. */
export async function actualModel({ harness, workspace, handle, env = process.env, homedir = os.homedir(),
  hermesFile = hermesStateDb({ env, homedir }) }) {
  if (harness === "claude") return claudeActual({ workspace, handle, env, homedir });
  if (harness === "hermes") return hermesActual({ handle, file: hermesFile });
  return { unknown: `${harness} sessions are not read yet` };
}

/** Size and mtime of each file, or `-` for one that is not there: a reading of them stands until this changes. */
function signature(files, stat) {
  return files.map((file) => {
    try {
      const { size, mtimeMs } = stat(file);
      return `${size}:${mtimeMs}`;
    } catch {
      return "-";
    }
  }).join("|");
}

/**
 * The actual model read on demand, each reading kept until a file it came from changes (0.9.1 3B: asked when someone
 * looks, so a repeat look costs one stat and never answers older than the file).
 * ponytail: one entry per session read in this process's life, a few dozen; evict when a host reads thousands.
 */
export class ModelReader {
  #memo = new Map();
  #stat;
  #read;
  #sources;

  constructor({ env = process.env, homedir = os.homedir(), hermesFile = hermesStateDb({ env, homedir }),
    stat = fs.statSync, read = (asked) => actualModel({ ...asked, env, homedir, hermesFile }) } = {}) {
    this.#stat = stat;
    this.#read = read;
    this.#sources = {
      claude: ({ workspace, handle }) => [claudeTranscript({ workspace, handle, env, homedir })],
      // SQLite writes land in the write-ahead log first, so the database file alone can stand still while a turn is recorded.
      hermes: () => [hermesFile, `${hermesFile}-wal`],
    };
  }

  async read({ harness, workspace, handle }) {
    const files = handle ? this.#sources[harness]?.({ workspace, handle }) : null;
    if (!files) return this.#read({ harness, workspace, handle });
    const key = `${harness}\0${files[0]}\0${handle}`;
    const now = signature(files, this.#stat);
    const kept = this.#memo.get(key);
    if (kept?.signature === now) return kept.result;
    const result = await this.#read({ harness, workspace, handle });
    this.#memo.set(key, { signature: now, result });
    return result;
  }
}
