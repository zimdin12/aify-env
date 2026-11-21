// lib/skill-roots.mjs: every root is the one the harness names, or a named refusal. The harness IO is faked here
// (no real claude, codex or hermes runs). The native Codex arm uses a private npm-style shim. The Hermes probe's
// own Python is run against a fixture checkout in tests/a-hermes-skill-probe-asks-hermes-and-writes-nothing.test.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CODEX_CONTROL_NAME, HERMES_CATEGORY, HERMES_PROBE, SKILL_CLIENTS, parseCodexRoots, resolveSkillRoot, spawnRun,
} from '../lib/skill-roots.mjs';

const POSIX_HOME = '/home/someone';
const WIN_HOME = 'C:\\Users\\someone';

const never = (what) => () => { throw new Error(`${what} must not be called`); };

/** A Codex prompt render: one message whose skills block declares `roots` and offers `skills` ([name, rootId, rest]). */
function codexRender(roots, skills = []) {
  const lines = [
    ...roots.map((root, index) => `- \`r${index}\` = \`${root}\``),
    ...skills.map(([name, rootId, rest]) => `- ${name}: does a thing. (file: ${rootId}/${rest})`),
  ];
  return JSON.stringify([{ role: 'developer', content: [{ type: 'input_text', text: `<skills_instructions>\n${lines.join('\n')}\n</skills_instructions>` }] }]);
}

/** A fake runtime: `find` answers from `found`, `run` from `answers` keyed by the argument list, recording each call. */
function runtime({ found = {}, answers = {} } = {}) {
  const calls = [];
  return {
    calls,
    find: (name) => found[name] ?? '',
    run: (file, args, options) => {
      calls.push({ file, args, options });
      const reply = answers[args.join(' ')];
      if (reply === undefined) throw new Error(`unexpected run of ${file} ${args.join(' ')}`);
      return typeof reply === 'function' ? reply(file, args, options) : reply;
    },
  };
}

const codexIo = (rt, env = {}, extra = {}) => ({
  home: POSIX_HOME, env, windows: false, cwd: '/work/project', find: rt.find, run: rt.run, ...extra,
});

test('the clients are exactly the three skill harnesses, and any other name is refused by name', () => {
  assert.deepEqual(SKILL_CLIENTS, ['claude', 'codex', 'hermes']);
  for (const client of ['pi', 'Claude', '__proto__', 'constructor', '', undefined]) {
    const result = resolveSkillRoot(client, { home: POSIX_HOME, env: {}, windows: false, find: never('find'), run: never('run') });
    assert.equal(result.root, null, String(client));
    assert.deepEqual(result.searchRoots, []);
    assert.match(result.problem, /has no known skill root; skills are placed for claude, codex, hermes$/);
  }
});

test('a home that is not absolute is refused before any harness is asked', () => {
  for (const client of SKILL_CLIENTS) {
    const result = resolveSkillRoot(client, { home: 'relative/home', env: {}, windows: false, find: never('find'), run: never('run') });
    assert.equal(result.problem, 'the home folder is not an absolute path', client);
  }
});

test('Claude: <home>/.claude/skills, CLAUDE_CONFIG_DIR moves it, and nothing is run', () => {
  const io = { home: POSIX_HOME, windows: false, find: never('find'), run: never('run') };
  assert.deepEqual(resolveSkillRoot('claude', { ...io, env: {} }), { root: '/home/someone/.claude/skills', searchRoots: [], problem: null });
  assert.deepEqual(resolveSkillRoot('claude', { ...io, env: { CLAUDE_CONFIG_DIR: '/custom/claude/' } }).root, '/custom/claude/skills');
  assert.equal(resolveSkillRoot('claude', { ...io, env: { CLAUDE_CONFIG_DIR: '' } }).root, '/home/someone/.claude/skills');
  const windows = resolveSkillRoot('claude', { ...io, home: WIN_HOME, windows: true, env: { CLAUDE_CONFIG_DIR: 'D:\\Claude\\Config\\' } });
  assert.equal(windows.root, 'D:/Claude/Config/skills');
});

