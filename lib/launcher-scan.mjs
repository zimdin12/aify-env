// Which files on PATH could be aify launchers, and what they contain.
//
// THE ANSWER FEEDS THE ADVERTISEMENT. `installedHarnesses` reads the marker inside each of these
// files to decide which runtimes this host can actually run, and that list is what every registered
// service is told. So a scan that quietly returns nothing does not fail -- it advertises a host with
// no runtimes, and spawns are routed elsewhere with nothing anywhere saying why.
//
// READING A DIRECTORY IS NOT RUNNING ANYTHING IN IT, and that distinction is load-bearing. Deciding
// what a launcher is by ASKING it would start a coding-agent runtime: a pre-contract wrapper
// forwards `--check` to the runtime it wraps. That is how a fleet went down once already.
//
// EXTRACTED FROM `bin/aify-env.mjs` SO IT CAN FAIL A TEST. Inside that file it was unreachable --
// importing it STARTS a daemon that supersedes the operator's and reaps its managed workers -- so
// every rule below was a comment nothing could execute. It also took that file past the 1000-line
// gate, and this is the subject that leaves rather than whichever block was longest: "what is on
// PATH" is a filesystem question with no daemon state in it at all.
//
// THE NAME IS DELIBERATELY NOT `launcherCandidates`. `lib/launcher-resolve.mjs` already exports one
// of those and it answers a different question -- given a COMMAND, which file would run. This
// answers "what is out there". Two functions with one name in one package is a reader picking the
// wrong import and getting a plausible empty list.

import { readdirSync, readFileSync } from "node:fs";

//: What a launcher's filename must contain. Every wrapper this project renders is `<runtime>-aify`,
//: so this is a cheap pre-filter before the expensive part. The MARKER inside the file is still what
//: decides -- reading every executable on PATH to find that out would be a great deal of I/O for one
//: answer, and this cuts the population to a handful without deciding anything.
const LAUNCHER_NAME_HINT = "-aify";

/**
 * Every file on PATH whose name could be an aify launcher, with its text.
 *
 * @param {{env?: object, platform?: string, readdir?: Function, readFile?: Function}} deps
 *   injected so a test drives the whole walk without a PATH full of real launchers
 * @returns {Array<{file: string, text: string}>} in PATH order, each file once
 */
export function aifyLauncherFilesOnPath({
  env = process.env,
  platform = process.platform,
  readdir = readdirSync,
  readFile = readFileSync,
} = {}) {
  const separator = platform === "win32" ? ";" : ":";
  const entries = [];
  const seen = new Set();
  for (const dir of String(env.PATH || "").split(separator).map((d) => d.trim()).filter(Boolean)) {
    let names = [];
    try {
      names = readdir(dir);
    } catch {
      // One unreadable directory must not make the rest of PATH unsearchable. A permission error on
      // a single entry is ordinary; losing every launcher after it is not.
      continue;
    }
    for (const name of names) {
      const file = `${dir}/${name}`;
      // ONE ENTRY PER FILE, keyed on the full path. The same directory appearing twice on PATH is
      // ordinary, and a duplicate here would be counted twice by whatever reads the markers.
      if (seen.has(file)) continue;
      seen.add(file);
      if (!String(name).includes(LAUNCHER_NAME_HINT)) continue;
      try {
        entries.push({ file, text: readFile(file, "utf8") });
      } catch {
        // FAILS CLOSED: unread is ABSENT, never present. A file this cannot read says nothing about
        // which runtimes exist, and inventing an entry with empty text would let a marker test read
        // it as a launcher that declares nothing.
      }
    }
  }
  return entries;
}
