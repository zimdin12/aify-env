// 0.9.9 item 4, judged by its frames: adding the DETAIL pane changes every frame the view drew before by exactly one
// line, its collapsed heading, and nothing else. The OLD lib/ (a git ref, extracted whole) and the NEW one (the working
// tree) render the same snapshots under the same layouts, widths, heights, colour and keyboard. Each new frame, with
// its one `▸ DETAIL` line taken out, must equal the old frame; a frame with no keyboard must equal it outright.
//
//   node differential.mjs <repo> <old-ref>
//
// A HEIGHT-LIMITED FRAME is reported apart: there the heading costs a row, and what gives way for it is printed, so
// the cost is seen rather than assumed. A negative control in the same run: an OPENED detail pane must differ by more.
// Exit 0 when every unlimited frame differs by exactly the heading and the control differs; 1 otherwise.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, oldRef] = process.argv.slice(2);
if (!repo || !oldRef) { console.error("usage: node differential.mjs <repo> <old-ref>"); process.exit(64); }

const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-099-detail-old-"));
fs.writeFileSync(path.join(oldRoot, "lib.tar"), execFileSync("git", ["-C", repo, "archive", oldRef, "lib"], { maxBuffer: 64 * 1024 * 1024 }));
// Relative names, from inside the folder: GNU tar reads `C:...` as a remote host.
execFileSync("tar", ["-xf", "lib.tar"], { cwd: oldRoot });

const load = async (root) => ({
  render: (await import(pathToFileURL(path.join(root, "lib", "tui.mjs")).href)).renderDashboard,
  layoutFrom: (await import(pathToFileURL(path.join(root, "lib", "tui-layout.mjs")).href)).layoutFrom,
});
const before = await load(oldRoot);
const after = await load(repo);

const NOW = 10_000_000;
const us = (minutesAgo) => (NOW - minutesAgo * 60_000) * 1000;
const proc = (n, label) => ({ id: `1f15df98-p${n}`, pid: 4000 + n, label, service: "aify-comms", terminal: true,
  uptimeMs: n * 600_000, title: `${label} at work on something long enough to be clipped somewhere`, lastOutputAtMs: NOW - n * 1000 });
const SNAPSHOT = {
  version: "0.9.8", build: "abc", endpoint: "http://127.0.0.1:8802", nowMs: NOW, answered: true,
  terminals: { available: true, reason: "" }, services: [{ name: "aify-comms", endpoint: "http://x", state: "ok", detail: "healthy" }],
  checks: [{ name: "service", state: "ok", detail: "healthy" }],
  history: { startedTotal: 5, lastExitAtMs: NOW - 90_000, recentExits: [{ id: "p9", label: "gone", atMs: NOW - 90_000, code: 1 }] },
  traffic: { requests: 12, bytesOut: 4096 },
  processes: [proc(1, "alpha"), proc(2, "bravo"), proc(3, "charlie")],
  agentRecords: {
    alpha: { agentId: "alpha", state: "working", lifetime: "l1", stateCause: "turn-open", turn: { open: true, startedAtUs: us(12) } },
    bravo: { agentId: "bravo", state: "blocked", lifetime: "l2", stateCause: "folder-trust", turn: { open: false, lastEventAtUs: us(3) } },
  },
  definitions: { alpha: { harness: "claude", model: "opus", effort: "high" } },
};
const LAYOUTS = {
  default: null,
  extended: JSON.stringify({ extended: true }),
  "old file with collapsed": JSON.stringify({ collapsed: ["health"], hidden: ["traffic"] }),
  "agents collapsed": JSON.stringify({ collapsed: ["agents"] }),
};
const KEYS = { off: { enabled: false, canQuit: false }, on: { enabled: true, canQuit: true } };
const view = (selected) => ({ rows: SNAPSHOT.processes, selected, mode: "dashboard", query: "", paneHidden: true });

const frame = (side, layoutText, keys, columns, rows, color, selected) => side.render(SNAPSHOT, {
  columns, rows, color, keys, view: keys.enabled ? view(selected) : undefined, layout: side.layoutFrom(layoutText),
});
const isHeading = (line) => /^(\u001b\[[0-9;]*m)*▸(\u001b\[[0-9;]*m)* (\u001b\[[0-9;]*m)*DETAIL/.test(line);

let cases = 0;
let wrong = 0;
const limited = new Map();
for (const [lName, layoutText] of Object.entries(LAYOUTS)) {
  for (const [kName, keys] of Object.entries(KEYS)) {
    for (const columns of [60, 100, 160]) {
      for (const rows of [0, 24]) {
        for (const color of [false, true]) {
          for (const selected of [0, 1, 2]) {
            cases += 1;
            const a = frame(before, layoutText, keys, columns, rows, color, selected);
            const b = frame(after, layoutText, keys, columns, rows, color, selected);
            const headings = b.filter(isHeading);
            const rest = b.filter((line) => !isHeading(line));
            const label = `${lName} / keys ${kName} / ${columns}x${rows || "unlimited"} / colour ${color} / row ${selected}`;
            const expectHeadings = keys.enabled ? 1 : 0;
            if (rows) {
              // The heading may have given way here (renderDashboard's fitting pass); what is left must be the old frame.
              if (headings.length > expectHeadings) { wrong += 1; console.log(`WRONG HEADING COUNT ${headings.length}: ${label}`); }
              if (rest.join("\n") !== a.join("\n")) limited.set(label, a.filter((line) => !rest.includes(line)));
              continue;
            }
            if (headings.length !== expectHeadings || rest.join("\n") !== a.join("\n")) {
              wrong += 1;
              console.log(`DIFFERS BEYOND THE HEADING: ${label}`);
            }
          }
        }
      }
    }
  }
}
const opened = JSON.stringify({ expanded: ["detail"] });
const openedB = frame(after, opened, KEYS.on, 100, 0, false, 0).filter((line) => !isHeading(line));
const control = openedB.join("\n") !== frame(before, opened, KEYS.on, 100, 0, false, 0).join("\n");
console.log(`${cases} cases; ${wrong} wrong; height-limited frames where a line gave way for the heading: ${limited.size}`);
const kinds = new Map();
for (const lines of limited.values()) for (const line of lines) kinds.set(line.replace(/\u001b\[[0-9;]*m/g, "").trim(), (kinds.get(line) ?? 0) + 1);
for (const [line] of kinds) console.log(`  gave way: ${JSON.stringify(line)}`);
console.log(`NEGATIVE CONTROL (DETAIL opened differs by more than its heading): ${control}`);
fs.rmSync(oldRoot, { recursive: true, force: true });
process.exit(wrong === 0 && control ? 0 : 1);