test('Claude: a relative CLAUDE_CONFIG_DIR is refused, not resolved against a guess', () => {
  const result = resolveSkillRoot('claude', { home: POSIX_HOME, env: { CLAUDE_CONFIG_DIR: 'claude-config' }, windows: false });
  assert.deepEqual(result, { root: null, searchRoots: [], problem: 'CLAUDE_CONFIG_DIR is not an absolute path' });
});

test('Codex: <CODEX_HOME>/skills is accepted when its render lists that root, asked from the session folder', () => {
  const env = { CODEX_HOME: '/custom/codex' };
  const rt = runtime({
    found: { codex: '/usr/bin/codex' },
    answers: { 'debug prompt-input': { status: 0, stdout: codexRender(['/custom/codex/skills/.system', '/work/project/.agents/skills'], [['imagegen', 'r0', 'imagegen/SKILL.md']]) } },
  });
  const result = resolveSkillRoot('codex', codexIo(rt, env));
  assert.deepEqual(result, { root: '/custom/codex/skills', searchRoots: ['/custom/codex/skills/.system', '/work/project/.agents/skills'], problem: null });
  assert.deepEqual(rt.calls.map((call) => [call.file, call.args, call.options.cwd, call.options.env]), [['/usr/bin/codex', ['debug', 'prompt-input'], '/work/project', env]]);
});

test('Codex: without CODEX_HOME the root is <home>/.codex/skills', () => {
  const rt = runtime({ found: { codex: '/usr/bin/codex' }, answers: { 'debug prompt-input': { status: 0, stdout: codexRender(['/home/someone/.codex/skills']) } } });
  assert.equal(resolveSkillRoot('codex', codexIo(rt)).root, '/home/someone/.codex/skills');
});

test('Codex: a render that does not list the root is refused with what it does search', () => {
  const rt = runtime({ found: { codex: '/usr/bin/codex' }, answers: { 'debug prompt-input': { status: 0, stdout: codexRender(['/elsewhere/skills', '/home/someone/.codex/skills-old']) } } });
  const result = resolveSkillRoot('codex', codexIo(rt));
  assert.equal(result.root, null);
  assert.equal(result.problem, 'Codex does not search /home/someone/.codex/skills; it searches /elsewhere/skills, /home/someone/.codex/skills-old');
});

test('Codex on Windows: backslashes and case fold when the root is compared', () => {
  const rt = runtime({ found: { codex: 'C:\\npm\\codex.cmd' }, answers: { 'debug prompt-input': { status: 0, stdout: codexRender(['c:\\users\\SOMEONE\\.codex\\skills\\.system']) } } });
  const result = resolveSkillRoot('codex', codexIo(rt, {}, { home: WIN_HOME, windows: true, cwd: 'C:\\work' }));
  assert.equal(result.problem, null);
  assert.equal(result.root, 'C:/Users/someone/.codex/skills');
  assert.deepEqual(result.searchRoots, ['c:/users/SOMEONE/.codex/skills/.system']);
});

