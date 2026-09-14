#!/usr/bin/env node
// A pane that is already watching survives the terminal being resized.
//
// THE DEFECT. A resize makes the daemon write a new `meta` built from `streamMeta`, whose `resized`
// is true while the resize sits inside the retained buffer. The follower replaced its whole meta with
// that frame, so `baselineIsSound` turned false and the pane said "waiting for the first full
// repaint -- the terminal was resized" and refused input with no way out: Claude never emits RIS.
// Every attach, Herdr pane connect and `--shared` launch sends a resize, so this was hit constantly.
//
// WHY THE LATER VERDICT IS WRONG FOR THIS SUBSCRIBER. `truncated` and `resized` describe the REPLAY a
// subscriber was handed when it joined. A subscriber that received the later bytes live applied the
// resize in order with them, so its screen is sound. Only the first meta of a subscription can carry
// that verdict; later ones move the geometry and nothing else.

import assert from "node:assert/strict";
import test from "node:test";

import { OutputFollower } from "../lib/output-follower.mjs";
import { dataFrame, namedFrame } from "../lib/sse-frames.mjs";
import { loadEmulator } from "../lib/screen-emulator.mjs";

const ESC = String.fromCharCode(27);

/** A follower whose stream pauses after its first frames, so the screen exists before the resize. */
function followingSlowly(first, ...rest) {
  const encoder = new TextEncoder();
  return new OutputFollower({
    endpoint: "http://127.0.0.1:8802",
    id: "p1",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      body: (async function* body() {
        yield encoder.encode(first);
        await new Promise((r) => setTimeout(r, 80));
        for (const piece of rest) yield encoder.encode(piece);
      })(),
    }),
  });
}

const settle = () => new Promise((r) => setTimeout(r, 80));
const META = (over = {}) => namedFrame("meta", {
  cols: 80, rows: 24, truncated: false, resized: false, replayBytes: 65536, ...over,
});

test("POSITIVE CONTROL: the emulator is installed, so the screen below is real", async () => {
  assert.ok(await loadEmulator(), "@xterm/headless is absent");
});

test("A LIVE RESIZE DOES NOT FREEZE A PANE THAT WAS SOUND", async () => {
  const f = followingSlowly(
    META() + dataFrame(`${ESC}[1;1Hwatching`),
    // Exactly what the route writes after `runner.resize`: `resized` is true now.
    META({ cols: 60, rows: 20, resized: true }),
    dataFrame(`${ESC}[2;1Hstill live`),
  );
  await f.start();
  await settle();
  assert.equal(f.screen?.term.cols, 60, "the resize never reached the screen, so nothing was tested");
  assert.equal(f.paneProblem(), "", "a pane that applied the resize live was declared unsound");
  assert.match(f.lines({ height: 20, width: 60 }).join("\n"), /still live/);
  f.stop();
});

test("A LATER meta THAT SAYS TRUNCATED DOES NOT FREEZE IT EITHER", async () => {
  // The buffer overflowing after this subscriber joined lost nothing this subscriber did not see.
  const f = followingSlowly(
    META() + dataFrame(`${ESC}[1;1Hwatching`),
    META({ cols: 70, rows: 22, truncated: true, resized: true }),
  );
  await f.start();
  await settle();
  assert.equal(f.paneProblem(), "");
  assert.equal(f.meta.cols, 70, "the geometry of the later meta was dropped");
  assert.equal(f.meta.rows, 22);
  f.stop();
});

test("NEGATIVE CONTROL: the FIRST meta's verdict still refuses", async () => {
  // A subscriber whose replay straddled a resize has an unsound screen, and a later sound-looking
  // meta must not rescue it -- only a full repaint can.
  const f = followingSlowly(
    META({ resized: true }) + dataFrame(`${ESC}[1;1Hreplayed`),
    META({ cols: 60, rows: 20, resized: false }),
  );
  await f.start();
  await settle();
  assert.match(f.paneProblem(), /resized/, "a later meta erased the replay's verdict");
  f.stop();
});
