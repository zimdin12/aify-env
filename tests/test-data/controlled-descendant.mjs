// Fixture workers do not monitor parent death: the product must end the real descendant.
// Only teardown's private marker or the fixture TTL makes a surviving worker exit itself.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProcessIdentityProbe } from '../../lib/process-identity.mjs';
import { observedBirth, validBirth } from '../../lib/process-birth.mjs';

export const FIXTURE_TTL_MS = 120_000;
const WORKER_FILE = fileURLToPath(import.meta.url);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ControlledDescendant {
  constructor({ controlDir, role = 'root', rootBirth = null, hasChild = true,
    platform = process.platform, pid = process.pid, identity = new ProcessIdentityProbe(),
    io = fs, start = spawn, now = Date.now, pause = wait, finish = code => process.exit(code),
    ttlMs = FIXTURE_TTL_MS } = {}) {
    if (typeof controlDir !== 'string' || !path.isAbsolute(controlDir)) throw new TypeError('fixture needs an absolute private control directory');
    if (role !== 'root' && role !== 'child') throw new TypeError('unknown fixture role');
    if (typeof hasChild !== 'boolean') throw new TypeError('fixture child policy must be explicit');
    if (role === 'child' && !validBirth(rootBirth)) throw new TypeError('fixture child needs the original root birth');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > FIXTURE_TTL_MS) throw new TypeError('fixture TTL must remain bounded');
    Object.assign(this, { controlDir, role, rootBirth, hasChild, platform, pid, identity, io, start, now, pause, finish, ttlMs });
  }

  async run() {
    const deadline = this.now() + this.ttlMs;
    const answer = (await this.identity.probe([this.pid])).get(this.pid);
    const birth = observedBirth(this.pid, answer, this.platform);
    if (!birth) throw new Error('fixture could not capture its own original birth');
    const rootBirth = this.role === 'root' ? birth : this.rootBirth;
    const row = { role: this.role, birth, rootBirth, hasChild: this.role === 'root' && this.hasChild };
    const file = path.join(this.controlDir, this.role + '.json');
    this.io.writeFileSync(file + '.tmp', JSON.stringify(row));
    this.io.renameSync(file + '.tmp', file);
    if (this.role === 'root' && this.hasChild) {
      // The real child inherits this group/console and never exits merely because its parent dies.
      const child = this.start(process.execPath, [WORKER_FILE, JSON.stringify({ controlDir: this.controlDir,
        role: 'child', rootBirth, hasChild: false, ttlMs: this.ttlMs })], { stdio: 'ignore', windowsHide: true });
      child.once('error', error => { process.stderr.write(`fixture descendant failed: ${error.message}\n`); this.finish(1); });
    }
    while (!this.io.existsSync(path.join(this.controlDir, 'stop')) && this.now() < deadline) await this.pause(25);
    // A self-exit receipt prevents TTL/teardown from being mistaken for product-driven termination.
    const reason = this.io.existsSync(path.join(this.controlDir, 'stop')) ? 'marker' : 'ttl';
    this.io.writeFileSync(path.join(this.controlDir, 'finished-' + this.role + '.json'), JSON.stringify({ birth, reason }));
    // This is self-exit, never process.kill(savedPid), taskkill or a process-table sweep.
    this.finish(0);
    return row;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === WORKER_FILE) {
  try { await new ControlledDescendant(JSON.parse(process.argv[2])).run(); }
  catch (error) { process.stderr.write(`controlled fixture failed: ${error.message}\n`); process.exitCode = 1; }
}
