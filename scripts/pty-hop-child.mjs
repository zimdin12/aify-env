// The thing on the other end of the PTY, for `measure-pty-hop.mjs`. It is a stand-in for an agent.
//
// A LINE PROTOCOL, and the response token is NEVER the request token. A Windows ConPTY echoes what
// the parent writes back down the same stream the child's output arrives on, so a probe that looked
// for the token it had just sent would find its own echo and time the console's line discipline
// instead of this process. Every reply is wrapped in tildes the parent never writes.
//
//   E <token>          echo once, immediately: a round trip with no work in the middle
//   P <token> <size>   write a pre-built painted frame of that size, terminated by the token
//   Q                  exit 0
//
// PAYLOADS ARE BUILT AT BOOT, not per request, so the timed span is a write and a read rather than
// this process generating bytes. The recipe is the one `measure-xterm-write.mjs` and
// `measure-pane-render.mjs` use, so the arms are the same workload rather than three workloads with
// the same name.

const ESC = String.fromCharCode(27);
const SIZES = [1024, 16 * 1024, 64 * 1024];

function paintedBytes(targetChars) {
  const parts = [];
  let size = 0;
  let row = 1;
  while (size < targetChars) {
    const line = `${ESC}[${row};1H${ESC}[38;5;${(row % 200) + 16}m`
      + `row ${row} of a full-screen redraw with some content on it${ESC}[0m`;
    parts.push(line);
    size += line.length;
    row = (row % 200) + 1;
  }
  return parts.join("");
}

const PAYLOADS = new Map(SIZES.map((size) => [String(size), paintedBytes(size)]));

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index = pending.indexOf("\n");
  while (index !== -1) {
    handle(pending.slice(0, index).replace("\r", "").trim());
    pending = pending.slice(index + 1);
    index = pending.indexOf("\n");
  }
});

function handle(line) {
  if (!line) return;
  const [verb, token, size] = line.split(" ");
  if (verb === "Q") { process.exit(0); return; }
  if (verb === "E") {
    process.stdout.write(`${ESC}[1;1H~${token}~${ESC}[0m`);
    return;
  }
  if (verb === "P") {
    const payload = PAYLOADS.get(String(size));
    // AN UNKNOWN SIZE IS SAID, NOT GUESSED. Answering with the nearest payload would give the parent
    // a plausible number for a workload it did not ask for.
    if (!payload) { process.stdout.write(`${ESC}[1;1H~unknown-size-${size}~`); return; }
    process.stdout.write(payload + `${ESC}[40;1H~${token}~${ESC}[0m`);
  }
}
