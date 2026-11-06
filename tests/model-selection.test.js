// Explicit choices, not runtime defaults: exercise the actual protocol, receiver and private DefinitionStore.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRequest } from '../lib/protocol.mjs';
import { receiver, definitions, choice, launch, barrier, UUID, LIFETIME } from './fixtures/model-selection.mjs';

const fieldsExceptModel = agent => { const { model, ...other } = agent; return other; };
const warningLines = f => f.logs.filter(line => line.startsWith('model changed:'));

async function applied(f, body) {
  const result = await f.send(body);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result.body;
}

test('unavailable receiver is an honest 503, and the route remains POST-only', async () => {
  const path = '/agents/fixture/model-selection';
  const unavailable = await handleRequest({ method: 'POST', path, body: launch() }, {});
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.applied, false);
  assert.equal((await handleRequest({ method: 'GET', path }, {})).status, 405);
});

test('a default launch with no explicit selection does not change the definition or revision', async t => {
  const f = await receiver(t), before = await f.read();
  const result = await applied(f, launch(null));
  assert.equal(result.applied, false);
  assert.deepEqual(await f.read(), before);
  assert.equal(warningLines(f).length, 0);
});

test('an explicit launch writes only model through CAS and emits one escaped warning', async t => {
  const f = await receiver(t), before = await f.read();
  await applied(f, launch('provider/model'));
  const after = await f.read();
  assert.equal(after.agent.model, 'provider/model');
  assert.deepEqual(fieldsExceptModel(after.agent), fieldsExceptModel(before.agent));
  assert.equal(after.incarnation, before.incarnation);
  assert.equal(after.revision, before.revision + 1);
  assert.equal(warningLines(f).length, 1);
  assert.match(warningLines(f)[0], /fixture.*initial.*provider\/model.*launch/);
});

test('A to B to A ends at the last native position, not value equality', async t => {
  const f = await receiver(t);
  for (const [position, value] of [[10, 'A'], [20, 'B'], [30, 'A']]) await applied(f, choice(position, value));
  assert.equal((await f.read()).agent.model, 'A');
  assert.equal(warningLines(f).length, 3);
});

test('an older report and an exact duplicate cannot rewrite an intervening definition edit', async t => {
  const f = await receiver(t);
  await applied(f, choice(20, 'B'));
  const seen = await f.read();
  await f.store.set('fixture', { ...seen.agent, model: 'external' }, { installed: f.installed, expect: { incarnation: seen.incarnation, revision: seen.revision } });
  const edited = await f.read();
  await applied(f, choice(10, 'A'));
  await applied(f, choice(20, 'B'));
  assert.deepEqual(await f.read(), edited);
  assert.equal(warningLines(f).length, 1);
});

test('a newer re-pick of A reasserts A after somebody edited the definition to B', async t => {
  const f = await receiver(t);
  await applied(f, choice(10, 'A'));
  const seen = await f.read();
  await f.store.set('fixture', { ...seen.agent, model: 'B' }, { installed: f.installed });
  await applied(f, choice(20, 'A'));
  assert.equal((await f.read()).agent.model, 'A');
  assert.equal(warningLines(f).length, 2);
});

test('an unresolved newer choice fences older values without writing or clearing model', async t => {
  const f = await receiver(t);
  await applied(f, choice(10, 'A'));
  const before = await f.read();
  assert.equal((await applied(f, choice(30, null))).applied, false);
  await applied(f, choice(20, 'B'));
  assert.deepEqual(await f.read(), before);
});

test('explicit Default is the empty string, unlike a null launch or unresolved choice', async t => {
  const f = await receiver(t);
  await applied(f, launch(null));
  await applied(f, choice(10, null));
  assert.equal((await f.read()).agent.model, 'initial');
  await applied(f, choice(20, ''));
  assert.equal((await f.read()).agent.model, '');
  assert.equal(warningLines(f).length, 1);
});

test('completion phase, including unresolved, blocks delayed launch reports', async t => {
  const f = await receiver(t);
  await applied(f, choice(10, null));
  const before = await f.read();
  await applied(f, launch('late-launch'));
  assert.deepEqual(await f.read(), before);
});

test('launch is admitted once, even when its first value was no explicit choice', async t => {
  const f = await receiver(t);
  await applied(f, launch(null));
  await applied(f, launch('duplicate-launch'));
  assert.equal((await f.read()).agent.model, 'initial');
});

for (const [name, change] of [
  ['wrong instance', f => choice(10, 'A', { instance: 'other' })],
  ['stale lifetime', f => choice(10, 'A', { lifetime: '99999999-9999-4999-8999-999999999999' })],
  ['conflicting identity', f => { f.identity.conflict = true; return choice(10); }],
  ['unknown identity', f => { f.identity.unknown = true; return choice(10); }],
  ['missing current lifetime', f => { f.identity.lifetime = null; return choice(10); }],
]) {
  test(`${name} is refused without changing any definition fields`, async t => {
    const f = await receiver(t), before = await f.read();
    const result = await f.send(change(f));
    assert.deepEqual({ status: result.status, after: await f.read() }, { status: 409, after: before });
  });
}

