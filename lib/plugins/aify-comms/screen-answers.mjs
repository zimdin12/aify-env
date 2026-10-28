// Dialogs a managed claude cannot get past on its own, answered by this host, each one switchable.
//
// FOLDER TRUST, THE FIRST ONE (2026-10-28). Claude asks "Is this a project you created or one you trust?" the first
// time it starts in a folder with no trusted ancestor, and a managed worker sat at it with its brief queued until the
// service gave the brief up. Two of them did on 2026-10-28 and the operator approved each by hand.
//
// ANSWERED ON THE SCREEN, NOT WRITTEN AHEAD INTO ~/.claude.json. Claude records the answer itself
// (`projects[<folder>].hasTrustDialogAccepted`), so nothing here writes a file every running claude rewrites: on this
// host about twenty of them read-modify-write those 124 KB, and a write from outside them is one lost update away
// from vanishing. aify-comms' console_prompts.py once called this dialog state to write; that was decided before the
// size of the fleet writing it was a fact (design approved by comms-tech-lead, 2026-10-28).
//
// THE CURSOR STARTS ON "No, exit", so a bare Enter EXITS the worker. Measured on claude 2.1.312:
//
//    ❯ No, exit
//      Yes, I trust this folder
//
//    Enter to confirm · Esc to cancel
//
// The answer is therefore two steps, each taken only on what the screen shows NOW: the cursor on "No, exit" gets one
// DOWN, the cursor on "Yes, I trust this folder" gets one ENTER. Each step is taken at most once per terminal, so a
// DOWN that did not move the cursor is never repeated into a menu that wraps, and a dialog that will not go away is
// left on screen for the state word to show rather than typed at for ever.
//
// ONLY THE WHOLE DIALOG, AT THE BOTTOM. The two rows must be adjacent and the last drawn thing must be the key hint, so
// a transcript that quotes this dialog above a live prompt box is not a dialog. A reworded row matches nothing and
// types nothing: the worker waits at the dialog, as it did before this existed.
//
// SWITCHABLE in ~/.aify/config.json, `plugins["aify-comms"].autoConfirm`, one boolean per answer below. A missing file,
// section or key means on; a section that cannot be read, or a value that is not a boolean, means OFF, because a guard
// that types into a terminal fails closed. The keys are the answers' own names, so a new answer is configurable
// without an edit, and an unknown key is reported rather than ignored. Read only while a dialog is showing, and on
// every such read, so an edit reaches a running host without a restart.
//
// IN THE PLUGIN, because what a claude screen means is aify-comms' knowledge (the 2026-09-14 boundary that also put
// screen-rules.mjs here). The host core still only offers screen text and a write.

const ESC = String.fromCharCode(27);
export const DOWN = `${ESC}[B`;
export const ENTER = "\r";

// A menu row as claude draws it: indentation, at most a box border, at most a cursor, then the label.
const ROW = /^\s*(?:│\s*)?([❯›▶])?\s*(.*?)\s*│?$/u;
const KEY_HINT = /^\s*(?:│\s*)?Enter to confirm/u;

function menuRow(line) {
  const match = ROW.exec(line);
  return { cursor: Boolean(match?.[1]), label: match?.[2] ?? "" };
}

/**
 * PURE. The next step through claude's folder-trust dialog, or null when the screen does not end in that dialog.
 *
 * @param {string} screen  screen text, rows joined by newlines (screen-rules.mjs `screenText`)
 * @returns {{step: "leave-no"|"accept-yes", keys: string}|null}
 */
export function folderTrustAnswer(screen) {
  const lines = String(screen ?? "").split("\n").map((line) => line.trimEnd());
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.length || !KEY_HINT.test(lines.at(-1))) return null;
  let last = lines.length - 2;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last < 1) return null;
  const no = menuRow(lines[last - 1]);
  const yes = menuRow(lines[last]);
  if (no.label !== "No, exit" || yes.label !== "Yes, I trust this folder" || no.cursor === yes.cursor) return null;
  return no.cursor ? { step: "leave-no", keys: DOWN } : { step: "accept-yes", keys: ENTER };
}

/** Every answer this host can give, by its configuration key. */
export const ANSWERS = Object.freeze({ folderTrust: folderTrustAnswer });

/**
 * PURE. Which answers are on, from a plugin config read (lib/plugin-config.mjs), and what is wrong with it.
 *
 * @param {{config: object|null, problem: string, absent?: boolean}|null} read
 * @returns {{on: Record<string, boolean>, problems: string[]}}
 */
export function autoConfirmSettings(read) {
  const all = (value) => Object.fromEntries(Object.keys(ANSWERS).map((key) => [key, value]));
  if (!read || (read.config === null && read.absent !== true)) {
    return { on: all(false), problems: [read?.problem || "no configuration was read, so nothing is answered"] };
  }
  const section = read.config?.autoConfirm;
  if (section === undefined) return { on: all(true), problems: [] };
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { on: all(false), problems: ['plugins["aify-comms"].autoConfirm is not an object, so nothing is answered'] };
  }
  const problems = Object.keys(section).filter((key) => !Object.hasOwn(ANSWERS, key))
    .map((key) => `autoConfirm.${key} is not an answer this host gives (it gives: ${Object.keys(ANSWERS).join(", ")})`);
  const on = {};
  for (const key of Object.keys(ANSWERS)) {
    const value = section[key];
    if (value === undefined || typeof value === "boolean") on[key] = value !== false;
    else {
      on[key] = false;
      problems.push(`autoConfirm.${key} is not true or false, so it is off`);
    }
  }
  return { on, problems };
}

/** Answers for every terminal this plugin carries. One per plugin; one watcher per terminal. */
export class ScreenAnswers {
  #config;
  #write;
  #log;

  /**
   * @param {object} deps
   * @param {() => object} deps.config  this plugin's config read, as the plugin factory is given it
   * @param {(handle: string, keys: string) => {ok: boolean, error?: string}} deps.write  the runner's write
   * @param {(message: string) => void} [deps.log]
   */
  constructor({ config, write, log = () => {} }) {
    this.#config = typeof config === "function" ? config : () => null;
    this.#write = write;
    this.#log = log;
  }

  /** The function a terminal's screen observer calls with each screen it reads. */
  forTerminal(terminalId, handle) {
    const taken = new Set();
    return (screen) => {
      for (const [key, answer] of Object.entries(ANSWERS)) {
        const found = answer(screen);
        if (!found || taken.has(`${key}:${found.step}`)) continue;
        if (!autoConfirmSettings(this.#config()).on[key]) continue;
        taken.add(`${key}:${found.step}`);
        const written = this.#write(handle, found.keys);
        this.#say(written?.ok === false
          ? `terminal ${terminalId}: could not answer ${key} (${found.step}): ${written.error}`
          : `terminal ${terminalId}: answered ${key} (${found.step})`);
        return;
      }
    };
  }

  #say(message) {
    try { this.#log(message); } catch { /* a failing logger must not undo an answer already typed */ }
  }
}