test('native Windows Codex probe runs the npm cmd shim, not its extensionless sibling', {
  skip: process.platform !== 'win32' ? 'requires native Windows' : false,
}, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex probe '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const extensionless = path.join(home, 'codex');
  const shim = path.join(home, 'codex.cmd');
  fs.writeFileSync(extensionless, '#!/bin/sh\nexit 91\n');
  fs.writeFileSync(path.join(home, 'codex.ps1'), 'exit 92');
  const root = path.join(home, '.codex', 'skills');
  const responder = path.join(home, 'probe.mjs');
  fs.writeFileSync(responder, `if (process.argv.slice(2).join(' ') !== 'debug prompt-input') process.exit(93);\nprocess.stdout.write(${JSON.stringify(codexRender([root]))});\n`);
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${responder}" %*\r\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|pathext|codex_home)$/i.test(key)));
  Object.assign(env, { Path: home, Pathext: '.PS1;.CMD', CODEX_HOME: path.join(home, '.codex') });
  assert.equal(spawnRun(extensionless, ['debug', 'prompt-input'], { cwd: home, env }).error?.code, 'ENOENT');
  const files = [];
  const io = { home, env, windows: true, cwd: home, run: (file, args, options) => {
    files.push(file);
    return spawnRun(file, args, options);
  } };
  const result = resolveSkillRoot('codex', io);
  assert.equal(result.problem, null, result.problem);
  assert.deepEqual(files, [shim]);
  assert.equal(result.root, root.split(path.sep).join('/'));

  fs.unlinkSync(shim);
  assert.equal(resolveSkillRoot('codex', { ...io, run: never('run') }).problem, 'Codex was not found on PATH');
});

test('Codex: not on PATH, or found by a relative path, is refused without running anything', () => {
  assert.equal(resolveSkillRoot('codex', codexIo({ find: () => '', run: never('run') })).problem, 'Codex was not found on PATH');
  assert.equal(resolveSkillRoot('codex', codexIo({ find: () => 'bin/codex', run: never('run') })).problem, 'the Codex found on PATH is not an absolute path');
});

test('Codex: a failing render is refused by its exit, never by its text', () => {
  const secretish = 'config.toml: api_key = "fixture-secret"';
  const cases = [
    [{ status: 1, stdout: '', stderr: secretish }, 'codex debug prompt-input exited 1'],
    [{ status: null, stdout: '', stderr: secretish, error: Object.assign(new Error(secretish), { code: 'ETIMEDOUT' }) }, 'codex debug prompt-input did not answer within 60 s'],
    [{ status: null, stdout: '', stderr: '', error: Object.assign(new Error(secretish), { code: 'ENOENT' }) }, 'codex debug prompt-input did not run (ENOENT)'],
    [{ status: null, stdout: secretish, stderr: secretish }, 'codex debug prompt-input ended by a signal'],
  ];
  for (const [reply, problem] of cases) {
    const rt = runtime({ found: { codex: '/usr/bin/codex' }, answers: { 'debug prompt-input': reply } });
    const result = resolveSkillRoot('codex', codexIo(rt));
    assert.equal(result.problem, problem);
    assert.doesNotMatch(result.problem, /fixture-secret/);
  }
});

test('Codex: a render with no roots table is refused by version, naming the earliest Codex measured with one', () => {
  const old = JSON.stringify([{ content: [{ text: '<skills_instructions>\n- imagegen: does a thing. (file: /home/someone/.codex/skills/imagegen/SKILL.md)\n</skills_instructions>' }] }]);
  const rt = runtime({ found: { codex: '/usr/bin/codex' }, answers: { 'debug prompt-input': { status: 0, stdout: old }, '--version': { status: 0, stdout: 'codex-cli 0.135.0\n' } } });
  assert.equal(resolveSkillRoot('codex', codexIo(rt)).problem,
    'Codex 0.135.0 renders skills without a roots table, so where it loads skills from cannot be read; skills are placed for Codex 0.160 or later');
  const unread = runtime({ found: { codex: '/usr/bin/codex' }, answers: { 'debug prompt-input': { status: 0, stdout: old }, '--version': { status: 2, stdout: '' } } });
  assert.match(resolveSkillRoot('codex', codexIo(unread)).problem, /^a Codex whose version could not be read renders skills without a roots table/);
});

