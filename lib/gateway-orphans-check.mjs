// The `gateway-orphans` row: hermes gateways on this host that no agent lifetime records.
//
// MOVED HERE FROM `aify-comms doctor` in 0.9.10, with the records it judges against. A gateway is
// `hermes dashboard --port <P>` on a port in aify-env's range (lib/hermes-gateway-ports.mjs); its launcher
// registers its pid in the book (lib/hermes-gateway-book.mjs). One the book does not hold belongs to no running
// lifetime: it keeps its port and, on Windows, hermes' native files locked (on 2026-08-31 an operator's
// `hermes update` refused to run, listing 45 such processes).
//
// A GATEWAY IS RECORDED WHEN A RECORDED PID IS IT OR AN ANCESTOR: on Windows `hermes` is a launcher that serves
// from a child carrying the same command line.
//
// READ-ONLY: it names pids and kills nothing. ponytail: an elevated gateway whose command line cannot be read is
// not seen; comms' row resolved those through the listening sockets, add that when one is met here.

import { failed, passed, unanswered } from './health.mjs';
import { PORT_BASE, PORT_SPAN } from './hermes-gateway-ports.mjs';

const GATEWAY_ORPHANS = 'gateway-orphans';
const ANCESTRY = 8;

/** The port a hermes gateway serves, or null when this command line is not one. PURE. */
export function gatewayPort(commandLine) {
  const line = String(commandLine || '');
  if (!/hermes/i.test(line) || !/\bdashboard\b/.test(line)) return null;
  const match = line.match(/--port[\s=]+(\d{1,5})\b/);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port >= PORT_BASE && port < PORT_BASE + PORT_SPAN ? port : null;
}

/**
 * Gateways in aify-env's range that no record's pid is, or is an ancestor of. PURE.
 * @param {{processes: {pid: number, ppid: number, commandLine: string}[], records: {record: {pid: number}}[]}} input
 * @returns {{pid: number, port: number}[]}
 */
export function gatewayOrphans({ processes, records }) {
  const recorded = new Set(records.map(({ record }) => record.pid).filter((pid) => pid > 0));
  const parentOf = new Map(processes.map((p) => [p.pid, p.ppid]));
  const isRecorded = (pid) => {
    for (let at = pid, hops = 0; at > 0 && hops <= ANCESTRY; at = parentOf.get(at) ?? 0, hops += 1) {
      if (recorded.has(at)) return true;
    }
    return false;
  };
  return processes
    .map((p) => ({ pid: p.pid, port: gatewayPort(p.commandLine) }))
    .filter(({ pid, port }) => port !== null && !isRecorded(pid));
}

/**
 * @param {{listProcesses: () => object[], records: () => object[]}} deps
 * @returns {object} the row
 */
export function gatewayOrphansCheck({ listProcesses, records }) {
  let processes;
  try { processes = listProcesses(); } catch (error) {
    return unanswered(GATEWAY_ORPHANS, `this host's process table could not be read: ${error?.message || error}`);
  }
  const orphans = gatewayOrphans({ processes, records: records() });
  if (!orphans.length) return passed(GATEWAY_ORPHANS, 'every hermes gateway in the agent port range belongs to a recorded agent lifetime');
  return failed(GATEWAY_ORPHANS,
    `${orphans.length} hermes gateway(s) belong to no agent lifetime: ${orphans.map(({ pid, port }) => `pid ${pid} on port ${port}`).join(', ')}`,
    'each serves no running agent and holds its port and hermes\' files: end the listed pids');
}
