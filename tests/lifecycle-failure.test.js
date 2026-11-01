// A classifier must require both the distinct code and explicit evidence that no effect was entered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleFailure } from '../lib/lifecycle-failure.mjs';
for (const [name, error, boundary, expected] of [
  ['known acquisition timeout before effects', { code: 'DEFINITION_LOCK_TIMEOUT' }, false, 'definition-lock-timeout'],
  ['same code after an effect', { code: 'DEFINITION_LOCK_TIMEOUT' }, true, null],
  ['other pre-effect error', { code: 'EIO', message: 'DEFINITION_LOCK_TIMEOUT' }, false, null],
  ['missing error', null, false, null],
  ['missing boundary', { code: 'DEFINITION_LOCK_TIMEOUT' }, undefined, null],
  ['wrongly typed boundary', { code: 'DEFINITION_LOCK_TIMEOUT' }, 0, null],
]) test(name, () => assert.equal(lifecycleFailure(error, boundary), expected));
