#!/usr/bin/env node
// A screen exists while its pane is shown, and not one moment longer.
//
// WHY THE FOLLOWER OWNS IT. The operator asked for the console "when console is shown (only then)".
// A follower already lives exactly that long -- `console-session.mjs` opens one when the pane is
// shown and closes it on hide, switch and exit -- so putting the emulator inside it makes the gate
// STRUCTURAL rather than a flag somebody has to remember in three places. There is no way for a
// screen to outlive its pane, because there is no screen without a follower.
//
// WHAT WOULD LEAK WITHOUT IT: a parser holding a grid, per pane, on a host running twenty agents.
// And worse than memory -- review measured a write callback firing AFTER `dispose()`, so an
// undisposed screen can resolve a write for a pane that has moved to a different process.
//
// DRIVEN THROUGH REAL FRAMES, built by this repo's own writers rather than hand-typed, so a test
// cannot agree with a follower about a wire format neither shares with the daemon.

import assert from "node:assert/strict";
import test from "node:test";

import { OutputFollower } from "../lib/output-follower.mjs";
import { dataFrame, namedFrame } from "../lib/sse-frames.mjs";
import { ScreenEmulator, loadEmulator } from "../lib/screen-emulator.mjs";

const ESC = String.fromCharCode(27);

/**
 * A follower reading a stream that yields exactly what the daemon writes, through the REAL `start()`.
 *
 * FRAMES BUILT BY THIS REPO'S OWN WRITERS, not hand-typed, so a test cannot agree with a follower
 * about a format neither shares with the daemon. And driven through `start()` rather than a private
 * seam, so the parsing, the frame dispatch and the screen lifecycle are all the ones that ship.
 */
function following(...wire) {
  const encoder = new TextEncoder();
  return new OutputFollower({
    endpoint: "http://127.0.0.1:8802",
    id: "p1",
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      body: (async function* body() {
        for (const piece of wire) yield encoder.encode(piece);
      })(),
    }),
  });
}

/** Let the emulator finish loading and applying, which it does in tasks rather than synchronously. */
const settle = () => new Promise((r) => setTimeout(r, 80));

/**
 * Like `following`, but PAUSES after the first frame so the emulator is loaded before the rest.
 *
 * WITHOUT THE PAUSE THERE IS NO WINDOW TO OBSERVE. The import is async, so an unpaused stream is
 * consumed entirely before the screen exists -- every chunk takes the "no screen yet" path, and a
 * test written against it cannot tell an eager flag from a correct one. A mutant walked through
 * exactly that.
 */
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
        await new Promise((r) => setTimeout(r, 80));   // the emulator loads in here
        for (const piece of rest) yield encoder.encode(piece);
      })(),
    }),
  });
}

const META = (over = {}) => namedFrame("meta", {
  cols: 40, rows: 6, truncated: false, replayBytes: 65536, ...over,
});

test("POSITIVE CONTROL: the emulator is installed, so these tests are not measuring its absence", async () => {
  // Every assertion below about a drawn screen would pass vacuously as "no screen, show the notice"
  // on a machine without the optional dependency. This says which arm is running.
  assert.ok(await loadEmulator(), "@xterm/headless is absent -- the drawing tests below prove nothing");
});

test("A SCREEN IS BUILT AT THE PRODUCER'S SIZE, from the meta frame that arrives first", async () => {
  const f = following(META({ cols: 100, rows: 12 }));
  await f.start();
  await settle();
  assert.ok(f.screen, "no screen was built for a real terminal");
  assert.equal(f.screen.term.cols, 100);
  assert.equal(f.screen.term.rows, 12);
  f.stop();
});

test("A PIPED PROCESS GETS NO SCREEN, because 0x0 is not a terminal", async () => {
  // The negative control for the test above, and a real case: a piped process has no geometry, its
  // output is lines, and the buffer already models lines correctly.
  const f = following(META({ cols: 0, rows: 0 }));
  await f.start();
  await settle();
  assert.equal(f.screen, null, "an emulator was built for something with no terminal");
  f.stop();
});

