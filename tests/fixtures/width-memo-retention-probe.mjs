// Measures what the width memo RETAINS, and prints it as JSON for its test to read.
//
// A SEPARATE PROCESS because this needs `--expose-gc`, and the suite must not run with it: a global
// `gc()` available to every other test is an invitation to hide a timing problem behind a collection.
//
// WHAT IT IS FOR. V8 represents `big.slice(a, b)` as a SlicedString pointing AT `big`, so caching a
// slice holds its whole parent. A pane line is a slice of terminal output, so that is how keys
// arrive here. The entry bound and the key-length bound are both honoured while this happens, which
// is why only a heap measurement can see it.
//
// EVERY POPULATION FIGURE BELOW IS MEASURED FROM THE STRINGS ACTUALLY BUILT, never computed from the
// constants that were meant to produce them. The first version of this file reported
// `PARENTS * PARENT_UNITS * 2` as its parent size -- a constant, which its test then compared
// against the same constant. It was wrong twice over: the repeated pattern is FIVE units, not the
// eight the divisor assumed, so each parent was 655,360 units rather than 1,048,576; and external
// review showed that cutting the repeat count to 30 still reported 67,108,864 and still passed.
// A probe whose population is asserted from its own intentions cannot report a wrong one.

import { width, widthMemoSizeForTests } from "../../lib/text-width.mjs";

const PARENTS = 32;
const PARENT_UNITS = 1024 * 1024;      // the TARGET size of each parent, in UTF-16 units
const SLICE_UNITS = 120;

/** A distinct non-ASCII pattern per parent, so each slice is its own cache entry. */
const patternFor = (i) => `翻${String(i).padStart(4, "0")}`;
// FROM THE PATTERN ITSELF. Dividing by a hand-written unit count is what made the parents 37% small.
const REPEATS = Math.ceil(PARENT_UNITS / patternFor(0).length);

function settle() {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

widthMemoSizeForTests({ reset: true });
const base = settle();

let parentUnitsBuilt = 0;
let sliceUnitsCached = 0;
for (let i = 0; i < PARENTS; i += 1) {
  const parent = patternFor(i).repeat(REPEATS);
  parentUnitsBuilt += parent.length;
  const slice = parent.slice(10, 10 + SLICE_UNITS);
  sliceUnitsCached += slice.length;
  width(slice);
  // The parent goes out of scope here. Only the cache could still be holding it.
}

const withCache = settle();
const entries = widthMemoSizeForTests();
widthMemoSizeForTests({ reset: true });
const afterReset = settle();

process.stdout.write(JSON.stringify({
  entries,
  // MEASURED, both of them: the sum of the lengths of the strings this run actually constructed.
  parentUnitsBuilt,
  sliceUnitsCached,
  parentBytes: parentUnitsBuilt * 2,
  attributableBytes: (withCache - base) - (afterReset - base),
}));
