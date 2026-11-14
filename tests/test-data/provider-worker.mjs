import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: 'finished-id', ok: true, value: 'wrong' }) + '\n');
  const answer = { id: request.id, ok: request.call !== 'refuse', problem: 'fixture refusal',
    value: { repoRoot: request.repoRoot, reasonCode: 'no_index', text: 'λ', key: process.env.APG_DASHBOARD_KEY ?? null }, provenance: null };
  const bytes = Buffer.from(JSON.stringify(answer) + '\n'), at = bytes.indexOf(Buffer.from('λ')) + 1;
  process.stdout.write(bytes.subarray(0, at));
  await new Promise(resolve => setImmediate(resolve));
  process.stdout.write(bytes.subarray(at));
}
