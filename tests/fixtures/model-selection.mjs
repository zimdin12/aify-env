import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DefinitionStore } from '../../lib/agent-definitions.mjs';
import { handleRequest } from '../../lib/protocol.mjs';

export const LIFETIME = '11111111-1111-4111-8111-111111111111';
export const SESSION = '22222222-2222-4222-8222-222222222222';
export const UUID = offset => `33333333-3333-4333-8333-${String(offset).padStart(12, '0')}`;
export const choice = (endOffset, value = 'A', over = {}) => ({ instance: 'fixture', lifetime: LIFETIME,
  harness: 'claude', source: 'model-command', session: SESSION, transcriptIdentity: 'native-file',
  endOffset, recordUuid: UUID(endOffset), value, ...over });
export const launch = (value = null, over = {}) => ({ instance: 'fixture', lifetime: LIFETIME,
  harness: 'claude', source: 'launch', session: '', transcriptIdentity: null, endOffset: null, recordUuid: null, value, ...over });

export async function definitions(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-selection-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = new DefinitionStore({ dir: path.join(home, 'definitions') });
  const installed = new Set(['claude']);
  await store.set('fixture', { id: 'fixture', name: 'Fixture', role: 'coder', harness: 'claude', mode: 'managed',
    workspace: home, model: 'initial', effort: 'high', instructions: 'keep instructions', env: { KEEP: 'yes' }, herdrSpace: false }, { installed });
  const read = async () => (await store.list()).definitions.find(entry => entry.id === 'fixture');
  return { home, store, installed, read };
}

export async function receiver(t, options = {}) {
  const base = await definitions(t);
  const logs = [];
  const identity = { lifetime: LIFETIME, conflict: false, unknown: false, unavailable: false, owns: true, done: 0 };
  const host = { rawIdentity() {
    if (identity.unavailable) throw Error('fixture observation unavailable');
    return { current: identity.lifetime ? { lifetime: identity.lifetime } : null, conflict: identity.conflict, unknown: identity.unknown };
  } };
  const residents = { enter() {
    if (!identity.owns) return null;
    return { host, op: { guard() { if (!identity.owns) throw Object.assign(Error('not owner'), { code: 'NOT_OWNER' }); }, done() { identity.done++; } } };
  } };
  let owner;
  const ports = { receive: async (id, body) => {
    if (!owner) {
      const { ModelSelections } = await import('../../lib/model-selections.mjs');
      owner = new ModelSelections({ host, instance: 'fixture', residents, definitions: options.store?.(base.store) ?? base.store,
        installed: options.installed ?? (() => base.installed), report: line => logs.push(line) });
    }
    return owner.receive(id, body);
  } };
  const send = body => handleRequest({ method: 'POST', path: '/agents/fixture/model-selection', body }, { modelSelections: ports });
  // On the old product this fails as a named missing-route assertion, without importing a nonexistent new module.
  assert.equal((await send({})).status, 400, 'the production model-selection route must reach its receiver schema');
  logs.length = 0;
  return { ...base, host, identity, logs, send, restart() { owner = undefined; } };
}

export function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
