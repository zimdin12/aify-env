// Ported from aify-comms `mcp/stdio/tests/the-claude-login-has-a-deadline.test.js` in 0.9.7, when this row moved to `aify-env doctor`.
// The one credential 21 agents share, and nothing was watching it.
//
// WHY THIS EXISTS, measured 2026-09-03 16:36 UTC. The task list recorded "claude login expires
// ~2026-09-05". `~/.claude/.credentials.json` said the access token expired at 23:09 THAT NIGHT and
// the refresh token at 11:57 the next morning -- roughly two days optimistic, in the direction where
// being wrong means a fleet that stops overnight with the operator asleep. aify-comms' `usage-collector.js` had
// been reading that same file for the quota pool all along, so the gap was never access to the data:
// nobody asked it the one question with a deadline attached.

import { test } from "node:test";
import assert from "node:assert/strict";

import { join } from "node:path";

import {
  CLAUDE_LOGIN_EXPIRED,
  CLAUDE_LOGIN_EXPIRING,
  CLAUDE_LOGIN_OK,
  CLAUDE_LOGIN_UNKNOWN,
  CLAUDE_REFRESH_WARN_HOURS,
  claudeLoginCheck,
  claudeCredentialsPath,
  claudeLoginStateAt,
} from "../lib/claude-login-check.mjs";

const NOW = Date.UTC(2026, 8, 3, 16, 36);
const hours = (n) => NOW + n * 3_600_000;
const creds = (over = {}) => ({
  claudeAiOauth: {
    accessToken: "sk-ant-SECRET-DO-NOT-PRINT",
    refreshToken: "refresh-SECRET-DO-NOT-PRINT",
    expiresAt: hours(6.5),
    refreshTokenExpiresAt: hours(19.3),
    ...over,
  },
});

test("A HEALTHY LOGIN READS OK", () => {
  // POSITIVE CONTROL. Most assertions below are about NOT being ok, and a classifier that never
  // returned ok would satisfy them all while making the row permanently red.
  const v = claudeLoginStateAt(creds({ refreshTokenExpiresAt: hours(240) }), NOW);
  assert.equal(v.state, CLAUDE_LOGIN_OK);
  assert.match(v.detail, /good for 240h/);
});

test("THE LIVE SHAPE THAT PROMPTED THIS: 19.3h of refresh left is EXPIRING", () => {
  const v = claudeLoginStateAt(creds(), NOW);
  assert.equal(v.state, CLAUDE_LOGIN_EXPIRING);
  assert.match(v.detail, /19\.3h/);
  assert.match(v.detail, /every claude-code agent stops at once/,
    "the consequence is the whole reason to act, so it has to be in the row");
});

test("AN EXPIRED ACCESS TOKEN BESIDE A HEALTHY REFRESH IS STILL OK", () => {
  // THE CRIES-WOLF TRAP, and the reason the access token cannot decide the verdict. It is
  // short-lived and refreshed silently on next use, so this is the ORDINARY state between two
  // calls. A check that went red for it would go red most hours, get switched off, and then the
  // real deadline would pass unwatched too.
  const v = claudeLoginStateAt(creds({ expiresAt: hours(-2), refreshTokenExpiresAt: hours(240) }), NOW);
  assert.equal(v.state, CLAUDE_LOGIN_OK);
  assert.match(v.detail, /lapsed and refreshes on next use, which is normal/);
});

test("an expired REFRESH token is terminal and says what to do", () => {
  const v = claudeLoginStateAt(creds({ refreshTokenExpiresAt: hours(-3) }), NOW);
  assert.equal(v.state, CLAUDE_LOGIN_EXPIRED);
  assert.match(v.detail, /EXPIRED \(3\.0h ago\)/);
  assert.match(v.detail, /log in/i);
});

test("the boundary is the refresh window, not the access one", () => {
  const justInside = claudeLoginStateAt(creds({ refreshTokenExpiresAt: hours(CLAUDE_REFRESH_WARN_HOURS - 0.1) }), NOW);
  const justOutside = claudeLoginStateAt(creds({ refreshTokenExpiresAt: hours(CLAUDE_REFRESH_WARN_HOURS + 0.1) }), NOW);
  assert.equal(justInside.state, CLAUDE_LOGIN_EXPIRING);
  assert.equal(justOutside.state, CLAUDE_LOGIN_OK);
});

