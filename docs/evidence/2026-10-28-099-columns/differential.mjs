// 0.9.9 item 6, judged by its frames: every frame the view drew before the new columns is drawn byte for byte the same
// after them. The OLD lib/ (a git ref, extracted whole) and the NEW one (the working tree) each render the same
// snapshots under the same layouts, widths, colour and keyboard; any difference is printed. Plus a negative control in
// the same run: a layout naming a new column must differ, or this could not see a difference at all.
//
//   node differential.mjs <repo> <old-ref>
//
// Exit 0 when old and new agree on every case and the control differs; 1 otherwise.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, oldRef] = process.argv.slice(2);
if (!repo || !oldRef) { console.error("usage: node differential.mjs <repo> <old-ref>"); process.exit(64); }

const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aify-099-columns-old-"));
const archive = path.join(oldRoot, "lib.tar");
fs.writeFileSync(archive, execFileSync("git", ["-C", repo, "archive", oldRef, "lib"], { maxBuffer: 64 * 1024 * 1024 }));
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
const proc = (n, label, extra = {}) => ({ id: `1f15df98-7d5e-4f24-92fe-51ddd4a3a24e-p${n}`, pid: 4000 + n, label, service: "aify-comms",
  terminal: n % 2 === 1, uptimeMs: n * 600_000, title: `${label} at work on something long enough to be clipped somewhere`,
  lastOutputAtMs: NOW - n * 1000, ...extra });
const record = (agentId, state, extra = {}) => ({ agentId, state, lifetime: `l-${agentId}`, role: "coder",
  launch: { cwd: `C:/w/${agentId}` }, ...extra });
const SNAPSHOTS = {
  busy: {
    version: "0.9.8", build: "abc", endpoint: "http://127.0.0.1:8802", nowMs: NOW, answered: true,
    terminals: { available: true, reason: "" }, services: [{ name: "aify-comms", endpoint: "http://x", state: "ok", detail: "healthy" }],
    checks: [{ name: "service", state: "ok", detail: "healthy" }, { name: "claude-login", state: "fail", detail: "never set up" }],
    history: { startedTotal: 5, lastExitAtMs: NOW - 90_000, recentExits: [{ id: "p9", label: "gone", atMs: NOW - 90_000, code: 1 }] },
    traffic: { requests: 12, bytesOut: 4096 },
    processes: [proc(1, "alpha"), proc(2, "bravo"), proc(3, "charlie"), proc(4, "delta")],
    agentRecords: {
      alpha: record("alpha", "working", { stateCause: "turn-open", turn: { open: true, startedAtUs: us(12) } }),
      bravo: record("bravo", "blocked", { stateCause: "folder-trust", turn: { open: false, lastEventAtUs: us(3) } }),
      charlie: record("charlie", "idle", { stateCause: "at-prompt", turn: { open: false, lastEventAtUs: us(75) } }),
      echo: record("echo", "stopped", { lifetime: null, stateCause: "operator-stop" }),
    },
    unknown: [],
  },
  idle: { version: "0.9.8", endpoint: "http://127.0.0.1:8802", nowMs: NOW, answered: true, terminals: { available: false, reason: "no conpty" },
    services: [], checks: [], history: { startedTotal: 0, lastExitAtMs: null }, traffic: {}, processes: [], agentRecords: {}, unknown: [] },
};
const LAYOUTS = {
  default: null,
  extended: JSON.stringify({ extended: true }),
  attention: JSON.stringify({ sort: "attention" }),
  "hand-picked old columns": JSON.stringify({ columns: { agents: { normal: ["#", "status-word", "agent", "up", "title"] } } }),
  "collapsed and reordered": JSON.stringify({ panes: ["agents", "health"], collapsed: ["health"], hidden: ["traffic"] }),
};
const KEYS = { off: { enabled: false, canQuit: false }, on: { enabled: true, canQuit: true } };
const viewOf = (snapshot) => ({ rows: snapshot.processes, selected: 1, mode: "dashboard", query: "", paneHidden: true });

const frame = (side, snapshot, layoutText, keys, columns, color) => side.render(snapshot, {
  columns, color, keys, view: keys.enabled ? viewOf(snapshot) : undefined, layout: side.layoutFrom(layoutText),
}).join("\n");

let cases = 0;
let differing = 0;
for (const [sName, snapshot] of Object.entries(SNAPSHOTS)) {
  for (const [lName, layoutText] of Object.entries(LAYOUTS)) {
    for (const [kName, keys] of Object.entries(KEYS)) {
      for (const columns of [60, 100, 160, 220]) {
        for (const color of [false, true]) {
          cases += 1;
          const a = frame(before, snapshot, layoutText, keys, columns, color);
          const b = frame(after, snapshot, layoutText, keys, columns, color);
          if (a !== b) {
            differing += 1;
            console.log(`DIFFERS: ${sName} / ${lName} / keys ${kName} / ${columns} columns / colour ${color}`);
          }
        }
      }
    }
  }
}
const chosen = JSON.stringify({ columns: { agents: { normal: ["agent", "role", "cwd", "age", "cause"] } } });
const control = frame(before, SNAPSHOTS.busy, chosen, KEYS.on, 160, false) !== frame(after, SNAPSHOTS.busy, chosen, KEYS.on, 160, false);
console.log(`${cases} cases, ${differing} differ; NEGATIVE CONTROL (a layout naming the new columns) differs: ${control}`);
fs.rmSync(oldRoot, { recursive: true, force: true });
process.exit(differing === 0 && control ? 0 : 1);