test("BYTES THAT ARRIVE WHILE THE EMULATOR IS LOADING ARE NOT LOST", async () => {
  // The import is async and the replay follows the meta frame immediately, so the first chunk almost
  // always arrives before the screen exists. Dropping it would lose exactly the replay -- the part
  // that makes the pane show something the moment it opens.
  const f = following(META(), dataFrame(`${ESC}[1;1HREPLAYED`));
  await f.start();
  await settle();
  assert.match(f.screen.rows()[0], /^REPLAYED/, "the replay was dropped while the emulator loaded");
  f.stop();
});

test("THE PANE DRAWS THE SCREEN once the baseline is sound", async () => {
  // End to end: frames in, pane rows out, through the real emulator and the real buffer.
  const f = following(META(), dataFrame(`${ESC}[2;3HHELLO`));
  await f.start();
  await settle();
  const view = f.lines({ height: 6, width: 40 });
  assert.match(view[1], /^ {2}HELLO/, `the pane did not draw the screen: ${JSON.stringify(view)}`);
});

test("A TRUNCATED REPLAY IS NOT DRAWN, because it may be confidently wrong", async () => {
  // The rule review insisted on. A picture reconstructed from a suffix is coherent-looking and
  // possibly WRONG -- the bytes that fell off carried cursor moves and SGR state the survivors cannot
  // recover -- so the pane says what it is waiting for instead of drawing it.
  const f = following(META({ truncated: true }), dataFrame(`${ESC}[2;3HSUSPECT`));
  await f.start();
  await settle();
  const waiting = f.lines({ height: 6, width: 60 }).join(" ");
  assert.ok(!waiting.includes("SUSPECT"), `an untrusted screen was drawn: ${waiting}`);
  assert.match(waiting, /waiting for the first full repaint/);
  f.stop();
});

test("A FULL REPAINT RESCUES IT, which is what stops this being a permanent refusal", async () => {
  // TWO FOLLOWERS RATHER THAN ONE, because the repaint has to be ABSENT for the test above to mean
  // anything. My first version put both chunks on one stream and then asserted "not drawn" after the
  // whole stream had been read -- the repaint had already arrived, so the assertion was measuring a
  // state that no longer existed.
  //
  // Once a process throws its screen away and draws it again, whatever fell off the front stops
  // bearing on what is displayed. A coding agent repaints constantly, so the wait is seconds.
  // RIS (`ESC c`), NOT `ESC[2J`. This test used the latter until review proved it is not a full
  // reset: it erases the display and leaves SGR standing, so a conceal lost off the front of a
  // truncated replay comes back OFF and the reconstruction prints what the terminal hides.
  const f = following(META({ truncated: true }), dataFrame(`${ESC}[2;3HSUSPECT`),
    dataFrame(`${ESC}c${ESC}[1;1HTRUSTED`));
  await f.start();
  await settle();
  const drawn = f.lines({ height: 6, width: 60 }).join(" ");
  assert.match(drawn, /TRUSTED/, `a repaint did not rescue the screen: ${drawn}`);
  assert.ok(!drawn.includes("waiting"), "it still says it is waiting after a repaint arrived");
  f.stop();
});

test("A SPLIT RESET IS STILL SEEN, because a socket breaks wherever it likes", async () => {
  // `ESC c` is two bytes. A detector judging each chunk alone misses it delivered as `ESC` then `c`,
  // and the cost is a console that stays unsound for ever -- the harmless direction, and still a
  // screen the operator never gets.
  const f = following(META({ truncated: true }),
    dataFrame(`${ESC}[2;3HSUSPECT`), dataFrame(ESC), dataFrame(`c${ESC}[1;1HTRUSTED`));
  await f.start();
  await settle();
  const drawn = f.lines({ height: 6, width: 60 }).join(" ");
  assert.match(drawn, /TRUSTED/, `a reset split across frames was missed: ${drawn}`);
  f.stop();
});

