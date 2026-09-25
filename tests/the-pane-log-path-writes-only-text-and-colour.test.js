// A process's log lines reach the operator's terminal as text and colour, and nothing else.
//
// THE DEFECT (v0.7 scan, F3). When a stream's retained lines hold no cursor-move sequence the pane
// prints them raw through `clipToWidth`, which understands SGR colour and nothing more. So an
// alternate-screen switch, a full reset, a scroll region or a clipboard write passed straight onto the
// operator's terminal -- re-sent whenever that row changed -- and an agent could write the operator's
// clipboard.

import assert from "node:assert/strict";
import test from "node:test";

import { PaneBuffer } from "../lib/pane-buffer.mjs";
import { displayable } from "../lib/text-width.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** What the pane prints for one log line. */
const shown = (line) => new PaneBuffer().append(`${line}\n`).view({ height: 5, width: 120 }).join("\n");

/** Every escape sequence in a string, by its introducer and final byte. */
const escapes = (text) => text.match(new RegExp(`${ESC}(\\[[0-9;?]*.|.)`, "g")) ?? [];

test("a mode switch, a reset, a scroll region and a clipboard write do not reach the terminal", () => {
  const hostile = {
    "alternate screen": `hi ${ESC}[?1049h there`,
    "clipboard write": `x ${ESC}]52;c;aGVsbG8=${BEL} y`,
    "full reset": `before ${ESC}c after`,
    "scroll region": `r ${ESC}[1;5r s`,
  };
  for (const [what, line] of Object.entries(hostile)) {
    const out = shown(line);
    assert.deepEqual(escapes(out), [], `the ${what} reached the operator's terminal: ${JSON.stringify(out)}`);
  }
  // AND THE TEXT AROUND THEM SURVIVES. Dropping the whole line would be a different defect.
  assert.match(shown(`hi ${ESC}[?1049h there`), /hi\s+there/);
  assert.match(shown(`x ${ESC}]52;c;aGVsbG8=${BEL} y`), /x\s+y/);
});

test("CONTROL: a plain line is unchanged and colour is kept", () => {
  assert.equal(shown("plain text"), "plain text");
  const coloured = shown(`${ESC}[31mred${ESC}[0m`);
  assert.ok(coloured.includes(`${ESC}[31m`), "a log's colour was stripped");
});

test("CONTROL: a line that moves the cursor is still refused, not printed", () => {
  // The painting refusal is untouched: a cursor move sends the stream to the emulator or the notice.
  assert.match(shown(`${ESC}[12;40Hfragment`), /live TUI/);
});

test("displayable keeps text and colour, turns line breaks into spaces, and drops every other control", () => {
  assert.equal(displayable(`a${ESC}[2Jb`), "ab");
  assert.equal(displayable(`a\nb\tc\rd`), "a b c d");
  assert.equal(displayable(`a${String.fromCharCode(0x9b)}b${String.fromCharCode(7)}c`), "abc");
  assert.equal(displayable(`${ESC}[1;33mw${ESC}[0m`), `${ESC}[1;33mw${ESC}[0m`);
  assert.equal(displayable(`${ESC}[1;33mw${ESC}[0m`, { keepColour: false }), "w");
  assert.equal(displayable(`t ${ESC}]0;title`), "t ", "an unterminated OSC swallowed nothing past its end");
});
