// Disposable-container driver. Never imports the environment executable.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const expected = process.argv[2];
fs.mkdirSync('/evidence', { recursive: true });
const seal = '/sealed';
fs.mkdirSync(seal, { recursive: true });
const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  ACTIVITY_SEALED_ROOT: seal, EXPECTED_ACTIVITY_NODE: process.execPath,
  AIFY_WRAPPER_REPO: '/wrapper', npm_config_cache: '/sealed/npm-cache',
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'HERMES_HOME',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemDrive']) {
  env[key] = path.join(seal, key.replace(/[^a-z]/gi, '_')); fs.mkdirSync(env[key], { recursive: true });
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function save(name, value) { fs.writeFileSync('/evidence/' + name, JSON.stringify(value, null, 2)); }
function run(name, command, args, extra = {}, mustPass = true) {
  const result = spawnSync(command, args, { cwd: '/work', env: { ...env, ...extra }, encoding: 'utf8', timeout: 300000, maxBuffer: 40 * 1024 * 1024 });
  fs.writeFileSync('/evidence/' + name + '.stdout', result.stdout ?? '');
  fs.writeFileSync('/evidence/' + name + '.stderr', result.stderr ?? '');
  save(name + '.command.json', { command, args, status: result.status, signal: result.signal, error: result.error?.message });
  if (mustPass && result.status !== 0) throw new Error(`${name}: ${result.status} ${result.stderr}`);
  return result;
}
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}
function dependencies() {
  const require = createRequire('/work/package.json');
  const koffi = require('koffi');
  const native = files('/work/node_modules').filter(file => file.endsWith('.node'));
  return { node: process.version, executable: process.execPath, executableHash: hash(fs.readFileSync(process.execPath)),
    koffi: JSON.parse(fs.readFileSync('/work/node_modules/koffi/package.json')).version, entry: require.resolve('koffi'),
    errnoWouldBlock: koffi.os.errno.EWOULDBLOCK,
    native: native.map(file => ({ file, sha256: hash(fs.readFileSync(file)) })),
    loadedLibraries: fs.readFileSync('/proc/self/maps', 'utf8').split('\n').filter(line => /koffi|libc[.-]|ld-linux/.test(line)),
    sourceHashes: Object.fromEntries(files('/work/lib/plugins/aify-dashboard').map(file => [file, hash(fs.readFileSync(file))])),
    fixtureHashes: Object.fromEntries(files('/wrapper/lib').map(file => [file, hash(fs.readFileSync(file))])) };
}
function persistedBytes(name, mutated) {
  const cases = files('/evidence/' + name + '/fixtures').filter(file => file.endsWith('/input.json')).map(file => {
    const input = JSON.parse(fs.readFileSync(file));
    const box = path.join(path.dirname(file), 'after/writers');
    const result = { name: input.name, checkpoints: {} };
    const read = label => {
      const bytes = fs.readFileSync(path.join(box, label + '.json'));
      const generations = Object.values(JSON.parse(bytes).sources).map(source => source.generation);
      if (generations.length !== 1) throw new Error('Expected exactly one real producer source');
      result.checkpoints[label] = { sha256: hash(bytes), generation: generations[0], bytes: bytes.length };
      return bytes;
    };
    if (input.name.includes('cannot overlap checkpoint writes')) {
      const before = read('checkpoint-before'), b = read('checkpoint-after-B'); read('checkpoint-after-A');
      const state = result.checkpoints;
      result.accepted = before.equals(b) === !mutated && state['checkpoint-after-B'].generation === state['checkpoint-before'].generation + Number(mutated)
        && state['checkpoint-after-A'].generation === state['checkpoint-before'].generation + 1;
    } else if (input.name.includes('owner death after')) {
      const before = read('checkpoint-before-death'), dead = read('checkpoint-after-death'), successor = read('checkpoint-before-successor-save');
      read('checkpoint-after-successor-save');
      result.accepted = before.equals(dead) && before.equals(successor)
        && result.checkpoints['checkpoint-after-successor-save'].generation === result.checkpoints['checkpoint-before-death'].generation + 1;
    } else { result.accepted = input.name === 'native dependency is lazy and absence fails closed without exposing loader details'; }
    return result;
  });
  save(name + '/persisted-byte-verification.json', cases);
  return cases.length === 5 && cases.filter(item => item.name.includes('cannot overlap checkpoint writes')).length === 2
    && cases.filter(item => item.name.includes('owner death after')).length === 2 && cases.every(item => item.accepted);
}
function arm(name, wantedExit) {
  fs.mkdirSync('/evidence/' + name, { recursive: true });
  const native = dependencies(); save(name + '/dependencies.json', native);
  fs.copyFileSync('/work/lib/plugins/aify-dashboard/activity-operation-lock.mjs', '/evidence/' + name + '/activity-operation-lock.mjs');
  run(name + '/compile', process.execPath, ['--check', '/work/lib/plugins/aify-dashboard/activity-operation-lock.mjs']);
  const result = run(name + '/test', '/usr/bin/strace', ['-ff', '-s', '256', '-o', '/evidence/' + name + '/syscalls', '-e',
    'trace=flock,openat,close,fsync,rename,renameat,kill,execve', '/usr/local/bin/npm', 'test', '--',
    'tests/the-dashboard-plugin-serializes-activity-checkpoints.test.js'], { ACTIVITY_EVIDENCE_DIR: '/evidence/' + name + '/fixtures' }, false);
  const text = result.stdout + result.stderr;
  const counts = Object.fromEntries([...text.matchAll(/^[#ℹ] (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
  const traceFiles = files('/evidence/' + name).filter(file => /\/syscalls\.\d+$/.test(file));
  const traces = traceFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const record = { exit: result.status, counts, persistedBytesVerified: persistedBytes(name, wantedExit !== 0), namedByteAssertion: text.includes('B cannot overwrite checkpoint bytes while A owns the operation'),
    forbiddenPersistedWrites: [...text.matchAll(/"bChangedCheckpoint":true/g)].length,
    successfulFlock: [...traces.matchAll(/flock\([^\n]*LOCK_EX\|LOCK_NB\)\s+= 0/g)].length,
    refusedFlock: [...traces.matchAll(/flock\([^\n]*LOCK_EX\|LOCK_NB\)\s+= -1 EAGAIN/g)].length,
    allFlockCalls: [...traces.matchAll(/flock\(/g)].length,
    flockExecutableCalls: [...traces.matchAll(/execve\("[^"]*\/flock"/g)].length,
    fsyncCalls: [...traces.matchAll(/fsync\(/g)].length,
    atomicReplacements: [...traces.matchAll(/rename\([^\n]*state\.tmp[^\n]*state\.json[^\n]*\)\s+= 0/g)].length,
    nofollowNonblockOpens: [...traces.matchAll(/openat\([^\n]*\/lock"[^\n]*O_NONBLOCK[^\n]*O_NOFOLLOW/g)].length,
    expectedWorker: text.includes(`\"version\":\"v${expected}\"`) && text.includes('"sealed":true'),
    traceFileCount: traceFiles.length };
  record.accepted = result.status === wantedExit && counts.tests === 5 && counts.cancelled === 0 && counts.skipped === 0
    && record.persistedBytesVerified && record.expectedWorker && record.flockExecutableCalls === 0 && record.nofollowNonblockOpens > 0 && record.fsyncCalls > 0 && record.atomicReplacements > 0
    && (wantedExit === 0 ? counts.pass === 5 && counts.fail === 0 && record.successfulFlock > 0 && record.refusedFlock >= 2
      : counts.fail === 2 && counts.pass === 3 && record.namedByteAssertion && record.forbiddenPersistedWrites === 2 && record.allFlockCalls === 0);
  save(name + '/result.json', record); return record;
}
try {
  if (process.version !== 'v' + expected || process.platform !== 'linux') throw new Error('Wrong native interpreter');
  for (const folder of ['lib', 'tests']) fs.cpSync('/source/' + folder, '/work/' + folder, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync('/source/' + file, '/work/' + file);
  fs.cpSync(process.argv[3] + '/wrapper', '/wrapper', { recursive: true });
  fs.copyFileSync('/source/docs/evidence/activity-flock-linux-6.mjs', '/evidence/executed-driver.mjs');
  run('apt-update', '/usr/bin/apt-get', ['update']);
  run('apt-strace', '/usr/bin/apt-get', ['install', '-y', '--no-install-recommends', 'strace']);
  run('npm-ci', '/usr/local/bin/npm', ['ci', '--ignore-scripts', '--include=optional']);
  run('npm-ls', '/usr/local/bin/npm', ['ls', '--all', '--json']);
  fs.mkdirSync('/evidence/native-dependencies', { recursive: true });
  for (const file of files('/work/node_modules').filter(file => file.endsWith('.node'))) {
    fs.copyFileSync(file, '/evidence/native-dependencies/' + hash(fs.readFileSync(file)) + '.node');
  }
  run('kernel', '/usr/bin/uname', ['-a']);
  run('filesystem', '/usr/bin/stat', ['-f', '-c', '%T %t %s %S', '/work', '/evidence']);
  run('libc', '/usr/bin/ldd', ['--version']);
  run('node-linked-libraries', '/usr/bin/ldd', [process.execPath]);
  const file = '/work/lib/plugins/aify-dashboard/activity-operation-lock.mjs';
  const original = fs.readFileSync(file, 'utf8');
  save('original-source-hash.json', { sha256: hash(original) });
  const green = arm('green', 0);
  const needle = 'if (api.flock(fd, 2 | 4) !== 0) {';
  if (original.split(needle).length !== 2) throw new Error('Mutation target not unique');
  fs.writeFileSync(file, original.replace(needle, 'if (false) { // CONTROL: flock deliberately bypassed'));
  let red;
  try { red = arm('red-no-flock', 1); } finally { fs.writeFileSync(file, original); }
  const restored = arm('restored-green', 0);
  const exactRestoration = hash(fs.readFileSync(file)) === hash(original);
  const qualified = green.accepted && red.accepted && restored.accepted && exactRestoration;
  save('result.json', { version: process.version, green, red, restored, exactRestoration, qualified });
  console.log(JSON.stringify({ version: process.version, qualified, green, red, restored }));
  if (!qualified) process.exitCode = 1;
} catch (error) {
  save('result.json', { qualified: false, error: error.stack }); console.error(error); process.exitCode = 1;
}
