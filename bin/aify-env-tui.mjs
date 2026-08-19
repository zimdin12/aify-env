#!/usr/bin/env node
// A live view of this environment.
//
// It asks the running daemon and the registry and renders what it was told. It computes nothing about
// agents, because the renderer it feeds refuses to display that and aify-env has no business deciding
// it — alive is not working.
//
//   aify-env-tui           refresh until interrupted
//   aify-env-tui --once    render one frame and exit (what a script or a test wants)
//
// If the daemon is not answering it says so and keeps trying, rather than exiting: the common reason to
// have this open is watching for the moment something comes back.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readServices, probeService } from "../lib/services.mjs";
import { renderDashboard } from "../lib/tui.mjs";

const args = process.argv.slice(2);
const once = args.includes("--once");

const REGISTRY_PATH = process.env.AIFY_SERVICE_REGISTRY || join(homedir(), ".aify", "services.json");
const ENDPOINT = process.env.AIFY_ENV_ENDPOINT || "http://127.0.0.1:8801";
const REFRESH_MS = Number(process.env.AIFY_TUI_REFRESH_MS || 2000);
const PROBE_TIMEOUT_MS = Number(process.env.AIFY_PROBE_TIMEOUT_MS || 1500);

async function knock(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "timed out" : (error.cause?.code ?? error.message) };
  }
}

function registryText() {
  try {
    return readFileSync(REGISTRY_PATH, "utf8");
  } catch {
    // Absent or unreadable both mean "cannot list services here". The doctor is where that distinction
    // is drawn; a view drawing it too would be a second opinion.
    return "";
  }
}

async function snapshot() {
  const env = await knock(`${ENDPOINT}/health`);
  const services = [];
  for (const service of readServices(registryText())) {
    const check = probeService(service, await knock(`${service.endpoint}/health`));
    services.push({ ...service, state: check.state, detail: check.detail });
  }

  return {
    version: env.ok ? env.body?.version ?? "?" : "?",
    endpoint: env.ok ? ENDPOINT : `${ENDPOINT} (not answering: ${env.error})`,
    terminals: env.ok
      ? { available: Boolean(env.body?.terminals), reason: "reported by the environment" }
      : { available: false, reason: "no environment answered" },
    services,
    processes: env.ok && Array.isArray(env.body?.processes) ? env.body.processes : [],
    unknown: env.ok && Array.isArray(env.body?.unknown) ? env.body.unknown : [],
    traffic: env.ok && env.body?.traffic ? env.body.traffic : { requests: 0, bytesOut: 0 },
  };
}

async function frame() {
  const lines = renderDashboard(await snapshot());
  if (!once) process.stdout.write("[2J[H");
  process.stdout.write(`${lines.join("\n")}\n`);
}

await frame();
if (!once) {
  const timer = setInterval(() => { frame().catch(() => {}); }, REFRESH_MS);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      clearInterval(timer);
      process.exit(0);
    });
  }
}
