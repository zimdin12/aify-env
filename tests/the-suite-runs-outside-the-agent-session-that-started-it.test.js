// tests/run-in-a-temp-root.mjs hands the suite an environment without the Herdr and agent of the terminal it
// was started from. Run from an agent's Herdr pane, tests held that pane's live socket and that agent's id
// (2026-10-03). Green for nothing from a plain terminal, which holds neither; on this host the suite is run
// from agent panes.

import assert from 'node:assert/strict';
import { test } from 'node:test';

test('no test sees a Herdr or an agent identity it did not set itself', () => {
  const leaked = Object.keys(process.env).filter((name) =>
    /^(AIFY_)?HERDR_/i.test(name) || ['AIFY_AGENT_ID', 'AIFY_AGENT_LEASE', 'CLAUDE_CODE_CHILD_SESSION'].includes(name.toUpperCase()));
  assert.deepEqual(leaked, []);
});
