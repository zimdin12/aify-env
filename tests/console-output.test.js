// `aify-env attach` sets the Windows console to keep a line feed's column, writes raw, and hands it back
// (lib/console-output.mjs). Every console call here goes to a fake, so these run anywhere.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DISABLE_NEWLINE_AUTO_RETURN,
  ENABLE_VIRTUAL_TERMINAL_PROCESSING,
  STD_OUTPUT_HANDLE,
  UTF8_CODE_PAGE,
  openConsoleOutput,
} from "../lib/console-output.mjs";

const ORIGINAL_MODE = 0x3;
const ORIGINAL_CP = 775;

function fakeConsole({ setModeAnswers = [], setCpAnswers = [] } = {}) {
  const calls = [];
  const state = { mode: ORIGINAL_MODE, cp: ORIGINAL_CP };
  const api = {
    getStdHandle: (which) => { calls.push(["getStdHandle", which]); return "handle"; },
    getConsoleMode: (handle) => { calls.push(["getConsoleMode", handle]); return state.mode; },
    setConsoleMode: (handle, mode) => {
      calls.push(["setConsoleMode", mode]);
      const ok = setModeAnswers.length ? setModeAnswers.shift() : true;
      if (ok) state.mode = mode;
      return ok;
    },
    getConsoleOutputCP: () => { calls.push(["getConsoleOutputCP"]); return state.cp; },
    setConsoleOutputCP: (cp) => {
      calls.push(["setConsoleOutputCP", cp]);
      const ok = setCpAnswers.length ? setCpAnswers.shift() : true;
      if (ok) state.cp = cp;
      return ok;
    },
  };
  return { api, calls, state };
}

const open = (over = {}) => openConsoleOutput({ platform: "win32", isTTY: true, fallback: () => {}, log: () => {}, ...over });

test("ON A WINDOWS TERMINAL the console keeps a line feed's column and UTF-8, and gets both back", async () => {
  const { api, calls, state } = fakeConsole();
  const output = await open({ loadApi: async () => api });
  assert.equal(output.raw, true);
  assert.deepEqual(calls[0], ["getStdHandle", STD_OUTPUT_HANDLE]);
  assert.equal(state.mode, ORIGINAL_MODE | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN);
  assert.equal(state.cp, UTF8_CODE_PAGE);
  output.restore();
  output.restore();
  assert.deepEqual(state, { mode: ORIGINAL_MODE, cp: ORIGINAL_CP });
  assert.equal(calls.filter(([name]) => name === "setConsoleMode").length, 2, "restore ran twice");
});

test("WRITES GO RAW TO fd 1, every byte, through partial writes", async () => {
  const { api } = fakeConsole();
  const written = [];
  const partial = (fd, bytes, at, length) => { written.push(bytes.subarray(at, at + Math.min(2, length))); return Math.min(2, length); };
  let fellBack = "";
  const output = await open({ loadApi: async () => api, writeSync: partial, fallback: (text) => { fellBack += text; } });
  output.write("a\nb ✻");
  assert.equal(Buffer.concat(written).toString("utf8"), "a\nb ✻");
  assert.equal(fellBack, "");
});

test("A FAILED WRITE HANDS THE CONSOLE BACK AT ONCE and the rest goes through stdout, nothing twice", async () => {
  const { api, state } = fakeConsole();
  let calls = 0;
  const failsSecond = (fd, bytes, at) => { calls += 1; if (calls === 2) throw Object.assign(new Error("x"), { code: "EIO" }); return 1; };
  const fellBack = [];
  const output = await open({ loadApi: async () => api, writeSync: failsSecond, fallback: (text) => fellBack.push(String(text)) });
  output.write("abc");
  assert.deepEqual(state, { mode: ORIGINAL_MODE, cp: ORIGINAL_CP }, "the console kept our modes after a failed write");
  assert.deepEqual(fellBack, ["bc"]);
  assert.equal(output.raw, false);
  output.write("d");
  assert.deepEqual(fellBack, ["bc", "d"]);
});

test("NO koffi, or a console that refuses, is today's output exactly, said once", async () => {
  const lines = [];
  const missing = await open({ loadApi: async () => { throw new Error("Cannot find package 'koffi'"); }, log: (l) => lines.push(l) });
  assert.equal(missing.raw, false);
  assert.match(lines[0], /koffi is unavailable/);
  const refused = fakeConsole({ setCpAnswers: [false] });
  const output = await open({ loadApi: async () => refused.api });
  assert.equal(output.raw, false);
  assert.deepEqual(refused.state, { mode: ORIGINAL_MODE, cp: ORIGINAL_CP }, "a half-set console was left half set");
});

test("NOT WINDOWS, OR NOT A TERMINAL, makes no console call", async () => {
  for (const over of [{ platform: "linux" }, { isTTY: false }]) {
    let loaded = false;
    const output = await open({ ...over, loadApi: async () => { loaded = true; return fakeConsole().api; } });
    assert.equal(output.raw, false);
    assert.equal(loaded, false, JSON.stringify(over));
  }
});

test("THE ATTACH CLIENT WRITES THROUGH IT and hands the console back on exit as well", async () => {
  // bin/aify-env-attach.mjs runs on import, so its wiring is read as text: a helper nobody calls fixes nothing.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../bin/aify-env-attach.mjs", import.meta.url), "utf8");
  assert.match(source, /const output = await openConsoleOutput\(/);
  assert.match(source, /passthrough\(\(text\) => output\.write\(text\)\)/);
  assert.match(source, /process\.on\("exit", \(\) => output\.restore\(\)\)/);
  assert.doesNotMatch(source, /passthrough\(\(text\) => process\.stdout\.write/);
});
