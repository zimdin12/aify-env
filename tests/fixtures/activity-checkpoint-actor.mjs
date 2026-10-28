// Real checkpoint writer. Hooks only delay after real filesystem operations.
import fs from 'node:fs';
import path from 'node:path';
import { ActivityState } from '../../lib/plugins/aify-dashboard/activity-state.mjs';
const [raw, endpoint, box, who, mode] = process.argv.slice(2);
const storage = new ActivityState({ directory: raw, endpoint });
const signal = name => path.join(box, `${who}-${name}`);
// A PHASE FILE APPEARS WHOLE OR NOT AT ALL (2026-10-28). The parent waits for the name to exist and then parses it, and
// writeFileSync creates the file before it writes: a writer stalled in between, as on a host short of memory, handed
// the parent an empty file and "Unexpected end of JSON input". Written beside it and renamed into place instead.
const say = (name, text) => {
  const file = signal(name), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text); fs.renameSync(temporary, file);
};
function wait(name) {
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(signal(name))) {
    if (Date.now() > deadline) throw new Error('fixture-deadline');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
const originalRead = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const value = originalRead.call(this, file, ...args);
  if (mode === 'stale' && file === path.join(storage.directory, 'lock')) {
    say('read', 'real-read'); wait('recover');
  }
  return value;
};
const sealedRoot = process.env.ACTIVITY_SEALED_ROOT;
if (sealedRoot) {
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'HERMES_HOME',
    'ProgramFiles', 'ProgramW6432', 'ProgramData', 'SystemDrive', ...(process.platform === 'win32' ? ['ProgramFiles(x86)'] : [])]) {
    if (!path.resolve(process.env[key] ?? '').toLowerCase().startsWith(path.resolve(sealedRoot).toLowerCase())) throw new Error('fixture-environment');
  }
}
say('ready', JSON.stringify({ version: process.version, executable: process.execPath, sealed: Boolean(sealedRoot) }));
wait('go');
let entered = false;
try {
  storage.transaction(state => {
    entered = true;
    say('entered', String(process.pid));
    wait('finish');
    for (const source of Object.values(state.sources)) source.generation++;
    storage.save(state);
    say('saved', 'saved');
    if (mode === 'die-after-save') wait('close');
  });
  say('result', JSON.stringify({ entered, ok: true }));
} catch (error) {
  say('result', JSON.stringify({ entered, ok: false, error: error.message }));
  process.exitCode = 2;
}
