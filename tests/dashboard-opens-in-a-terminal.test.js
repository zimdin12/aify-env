// Running `aify-env` in a terminal opens the view; piping it does not.
//
// Operator request, 2026-08-24: "when I run aify-env command then it should open tui in terminal".
// The daemon still starts -- that is what the command means and what the unknown-subcommand guard
// warns about -- and now the terminal that started it shows what it is doing instead of two lines.
//
// TESTED THROUGH A REAL PTY, because the whole behaviour keys on `process.stdout.isTTY` and faking
// that from the outside tests nothing. The pipe case matters just as much: a service manager or a log
// file must keep the plain banner, since screen-clearing escapes in a log are noise and the banner is
// what those readers parse.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { freePort } from "./_free-port.mjs";
import { sealedHomeEnv } from "./_sealed-daemon-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "bin", "aify-env.mjs");
const ESC = String.fromCharCode(27);
const CLEAR = `${ESC}[2J`;

// The free-port helper and the whole reason for it live in `_free-port.mjs`, shared with the
// supersession and takeover tests, which hit the SAME defect from the other direction: they used
// 8884 and 8885 in two files that `node --test` runs in parallel.

function tempRecord(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aify-${label}-`));
  // NEVER the default record: a test instance reading the real one would reap the operator's
  // processes at startup. That is not hypothetical in this fleet.
  return path.join(dir, "owned.json");
}

function sealedEnv(record, port) {
  return sealedHomeEnv({
    ...process.env,
    AIFY_ENV_PROCESS_RECORD: record,
    // Point the view at a registry that does not exist, so this test never depends on -- or reads --
    // whatever services the host really has registered.
    AIFY_SERVICE_REGISTRY: path.join(path.dirname(record), "no-such-registry.json"),
    AIFY_TUI_REFRESH_MS: "300",
    AIFY_ENV_PORT: String(port),
  });
}

// WAIT FOR WHAT IS ASSERTED, NOT FOR A FIXED TIME. A fixed 2.5 s failed under full-suite load with nothing but
// ConPTY's own preamble captured (`\x1b[?9001h\x1b[?1004h`, 2026-10-25): the daemon had not yet printed its banner.
// A presence waits up to BOOT_MS; an absence is judged over QUIET_MS after the banner, five view refreshes.
const BOOT_MS = 30_000;
const QUIET_MS = 1_500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `seen()` is true, or after `ms`; the caller's assertion then says which. */
async function until(seen, ms = BOOT_MS) {
  const deadline = Date.now() + ms;
  while (!seen() && Date.now() < deadline) await sleep(50);
}

function collector(child) {
  const got = { out: "" };
  child.stdout?.on("data", (chunk) => { got.out += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { got.out += chunk.toString(); });
  return got;
}

const plainOf = (out) => out.split(ESC).join("");

test("piped output keeps the plain banner and prints no escapes", async () => {
  const record = tempRecord("pipe");
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY, "--port", String(port)], {
    env: sealedEnv(record, port), stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const got = collector(child);
    await until(() => /aify-env .* listening on/.test(got.out));
    await sleep(QUIET_MS);
    const out = got.out;
    assert.match(out, /aify-env .* listening on/, `no banner: ${out}`);
    assert.ok(!out.includes(CLEAR), "a screen-clearing escape reached a pipe");
    assert.ok(!/PROCESSES/.test(out), "the view opened on a non-terminal");
  } finally {
    child.kill();
  }
});

test("a terminal gets the view", async (t) => {
  let pty;
  try {
    pty = await import("node-pty");
  } catch {
    // Same honesty rule the rest of this suite follows: unverified must not read as verified.
    t.skip("node-pty is not installed, so no real terminal is available to test with");
    return;
  }
  const record = tempRecord("tty");
  const port = await freePort();
  const child = pty.spawn(process.execPath, [ENTRY, "--port", String(port)], {
    name: "xterm-color", cols: 120, rows: 40, cwd: ROOT, env: sealedEnv(record, port),
  });
  let out = "";
  child.onData((data) => { out += data; });
  try {
    await until(() => out.includes(CLEAR) && ["SERVICES", "PROCESSES", "TRAFFIC"].every((word) => plainOf(out).includes(word)));
    assert.ok(out.includes(CLEAR), `the view never drew a frame: ${JSON.stringify(out.slice(0, 200))}`);
    const plain = out.split(ESC).join("");
    assert.match(plain, /SERVICES/);
    assert.match(plain, /PROCESSES/);
    // No AGENTS section: asking a service for its agent list was reverted on the operator's ruling
    // that it is not this environment's concern. What the view says about running work is PROCESSES,
    // which aify-env started and therefore knows.
    assert.ok(!/AGENTS/.test(plain), "the view is asking a service for its domain data again");
    assert.match(plain, /TRAFFIC/);
  } finally {
    child.kill();
  }
});

test("AIFY_NO_DASHBOARD keeps a terminal on the plain banner", async (t) => {
  let pty;
  try {
    pty = await import("node-pty");
  } catch {
    t.skip("node-pty is not installed");
    return;
  }
  const record = tempRecord("nodash");
  const port = await freePort();
  const child = pty.spawn(process.execPath, [ENTRY, "--port", String(port)], {
    name: "xterm-color", cols: 120, rows: 40, cwd: ROOT,
    env: { ...sealedEnv(record, port), AIFY_NO_DASHBOARD: "1" },
  });
  let out = "";
  child.onData((data) => { out += data; });
  try {
    await until(() => /listening on/.test(plainOf(out)));
    await sleep(QUIET_MS);
    const plain = plainOf(out);
    assert.match(plain, /listening on/);
    // Asserted on the view's CONTENT, not on the absence of a screen-clear escape. ConPTY emits its
    // own escapes when a terminal is allocated, so "no escapes" is not evidence about this program --
    // the first version of this test asserted exactly that and failed against a working opt-out.
    assert.ok(!/PROCESSES/.test(plain), "the opt-out did not stop the view");
    assert.ok(!/TRAFFIC/.test(plain), "the opt-out did not stop the view");
  } finally {
    child.kill();
  }
});
