// Kernel-owned, nonblocking operation lock. Never unlink the rendezvous file:
// deleting an advisory-locked inode would let another opener lock a different inode.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export class ActivityOperationLock {
  constructor(file) { this.file = file; this.api = null; }
  load() {
    if (this.api) return this.api;
    try {
      const koffi = require('koffi');
      if (process.platform === 'win32') {
        const lib = koffi.load('kernel32.dll');
        this.api = {
          koffi,
          open: lib.func('void* __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void* security, uint32_t disposition, uint32_t flags, void* templateFile)'),
          info: lib.func('int32_t __stdcall GetFileInformationByHandleEx(void* handle, int32_t kind, void* info, uint32_t size)'),
          error: lib.func('uint32_t __stdcall GetLastError()'),
          close: lib.func('int32_t __stdcall CloseHandle(void* handle)'),
        };
      } else {
        const lib = koffi.load(null);
        this.api = { koffi, flock: lib.func('int flock(int fd, int operation)') };
      }
      return this.api;
    } catch { throw new Error('state-lock-unavailable'); }
  }
  run(action) {
    const api = this.load();
    return process.platform === 'win32' ? this.windows(api, action) : this.posix(api, action);
  }
  windows(api, action) {
    // Microsoft CreateFileW: share=0 excludes read/write/delete opens until CloseHandle.
    // OPEN_ALWAYS=4 preserves existing bytes. NULL security makes the handle non-inheritable.
    // FILE_FLAG_OPEN_REPARSE_POINT opens the link itself; inspect that held handle below.
    // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
    let handle;
    try { handle = api.open(path.toNamespacedPath(this.file), 0xc0000000, 0, null, 4, 0x00200080, null); }
    catch { throw new Error('state-lock-failed'); }
    if (handle === null || BigInt.asIntN(api.koffi.sizeof('void*') * 8, api.koffi.address(handle)) === -1n) {
      throw new Error(api.error() === 32 ? 'state-busy' : 'state-lock-failed');
    }
    try {
      // FileAttributeTagInfo=9, FILE_ATTRIBUTE_TAG_INFO is two DWORDs.
      // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex
      const info = Buffer.alloc(8);
      if (!api.info(handle, 9, info, info.length)) throw new Error('state-lock-failed');
      if (info.readUInt32LE(0) & 0x410) throw new Error('unsafe-file'); // directory or reparse point
      return action();
    } finally { if (!api.close(handle)) throw new Error('state-lock-release'); }
  }
  posix(api, action) {
    // BSD/Linux flock: LOCK_EX | LOCK_NB never waits. Closing the last descriptor,
    // including process death, releases ownership. Node opens descriptors close-on-exec.
    // https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    } catch { throw new Error('state-lock-failed'); }
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('unsafe-file');
      if (api.flock(fd, 2 | 4) !== 0) {
        throw new Error(api.koffi.errno() === api.koffi.os.errno.EWOULDBLOCK ? 'state-busy' : 'state-lock-failed');
      }
      return action();
    } finally { fs.closeSync(fd); }
  }
}
