// Client-only Herdr adapter. Never invokes a binary or starts either server.
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolveAttachTarget } from './attach-target.mjs';

// WHERE HERDR IS, asked the way aify-wrapper's `lib/herdr-binary.mjs` asks (v0.7 scan, F19). This
// checked PATH and `%LOCALAPPDATA%/Programs/Herdr/bin` only, while aify-wrapper -- which measured that
// Herdr is usually NOT on PATH at an ordinary Windows prompt -- checks `HERDR_BIN_PATH`, the
// standalone package under `HERDR_HOME`, `HERDR_INSTALL_DIR`, then PATH. So `aify-env herdr` could
// miss a Herdr that `herdr-aify` found. Same places, same order, read from Herdr v0.9.0's installers.
// Nothing here runs the binary; a match is a file that exists.
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
const listDir = dir => { try { return readdirSync(dir); } catch { return []; } };

/** Every place a herdr binary might be, most trusted first. */
export function herdrCandidates(env = process.env, { platform = process.platform, home = homedir(), readdir = listDir } = {}) {
  const windows = platform === 'win32';
  const names = windows ? ['herdr.exe', 'herdr'] : ['herdr'];
  const found = [];
  const add = candidate => { if (candidate && !found.includes(candidate)) found.push(candidate); };
  const addDir = dir => { if (dir) for (const name of names) add(path.join(dir, name)); };
  add(env.HERDR_BIN_PATH);
  if (windows) {
    const standalone = path.join(env.HERDR_HOME || path.join(home, '.herdr'), 'packages', 'standalone');
    addDir(path.join(standalone, 'current'));
    // A release directly, newest first, for an install whose `current` link is missing or broken.
    for (const release of [...readdir(path.join(standalone, 'releases'))].sort().reverse()) {
      addDir(path.join(standalone, 'releases', release));
    }
  }
  addDir(env.HERDR_INSTALL_DIR || (windows
    ? env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Herdr', 'bin')
    : path.join(home, '.local', 'bin')));
  for (const dir of String(env.PATH ?? env.Path ?? '').split(windows ? ';' : ':')) addDir(dir);
  return found;
}

export function detectHerdr(env = process.env, { exists = isFile, ...where } = {}) {
  // AN EXPLICIT `HERDR_BIN_PATH` IS AUTHORITATIVE: inside a pane it is Herdr's own statement of which
  // binary opened it, and searching past it would talk to a different Herdr.
  if (typeof env.HERDR_BIN_PATH === 'string' && env.HERDR_BIN_PATH !== '') return env.HERDR_BIN_PATH;
  return herdrCandidates(env, where).find(candidate => exists(candidate)) ?? null;
}

export function endpoint(value) {
  // Literal loopback only. Reject credentials, redirects, paths and URL normalization tricks.
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value || '')) throw new Error('Set AIFY_ENV_ENDPOINT to http://127.0.0.1:<port> for the existing daemon');
  if (Number(new URL(value).port || 80) > 65535) throw new Error('Invalid endpoint port');
  return value;
}

export function socketPath(value) {
  if (!value || /[\x00-\x1f]/.test(value)) throw new Error('Set HERDR_SOCKET_PATH to the existing Herdr server socket; no server is started');
  if (process.platform === 'win32') {
    if (/^[a-zA-Z0-9_.-]+$/.test(value)) return '\\\\.\\pipe\\' + value;
    if (/^\\\\\.\\pipe\\[a-zA-Z0-9_.-]+$/.test(value)) return value;
    // A FILESYSTEM SOCKET IS WHAT HERDR ACTUALLY USES ON WINDOWS, and refusing one made this adapter
    // unable to talk to the very Herdr it was running inside. Measured against Herdr 0.9.0: its own
    // error names `...config\herdr\herdr.sock`, and a dedicated instance is given a `.sock` file
    // under its invocation root. An absolute path is accepted for that reason and no other.
    if (path.isAbsolute(value)) return value;
    throw new Error('HERDR_SOCKET_PATH must be a named pipe or an absolute socket path');
  }
  if (!path.isAbsolute(value)) throw new Error('HERDR_SOCKET_PATH must be absolute');
  return value;
}

