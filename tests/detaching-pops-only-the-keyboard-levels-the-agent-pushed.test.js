// Detaching pops the keyboard-protocol levels the agent pushed, and no others.
//
// THE DEFECT (v0.7.1 review, W14). The leave sequence always ended with `CSI < u`, one pop of the
// kitty keyboard-protocol stack. An agent that never pushed a level left that pop to land on whatever
// the operator's own terminal stack held -- a level the shell, a multiplexer or the terminal itself
// had pushed -- and took it away.
//
// So the pass-through counts what the agent's output pushed (`CSI > flags u`) and popped
// (`CSI < n u`), and the leave sequence pops the difference. Per screen, because the kitty
// specification says "the main and alternate screens in the terminal emulator must maintain their
// own, independent, keyboard mode stacks": a level pushed on the alternate screen is popped while the
// alternate screen is showing, before the leave sequence switches back.

import assert from "node:assert/strict";
import test from "node:test";

import { passthrough } from "../lib/attach-screen.mjs";

const ESC = String.fromCharCode(27);
const PUSH = `${ESC}[>1u`;
const POP_ANY = new RegExp(`${ESC}\\[<\\d*u`, "g");

/** The leave sequence after the agent's output arrived in these reads. */
function leaveAfter(...reads) {
  const out = passthrough(() => {});
  for (const read of reads) out.append(read);
  return out.leave();
}

const pops = (sequence) => sequence.match(POP_ANY) ?? [];

test("an agent that pushed nothing gets no pop, so the operator's own level survives", () => {
  const leave = leaveAfter("hello", `${ESC}[?25l`, "world");
  assert.deepEqual(pops(leave), [], `detaching popped a level nobody pushed: ${JSON.stringify(leave)}`);
  assert.ok(leave.includes(`${ESC}[?1049l`), "positive control: the rest of the leave sequence went missing");
});

test("a pushed level is popped on the way out", () => {
  assert.deepEqual(pops(leaveAfter("x", PUSH, "y")), [`${ESC}[<1u`]);
});

test("levels the agent popped itself are not popped again", () => {
  assert.deepEqual(pops(leaveAfter(PUSH, `${ESC}[>3u`, `${ESC}[<2u`)), []);
  assert.deepEqual(pops(leaveAfter(PUSH, `${ESC}[>3u`, `${ESC}[<u`)), [`${ESC}[<1u`], "a bare pop is one level");
  assert.deepEqual(pops(leaveAfter(PUSH, `${ESC}[<5u`)), [], "an over-pop is not owed back as a negative");
});

test("a push split across two reads at any point is still counted", () => {
  for (let at = 1; at < PUSH.length; at += 1) {
    assert.deepEqual(pops(leaveAfter(`a${PUSH.slice(0, at)}`, `${PUSH.slice(at)}b`)), [`${ESC}[<1u`],
      `a push split after ${at} byte(s) was missed`);
  }
});

test("a level pushed on the alternate screen is popped there, before the screen is left", () => {
  const leave = leaveAfter(`${ESC}[?1049h`, PUSH);
  const pop = leave.indexOf(`${ESC}[<1u`);
  assert.ok(pop >= 0, `no pop for the alternate screen's level: ${JSON.stringify(leave)}`);
  assert.ok(pop < leave.indexOf(`${ESC}[?1049l`), "the pop landed on the main screen's stack");
});

test("a level pushed on the main screen is popped on the main screen", () => {
  const leave = leaveAfter(PUSH, `${ESC}[?1049h`, "full screen app", `${ESC}[?1049l`);
  assert.deepEqual(pops(leave), [`${ESC}[<1u`]);
  assert.ok(leave.indexOf(`${ESC}[<1u`) > leave.indexOf(`${ESC}[?1049l`),
    "the main screen's level was popped while the alternate screen was showing");
});

test("a level left on the alternate screen after the agent went back to main is still popped there", () => {
  // The alternate screen's stack outlives the screen being shown; a later full-screen program in the
  // operator's shell would inherit it. The leave sequence visits it to pop, then leaves.
  const leave = leaveAfter(`${ESC}[?1049h`, PUSH, `${ESC}[?1049l`);
  const enter = leave.indexOf(`${ESC}[?1049h`);
  const pop = leave.indexOf(`${ESC}[<1u`);
  assert.ok(enter >= 0 && pop > enter && pop < leave.lastIndexOf(`${ESC}[?1049l`),
    `the alternate screen's level was not popped on the alternate screen: ${JSON.stringify(leave)}`);
});
