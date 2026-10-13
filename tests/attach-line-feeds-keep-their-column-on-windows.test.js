// On Windows `aify-env attach` writes the stream unchanged and the console keeps a bare LF's column.
//
// THE DEFECT (2026-09-30), the scrambled herdr pane. ConPTY moves the cursor down with a bare LF, meaning
// "same column". Node's TTY writer and the console's auto-return each made it CR+LF, so the row went back
// to column 1 and the cells it did not cover kept the old text ("bot-" for "both"). lib/console-output.mjs
// writes raw to fd 1 with DISABLE_NEWLINE_AUTO_RETURN on and the code page at UTF-8, set through koffi.
//
// MEASURED THROUGH A REAL CONPTY, the path the bytes take in a herdr pane: a child writes through the real
// `openConsoleOutput` and `passthrough` inside node-pty, and a real emulator reads what the console made of
// it. The controls write the same bytes the old ways and must show the shift.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCAL_SCREEN_RESET } from "../lib/attach-screen.mjs";
import { ScreenEmulator } from "../lib/screen-emulator.mjs";

const ESC = String.fromCharCode(27);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = (name) => pathToFileURL(path.join(HERE, "..", "lib", name)).href;
//: A row at column 3, a LF mid-screen, box drawing and accents, and a LF on the bottom row, which scrolls.
const CHUNK = `${ESC}[2;3Hab\ncd${ESC}[4;1H└─ ✻ é${ESC}[6;1Hbottom\nnext`;
const EXPECTED = ["  ab", "    cd", "└─ ✻ é", "", "bottom", "      next"];

const require = createRequire(import.meta.url);
const has = (name) => { try { require.resolve(name); return true; } catch { return false; } };
const windowsWith = (...needs) => ({
  skip: process.platform !== "win32" ? "a Windows console is what converts LF"
    : needs.find((name) => !has(name)) ? `${needs.find((name) => !has(name))} is not installed` : false,
});

/** Run `body` as a node child inside a 40x6 ConPTY; it ends by writing `ESC]0;written BEL`. */
async function inConsole(body) {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aify-attach-console-")), "report.json");
  const script = `
    const REPORT = ${JSON.stringify(report)};
    const CHUNK = ${JSON.stringify(CHUNK)};
    const done = () => setTimeout(() => process.stdout.write("\\x1b]0;written\\x07"), 300);
    ${body}
    setInterval(() => {}, 1000);
  `;
  // THE CHILD STAYS ALIVE AND IS KILLED, the way the other pty tests end one: awaiting a ConPTY child's own
  // exit leaves node-pty's output socket open, and the file never finished (measured).
  const child = require("node-pty").spawn(process.execPath, ["--input-type=module", "-e", script],
    { name: "xterm-256color", cols: 40, rows: 6 });
  let output = "";
  child.onData((data) => { output += data; });
  const until = Date.now() + 30000;
  while (!output.includes("written") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  child.kill();
  assert.ok(output.includes("written"), "the child never said it had written, so there is no screen to read");
  const screen = await ScreenEmulator.create({ cols: 40, rows: 6 });
  assert.ok(screen, "@xterm/headless is absent, so nothing here is measured");
  await screen.write(output);
  const rows = screen.rows().map((row) => row.trimEnd());
  screen.dispose();
  return { rows, report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : null };
}

test("A LINE FEED KEEPS ITS COLUMN, TEXT STAYS UTF-8, AND THE CONSOLE IS HANDED BACK",
  windowsWith("node-pty", "@xterm/headless", "koffi"), async () => {
    const { rows, report } = await inConsole(`
      const { openConsoleOutput, loadConsoleApi, STD_OUTPUT_HANDLE } = await import(${JSON.stringify(url("console-output.mjs"))});
      const { passthrough } = await import(${JSON.stringify(url("attach-screen.mjs"))});
      const api = await loadConsoleApi();
      const handle = api.getStdHandle(STD_OUTPUT_HANDLE);
      const before = { mode: api.getConsoleMode(handle), cp: api.getConsoleOutputCP() };
      const output = await openConsoleOutput();
      const raw = output.raw;
      passthrough((text) => output.write(text)).append(CHUNK);
      output.restore();
      const after = { mode: api.getConsoleMode(handle), cp: api.getConsoleOutputCP() };
      (await import("node:fs")).writeFileSync(REPORT, JSON.stringify({ raw, before, after }));
      done();
    `);
    assert.equal(report?.raw, true, "the console did not take its modes, so nothing here is measured");
    assert.deepEqual(rows, EXPECTED);
    assert.deepEqual(report.after, report.before, "the console's mode and code page were not put back");
  });

test("CONTROL: the same bytes through process.stdout land at column 1", windowsWith("node-pty", "@xterm/headless"), async () => {
  const { rows } = await inConsole(`process.stdout.write(${JSON.stringify(LOCAL_SCREEN_RESET)} + CHUNK); done();`);
  assert.equal(rows[1], "cd", "Node did not add a carriage return, so the first test proves nothing about it");
});

test("CONTROL: a raw write without the modes lands at column 1 too", windowsWith("node-pty", "@xterm/headless"), async () => {
  const { rows } = await inConsole(`(await import("node:fs")).writeSync(1, ${JSON.stringify(LOCAL_SCREEN_RESET)} + CHUNK); done();`);
  assert.equal(rows[1], "cd", "the console did not add a carriage return, so the modes are not what the first test shows");
});