test("THE SCREEN IS NOT CALLED SOUND BEFORE THE PARSER HAS APPLIED THE RESET", async () => {
  // `write` is asynchronous. Setting the flag when the BYTES arrive declares the screen trustworthy
  // while the buffer still holds the pre-reset picture -- review measured `lines()` publishing
  // pre-reset content as correct. The flag follows the write's COMPLETION instead.
  //
  // TWO EARLIER VERSIONS OF THIS TEST COULD NOT FAIL. The first called `f.screen.write()` directly,
  // bypassing the function under test. The second drove the real path but on an unpaused stream,
  // which is consumed before the emulator exists -- so every chunk took the "no screen yet" branch
  // and neither the correct nor the eager version ever set the flag during the window. This one
  // pauses the stream so the screen is already open when the reset arrives, which is the only
  // arrangement where the two behave differently.
  const f = followingSlowly(META({ truncated: true }), dataFrame(`${ESC}c${ESC}[1;1HAFTER`));
  await f.start();
  assert.ok(f.screen, "precondition: the screen was open before the reset arrived");
  assert.equal(f.repaintedSince, false,
    "the screen was declared sound while the reset was still in the parser's queue");

  await settle();
  assert.equal(f.repaintedSince, true, "the reset never took effect at all");
  f.stop();
});

test("A CHUNK IS JUDGED ONCE, or a replay can INVENT a reset that never arrived", async () => {
  // THE DANGEROUS DIRECTION of a double-judged carry. Bytes arriving before the emulator loads are
  // held and replayed, and if the verdict is recomputed on the way through, the carry left over from
  // the FIRST pass prefixes the first replayed chunk.
  //
  // Constructed here: a first chunk that STARTS with "c" (and paints, so the pane takes the screen
  // path at all), then a chunk that is a lone ESC. No reset in that order. After the first pass the
  // carry is ESC; recomputing on replay joins it to the leading "c" and reads `ESC c`, so the
  // follower would declare a TRUNCATED screen sound on the strength of a reset the process never
  // sent. Same class as the ED2 disclosure: a wrong screen shown as right.
  //
  // THE LEADING "c" AND THE CURSOR MOVE ARE BOTH LOAD-BEARING. Without the cursor move the buffer is
  // a log, the pane never consults the screen, and the test measures nothing -- which is how my first
  // version of it failed against correct code.
  const f = following(META({ truncated: true }), dataFrame(`c${ESC}[1;1Hx`), dataFrame(ESC));
  await f.start();
  await settle();
  assert.equal(f.repaintedSince, false,
    "a reset was invented by re-judging replayed chunks against a stale carry");
  const waiting = f.lines({ height: 6, width: 60 }).join(" ");
  assert.match(waiting, /waiting for the first full repaint/,
    "the pane published a truncated screen as trustworthy");
  f.stop();
});

test("A TRUNCATED SUFFIX IS REFUSED EVEN WHEN IT LOOKS LIKE A LOG", async () => {
  // THE DISCLOSURE THAT SURVIVED THE FIRST BASELINE FIX. The gate lived inside `isPainting()`, so a
  // retained suffix containing no cursor commands read as an ordinary log and the pane printed it
  // RAW -- past the conceal handling and past the baseline. Reproduced by review: `ESC[8m` lost off
  // the front, `SYNTHETIC_HIDDEN` in the surviving bytes, and the pane showed the secret.
  //
  // Absence of cursor commands says nothing about whether the bytes are a log: the SGR state that
  // governs them fell off the front with everything else.
  const f = following(META({ truncated: true }), dataFrame("SYNTHETIC_HIDDEN"));
  await f.start();
  await settle();
  assert.equal(f.buffer.isPainting(), false, "precondition: this suffix reads as a log");
  const shown = f.lines({ height: 6, width: 60 }).join(" ");
  assert.ok(!shown.includes("SYNTHETIC_HIDDEN"), `the pane disclosed it: ${shown}`);
  assert.match(shown, /waiting for the first full repaint/);
  f.stop();
});

test("A TRUNCATED REPLAY IS REFUSED WITH NO SCREEN AT ALL, which is the case without an emulator", async () => {
  // THE VERDICT HAS TO TRAVEL INDEPENDENTLY OF THE EMULATOR. It was originally built only when a
  // screen existed, so a stream with no screen fell through to the raw log -- and there are two ways
  // to have no screen: the optional package is not installed, or the process is PIPED and has no
  // geometry to emulate. This drives the second, which is reachable on every machine.
  //
  // A piped process still emits SGR, and a truncated suffix still has an unknown SGR state, so the
  // reasoning that refuses a terminal's suffix refuses this one too.
  const f = following(META({ cols: 0, rows: 0, truncated: true }), dataFrame("SYNTHETIC_HIDDEN"));
  await f.start();
  await settle();
  assert.equal(f.screen, null, "precondition: no emulator was built for a piped process");
  const shown = f.lines({ height: 6, width: 60 }).join(" ");
  assert.ok(!shown.includes("SYNTHETIC_HIDDEN"), `the pane disclosed it with no screen: ${shown}`);
  assert.match(shown, /waiting/);
  f.stop();
});