test('residents role admission and revalidation fail closed', { timeout: 5000 }, async t => {
  const waiting = barrier(), release = barrier();
  const f = await receiver(t, { installed: async () => { waiting.resolve(); await release.promise; return new Set(['claude']); } });
  const body = choice(10, 'A', { instance: 'residents' });
  const before = await f.read(), pending = f.send(body);
  await waiting.promise;
  f.identity.owns = false;
  release.resolve();
  assert.deepEqual({ status: (await pending).status, after: await f.read() }, { status: 409, after: before });
  assert.equal(f.identity.done, 1);
  assert.equal((await f.send(choice(20, 'B', { instance: 'residents' }))).status, 409);
});

for (const offset of [0, -1, 1.5, '10', true, Number.MAX_SAFE_INTEGER + 1]) {
  test(`offset ${JSON.stringify(offset)} is not coerced or admitted`, async t => {
    const f = await receiver(t), before = await f.read();
    assert.equal((await f.send(choice(10, 'A', { endOffset: offset }))).status, 400);
    assert.deepEqual(await f.read(), before);
    await applied(f, choice(1, 'valid'));
    assert.equal((await f.read()).agent.model, 'valid', 'bad envelope acquired an ordering fence');
  });
}

for (const [name, body] of [
  ['unknown field', choice(10, 'A', { extra: true })],
  ['bad value type', choice(10, 'A', { value: 7 })],
  ['missing file domain', choice(10, 'A', { transcriptIdentity: null })],
  ['missing record identity', choice(10, 'A', { recordUuid: null })],
  ['unsupported harness', choice(10, 'A', { harness: 'codex' })],
  ['launch with native position', launch('A', { endOffset: 10 })],
]) {
  test(`${name} is refused before state or definition changes`, async t => {
    const f = await receiver(t), before = await f.read();
    assert.equal((await f.send(body)).status, 400);
    assert.deepEqual(await f.read(), before);
    await applied(f, choice(1, 'valid'));
    assert.equal((await f.read()).agent.model, 'valid');
  });
}

test('the maximum safe native offset is admitted without rounding', async t => {
  const f = await receiver(t);
  await applied(f, choice(10, 'A', { endOffset: Number.MAX_SAFE_INTEGER }));
  await applied(f, choice(20, 'old'));
  assert.equal((await f.read()).agent.model, 'A');
});

for (const [name, body] of [
  ['file change', choice(20, 'B', { transcriptIdentity: 'replacement-file' })],
  ['session change', choice(20, 'B', { session: '44444444-4444-4444-8444-444444444444' })],
  ['conflicting record', choice(10, 'B', { recordUuid: UUID(99) })],
]) {
  test(`a ${name} cannot reset the admitted native domain`, async t => {
    const f = await receiver(t);
    await applied(f, choice(10, 'A'));
    const before = await f.read(), result = await f.send(body);
    assert.deepEqual({ status: result.status, after: await f.read() }, { status: 409, after: before });
    await applied(f, choice(20, 'C'));
    assert.equal((await f.read()).agent.model, 'C');
  });
}

test('a newer failed write still fences delayed older resolved reports, with no retry', async t => {
  let writes = 0;
  const f = await receiver(t, { store: store => ({ list: () => store.list(), set: async (...args) => {
    writes++;
    if (writes === 1) throw Error('private failure detail');
    return store.set(...args);
  } }) });
  const before = await f.read();
  assert.equal((await f.send(choice(30, 'A'))).status, 503);
  await applied(f, choice(20, 'B'));
  assert.deepEqual({ writes, after: await f.read() }, { writes: 1, after: before },
    'a failed newer choice must prevent an older write attempt and persisted mutation');
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs[0], /private failure detail/);
});

test('a newer report overtakes an older read without applying that old model', { timeout: 5000 }, async t => {
  const waiting = barrier(), release = barrier();
  let hold = true;
  const f = await receiver(t, { installed: async () => { if (hold) { hold = false; waiting.resolve(); await release.promise; } return new Set(['claude']); } });
  const older = f.send(choice(10, 'A'));
  await waiting.promise;
  await applied(f, choice(20, null));
  release.resolve();
  assert.equal((await older).status, 200);
  assert.equal((await f.read()).agent.model, 'initial');
  assert.equal(warningLines(f).length, 0);
});

test('receiver restart followed by the newest report restores the right value without claiming a durable fence', async t => {
  const f = await receiver(t);
  await applied(f, choice(10, 'A'));
  f.restart();
  await applied(f, choice(20, 'B'));
  assert.equal((await f.read()).agent.model, 'B');
  await applied(f, choice(10, 'A'));
  assert.equal((await f.read()).agent.model, 'B');
});