test("IT NEVER PUTS A TOKEN IN ITS OUTPUT", () => {
  // This row is meant to be pasted into a report. A health check that handles a credential is a
  // credential in one more place, so it reads two timestamps and nothing else.
  for (const over of [{}, { refreshTokenExpiresAt: hours(-1) }, { refreshTokenExpiresAt: hours(500) }]) {
    const v = claudeLoginStateAt(creds(over), NOW);
    assert.ok(!/SECRET-DO-NOT-PRINT/.test(v.detail), `a token reached the detail: ${v.detail}`);
  }
});

test("A HOST WITH NO CLAUDE LOGIN IS NOT BROKEN", () => {
  // A machine running only codex or hermes agents has no claude grant. Failing there teaches an
  // operator that this row is noise, and then it is noise on the day it matters.
  assert.equal(claudeLoginStateAt({}, NOW).state, CLAUDE_LOGIN_UNKNOWN);
  assert.equal(claudeLoginStateAt(null, NOW).state, CLAUDE_LOGIN_UNKNOWN);
  assert.equal(claudeLoginStateAt({ claudeAiOauth: "nonsense" }, NOW).state, CLAUDE_LOGIN_UNKNOWN);
});

test("AN UNREADABLE STAMP IS UNKNOWN, NEVER EXPIRED", () => {
  // Reporting "expired" for a value that could not be parsed would send an operator to
  // re-authenticate a login that may be perfectly healthy -- inventing a verdict from no evidence,
  // which is the shape `a2f9e42` exists to refuse.
  for (const bad of [undefined, null, "", "soon", NaN, 0, -1]) {
    assert.equal(claudeLoginStateAt(creds({ refreshTokenExpiresAt: bad }), NOW).state, CLAUDE_LOGIN_UNKNOWN,
      `refreshTokenExpiresAt=${JSON.stringify(bad)} was not treated as unknown`);
  }
});

test("the ROW passes as not applicable, with code skipped, when the file is absent", () => {
  // Not a failure and not unanswered: a host with no claude login is not broken and has no question
  // here. The code keeps it distinguishable from a measured pass.
  const row = claudeLoginCheck({
    readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    now: () => NOW,
  });
  assert.equal(row.id, "claude-login");
  assert.equal(row.state, "passed", "a host with no claude login was reported as a failure");
  assert.equal(row.code, "skipped");
  assert.match(row.detail, /no claude credentials/);
});

test("a file with no readable expiry is not applicable either, and says nothing was measured", () => {
  const row = claudeLoginCheck({ readFile: () => JSON.stringify({ claudeAiOauth: {} }), now: () => NOW });
  assert.equal(row.code, "skipped");
  assert.match(row.detail, /nothing was measured/);
});

test("THE ROW REPORTS THE VERDICT ITS CLASSIFIER PRODUCED, and offers the fix", () => {
  // The call site, not just the predicate: a classifier proven correct and a check that reports
  // something else is the disconnected-call-site defect this project keeps finding.
  const row = claudeLoginCheck({ readFile: () => JSON.stringify(creds()), now: () => NOW });
  assert.equal(row.id, "claude-login");
  assert.equal(row.code, CLAUDE_LOGIN_EXPIRING);
  assert.equal(row.state, "failed");
  assert.match(row.fix, /Run `claude`/);
});

test("an EXPIRED login fails the row too", () => {
  const row = claudeLoginCheck({ readFile: () => JSON.stringify(creds({ refreshTokenExpiresAt: hours(-3) })), now: () => NOW });
  assert.equal(row.state, "failed");
  assert.equal(row.code, CLAUDE_LOGIN_EXPIRED);
});

test("and it passes WITHOUT a fix when there is nothing to do", () => {
  const row = claudeLoginCheck({
    readFile: () => JSON.stringify(creds({ refreshTokenExpiresAt: hours(500) })),
    now: () => NOW,
  });
  assert.equal(row.state, "passed");
  assert.equal(row.code, CLAUDE_LOGIN_OK);
  assert.equal(row.fix, "", "a passing row offered a remedy for nothing");
});

test("it reads the file claude keeps, under the home it is given", () => {
  // aify-comms' `usage-collector.js` reads the same file for the quota pool; aify-comms' suite holds
  // the two spellings together from its side.
  const read = [];
  claudeLoginCheck({ home: "/home/op", readFile: (path) => { read.push(path); return "{}"; }, now: () => NOW });
  assert.deepEqual(read, [join("/home/op", ".claude", ".credentials.json")]);
  assert.equal(claudeCredentialsPath("/home/op"), join("/home/op", ".claude", ".credentials.json"));
});
