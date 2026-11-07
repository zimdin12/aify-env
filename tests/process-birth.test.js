// New owner/takeover witnesses: #22 covers child tokens, not exact owner birth or held-handle binding.
// These pure cases catch legacy PID upgrades, unknown-as-gone and cross-clock/creation-time mismatches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ProcessEffectTripwire } from './fixtures/no-process-effects.mjs';
import { observedBirth, validBirth, sameBirth, originalBirthState, heldBirthMatches } from '../lib/process-birth.mjs';
new ProcessEffectTripwire();
const { token } = JSON.parse(fs.readFileSync(new URL('./fixtures/process-identity-v1.json', import.meta.url), 'utf8'));
const win = { version: 1, platform: 'win32', pid: 424242, createdAtUs: 1790000000123456 };
const liveWin = { alive: true, createdAtUs: win.createdAtUs };

test('takeover captures an exact Windows birth from a legacy health PID without any published birth field', () => {
  assert.deepEqual(observedBirth(win.pid, liveWin, 'win32'), win);
  assert.equal(observedBirth(win.pid, { ...liveWin, alive: null }, 'win32'), null);
});

test('takeover captures Linux raw ticks without rounded time or an owner-record upgrade', () => {
  assert.deepEqual(observedBirth(token.pid, { alive: true, platform: 'linux', startToken: token }, 'linux'), token);
  assert.equal(observedBirth(token.pid, { alive: true, platform: 'linux' }, 'linux'), null);
});

for (const [name, birth] of [
  ['PID only', { pid: win.pid }],
  ['wrong PID', { ...win, pid: win.pid + 1 }],
  ['missing creation', { ...win, createdAtUs: null }],
  ['unknown field', { ...win, guessed: true }],
]) {
  test(`owner birth refuses ${name} rather than granting a stored-owner exception`, () => {
    assert.ok(validBirth(win, win.pid), 'healthy owner is usable');
    assert.equal(validBirth(birth, win.pid), null);
    assert.equal(sameBirth(win, birth, win.pid), false);
  });
}

test('Windows owner birth compares every microsecond, never the child recovery tolerance', () => {
  assert.equal(sameBirth(win, { ...win }), true);
  assert.equal(sameBirth(win, { ...win, createdAtUs: win.createdAtUs + 1 }), false);
});

for (const [name, answer, expected] of [
  ['surviving original', liveWin, 'present'],
  ['confirmed absence', { alive: false }, 'gone'],
  ['reused PID with another birth', { alive: true, createdAtUs: win.createdAtUs + 1 }, 'gone'],
  ['unanswered probe', { alive: null }, 'unknown'],
  ['live PID without creation', { alive: true, createdAtUs: null }, 'unknown'],
]) {
  test(`original-owner state distinguishes ${name}`, () => {
    assert.equal(originalBirthState(win, answer, 'win32'), expected);
    assert.equal(originalBirthState({ pid: win.pid }, answer, 'win32'), 'unknown', 'no stored birth cannot prove an original gone');
  });
}

test('held root time must bind to the observed Windows birth before go', () => {
  const ticks = String((BigInt(win.createdAtUs) + 11644473600000000n) * 10n);
  assert.equal(heldBirthMatches(win, { createdAt100ns: ticks }), true);
  assert.equal(heldBirthMatches(win, { createdAt100ns: String(BigInt(ticks) + 10n) }), false);
  assert.equal(heldBirthMatches(win, { createdAt100ns: 'not-a-clock' }), false);
  assert.equal(heldBirthMatches(win, null), false);
});
