// The old one-shot outcome fixtures now speak the real worker's framed transport, without spawning or killing.
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { HeadWatcher } from '../../lib/plugins/aify-dashboard/head-watcher.mjs';

// The watcher serves only Windows locations. POSIX provider tests start at its judged-folder output;
// the real runner rechecks the native grant. On Windows the real watcher still judges the location.
export function providerWatchList(t, projectId, folder) {
  const platform = process.platform;
  if (platform === 'win32') return [{ projectId, name: 'Fixture project', root: { fsNamespace: 'windows', path: folder } }];
  const real = realpathSync.native(folder);
  t.mock.method(HeadWatcher.prototype, 'watched', () => [{ projectId, path: folder, real, platform, head: '' }]);
  return [];
}
export const request = (projectId, n = 1) => ({ requestId: `request-${n}`, projectId, call: 'stamp', args: {} });
export const providerApi = pending => {
  let n = 0;
  return { providerPending: async hostKey => ({ hostKey, projects: pending() }),
    claimProvider: async (_, projectId) => ({ claimed: [request(projectId, ++n)] }),
    postProviderResult: async () => ({ stored: true }) };
};
export function providerFetch(fetch) {
  let n = 0;
  return (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/provider/claim')) return Response.json({ claimed: [request(JSON.parse(options.body).projectId, ++n)] });
    if (path.endsWith('/result')) return Response.json({ stored: true });
    return fetch(String(url).replace(/\?waitSeconds=\d+$/, ''), options);
  };
}
export const scriptedRun = handle => options => new Promise(resolve => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  let ended = false;
  const finish = result => { if (!ended) { ended = true; stdout.end(); resolve(result); } };
  const normal = { code: 0, signal: null, timedOut: false, stopped: false, error: '', unconfirmed: '' };
  const lines = createInterface({ input: stdin });
  lines.on('line', async line => {
    const req = JSON.parse(line), result = await handle({ ...options, cwd: req.repoRoot, request: req });
    if (result.code !== 0 || result.timedOut || result.stopped) finish(result);
    else stdout.write(result.frame ?? JSON.stringify({ id: req.id, ok: true, value: {}, provenance: null }) + '\n');
  });
  stdin.on('finish', () => finish(normal));
  options.signal.addEventListener('abort', () => finish({ ...normal, stopped: true }), { once: true });
  options.onChild({ stdin, stdout });
});
