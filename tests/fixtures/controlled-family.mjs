// An HTTP-started fixture has no ChildProcess handle in its caller. Its private stop file is cleanup,
// never evidence that the product stopped it. Observations use only this fixture's published births.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ProcessIdentityProbe } from '../../lib/process-identity.mjs';
import { originalBirthState, sameBirth, validBirth } from '../../lib/process-birth.mjs';

const WORKER_URL = new URL('../test-data/controlled-descendant.mjs', import.meta.url).href;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ControlledFamily {
  constructor({ hasChild = true, platform = process.platform, identity = new ProcessIdentityProbe(), now = Date.now, pause = wait } = {}) {
    if (typeof hasChild !== 'boolean') throw new TypeError('fixture child policy must be explicit');
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-controlled-family-'));
    this.hasChild = hasChild; this.platform = platform; this.identity = identity; this.now = now; this.pause = pause;
    this.launcher = path.join(this.dir, 'controlled-aify.mjs');
    const text = '#!/usr/bin/env node\nlet HARNESS_WRAPPER_VERSION;\nHARNESS_WRAPPER_VERSION="0.6.0"\n'
      + `import { ControlledDescendant } from ${JSON.stringify(WORKER_URL)};\n`
      + `await new ControlledDescendant(${JSON.stringify({ controlDir: this.dir, hasChild })}).run();\n`;
    fs.writeFileSync(this.launcher, text, { mode: 0o755 });
  }

  inputSnapshot() {
    const capture = file => {
      const bytes = fs.readFileSync(file);
      return { sha256: createHash('sha256').update(bytes).digest('hex'), text: bytes.toString('utf8') };
    };
    return { launcher: capture(this.launcher), worker: capture(new URL(WORKER_URL)), owner: capture(new URL(import.meta.url)) };
  }

  stopRequested() { return fs.existsSync(path.join(this.dir, 'stop')); }

  readRegistration({ expectedPid = null } = {}) {
    const read = role => {
      try { return JSON.parse(fs.readFileSync(path.join(this.dir, role + '.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`fixture ${role} registration is unreadable: ${error.message}`); }
    };
    const root = read('root');
    if (!root) return null;
    if (root.role !== 'root' || !validBirth(root.birth) || !sameBirth(root.birth, root.rootBirth)
      || root.hasChild !== this.hasChild || (expectedPid !== null && root.birth.pid !== expectedPid)) {
      throw new Error('fixture root registration does not match its actual HTTP-started root');
    }
    const child = this.hasChild ? read('child') : null;
    if (this.hasChild && !child) return null;
    if (child && (child.role !== 'child' || !validBirth(child.birth) || !sameBirth(root.birth, child.rootBirth)
      || child.birth.pid === root.birth.pid)) throw new Error('fixture descendant is not bound to its original root');
    return { root, children: child ? [child] : [] };
  }

  async until(check, what) {
    const deadline = this.now() + 20_000;
    for (;;) {
      const answer = await check();
      if (answer) return answer;
      if (this.now() >= deadline) throw new Error(`${what} was not confirmed within 20000ms`);
      await this.pause(100);
    }
  }

  ready({ expectedPid }) {
    if (!Number.isSafeInteger(expectedPid) || expectedPid <= 1) throw new TypeError('fixture readiness needs the HTTP-created PID');
    return this.until(() => this.readRegistration({ expectedPid }), 'fixture-owned birth registration');
  }

  async states(registration) {
    if (!registration?.root || !Array.isArray(registration.children)) throw new TypeError('fixture observations need a complete registration');
    const rows = [registration.root, ...registration.children];
    if (rows.some(row => !validBirth(row.birth) || !sameBirth(registration.root.birth, row.rootBirth))) {
      throw new Error('fixture observation refused an unbound birth');
    }
    const answers = await this.identity.probe(rows.map(row => row.birth.pid));
    return rows.map(row => {
      const state = originalBirthState(row.birth, answers.get(row.birth.pid), this.platform);
      if (state === 'unknown') throw new Error(`fixture birth observation is unknown for ${row.birth.pid}`);
      return { row, state };
    });
  }

  async countChildren(registration) {
    const states = await this.states(registration);
    return states.filter(({ row, state }) => row.role === 'child' && state === 'present').length;
  }

  async originalsGone(registration) {
    return (await this.states(registration)).every(({ state }) => state === 'gone');
  }

  async productGone(registration) {
    if (this.stopRequested()) throw new Error('fixture teardown already began; product disappearance cannot be qualified');
    if (!await this.originalsGone(registration)) return false;
    for (const row of [registration.root, ...registration.children]) {
      if (fs.existsSync(path.join(this.dir, 'finished-' + row.role + '.json'))) {
        throw new Error('fixture self-exit/TTL cannot qualify product-driven disappearance');
      }
    }
    return true;
  }

  async dispose({ registration = null, expectedPid = null } = {}) {
    fs.writeFileSync(path.join(this.dir, 'stop'), 'fixture teardown only\n');
    if (!registration) registration = this.readRegistration({ expectedPid });
    if (!registration) return { confirmed: false, problem: 'no complete fixture registration; private stop/TTL remains, no numeric signal permitted' };
    await this.until(() => this.originalsGone(registration), 'fixture self-exit after private teardown marker');
    fs.rmSync(this.dir, { recursive: true, force: true });
    return { confirmed: true };
  }
}
