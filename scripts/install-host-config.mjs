#!/usr/bin/env node
// Write the host's transport default into `~/.aify/config.json` at install time — once.
//
// ONCE, AND NEVER OVER AN ANSWER. An operator who switched the local socket off did so on purpose,
// and an installer that "restores the default" on every update is an installer that overrules them
// silently. So a key that is already present is left exactly as it is, and only a MISSING key is
// written. The same rule the service registry follows for entries it does not own.
//
// AND IT MERGES. Another tier may own keys in this file; the whole file is preserved and one value
// is set. Rewriting it wholesale would delete what the next tier wrote.
//
// FAILING TO WRITE IS NOT FAILING TO INSTALL. The default lives in the code (lib/host-config.mjs), so
// a host with no file behaves identically to one with `localSocket: true`. This exists to make the
// setting DISCOVERABLE -- an operator can open the file and see what there is to change.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { HOST_SETTINGS, hostConfigPath, withHostSetting } from "../lib/host-config.mjs";

const home = process.env.USERPROFILE || process.env.HOME || "";
const file = hostConfigPath(home);

let text = null;
try { text = readFileSync(file, "utf8"); } catch { text = null; }

let parsed = null;
try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
const existing = parsed?.transport?.localSocket;

if (typeof existing === "boolean") {
  process.stdout.write(`[aify-env] ${file}: transport.localSocket is already ${existing}; left alone\n`);
  process.exit(0);
}

try {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, withHostSetting(text, "localSocket", HOST_SETTINGS.localSocket.default), "utf8");
  process.stdout.write(`[aify-env] ${file}: transport.localSocket = ${HOST_SETTINGS.localSocket.default}\n`);
} catch (error) {
  // Not fatal, on purpose: the default is in the code either way.
  process.stdout.write(`[aify-env] could not write ${file} (${error?.message ?? error}); the default still applies\n`);
}
