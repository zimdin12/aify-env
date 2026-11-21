import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SkillPlacer } from '../lib/install-skills.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-preflight-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'runtime', 'skills');
  const receipt = path.join(home, '.aify', 'installed-skills.json');
  const skill = (base, name, text) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
    return dir;
  };
  const assets = (label, trees) => {
    const packageDir = path.join(home, label);
    const directory = 'skills';
    for (const [name, text] of Object.entries(trees)) skill(path.join(packageDir, directory), name, text);
    return { service: 'fixture-provider', packageDir, directory, source: { artifact: 'fixture-skills', revision: 'a'.repeat(40), approval: 'b'.repeat(64) } };
  };
  const put = (offer, { io = fs, searchRoots = [] } = {}) => new SkillPlacer({ home, io }).place(offer, 'claude', { root, searchRoots });
  const read = dir => fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  return { home, root, receipt, skill, assets, put, read };
}

function refuse(fn) {
  let result;
  assert.throws(fn, error => { result = error.message; return true; });
  return result;
}

test('preflight names every existing conflict before any filesystem write', t => {
  const f = fixture(t);
  f.put(f.assets('prior', { 'm-edited': 'owned original', 'r-retired': 'owned original' }));
  const edited = f.skill(f.root, 'm-edited', 'user edit');
  const retired = f.skill(f.root, 'r-retired', 'keep retired edit');
  const legacy = f.skill(f.root, 'z-legacy', 'identical to new bytes');
  const linked = path.join(f.root, 'l-linked');
  const outside = f.skill(f.home, 'other-tree', 'not destination content');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const searchRoots = ['search-a', 'search-b'].map(name => path.join(f.home, name));
  const shadows = searchRoots.map(root => f.skill(root, 's-shadowed', 'shadow bytes'));
  const prior = fs.readFileSync(f.receipt);
  const offer = f.assets('incoming', { 'a-new': 'must not write', 'l-linked': 'new', 'm-edited': 'new', 's-shadowed': 'new', 'z-legacy': 'identical to new bytes' });
  const writes = [];
  const io = { ...fs };
  for (const operation of ['mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync', 'rmSync', 'rmdirSync', 'unlinkSync']) {
    io[operation] = file => { writes.push([operation, file]); throw new Error('preflight attempted a write'); };
  }
  const message = refuse(() => f.put(offer, { io, searchRoots }));
  assert.deepEqual(writes, [], 'an early clean name cannot be written before inspecting later conflicts');
  for (const dir of [edited, retired, legacy, linked, ...shadows]) assert.ok(message.includes(dir), `refusal must name ${dir}`);
  assert.match(message, /unmanaged or changed/);
  assert.match(message, /is a link; nothing follows it/);
  assert.match(message, /would shadow/);
  assert.match(message, /backup outside every configured skill search root.*rerun/s);
  assert.deepEqual(fs.readFileSync(f.receipt), prior);
  assert.equal(fs.existsSync(path.join(f.root, 'a-new')), false);
  assert.equal(f.read(legacy), 'identical to new bytes');
  assert.equal(f.read(edited), 'user edit');
  assert.equal(f.read(retired), 'keep retired edit');
  assert.ok(fs.lstatSync(linked).isSymbolicLink());
});

test('a collision planted after a clean preflight is refused without adopting it', t => {
  const f = fixture(t);
  const offer = f.assets('incoming', { 'a-clean': 'placed bytes', 'z-late': 'offered bytes' });
  const late = path.join(f.root, 'z-late');
  let planted = false;
  const io = { ...fs, renameSync(from, to) {
    fs.renameSync(from, to);
    if (to === f.receipt && !planted) {
      planted = true;
      f.skill(f.root, 'z-late', 'late owner bytes');
    }
  } };
  const message = refuse(() => f.put(offer, { io }));
  assert.equal(planted, true);
  assert.ok(message.includes(late), 'late conflict must name the destination');
  assert.match(message, /unmanaged or changed/, 'per-skill guard still refuses a late unmanaged tree');
  assert.equal(f.read(late), 'late owner bytes');
  assert.equal(f.read(path.join(f.root, 'a-clean')), 'placed bytes');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).placements.map(row => row.skill), ['a-clean']);
});

test('an unchanged preflight result allows all clean skills to be placed', t => {
  const f = fixture(t);
  const offer = f.assets('incoming', { alpha: 'first', zeta: 'last' });
  assert.doesNotThrow(() => f.put(offer), 'clean destinations must not be refused');
  assert.equal(f.read(path.join(f.root, 'alpha')), 'first');
  assert.equal(f.read(path.join(f.root, 'zeta')), 'last');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).placements.map(row => row.skill), ['alpha', 'zeta']);
});
