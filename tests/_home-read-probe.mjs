// Preloaded into a spawned doctor (`node --import <this> ...`) to RECORD every filesystem path it touches
// under the directories named in AIFY_TEST_WATCH_DIRS (path.delimiter-separated), one per line in
// AIFY_TEST_WATCH_LOG. It changes no behaviour: each wrapped call goes through to the real one.
//
// It wraps the public `fs` and `fs.promises` functions that take a path first, then re-syncs the ESM
// named exports so `import { readFileSync } from "node:fs"` sees the wrapper too. Node's own module
// loader does not go through these, which is why a test watches the host-state directories (`.claude`,
// `.aify`) rather than the whole home: the code under test may itself live under that home.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const roots = String(process.env.AIFY_TEST_WATCH_DIRS || "").split(path.delimiter).filter(Boolean)
  .map((dir) => path.resolve(dir).toLowerCase());
const log = process.env.AIFY_TEST_WATCH_LOG || "";
const append = fs.appendFileSync;

function record(target) {
  if (!log || !roots.length) return;
  let text;
  try { text = path.resolve(String(target instanceof URL ? target.pathname : target)).toLowerCase(); } catch { return; }
  if (roots.some((root) => text === root || text.startsWith(root + path.sep))) append(log, `${text}\n`);
}

const SYNC = ["readFileSync", "openSync", "existsSync", "statSync", "lstatSync", "readdirSync", "accessSync",
  "realpathSync", "readFile", "open", "stat", "lstat", "readdir", "access", "createReadStream"];
const PROMISES = ["readFile", "open", "stat", "lstat", "readdir", "access", "realpath"];

function wrap(owner, name) {
  const real = owner[name];
  if (typeof real !== "function") return;
  const wrapped = function (target, ...rest) { record(target); return real.call(this, target, ...rest); };
  Object.assign(wrapped, real);
  if (name === "realpathSync" && typeof real.native === "function") {
    const native = real.native;
    wrapped.native = (target, ...rest) => { record(target); return native(target, ...rest); };
  }
  owner[name] = wrapped;
}

for (const name of SYNC) wrap(fs, name);
for (const name of PROMISES) wrap(fs.promises, name);
syncBuiltinESMExports();