export class HerdrClient {
  constructor(socket) { this.socket = socketPath(socket); }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID(), stream = net.connect(this.socket);
      let text = '', done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true; clearTimeout(timer); stream.destroy();
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`Herdr ${method} timed out`)), 5000);
      stream.on('error', error => finish(error));
      stream.on('end', () => finish(new Error(`Herdr ${method} ended without a response`)));
      stream.on('connect', () => stream.write(JSON.stringify({ id, method, params }) + '\n'));
      stream.on('data', chunk => {
        text += chunk;
        if (text.length > 1024 * 1024) return finish(new Error('Herdr response too large'));
        const end = text.indexOf('\n');
        if (end < 0) return;
        try {
          const response = JSON.parse(text.slice(0, end));
          if (response.id !== id || response.error || !response.result?.type) throw new Error(JSON.stringify(response));
          finish(null, response.result);
        } catch (error) { finish(error); }
      });
    });
  }
}

export async function listWorkers(base) {
  const response = await fetch(endpoint(base) + '/processes', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.processes)) throw new Error('Existing daemon did not return a process list');
  return data.processes;
}

export function selectWorker(workers, wanted, { exactId = false } = {}) {
  const result = resolveAttachTarget(workers, wanted, { exactId });
  if (result.error) throw new Error(result.error);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result.id)) throw new Error('Invalid process id');
  const matches = workers.filter(p => p.id === result.id);
  if (matches.length !== 1 || matches[0].terminal !== true) throw new Error('Target must be one existing terminal-backed worker');
  return matches[0];
}

/**
 * The line a Herdr pane types to attach to a running worker, in the shell that pane runs on this host.
 *
 * WINDOWS: one `powershell.exe -EncodedCommand` line, which any Windows shell can run. ELSEWHERE: a
 * POSIX line. On WSL this built the Windows one too, zsh found `powershell.exe` through interop, and
 * every pane showed Windows PowerShell failing to run a Linux node path.
 */
export function attachCommand({ node, script, base, id, platform = process.platform }) {
  endpoint(base);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error('Invalid process id');
  for (const value of [node, script]) {
    if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new Error('Invalid command path');
  }
  if (platform === 'win32') {
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const command = `$env:AIFY_ENV_ENDPOINT=${literal(base)}; & ${literal(node)} ${literal(script)} attach --id ${literal(id)}`;
    return 'powershell.exe -NoLogo -NoProfile -EncodedCommand ' + Buffer.from(command, 'utf16le').toString('base64');
  }
  // Quote and backslash go OUTSIDE the single quotes, escaped: fish reads `\\` and `\'` inside
  // single quotes as escapes, sh/bash/zsh do not, and outside quotes all of them agree.
  const literal = value => value.split(/(['\\])/).map(part => (part === "'" || part === '\\') ? '\\' + part : part && `'${part}'`).join('');
  // REFUSED, not quoted: `env` reads every leading operand holding `=` as an assignment, quoted or
  // not, so a node under `/opt/a=b/` became a variable and the SCRIPT ran as the program.
  if (node.includes('=')) throw new Error('Invalid command path: env would read a node path containing = as a variable');
  return `env AIFY_ENV_ENDPOINT=${literal(base)} ${literal(node)} ${literal(script)} attach --id ${literal(id)}`;
}

export async function openWorker({ client, worker, base, node, script, cwd }) {
  const pong = await client.call('ping');
  if (pong.type !== 'pong' || pong.version !== '0.9.0' || pong.protocol !== 22) throw new Error('This adapter supports Herdr 0.9.0 protocol 22 only');
  const command = attachCommand({ node, script, base, id: worker.id });
  const created = await client.call('workspace.create', { cwd, label: 'aify-env ' + worker.id, focus: true, env: { AIFY_ENV_ENDPOINT: base } });
  const pane_id = created.root_pane?.pane_id;
  if (!pane_id) throw new Error('Herdr did not return a pane');
  try {
    let shell;
    for (let attempt = 0; attempt < 30; attempt++) {
      const info = (await client.call('pane.process_info', { pane_id })).process_info;
      shell = info?.foreground_processes?.find(p => p.pid === info.shell_pid);
      if (shell) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!shell || !/^(powershell|pwsh)(\.exe)?$/i.test(shell.name)) throw new Error('Configure Herdr terminal.default_shell as PowerShell; other shells are not supported');
    // Separate CR submission avoids bracketed-paste and Windows Enter ambiguity.
    await client.call('pane.send_text', { pane_id, text: command });
    await client.call('pane.send_text', { pane_id, text: '\r' });
    const verified = await client.call('pane.get', { pane_id });
    if (verified.pane?.pane_id !== pane_id) throw new Error('Created pane disappeared');
    return { pane_id, worker_id: worker.id, workspace_id: created.workspace.workspace_id };
  } catch (error) {
    throw new Error(`${error.message}. Created pane ${pane_id} was left for inspection; worker was not stopped`);
  }
}
