// Fixture-only subprocess. Never imports the daemon CLI or reads an ambient home.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ActivityConsumer } from '../../lib/plugins/aify-dashboard/activity-consumer.mjs';
const { wrapper, action, ...input } = JSON.parse(process.argv[2]);
const { validActivityRecord } = await import(pathToFileURL(path.join(wrapper, 'lib/file-activity.mjs')));
const consumer = new ActivityConsumer({ ...input, validRecord: validActivityRecord });
const result = consumer.read();
if (!result.ok) throw new Error('fixture consumer refused');
console.log(JSON.stringify(result));
if (action === 'crash') consumer.storage.transaction(() => process.exit(23));
