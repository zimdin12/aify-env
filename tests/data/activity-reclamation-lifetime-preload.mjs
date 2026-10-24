// Scheduling-only gate before a real append. No read, PID or write result is fabricated.
import fs from 'node:fs';
import path from 'node:path';
const box = process.env.ACTIVITY_LIFETIME_BOX;
if (!box || !path.isAbsolute(box)) throw Error('missing owned lifetime fixture');
const open = fs.openSync, write = fs.writeSync;
const appenders = new Set();
let held = false;
fs.openSync = function(file, flags, ...args) {
  const fd = open.call(this, file, flags, ...args);
  if (typeof flags === 'number' && (flags & fs.constants.O_APPEND) && typeof file === 'string'
    && file.startsWith(path.join(box, 'leases') + path.sep) && /session-[a-f0-9]{64}\.jsonl$/.test(file)) appenders.add(fd);
  return fd;
};
fs.writeSync = function(fd, ...args) {
  if (!held && appenders.has(fd)) {
    held = true;
    fs.writeFileSync(path.join(box, 'writer-ready.json'), JSON.stringify({ pid: process.pid, version: process.version, executable: process.execPath }));
    const deadline = Date.now() + 60000, wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path.join(box, 'release-writer')) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 5);
    if (!fs.existsSync(path.join(box, 'release-writer'))) throw Error('owned scheduling gate timed out');
  }
  return write.call(this, fd, ...args);
};
process.on('exit', code => fs.writeFileSync(path.join(box, 'writer-exited.json'), JSON.stringify({ pid: process.pid, code, held })));
