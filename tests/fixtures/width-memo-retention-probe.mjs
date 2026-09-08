// Measures what the width memo RETAINS, and prints it as JSON for its test to read.
//
// A SEPARATE PROCESS because this needs `--expose-gc`, and the suite must not run with it: a global
// `gc()` available to every other test is an invitation to hide a timing problem behind a collection.
//
// WHAT IT IS FOR. V8 represents `big.slice(a, b)` as a SlicedString pointing AT `big`, so caching a
// slice holds its whole parent. A pane line is a slice of terminal output and a process title is a
// slice of a JSON body, so almost every key this cache is given arrives that way. The entry bound
// and the key-length bound are both honoured while this happens, which is why only a heap
// measurement can see it.

// A plain relative import. Resolving it by hand through `new URL(...).pathname` yields a
// leading-slash "/C:/..." on Windows that the ESM loader refuses.
import { width, widthMemoSizeForTests } from "../../lib/text-width.mjs";

const PARENTS = 32;
const PARENT_UNITS = 1024 * 1024;      // one MiB of UTF-16 units per parent
const SLICE_UNITS = 120;

function settle() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

widthMemoSizeForTests({ reset: true });
const base = settle();

for (let i = 0; i < PARENTS; i += 1) {
  // Non-ASCII, so the shortcut is skipped and the slice is cached. The marker keeps each distinct.
  const parent = `翻${String(i).padStart(4, "0")}`.repeat(PARENT_UNITS / 8);
  width(parent.slice(10, 10 + SLICE_UNITS));
  // The parent goes out of scope here. Only the cache could still be holding it.
}

const withCache = settle();
const entries = widthMemoSizeForTests();
widthMemoSizeForTests({ reset: true });
const afterReset = settle();

process.stdout.write(JSON.stringify({
  entries,
  logicalUnits: entries * SLICE_UNITS,
  attributableBytes: (withCache - base) - (afterReset - base),
  parentBytes: PARENTS * PARENT_UNITS * 2,
}));