test("UNKNOWN METADATA REFUSES TOO, and this reverses a call I made", async () => {
  // I let a stream with NO `meta` keep the raw path, reasoning that a daemon older than this feature
  // should degrade rather than go blank, and asked review to check that asymmetry. It answered with
  // the witness that settles it: the complete-history oracle CONCEALS the synthetic token and the
  // no-meta follower PRINTED it. Compatibility is not a reason to disclose.
  //
  // AND TWO OF THE THREE ARMS WERE NOT OLD DAEMONS AT ALL. A `meta` frame carrying `null` or an array
  // is rejected as unreadable by the parser, which leaves `meta` null -- so MALFORMED metadata took
  // the same permissive path as an absent one.
  for (const [label, frames] of [
    ["no meta at all", [dataFrame("SYNTHETIC_HIDDEN")]],
    ["meta null", [namedFrame("meta", null), dataFrame("SYNTHETIC_HIDDEN")]],
    ["meta as an array", [namedFrame("meta", [1, 2]), dataFrame("SYNTHETIC_HIDDEN")]],
    ["meta as a string", [namedFrame("meta", "80x24"), dataFrame("SYNTHETIC_HIDDEN")]],
  ]) {
    const f = following(...frames);
    await f.start();
    await settle();
    const shown = f.lines({ height: 6, width: 60 }).join(" ");
    assert.ok(!shown.includes("SYNTHETIC_HIDDEN"), `${label} disclosed it: ${shown}`);
    f.stop();
  }
});

test("NEGATIVE CONTROL: a COMPLETE log is still shown, or the fix has removed the feature", async () => {
  // The refusal above is only correct because it is narrow. A complete history has lost nothing, so
  // its bytes mean what they say and the pane prints them.
  const f = following(META({ truncated: false }), dataFrame("ordinary complete log"));
  await f.start();
  await settle();
  assert.match(f.lines({ height: 6, width: 60 }).join(" "), /ordinary complete log/);
  f.stop();
});

test("NEGATIVE CONTROL: a piped process with a complete history still shows its output", async () => {
  // No terminal, no screen, nothing lost -- the case the line buffer models correctly and always has.
  const f = following(META({ cols: 0, rows: 0, truncated: false }), dataFrame("piped output"));
  await f.start();
  await settle();
  assert.equal(f.screen, null, "an emulator was built for something with no terminal");
  assert.match(f.lines({ height: 6, width: 60 }).join(" "), /piped output/);
  f.stop();
});

test("A LATER meta RESIZES THE SCREEN, so the reconstruction follows the producer", async () => {
  // The consumer half of the same finding. `ScreenEmulator.resize` HAD NO PRODUCTION CALLER until
  // this path existed -- a method nothing invokes is a claim the code does not make -- and without it
  // a screen built at 132 columns keeps wrapping every row at 132 after the pty moves to 80.
  const f = following(
    META({ cols: 132, rows: 40 }),
    dataFrame(`${ESC}[1;1Hbefore`),
    namedFrame("meta", { cols: 80, rows: 24, truncated: false, replayBytes: 65536 }),
    dataFrame(`${ESC}[2;1Hafter`),
  );
  await f.start();
  await settle();
  assert.ok(f.screen, "no screen was built");
  assert.equal(f.screen.term.cols, 80, "the screen kept the geometry it was born with");
  assert.equal(f.screen.term.rows, 24);
  assert.equal(f.meta.cols, 80, "the follower kept the old meta");
  f.stop();
});

test("A RESIZE AFTER THE SCREEN EXISTS ALSO FOLLOWS, which is the ordinary case", async () => {
  // THE TEST ABOVE COULD NOT FAIL ON THIS PATH. Its second `meta` arrives while the emulator is still
  // loading, so the screen is born at the latest geometry and the resize branch never runs -- a
  // mutation removing that branch survived. A PAUSED stream puts the screen in place first, which is
  // what happens on a real console: the pane has been open for a while and then the window changes.
  const f = followingSlowly(
    META({ cols: 132, rows: 40 }),
    dataFrame(`${ESC}[1;1Hbefore`),
    namedFrame("meta", { cols: 80, rows: 24, truncated: false, replayBytes: 65536 }),
  );
  await f.start();
  await settle();
  assert.equal(f.screen.term.cols, 80, "a screen that already existed kept its old width");
  assert.equal(f.screen.term.rows, 24);
  f.stop();
});

