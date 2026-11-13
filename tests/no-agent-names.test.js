// Operational identities do not belong in shipped comments or maintained test data. Recognize roles, not a roster.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROLES = ['manager', 'senior-dev', 'tech-lead', 'lead', 'coder', 'tester', 'critic', 'reviewer', 'architect'];
const NAMES = new RegExp(`\\b[a-z0-9]+(?:-[a-z0-9]+)*-(?:${ROLES.join('|')})(?:-[a-z0-9]+)*\\b`, 'gi');
const names = text => [...text.matchAll(NAMES)].map(match => match[0]).filter(value => !ROLES.includes(value.toLowerCase()));

function filesAt(file) {
  return fs.statSync(file).isDirectory()
    ? fs.readdirSync(file).flatMap(name => filesAt(path.join(file, name))) : [file];
}

function violations() {
  const packaged = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
  const files = [...new Set([...packaged, 'tests/'].flatMap(name => filesAt(path.join(ROOT, name))))];
  return files.flatMap(file => {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    // Historical captures keep exact bytes, including JSON receipts; their maintained source drivers are still checked.
    if (relative.startsWith('docs/evidence/') && /\.(?:txt|out|log|json|tap|patch|diff)$/i.test(relative)) return [];
    if (!/\.(?:[cm]?js|sh|in|py|ps1|json|toml|ya?ml|md|html|css)$/i.test(file)) return [];
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes(0), false, `cannot inspect source containing NUL: ${relative}`);
    return bytes.toString('utf8').split(/\r?\n/).flatMap((line, index) => {
      const found = names(line);
      return found.length ? [`${relative}:${index + 1}: ${found.join(', ')}`] : [];
    });
  });
}

test('role-derived recognition catches prefixed identities while allowing roles and neutral fixtures', () => {
  for (const role of ROLES) {
    assert.deepEqual(names(role), [], 'a role alone is not an identity');
    const id = ['fixture', role].join('-');
    assert.deepEqual(names(id), [id]);
    assert.deepEqual(names(id + '-2'), [id + '-2']);
    assert.deepEqual(names(id.toUpperCase()), [id.toUpperCase()]);
  }
  for (const neutral of ['probe-agent', 'source-agent', 'target-agent', 'fixture.session', 'agent-2']) assert.deepEqual(names(neutral), []);
});

test('shipped source, narrative documentation and maintained test data contain no agent identities', () => {
  const found = violations();
  assert.deepEqual(found, [], `replace operational names with neutral fixtures or describe the incident without names:\n${found.join('\n')}`);
});