test('Codex: an unreadable render is the instrument broken, never an absence', () => {
  const cases = [
    ['not json', "Codex's prompt render is not JSON"],
    ['{"content":[]}', "Codex's prompt render is not a list of messages"],
    [JSON.stringify([{ content: [{ text: 'no skills here' }] }]), "Codex's prompt has no skills block"],
    [codexRender(['/home/someone/.codex/skills'], [['imagegen', 'r7', 'imagegen/SKILL.md']]), 'Codex offers a skill through r7, a root its table does not declare'],
    [codexRender(['/home/someone/.codex/skills'], [[CODEX_CONTROL_NAME, 'r0', 'x/SKILL.md']]), `Codex offers ${CODEX_CONTROL_NAME}, a name that cannot exist`],
    [codexRender(['relative/skills']), "Codex's roots table names a root that is not an absolute path"],
  ];
  for (const [stdout, problem] of cases) {
    const rt = runtime({ found: { codex: '/usr/bin/codex' }, answers: { 'debug prompt-input': { status: 0, stdout } } });
    assert.equal(resolveSkillRoot('codex', codexIo(rt)).problem, problem);
  }
  assert.deepEqual(parseCodexRoots(codexRender(['/a/skills/', '/b//skills'])), { roots: ['/a/skills', '/b/skills'] });
});

test('Codex: a relative CODEX_HOME is refused before Codex is looked for', () => {
  assert.equal(resolveSkillRoot('codex', codexIo({ find: never('find'), run: never('run') }, { CODEX_HOME: '.codex' })).problem, 'CODEX_HOME is not an absolute path');
});

/** A Hermes run that answers `report` (an object) as its last stdout line, after Hermes' own chatter. */
const hermesReply = (report, status = 0) => ({ status, stdout: `hermes says hello\n${JSON.stringify(report)}\n`, stderr: '' });

const hermesIo = (rt, env, extra = {}) => ({ home: POSIX_HOME, env, windows: false, cwd: '/work/project', find: never('find'), run: rt.run, ...extra });

const probeArgs = ['-B', HERMES_PROBE, '--cwd', '/work/project'].join(' ');

test('Hermes: the root is the selected profile\'s get_skills_dir()/autonomous-ai-agents, asked of its own venv', () => {
  const env = { HERMES_HOME: '/profiles/work' };
  const rt = runtime({ answers: { [probeArgs]: hermesReply({ hermesHome: '/profiles/work', skillsDir: '/profiles/work/skills/', searchRoots: ['/profiles/work/skills', '/shared/skills', '/work/project/.hermes/skills'] }) } });
  const result = resolveSkillRoot('hermes', hermesIo(rt, env));
  assert.deepEqual(result, { root: `/profiles/work/skills/${HERMES_CATEGORY}`, searchRoots: ['/profiles/work/skills', '/shared/skills', '/work/project/.hermes/skills'], problem: null });
  assert.deepEqual(rt.calls.map((call) => [call.file, call.options.cwd, call.options.env]), [['/profiles/work/hermes-agent/venv/bin/python', '/profiles/work/hermes-agent', env]]);
});

test('Hermes: AIFY_HERMES_AGENT selects the checkout over HERMES_HOME, and Windows uses venv/Scripts/python.exe', () => {
  const rt = runtime({ answers: { [['-B', HERMES_PROBE, '--cwd', 'C:\\work'].join(' ')]: hermesReply({ hermesHome: 'C:\\Users\\someone\\.hermes', skillsDir: 'C:\\Users\\someone\\.hermes\\skills', searchRoots: ['c:\\users\\someone\\.hermes\\skills'] }) } });
  const result = resolveSkillRoot('hermes', hermesIo(rt, { AIFY_HERMES_AGENT: 'D:\\hermes-agent', HERMES_HOME: 'E:\\ignored' }, { home: WIN_HOME, windows: true, cwd: 'C:\\work' }));
  assert.equal(result.problem, null);
  assert.equal(result.root, 'C:/Users/someone/.hermes/skills/autonomous-ai-agents');
  assert.equal(rt.calls[0].file, 'D:\\hermes-agent\\venv\\Scripts\\python.exe');
  assert.equal(rt.calls[0].options.cwd, 'D:\\hermes-agent');
});

