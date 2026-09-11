import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function instanceFixture(parent) {
  const invocation = randomUUID();
  const root = path.join(parent, 'invocations', invocation);
  fs.mkdirSync(root, { recursive: true });
  const context = {
    version: 1, invocation, scope: `herdr-${invocation}`, root,
    processRecord: path.join(root, 'owned-processes.json'),
    serviceRegistry: path.join(root, 'services.json'),
    ownerEndpoint: process.platform === 'win32' ? `\\\\.\\pipe\\aify-herdr-owner-${invocation}` : path.join(root, 'owner.sock'),
    readinessEndpoint: path.join(root, 'ready.json'),
    herdrApiEndpoint: process.platform === 'win32' ? `\\\\.\\pipe\\aify-herdr-api-${invocation}` : path.join(root, 'herdr.sock'),
    profileRef: 'integrated', takeover: 'refuse', recovery: 'none',
  };
  const file = path.join(root, 'instance.json');
  fs.writeFileSync(context.serviceRegistry, JSON.stringify({ version: 1, services: {} }));
  const save = () => fs.writeFileSync(file, JSON.stringify(context));
  save();
  return { context, file, save };
}
