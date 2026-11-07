// Linux token/admission coverage is new; existing resident-lifetimes tests retain Windows timestamp policy coverage.
// This file performs no OS probe, spawn, signal or kill. Every process identity is synthetic fixture data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { linuxStartTokenFrom, linuxStartTokenFromStat, sameLinuxStartToken } from '../lib/linux-process-token.mjs';
import { parseLifetimeRecord, verifyLifetime } from '../lib/resident-lifetimes.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
const { token, legacyResident: legacy, procStat } = fixture;
const fileName = `${legacy.agentId}.${legacy.lifetime}.json`;
const rawProbe = startToken => ({ platform: 'linux', alive: true, createdAtUs: null,
  startToken, commandLine: `bash\0${legacy.launcher}\0--resume\0` });
const altered = value => value === 'same' ? structuredClone(token) : value === null ? null : { ...token, ...value };

test('linuxStartTokenFromStat retains exact raw ticks beyond Number precision and never reads btime', () => {
  assert.deepEqual(linuxStartTokenFromStat(procStat, token.bootId + '\n', token.pid), token);
  assert.notEqual(Number(token.startTicks).toString(), token.startTicks, 'control: Number conversion would lose identity');
  assert.deepEqual(linuxStartTokenFromStat(procStat.replace(token.startTicks, '0'), token.bootId, token.pid), { ...token, startTicks: '0' },
    'a raw zero tick is valid; it is not the absence of identity');
  assert.equal(linuxStartTokenFromStat(procStat, token.bootId, token.pid, { parentPid: 200 })?.startTicks, token.startTicks);
  assert.equal(linuxStartTokenFromStat(procStat, token.bootId, token.pid, { parentPid: 201 }), null, 'a child capture refuses another parent');
});

for (const comm of ['shell with space', 'nested (shell)', 'shell ) tail', 'shell\nname', '(())', '']) {
  test(`proc comm ${JSON.stringify(comm)} does not shift field 22`, () => {
    const stat = procStat.replace('(hermes shell)', `(${comm})`);
    assert.deepEqual(linuxStartTokenFromStat(stat, token.bootId, token.pid), token);
  });
}

for (const [name, replacement] of [
  ['null', null], ['array', []], ['missing version', { version: undefined }], ['other version', { version: 2 }],
  ['other platform', { platform: 'win32' }], ['other pid', { pid: token.pid + 1 }],
  ['zero pid', { pid: 0 }], ['fractional pid', { pid: 1.5 }], ['unsafe pid', { pid: Number.MAX_SAFE_INTEGER + 1 }],
  ['missing boot', { bootId: undefined }], ['non-UUID boot', { bootId: 'not-a-boot-id' }],
  ['uppercase boot', { bootId: token.bootId.toUpperCase() }], ['numeric ticks', { startTicks: 9007199254740992 }],
  ['negative ticks', { startTicks: '-1' }], ['fractional ticks', { startTicks: '1.5' }], ['empty ticks', { startTicks: '' }],
  ['extra field', { extra: true }],
]) {
  test(`linuxStartTokenFrom refuses ${name}, not the healthy token`, () => {
    assert.deepEqual(linuxStartTokenFrom(token, token.pid), token);
    const value = replacement === null || Array.isArray(replacement) ? replacement : { ...token, ...replacement };
    assert.equal(linuxStartTokenFrom(value, token.pid), null);
  });
}

test('sameLinuxStartToken requires two valid equal tuples, including the boot and every raw tick digit', () => {
  assert.equal(sameLinuxStartToken(token, { ...token }, token.pid), true);
  assert.equal(sameLinuxStartToken(null, null, token.pid), false);
  for (const change of [{ bootId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, { pid: token.pid + 1 },
    { startTicks: '9007199254740992' }, { startTicks: '09007199254740993' }]) {
    assert.equal(sameLinuxStartToken(token, { ...token, ...change }, token.pid), false, JSON.stringify(change));
  }
});

for (const [name, stat, bootId, pid] of [
  ['another stat pid', procStat.replace('41236 (', '41237 ('), token.bootId, token.pid],
  ['missing comm', procStat.replace('(hermes shell)', 'hermes'), token.bootId, token.pid],
  ['no comm terminator', '41236 (unfinished', token.bootId, token.pid],
  ['missing start field', '41236 (shell) S 200', token.bootId, token.pid],
  ['non-integer start field', procStat.replace(token.startTicks, '1.5'), token.bootId, token.pid],
  ['unread boot', procStat, null, token.pid], ['unread stat', null, token.bootId, token.pid],
  ['missing expected pid', procStat, token.bootId, undefined],
]) {
  test(`proc parser refuses ${name}`, () => {
    assert.deepEqual(linuxStartTokenFromStat(procStat, token.bootId, token.pid), token);
    assert.equal(linuxStartTokenFromStat(stat, bootId, pid), null);
  });
}

test('legacy resident parsing is unchanged; a valid optional Linux token is retained exactly', () => {
  assert.deepEqual(parseLifetimeRecord(JSON.stringify(legacy), fileName), { ok: true, record: legacy });
  const current = { ...legacy, startToken: token };
  assert.deepEqual(parseLifetimeRecord(JSON.stringify(current), fileName), { ok: true, record: current });
});

for (const row of fixture.cases) {
  test(`compatibility: ${row.name}`, () => {
    const recordToken = altered(row.recordToken), probeToken = altered(row.probeToken);
    const supplied = { ...legacy, ...(recordToken === null ? {} : { startToken: recordToken }) };
    const parsed = parseLifetimeRecord(JSON.stringify(supplied), fileName);
    assert.equal(parsed.ok, true, 'an optional token must not make a legacy-compatible record unreadable');
    assert.equal(verifyLifetime(parsed.record, rawProbe(probeToken)).verified, row.verified);
  });
}

test('Linux admission needs the launcher as a whole case-sensitive argv element even with a matching token', () => {
  const record = { ...legacy, startToken: token };
  assert.equal(verifyLifetime(record, rawProbe(token)).verified, 'yes');
  for (const commandLine of [null, '', `bash\0${legacy.launcher}-old\0`, `bash\0${legacy.launcher.toUpperCase()}\0`]) {
    assert.equal(verifyLifetime(record, { ...rawProbe(token), commandLine }).verified, 'unknown', JSON.stringify(commandLine));
  }
});

test('a pinned Linux identity cannot mask another boot or unreadable current identity', () => {
  const record = { ...legacy, startToken: token }, first = verifyLifetime(record, rawProbe(token));
  assert.equal(first.verified, 'yes');
  assert.equal(verifyLifetime(record, rawProbe({ ...token }), first.pin).verified, 'yes');
  assert.equal(verifyLifetime(record, rawProbe({ ...token, bootId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }), first.pin).verified, 'unknown');
  assert.equal(verifyLifetime(record, rawProbe(null), first.pin).verified, 'unknown');
  const replacedToken = { ...token, startTicks: '9007199254740992' };
  assert.equal(verifyLifetime({ ...record, startToken: replacedToken }, rawProbe(replacedToken), first.pin).verified, 'unknown',
    'rewriting both the record and current answer cannot replace a pinned identity');
});