test("NEGATIVE CONTROL: a meta that repeats the SAME size does not disturb the screen", async () => {
  // Resizing an emulator reflows its buffer. Doing it for an unchanged size would reflow a screen
  // for no reason, which on a busy console is a visible flicker with no cause.
  const f = following(
    META({ cols: 100, rows: 30 }),
    dataFrame(`${ESC}[1;1Hkept`),
    namedFrame("meta", { cols: 100, rows: 30, truncated: false, replayBytes: 65536 }),
  );
  await f.start();
  await settle();
  assert.match(f.screen.rows()[0], /^kept/, "an identical meta disturbed the screen");
  f.stop();
});

test("A RESIZE CANNOT OVERTAKE OUTPUT ALREADY QUEUED, on either arm", async () => {
  // REVIEW'S WITNESS, and it is the sharpest kind: an ORACLE rather than an expectation. `write` is
  // asynchronous and `resize` was not, so a resize issued while a write sat in the parser's queue
  // applied ahead of it. At 80 columns write `ESC[1;61HOLD`, resize to 40, write again -- a correctly
  // ordered terminal leaves row 1 blank, and the follower left an `O` at column 40.
  //
  // TWO ARMS, because they fail for different reasons: with the emulator already loaded the resize
  // jumps a queued write; during the import the backlog held only TEXT, so the replay painted old
  // bytes at the newest width. The second is why the pending queue carries resizes as events.
  const oracle = await ScreenEmulator.create({ cols: 80, rows: 4 });
  assert.ok(oracle, "@xterm/headless is absent, so this comparison cannot run");
  await oracle.write(`${ESC}[1;61HOLD`);
  oracle.resize({ cols: 40, rows: 4 });
  await oracle.write(`${ESC}[2;1HNEW`);
  const want = oracle.rows()[0];
  oracle.dispose();
  assert.equal(want.trim(), "", "the oracle is not blank, so this test is measuring the wrong thing");

  for (const [label, build] of [
    ["import-time backlog", following],
    ["screen already loaded", followingSlowly],
  ]) {
    const f = build(
      META({ cols: 80, rows: 4 }),
      dataFrame(`${ESC}[1;61HOLD`),
      namedFrame("meta", { cols: 40, rows: 4, truncated: false, replayBytes: 65536 }),
      dataFrame(`${ESC}[2;1HNEW`),
    );
    await f.start();
    await settle();
    assert.equal(f.screen.rows()[0], want, `${label}: a resize overtook queued output`);
    assert.match(f.screen.rows()[1], /^NEW/, `${label}: the later write did not land`);
    f.stop();
  }
});

test("STOP DISPOSES THE SCREEN, so it cannot outlive its pane", async () => {
  const f = following(META());
  await f.start();
  await settle();
  const screen = f.screen;
  assert.ok(screen, "precondition: a screen exists");

  f.stop();
  assert.equal(f.screen, null, "the follower still holds a screen after stop()");
  assert.equal(screen.disposed, true, "the screen was dropped without being disposed");
  assert.deepEqual(screen.rows(), [], "a disposed screen still reported rows");
});

test("A SCREEN STILL LOADING WHEN THE PANE CLOSES IS DISPOSED ON ARRIVAL", async () => {
  // NOT AN EDGE CASE. An operator can hide a pane inside the same second they opened it, and the
  // import resolves afterwards either way. Without this the screen is stored into a stopped follower
  // and nothing ever disposes it -- a leak reachable by pressing `p` twice.
  const f = following(META());
  const running = f.start();
  f.stop();                 // before the import can resolve
  await running;
  await settle();
  assert.equal(f.screen, null, "a screen was stored into a stopped follower");
});

test("stop() is safe twice, and a follower that never built a screen stops cleanly", () => {
  const f = following();
  assert.doesNotThrow(() => { f.stop(); f.stop(); });
  assert.equal(f.screen, null);
});

console.log("the-screen-lives-and-dies-with-its-pane.test.js: all assertions passed");