test('Hermes: with neither variable it is not found, and nothing is run or guessed', () => {
  const result = resolveSkillRoot('hermes', hermesIo({ run: never('run') }, {}));
  assert.deepEqual(result, { root: null, searchRoots: [], problem: 'Hermes was not found: set HERMES_HOME, or AIFY_HERMES_AGENT to its checkout' });
  assert.equal(resolveSkillRoot('hermes', hermesIo({ run: never('run') }, { AIFY_HERMES_AGENT: 'hermes-agent' })).problem, 'AIFY_HERMES_AGENT is not an absolute path');
  assert.equal(resolveSkillRoot('hermes', hermesIo({ run: never('run') }, { HERMES_HOME: '/h' }, { cwd: undefined })).problem, 'the folder Hermes is asked from is not an absolute path');
});

test('Hermes: a missing venv Python is named; a probe that cannot run is refused by its code', () => {
  const missing = runtime({ answers: { [probeArgs]: { status: null, stdout: '', error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) } } });
  assert.equal(resolveSkillRoot('hermes', hermesIo(missing, { HERMES_HOME: '/h' })).problem, "Hermes' Python is not at /h/hermes-agent/venv/bin/python");
  const slow = runtime({ answers: { [probeArgs]: { status: null, stdout: '', error: Object.assign(new Error('spawn'), { code: 'ETIMEDOUT' }) } } });
  assert.equal(resolveSkillRoot('hermes', hermesIo(slow, { HERMES_HOME: '/h' })).problem, 'the Hermes skill probe did not answer within 120 s');
});

test('Hermes: a probe that stopped is reported by step and exception type only, never its message', () => {
  const cases = [
    [{ status: 2, stdout: '{"error":"the probe stopped","exception":"ImportError","phase":"import"}\n' }, 'the Hermes skill probe stopped in its import step with ImportError'],
    [{ status: 2, stdout: '{"error":"x","exception":"key = fixture-secret","phase":"/home/someone/.hermes"}\n' }, 'the Hermes skill probe stopped in its unnamed step with an unnamed exception'],
    [{ status: 2, stdout: 'Traceback: fixture-secret\n' }, 'the Hermes skill probe exited 2 without a report'],
    [hermesReply({ hermesHome: '/h', skillsDir: '/h/skills', searchRoots: ['/h/skills'] }, 1), 'the Hermes skill probe exited 1'],
  ];
  for (const [reply, problem] of cases) {
    const result = resolveSkillRoot('hermes', hermesIo(runtime({ answers: { [probeArgs]: reply } }), { HERMES_HOME: '/h' }));
    assert.equal(result.problem, problem);
  }
});

test('Hermes: a report in another shape, or a root Hermes does not search, is refused', () => {
  const shapes = [
    { skillsDir: '/h/skills', searchRoots: ['/h/skills'] },
    { hermesHome: '/h', skillsDir: 'skills', searchRoots: ['/h/skills'] },
    { hermesHome: '/h', skillsDir: '/h/skills', searchRoots: '/h/skills' },
    { hermesHome: '/h', skillsDir: '/h/skills', searchRoots: ['/h/skills', 'relative'] },
    ['/h/skills'],
  ];
  for (const report of shapes) {
    const result = resolveSkillRoot('hermes', hermesIo(runtime({ answers: { [probeArgs]: hermesReply(report) } }), { HERMES_HOME: '/h' }));
    assert.equal(result.problem, "the Hermes skill probe's report is not the shape this reads", JSON.stringify(report));
  }
  const elsewhere = runtime({ answers: { [probeArgs]: hermesReply({ hermesHome: '/h', skillsDir: '/h/skills', searchRoots: ['/other/skills', '/h/skills-old'] }) } });
  assert.equal(resolveSkillRoot('hermes', hermesIo(elsewhere, { HERMES_HOME: '/h' })).problem,
    'Hermes does not search /h/skills/autonomous-ai-agents; it searches /other/skills, /h/skills-old');
});
