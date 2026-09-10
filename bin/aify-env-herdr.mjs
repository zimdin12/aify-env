#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { detectHerdr, endpoint, HerdrClient, listWorkers, selectWorker, openWorker } from '../lib/herdr.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(a => a.startsWith('-'))) throw new Error('Usage: aify-env herdr [process-id-or-label]. Set AIFY_ENV_ENDPOINT and HERDR_SOCKET_PATH first');
  if (process.platform !== 'win32') throw new Error('This adapter currently supports Windows PowerShell panes only');
  const binary = detectHerdr();
  if (!binary) throw new Error('Herdr not found on PATH or LOCALAPPDATA/Programs/Herdr/bin. Install separately: https://herdr.dev/docs/quick-start/ . Nothing installed or started');
  const base = endpoint(process.env.AIFY_ENV_ENDPOINT);
  const client = new HerdrClient(process.env.HERDR_SOCKET_PATH);
  const workers = await listWorkers(base);
  let wanted = args[0];
  if (!wanted) {
    const candidates = workers.filter(p => p.terminal === true && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.id));
    if (!candidates.length) throw new Error('The existing daemon has no terminal-backed workers');
    candidates.forEach((p, i) => console.log(`${i + 1}. ${p.id} ${JSON.stringify(p.label || '')}`));
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Pass a process id or label when not in an interactive terminal');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question('Open worker number, or Enter to cancel: ');
      if (!answer) process.exit(0);
      if (!/^[1-9][0-9]*$/.test(answer) || !candidates[Number(answer) - 1]) throw new Error('Invalid selection');
      wanted = candidates[Number(answer) - 1].id;
    } finally { prompt.close(); }
  }
  // Resolve human convenience only against the initial listing. Identity is fixed thereafter.
  const selected = selectWorker(workers, wanted);
  const worker = selectWorker(await listWorkers(base), selected.id, { exactId: true });
  const opened = await openWorker({ client, worker, base, node: process.execPath,
    script: fileURLToPath(new URL('./aify-env.mjs', import.meta.url)), cwd: process.cwd() });
  console.log(JSON.stringify(opened));
  console.log('Attach command submitted in Herdr. Ctrl-] detaches; closing the pane does not stop the worker.');
} catch (error) {
  console.error(`aify-env herdr: ${error.message}`);
  process.exitCode = 69;
}
