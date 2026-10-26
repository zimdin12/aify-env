// Which port an agent's hermes gateway listens on (0.9.10: the gateway host moved here from the comms bridge).
//
// THE SAME RULE comms' bridge used (mcp/stdio/hermes-endpoint.js `agentPort` / `resolveGatewayPort`), so an agent's
// gateway keeps its port across the move: a hash of the agent id picks the start of an 8642-9641 range, the agent's
// previous port is kept unless another agent holds it, and otherwise the first free port from the start that no other
// agent holds is taken. Two ids can hash to one port ("comms-senior-dev" and "graph-hermes-tl" both hashed to 9341,
// 2026-05-31), so a hash alone is never the answer.
//
// What changed is where the previous ports are kept: the gateway book's records (lib/hermes-gateway-book.mjs), not one
// TEMP file per agent.

export const PORT_BASE = 8642;
export const PORT_SPAN = 1000;
/** Ports inside the range another tier listens on: the comms service (8800), Dashboard Next (8801), aify-env (8802). */
export const RESERVED_PORTS = new Set([8800, 8801, 8802]);
const PROBE_SPAN = 64;
export const NO_FREE_PORT = 'NO_FREE_GATEWAY_PORT';

/** PURE. FNV-1a 32-bit: deterministic, and it spreads agent ids across the range. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** PURE. Where an agent's search starts: its hash in the range, stepping past a reserved port. */
export function hashedPort(agentId) {
  const offset = fnv1a(agentId) % PORT_SPAN;
  for (let i = 0; i < PORT_SPAN; i += 1) {
    const port = PORT_BASE + ((offset + i) % PORT_SPAN);
    if (!RESERVED_PORTS.has(port)) return port;
  }
  return PORT_BASE + offset;
}

const inRange = (port) => Number.isInteger(port) && port >= PORT_BASE && port < PORT_BASE + PORT_SPAN;

/**
 * The agent's gateway port. `previous` is the port its record holds, `others` the ports other agents' records hold,
 * `isFree(port)` whether nothing listens there. The previous port is kept when it is free: the book ends the agent's own
 * gateway before it asks, so whatever still listens there is something it declined to kill (review of 85cbd1a).
 * @param {{agentId: string, previous?: number|null, others?: Iterable<number>, isFree: (port: number) => Promise<boolean>}} input
 * @returns {Promise<number>}
 */
export async function choosePort({ agentId, previous = null, others = [], isFree }) {
  const held = new Set(others);
  if (inRange(previous) && !held.has(previous) && await isFree(previous)) return previous;
  const start = hashedPort(agentId);
  for (let i = 0; i < PROBE_SPAN; i += 1) {
    const candidate = PORT_BASE + (((start - PORT_BASE) + i) % PORT_SPAN);
    if (RESERVED_PORTS.has(candidate) || held.has(candidate)) continue;
    if (await isFree(candidate)) return candidate;
  }
  // Refused rather than answered with a port known to be busy (review of e7e0956).
  throw Object.assign(new Error(`no free gateway port in ${PROBE_SPAN} from ${start}`), { code: NO_FREE_PORT });
}
