// Crash only this owned consumer, at actual filesystem/save boundaries.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ActivityConsumer } from '../../lib/plugins/aify-dashboard/activity-consumer.mjs';
const inputBytes = fs.readFileSync(process.argv[2]), input = JSON.parse(inputBytes);
const { validActivityRecord } = await import(pathToFileURL(path.join(input.wrapper, 'lib/file-activity.mjs')));
const c = new ActivityConsumer({ directory: input.directory, agentId: 'agent-1', endpoint: input.endpoint, validRecord: validActivityRecord });
console.log(JSON.stringify({ pid: process.pid, version: process.version, executable: process.execPath }));
const unlink = fs.unlinkSync, save = c.storage.save.bind(c.storage);
fs.unlinkSync = function(file, ...args) {
  const marker = file.endsWith('.loss'), raw = file.endsWith('.jsonl');
  const result = unlink.call(this, file, ...args);
  if (input.boundary === 'after-marker' && marker || input.boundary === 'after-raw' && raw) process.exit(23);
  return result;
};
c.storage.save = state => {
  const phase = Object.values(state.sources)[0]?.retirement?.phase;
  if (input.boundary === 'before-ack-save' && phase === 'acked') process.exit(23);
  save(state);
  if (input.boundary === 'marker-saved' && phase === 'marker-removed'
    || input.boundary === 'raw-saved' && phase === 'raw-removed') process.exit(23);
};
if (input.boundary === 'before-ack-save') c.ack(input.token, { committed: true, eventIds: input.token.eventIds, gapIds: input.token.gapIds });
else c.read();
throw Error('requested real crash boundary was not reached');
