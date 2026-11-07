// #15's service launch grant must not replace the provider's independently granted watched folder.
// Real core/plugin composition, fake git/client/network ports, and throwing default process effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboardPlugin } from '../lib/plugins/aify-dashboard/index.mjs';
import { SCRIPT } from '../lib/plugins/aify-dashboard/provider-runner.mjs';
import { grantedRoots, watchRootsFrom } from '../lib/watch-roots.mjs';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
new ProcessEffectTripwire();

test('the provider serves its watch grant without consulting core launch grants or PluginProcesses', { timeout: 5000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provider-launch-exemption-')));
  const folder = path.join(root, 'project'), gitDir = path.join(folder, '.git'), checkout = path.join(root, 'provider');
  fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
  const head = 'a'.repeat(40);
  fs.writeFileSync(path.join(gitDir, 'HEAD'), head + '\n');
  fs.writeFileSync(path.join(gitDir, 'config'), '[core]\nrepositoryformatversion = 0\n');
  fs.writeFileSync(path.join(checkout, SCRIPT), 'fixture only');
  let rootAsks = 0, processStarts = 0, sawRun;
  const runs = [], ran = new Promise(resolve => { sawRun = resolve; });
  const windows = process.platform === 'win32';
  const platform = windows ? 'windows' : 'linux';
  const plugin = createDashboardPlugin({
    machineId: `${process.platform}:fixture`, endpoint: 'http://fixture.invalid', service: { name: 'fixture' },
    cwdRoots: () => { rootAsks++; throw Error('provider must use its watch grant, not service launch grants'); },
    watchRoots: async () => grantedRoots(watchRootsFrom(JSON.stringify({ watchRoots: [root] }), process.platform), [], process.platform),
    config: () => ({ config: { providerCheckout: checkout }, problem: '' }),
  }, {
    git: { gitDirs: async () => ({ toplevel: folder, gitDir, commonDir: gitDir }), head: async () => head },
    fetch: async url => {
      const at = String(url);
      if (at.endsWith('/watch-list')) return Response.json({ hostKey: 'fixture', projects: [{ projectId: 'p1', name: 'Fixture project', root: { fsNamespace: platform, path: folder } }] });
      if (at.endsWith('/provider/pending')) return Response.json({ hostKey: 'fixture', projects: [{ projectId: 'p1', queued: 1 }] });
      if (at.endsWith('/reports/head')) return Response.json({ ok: true, ackedHead: head, cursorRevision: 1 });
      return Response.json({ error: 'fixture route absent' }, { status: 404 });
    },
    runChild: async value => { runs.push(value); sawRun(); return { code: 0, signal: null, timedOut: false, stopped: false, error: '' }; },
    tickMs: 60000, runEveryMs: 10,
  });
  t.after(async () => { await plugin.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const error = await plugin.start({ credential: async () => 'fixture-key', processes: { start() { processStarts++; throw Error('provider must not use PluginProcesses'); } } }).then(() => null, error => error);
  assert.equal(error === null, true, 'independent watch authority admits plugin startup');
  let timer;
  const reached = await Promise.race([ran.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2500); })]);
  clearTimeout(timer); await plugin.stop();
  assert.equal(reached, true, JSON.stringify(plugin.state()));
  assert.equal(runs[0].cwd, fs.realpathSync.native(folder), 'the actual watched real folder reaches the client');
  assert.deepEqual({ rootAsks, processStarts }, { rootAsks: 0, processStarts: 0 });
});