test('a newly admitted lifetime starts a new transcript domain; the previous lifetime cannot return', async t => {
  const f = await receiver(t);
  await applied(f, choice(100, 'A'));
  f.identity.lifetime = '55555555-5555-4555-8555-555555555555';
  await applied(f, choice(1, 'B', { lifetime: f.identity.lifetime, transcriptIdentity: 'next-file' }));
  assert.equal((await f.send(choice(200, 'old'))).status, 409);
  assert.equal((await f.read()).agent.model, 'B');
});

test('an equal current model advances the fence without a new revision or warning', async t => {
  const f = await receiver(t), before = await f.read();
  await applied(f, choice(10, 'initial'));
  await applied(f, choice(5, 'older'));
  assert.deepEqual(await f.read(), before);
  assert.equal(warningLines(f).length, 0);
});

test('warnings escape literal selector text onto one line', async t => {
  const f = await receiver(t);
  await applied(f, choice(10, 'model\nname'));
  assert.equal(warningLines(f).length, 1);
  assert.equal(warningLines(f)[0].includes('\n'), false);
});

test('an intervening definition edit fails CAS and is not retried or overwritten', async t => {
  let changed = false;
  const f = await receiver(t, { installed: async () => {
    if (!changed) { changed = true; const current = await f.read(); await f.store.set('fixture', { ...current.agent, effort: 'low', model: 'external' }, { installed: f.installed }); }
    return f.installed;
  } });
  assert.equal((await f.send(choice(10, 'A'))).status, 503);
  const after = await f.read();
  assert.equal(after.agent.model, 'external');
  assert.equal(after.agent.effort, 'low');
  await applied(f, choice(5, 'old'));
  assert.equal((await f.read()).agent.model, 'external');
});

for (const admission of ['lifetime', 'position']) {
test(`a ${admission} lost while waiting for the store lock cannot commit after initial admission`, { timeout: 5000 }, async t => {
  const held = barrier(), release = barrier(), setStarted = barrier();
  let once = true, holder;
  const f = await receiver(t, { store: store => ({
    list: async () => {
      const snapshot = await store.list();
      if (once) {
        once = false;
        holder = store.withLifecycleDefinition(async () => { held.resolve(); await release.promise; });
        await held.promise;
      }
      return snapshot;
    },
    set: (...args) => { setStarted.resolve(); return store.set(...args); },
  }) });
  const before = await f.read(), pending = f.send(choice(10, 'must-not-write'));
  await setStarted.promise;
  if (admission === 'lifetime') f.identity.lifetime = null;
  else await applied(f, choice(20, null));
  release.resolve();
  await holder;
  const result = await pending;
  assert.deepEqual({ status: result.status, reason: result.body.reason, after: await f.read() },
    { status: admission === 'lifetime' ? 409 : 200,
      reason: admission === 'lifetime' ? 'not-current' : 'superseded-position', after: before },
    'lost effect admission must leave the definition unchanged across the lock wait');
});
}

for (const [name, project] of [
  ['missing', listed => ({ ...listed, definitions: [] })],
  ['conflicted', listed => ({ ...listed, conflict: true })],
  ['enumeration failed', listed => ({ ...listed, enumerationFailed: true })],
  ['invalid', listed => ({ ...listed, definitions: listed.definitions.map(entry => ({ ...entry, problems: ['invalid definition'] })) })],
]) {
  test(`a ${name} definition projection refuses without creating or changing a definition`, async t => {
    const f = await receiver(t, { store: store => ({ list: async () => project(await store.list()), set: (...args) => store.set(...args) }) });
    const before = await f.read(), result = await f.send(choice(10));
    assert.deepEqual({ status: result.status, reason: result.body.reason, after: await f.read() },
      { status: 503, reason: 'definition-unavailable', after: before });
  });
}

test('a different definition harness refuses a Claude report without mutation', async t => {
  const f = await receiver(t), current = await f.read();
  f.installed.add('codex');
  await f.store.set('fixture', { ...current.agent, harness: 'codex' }, { installed: f.installed });
  const before = await f.read(), result = await f.send(choice(10));
  assert.deepEqual({ status: result.status, reason: result.body.reason, after: await f.read() },
    { status: 409, reason: 'wrong-harness', after: before });
});

test('an unavailable identity observation refuses rather than guessing a current lifetime', async t => {
  const f = await receiver(t), before = await f.read();
  f.identity.unavailable = true;
  const result = await f.send(choice(10));
  assert.deepEqual({ status: result.status, reason: result.body.reason, after: await f.read() },
    { status: 503, reason: 'state-unavailable', after: before });
});

test('DefinitionStore checks a supplied live guard under its writer lock before any commit', async t => {
  const f = await definitions(t), before = await f.read();
  let error;
  try { await f.store.set('fixture', { ...before.agent, model: 'must-not-write' },
    { installed: f.installed, expect: { incarnation: before.incarnation, revision: before.revision }, live: () => false }); }
  catch (caught) { error = caught; }
  assert.deepEqual({ refused: Boolean(error && /admitted/.test(error.message)), after: await f.read() },
    { refused: true, after: before }, 'a lost effect guard must refuse without changing the persisted definition');
});
