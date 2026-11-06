// hostConfigFrom exercises trustedAuthoritiesFrom and the AUTHORITY_SETTING diagnostic through the real config owner.
// #16: only a well-formed explicit host grant may extend loopback; transport preference recovery stays intact.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostConfigFrom, readHostConfig, withHostSetting } from '../lib/host-config.mjs';

const config = value => hostConfigFrom(JSON.stringify({ http: { trustedAuthorities: value } }));

test('HTTP authority trust defaults to no extras with no environment-derived grants', () => {
  const result = hostConfigFrom(null, { AIFY_ENV_ENDPOINT: 'http://proxy.example:9443', HTTP_HOST: 'proxy.example' });
  assert.deepEqual(result.http?.trustedAuthorities, [], 'ambient endpoint silently granted an authority');
  assert.deepEqual(result.http?.problems, []);
});

test('operator authorities are normalized without resolving names or inventing schemes', () => {
  const result = config(['Proxy.Example', '192.0.2.17:9443', '[2001:0db8::1]:443']);
  assert.deepEqual(result.http?.trustedAuthorities, ['proxy.example', '192.0.2.17:9443', '[2001:db8::1]:443']);
  assert.deepEqual(result.http?.problems, []);
});

for (const value of [null, 'proxy.example', {}, 1, ['proxy.example', '*'], ['https://proxy.example'],
  ['user@proxy.example'], ['proxy.example/path'], ['proxy.example:65536'], ['proxy.example:'],
  ['proxy.example:bad'], [' proxy.example'], ['proxy.example '], ['127.1'], ['2130706433'],
  ['0x7f000001'], ['127.000.0.1'], ['[::1'], ['proxy..example'], ['-proxy.example'], ['proxy.example,other.example'],
  ['proxy.example', null]]) {
  test(`malformed http.trustedAuthorities ${JSON.stringify(value)} disables the full extra list and reports it`, () => {
    const result = config(value);
    assert.deepEqual(result.http?.trustedAuthorities, [], 'malformed grant was partially or wholly accepted');
    assert.match(result.http?.problems?.join(' ') ?? '', /http\.trustedAuthorities/, 'operator gets no load diagnostic');
    assert.equal(result.localSocket, true, 'bad HTTP grant broke transport preference defaults');
  });
}

test('a malformed HTTP section or JSON never grants access or prevents local transport defaults', () => {
  for (const text of ['{', 'null', '[]', '{"http": "proxy.example"}']) {
    const result = hostConfigFrom(text);
    assert.deepEqual(result.http?.trustedAuthorities, []);
    assert.ok(result.http?.problems?.length, 'malformed configuration was not reported');
    assert.equal(result.localSocket, true);
  }
});

test('an IPv6 zone identifier cannot throw while loading an authority grant', () => {
  let result;
  assert.doesNotThrow(() => { result = config(['[fe80::1%eth0]']); }, 'malformed HTTP authority must not crash config loading');
  assert.deepEqual(result.http?.trustedAuthorities, []);
  assert.match(result.http?.problems?.join(' ') ?? '', /http\.trustedAuthorities/);
});

test('readHostConfig validates the actual supplied file, without reading another home', () => {
  const result = readHostConfig({ home: '/fixture-home', env: {}, readFile(file) {
    assert.match(file.replaceAll(String.fromCharCode(92), '/'), /fixture-home\/\.aify\/config\.json$/);
    return '{"transport":{"localSocket":false},"http":{"trustedAuthorities":["proxy.example:9443"]}}';
  } });
  assert.deepEqual(result.http?.trustedAuthorities, ['proxy.example:9443']);
  assert.equal(result.localSocket, false);
});

test('the existing transport writer preserves the explicit HTTP grant and unrelated keys', () => {
  const before = JSON.stringify({ version: 2, http: { trustedAuthorities: ['proxy.example'] }, other: { keep: true } });
  const written = JSON.parse(withHostSetting(before, 'localSocket', false));
  assert.deepEqual(written.http, { trustedAuthorities: ['proxy.example'] });
  assert.deepEqual(written.other, { keep: true });
  assert.equal(written.version, 2);
});
