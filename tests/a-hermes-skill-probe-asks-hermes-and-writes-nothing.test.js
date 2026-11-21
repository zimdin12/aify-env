// lib/hermes-skill-roots.py run for real, by this host's Python, against a fake Hermes checkout in a scratch folder.
// The fake does what a bootstrapping Hermes does on import (makes its skills folder, seeds SOUL.md, starts a process)
// and answers get_skills_dir() and the search roots. The probe must answer and leave every one of those undone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { HERMES_PROBE, resolveSkillRoot, spawnRun } from '../lib/skill-roots.mjs';

const windows = process.platform === 'win32';
const PYTHON = windows ? 'python' : 'python3';

function hostPython() {
  const ran = spawnSync(PYTHON, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(ran.status, 0, `NOT_RUN: this test needs ${PYTHON} on PATH`);
  return ran.stdout.trim();
}

const HERMES_CONSTANTS = `
import os, subprocess, sys
from pathlib import Path

def get_hermes_home():
    return Path(os.environ["HERMES_HOME"])

def get_skills_dir():
    skills = get_hermes_home() / "skills"
    if skills.is_dir():
        # A mkdir of a folder that exists, expecting only FileExistsError: the probe must let a change of nothing
        # through. (Path.mkdir(exist_ok=True) would swallow the refusal too, and could not tell the two apart.)
        try:
            os.mkdir(skills)
        except FileExistsError:
            pass
    for attempt in (
        lambda: skills.mkdir(parents=True, exist_ok=True),
        lambda: (get_hermes_home() / "SOUL.md").write_text("seeded"),
        lambda: subprocess.run([sys.executable, "-c", "open(r'" + os.environ["FAKE_MARKER"] + "', 'w').write('started')"]),
    ):
        try:
            attempt()
        except PermissionError:
            pass
    return skills
`;

const SKILL_UTILS = `
import os
from pathlib import Path
from hermes_constants import get_skills_dir

def get_all_skills_dirs():
    return [get_skills_dir(), Path(os.environ["FAKE_EXTERNAL"])]

def get_project_skills_dirs():
    return [Path.cwd() / ".hermes" / "skills"]
`;

/** A scratch Hermes: checkout with the fake modules, an empty home, a project folder; `broken` raises on import. */
function scratchHermes({ broken = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-hermes-probe-'));
  const agent = path.join(root, 'hermes-agent');
  fs.mkdirSync(path.join(agent, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'hermes_constants.py'), broken ? 'raise ValueError("api_key = fixture-secret")\n' : HERMES_CONSTANTS);
  fs.writeFileSync(path.join(agent, 'agent', '__init__.py'), '');
  fs.writeFileSync(path.join(agent, 'agent', 'skill_utils.py'), SKILL_UTILS);
  const home = path.join(root, 'profile');
  const project = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  return { root, agent, home, project, external: path.join(root, 'shared-skills'), marker: path.join(root, 'started.txt') };
}

/** resolveSkillRoot with the venv Python it computes redirected to this host's Python, recording what ran. */
function resolveWithHostPython(scratch) {
  const python = hostPython();
  const expected = path.join(scratch.agent, 'venv', ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const env = {
    PATH: process.env.PATH ?? process.env.Path ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
    HOME: scratch.root, USERPROFILE: scratch.root,
    AIFY_HERMES_AGENT: scratch.agent, HERMES_HOME: scratch.home, FAKE_EXTERNAL: scratch.external, FAKE_MARKER: scratch.marker,
  };
  const ran = [];
  const result = resolveSkillRoot('hermes', {
    home: scratch.root, env, windows, cwd: scratch.project, find: () => '',
    run: (file, args, options) => {
      assert.equal(file, expected, 'the probe runs with the selected Hermes venv Python');
      ran.push({ args, cwd: options.cwd });
      return spawnRun(python, args, options);
    },
  });
  return { result, ran };
}

const forward = (value) => value.replace(/\\/g, '/');
const fold = (value) => (windows ? forward(value).toLowerCase() : value);

test('the Hermes probe answers get_skills_dir() and the search roots, and Hermes\' bootstrap writes are refused', () => {
  const scratch = scratchHermes();
  const { result, ran } = resolveWithHostPython(scratch);
  assert.equal(result.problem, null);
  assert.equal(result.root, `${forward(scratch.home)}/skills/autonomous-ai-agents`);
  assert.equal(result.searchRoots.length, 3);
  assert.equal(fold(result.searchRoots[0]), fold(`${scratch.home}/skills`));
  assert.equal(fold(result.searchRoots[1]), fold(scratch.external));
  assert.match(fold(result.searchRoots[2]), /\/project\/\.hermes\/skills$/);
  assert.deepEqual(ran, [{ args: ['-B', HERMES_PROBE, '--cwd', scratch.project], cwd: scratch.agent }]);

  assert.deepEqual(fs.readdirSync(scratch.home), [], 'the probe made nothing in the Hermes home: no skills folder, no SOUL.md');
  assert.equal(fs.existsSync(scratch.marker), false, 'the process Hermes tried to start never ran');
  assert.equal(fs.existsSync(path.join(scratch.agent, '__pycache__')), false, 'no bytecode was written into the checkout');
  assert.equal(fs.existsSync(path.join(scratch.agent, 'agent', '__pycache__')), false);
});

test('an existing skills folder is let through, since a mkdir of it changes nothing', () => {
  const scratch = scratchHermes();
  fs.mkdirSync(path.join(scratch.home, 'skills'));
  const { result } = resolveWithHostPython(scratch);
  assert.equal(result.problem, null);
  assert.deepEqual(fs.readdirSync(scratch.home), ['skills']);
  assert.deepEqual(fs.readdirSync(path.join(scratch.home, 'skills')), []);
});

test('a Hermes that fails to import is reported by step and exception type, never by its message', () => {
  const scratch = scratchHermes({ broken: true });
  const { result } = resolveWithHostPython(scratch);
  assert.deepEqual(result, { root: null, searchRoots: [], problem: 'the Hermes skill probe stopped in its import step with ValueError' });
});

test('spawnRun starts a file and, on Windows, an npm .cmd shim, with stdin closed and the given folder', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aify-spawn-run-'));
  const script = path.join(folder, 'echo.mjs');
  fs.writeFileSync(script, "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify([process.cwd(), ...process.argv.slice(2)])));\n");
  const direct = spawnRun(process.execPath, [script, 'debug', 'prompt-input'], { cwd: folder, env: process.env });
  assert.equal(direct.status, 0, direct.stderr);
  const [cwd, ...args] = JSON.parse(direct.stdout);
  assert.equal(fold(cwd), fold(folder));
  assert.deepEqual(args, ['debug', 'prompt-input']);
  if (!windows) return;
  const shim = path.join(folder, 'codex.cmd');
  fs.writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`);
  const viaShell = spawnRun(shim, ['debug', 'prompt-input'], { cwd: folder, env: process.env });
  assert.equal(viaShell.status, 0, viaShell.stderr);
  assert.deepEqual(JSON.parse(viaShell.stdout).slice(1), ['debug', 'prompt-input']);
});

test('a Hermes checkout without the skill helpers fails closed instead of answering a guess', () => {
  const scratch = scratchHermes();
  fs.rmSync(path.join(scratch.agent, 'agent'), { recursive: true });
  const { result } = resolveWithHostPython(scratch);
  assert.equal(result.root, null);
  assert.equal(result.problem, 'the Hermes skill probe stopped in its import step with ModuleNotFoundError');
});
