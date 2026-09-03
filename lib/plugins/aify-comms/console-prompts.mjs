// The one console prompt a freshly-launched claude worker cannot get past on its own.
//
// WHAT IT IS. `claude-aify` launches claude with `--dangerously-load-development-channels
// server:aify-comms-channel`, which is how the channel that delivers dispatches is loaded at all.
// Claude answers that with a first-run acknowledgment menu:
//
//     ❯ 1. I am using this for local development
//       2. Exit
//     Enter to confirm · Esc to cancel
//
// and waits. The worker boots, registers `online`, never starts its in-process MCP, and never claims
// a dispatched run. "Up but deaf" — measured on the operator's fleet on 2026-07-03 and again on
// 2026-09-03, when a probe sat at this menu while every status field read healthy.
//
// THE aify-comms BRIDGE ANSWERED IT and this host did not, which is the whole reason it is here.
// That rule (`dev-channels-accept` in `mcp/stdio/claude-console-prompts.js`) is proven: it is why
// managed claude workers came up at all before hosting moved. When the bridge started the process it
// read the console and answered; when aify-env started it, nothing did.
//
// WHY A SECOND, SMALLER IMPLEMENTATION RATHER THAN THE MODULE ITSELF. That module carries eight
// rules, a resume-menu interlock and a cursor-move calculator, all of it aify-comms' model of a
// claude screen. Copying it into another repo is the duplication this whole split exists to end.
// What is copied here is ONE rule, deliberately the least clever one: a first-run acknowledgment
// whose default option is already the accepting one, so the answer is a bare Enter and there is no
// cursor arithmetic to get wrong.
//
// EVERYTHING ELSE IS LEFT ALONE, ON PURPOSE. A resume menu's highlighted default is "Resume from
// summary", so a stray Enter there silently compacts a session — that incident is written into the
// bridge's own comments, and it is why this refuses to answer anything but the one dialog it can
// identify by its own question line.

/** The acknowledgment's own question line. Matching the FLAG name instead would fire on ordinary
 *  boot output: the worker's command line contains `--dangerously-load-development-channels`, and it
 *  sits in the buffer at exactly the moment other menus render. The bridge learned that by silently
 *  compacting sessions on every cold start. */
const ACCEPT_LINE = /I am using this for local development/i;

/** The dialog's own chrome. A second gate rather than a cursor calculation: the phrase above could
 *  in principle appear in prose a worker printed, but not beside this. */
const CONFIRM_CHROME = /Enter to confirm/i;

/** A menu cursor, so the answer is only sent when the accepting option is the SELECTED one. */
const CURSOR = /[❯›▶]/;

/** Never answer anything while a resume menu is the live thing on screen. Its default destroys a
 *  session's context, and no rule here is clever enough to be trusted near it. */
const RESUME_MENU = /Resume (?:from summary|full session)/i;

/** How much of the tail to consider. The prompt is the LIVE thing on screen; a match anywhere in a
 *  large scrollback is a match on history. aify-comms has a standing bug of exactly this shape
 *  (`_terminal_prompt_hint_from_raw` scanning 64 KB), and it is not worth importing. */
export const PROMPT_TAIL_BYTES = 4000;

/**
 * Should this host press Enter for the worker?
 *
 * PURE, and answers only about the acknowledgment above. Returns the bytes to write, or "" for
 * every other screen — which is the overwhelmingly common case and must stay cheap.
 *
 * @param {string} tail recent console output
 * @returns {string} "" or the answer to write
 */
export function answerForConsole(tail) {
  const text = String(tail ?? "");
  if (!text) return "";
  const recent = text.length > PROMPT_TAIL_BYTES ? text.slice(-PROMPT_TAIL_BYTES) : text;

  if (!ACCEPT_LINE.test(recent) || !CONFIRM_CHROME.test(recent)) return "";
  // A resume menu LATER in the stream than this dialog means the menu is the live one. Compared by
  // position rather than by presence, because the buffer accumulates and answered menus linger.
  const dialogAt = lastIndexOf(recent, ACCEPT_LINE);
  const menuAt = lastIndexOf(recent, RESUME_MENU);
  if (menuAt > dialogAt) return "";

  // THE CURSOR MUST BE ON THE ACCEPTING LINE. Without this the answer is a blind Enter, which is
  // how a rule in the bridge once selected whatever a different menu had highlighted.
  const lines = recent.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!CURSOR.test(lines[i])) continue;
    return ACCEPT_LINE.test(lines[i]) ? String.fromCharCode(13) : "";
  }
  return "";
}

/** Index of the LAST match, or -1. Latest-wins, because the console tail accumulates. */
function lastIndexOf(text, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let at = -1;
  let match;
  while ((match = global.exec(text)) !== null) {
    at = match.index;
    if (global.lastIndex === match.index) global.lastIndex += 1;
  }
  return at;
}

/**
 * A per-terminal answering machine.
 *
 * ONCE PER TERMINAL, AND THAT IS NOT AN OPTIMISATION. `comms_console_input`'s own documentation
 * records the measurement: a repeated Enter into a stuck claude draft was tried five times, every
 * call reported success, and nothing ever submitted. A loop that keeps pressing Enter at a screen
 * it cannot change is indistinguishable from one that is working, and it types into whatever
 * replaces that screen.
 *
 * So: at most one answer per terminal, ever. If it did not work, the console tail says so and a
 * person decides — which is what the bridge's own tooling tells its callers to do.
 */
export function createPromptAnswerer({ write, log = () => {} } = {}) {
  const answered = new Set();
  //: The tail is rebuilt per terminal because output arrives in chunks that split lines anywhere --
  //: a menu can easily land across two writes, and a matcher fed one chunk at a time would see
  //: neither half. Bounded, so a long-running console cannot grow this without limit.
  const tails = new Map();

  return {
    /** Feed one chunk. Returns true when it answered, so a caller can log or count it. */
    observe(terminalId, chunk) {
      const id = String(terminalId || "");
      if (!id || answered.has(id)) return false;
      const next = (tails.get(id) || "") + String(chunk ?? "");
      tails.set(id, next.length > PROMPT_TAIL_BYTES ? next.slice(-PROMPT_TAIL_BYTES) : next);

      const answer = answerForConsole(tails.get(id));
      if (!answer) return false;
      answered.add(id);
      tails.delete(id);
      try {
        write(id, answer);
        log(
          `answered the development-channels acknowledgment for terminal ${id}. Without it the `
          + "worker boots, registers online, and never claims a dispatch.",
        );
      } catch (error) {
        // A failed write is worth saying and not worth throwing: this runs inside an output
        // listener, and taking that down would stop the console stream the operator reads.
        log(`could not answer the console prompt for terminal ${id}: ${error?.message || error}`);
      }
      return true;
    },
    /** A terminal that ended keeps nothing. Ids are recycled per instance. */
    forget(terminalId) {
      const id = String(terminalId || "");
      answered.delete(id);
      tails.delete(id);
    },
  };
}
