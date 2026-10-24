// Real checkpoint writer. Hooks only delay after real filesystem operations.
import fs from 'node:fs';
import path from 'node:path';
import { ActivityState } from '../../lib/plugins/aify-dashboard/activity-state.mjs';
const [raw, endpoint, box, who, mode] = process.argv.slice(2);
const storage = new ActivityState({ directory: raw, endpoint });
const signal = name => path.join(box, `${who}-${name}`);
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
    fs.writeFileSync(signal('read'), 'real-read'); wait('recover');
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
fs.writeFileSync(signal('ready'), JSON.stringify({ version: process.version, executable: process.execPath, sealed: Boolean(sealedRoot) }));
wait('go');
let entered = false;
try {
  storage.transaction(state => {
    entered = true;
    fs.writeFileSync(signal('entered'), String(process.pid));
    wait('finish');
    for (const source of Object.values(state.sources)) source.generation++;
    storage.save(state);
    fs.writeFileSync(signal('saved'), 'saved');
    if (mode === 'die-after-save') wait('close');
  });
  fs.writeFileSync(signal('result'), JSON.stringify({ entered, ok: true }));
} catch (error) {
  fs.writeFileSync(signal('result'), JSON.stringify({ entered, ok: false, error: error.message }));
  process.exitCode = 2;
}
