// The one console prompt a freshly-launched claude worker cannot get past on its own.
//
// `claude-aify` launches claude with `--dangerously-load-development-channels`, which is how the
// channel that delivers dispatches is loaded at all, and claude answers that with a first-run
// acknowledgment it then WAITS at. The worker boots, registers `online`, never starts its in-process
// MCP, and never claims a dispatched run. "Up but deaf" — measured on the operator's fleet on
// 2026-07-03, and again on 2026-09-03 when a probe sat at this menu while every status field read
// healthy and the console was the only thing that could say so.
//
// The aify-comms bridge answered it and this host did not, which is why a worker started here came
// up deaf. That rule is proven — it is why managed claude workers ever came up.
//
// WHAT THESE PIN, and all of them are about NOT answering:
//   * the flag name appears in ordinary boot output, so matching it fires on every cold start;
//   * a resume menu's default is "Resume from summary", so a stray Enter silently compacts a
//     session — the bridge did exactly that, on every worker cold-start, for a while;
//   * a repeated Enter has been MEASURED to do nothing, five times in a row, each reporting success.
// A rule that answers too eagerly is worse than no rule, because it types into whatever is on screen.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  answerForConsole,
  createPromptAnswerer,
  PROMPT_TAIL_BYTES,
} from "../lib/plugins/aify-comms/console-prompts.mjs";

const ENTER = String.fromCharCode(13);

/** The dialog as claude renders it, cursor on the accepting option. */
const DIALOG = [
  "  --dangerously-load-development-channels is for local channel development only.",
  "",
  "  Channels: server:aify-comms-channel",
  "",
  "  ❯ 1. I am using this for local development",
  "    2. Exit",
  "",
  "  Enter to confirm · Esc to cancel",
].join("\n");

test("the acknowledgment is answered with a bare Enter", () => {
  assert.equal(answerForConsole(DIALOG), ENTER);
});

test("ORDINARY BOOT OUTPUT naming the flag is NOT answered", () => {
  // The worker's own command line contains `--dangerously-load-development-channels` and sits in the
  // buffer at exactly the moment other menus render. Matching the flag rather than the dialog's own
  // question line is how the bridge came to press Enter into a resume menu on every cold start.
  const boot = "claude --dangerously-load-development-channels server:aify-comms-channel --model opus";
  assert.equal(answerForConsole(boot), "");
});

test("A RESUME MENU LATER IN THE STREAM SUPPRESSES IT", () => {
  // Its highlighted default is "Resume from summary", so a stray Enter there silently summarises —
  // compacts — a session's whole context. Compared by POSITION, because the buffer accumulates and
  // an already-answered dialog lingers in scrollback behind the live menu.
  const then = `${DIALOG}\n\n  ❯ Resume from summary (recommended)\n    Resume full session as-is\n`;
  assert.equal(answerForConsole(then), "");
});

test("a resume menu EARLIER in the stream does not suppress it", () => {
  // The other direction, and it must not be lost to caution: a channels dialog rendered after an
  // answered menu is the live thing, and refusing it would leave the worker deaf for ever.
  const then = `  ❯ Resume from summary (recommended)\n    Resume full session as-is\n\n${DIALOG}`;
  assert.equal(answerForConsole(then), ENTER);
});

test("the cursor must be ON the accepting option", () => {
  // Without this the answer is a blind Enter, which selects whatever a different menu highlighted.
  const onExit = DIALOG.replace("❯ 1. I am using", "  1. I am using")
    .replace("    2. Exit", "  ❯ 2. Exit");
  assert.equal(answerForConsole(onExit), "");
});

test("the dialog's own chrome is required, so prose cannot trip it", () => {
  const prose = "  ❯ 1. I am using this for local development\n  (no confirm line here)";
  assert.equal(answerForConsole(prose), "");
});

test("a match far back in SCROLLBACK is history, not a live prompt", () => {
  // aify-comms has a standing bug of exactly this shape — a prompt matcher scanning a 64 KB tail —
  // and it is restricted to one runtime because of it. Not worth importing.
  const buried = DIALOG + "\n" + "x".repeat(PROMPT_TAIL_BYTES + 500);
  assert.equal(answerForConsole(buried), "");
});

test("nothing at all is answered for an ordinary screen", () => {
  for (const quiet of ["", "  ❯ 1. Yes\n    2. No\n  Enter to confirm", "some output\n"]) {
    assert.equal(answerForConsole(quiet), "", `answered a screen it should not have: ${quiet}`);
  }
});

test("A CHUNKED dialog is still recognised", () => {
  // Output arrives in writes that split lines anywhere, so a menu routinely lands across two chunks.
  // A matcher fed one chunk at a time sees neither half — and the failure is silent.
  const written = [];
  const answerer = createPromptAnswerer({ write: (id, data) => written.push({ id, data }) });
  const half = Math.floor(DIALOG.length / 2);
  assert.equal(answerer.observe("term-1", DIALOG.slice(0, half)), false);
  assert.equal(answerer.observe("term-1", DIALOG.slice(half)), true);
  assert.deepEqual(written, [{ id: "term-1", data: ENTER }]);
});

test("IT ANSWERS ONCE PER TERMINAL, EVER", () => {
  // Not an optimisation. `comms_console_input`'s own docs record the measurement: a repeated Enter
  // into a stuck claude draft was tried five times, every call reported success, and nothing
  // submitted. A loop pressing Enter at a screen it cannot change is indistinguishable from one that
  // is working, and it types into whatever replaces that screen.
  const written = [];
  const answerer = createPromptAnswerer({ write: (id, data) => written.push({ id, data }) });
  assert.equal(answerer.observe("term-1", DIALOG), true);
  assert.equal(answerer.observe("term-1", DIALOG), false);
  assert.equal(answerer.observe("term-1", DIALOG), false);
  assert.equal(written.length, 1);
});

test("each terminal is answered on its own", () => {
  const written = [];
  const answerer = createPromptAnswerer({ write: (id, data) => written.push({ id, data }) });
  answerer.observe("term-1", DIALOG);
  answerer.observe("term-2", DIALOG);
  assert.deepEqual(written.map((w) => w.id), ["term-1", "term-2"]);
});

test("a WRITE THAT THROWS is reported and does not escape the output listener", () => {
  // This runs inside the subscription that carries the console. Throwing here would stop the stream
  // the operator reads — trading a stuck prompt for a blind one.
  const logs = [];
  const answerer = createPromptAnswerer({
    write: () => { throw new Error("no process for terminal"); },
    log: (m) => logs.push(String(m)),
  });
  assert.doesNotThrow(() => answerer.observe("term-1", DIALOG));
  assert.ok(logs.some((l) => /could not answer the console prompt/.test(l)));
});

test("forgetting a terminal lets a REUSED id be answered again", () => {
  // Runner ids are recycled per instance, so a remembered "already answered" would leave the next
  // worker on that id stuck at the prompt with nothing saying why.
  const written = [];
  const answerer = createPromptAnswerer({ write: (id, data) => written.push({ id, data }) });
  answerer.observe("term-1", DIALOG);
  answerer.forget("term-1");
  answerer.observe("term-1", DIALOG);
  assert.equal(written.length, 2);
});

test("it says WHY it answered, because a silent keystroke is unattributable", () => {
  const logs = [];
  createPromptAnswerer({ write: () => {}, log: (m) => logs.push(String(m)) }).observe("term-1", DIALOG);
  assert.ok(logs.some((l) => /development-channels acknowledgment/.test(l)));
  assert.ok(logs.some((l) => /never claims a dispatch/.test(l)),
    "the log must name the consequence, or a reader cannot tell it from noise");
});
