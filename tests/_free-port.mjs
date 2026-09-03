// A port the operating system says is free, asked for fresh per test.
//
// WHY, measured 2026-09-03. These tests bound daemons to hardcoded ports in the 8876-8894 range, and
// the comment beside them guarded the wrong thing: "a port nothing else in this SUITE uses". Two
// things were wrong with that.
//
// FIRST, THE HOST. An unrelated program of the operator's -- `sand_castle.exe` -- was listening on
// 127.0.0.1:8894. The daemon could not bind, printed nothing, and
// `dashboard-opens-in-a-terminal.test.js` failed with `no banner:` and an empty string, in the
// middle of an unrelated change in another repo. That reads exactly like a code regression. A fixed
// port asserts something about the whole machine that a test has no way to know.
//
// SECOND, THE SUITE ITSELF, which the comment actually claimed. `a-second-start-supersedes-the-
// first.test.js` and `a-takeover-says-what-it-would-cost.test.js` BOTH used 8884 and 8885, and
// `node --test` runs files in parallel (concurrency defaults to the core count; this machine has
// 32). So the guarantee the comment asserted was already false when it was written, in the one
// dimension it was about.
//
// A TEST THAT NEEDS TWO DAEMONS ON ONE PORT CALLS THIS ONCE. Supersession and takeover are tested by
// contending for a single port on purpose; handing each daemon its own free one would leave those
// tests passing while testing nothing. That is why this returns a port rather than wrapping the
// spawn.
//
// THE WINDOW BETWEEN CLOSING THE PROBE AND THE DAEMON BINDING IS REAL and is not worth removing:
// the alternative is handing the daemon a listening socket, which is not how it starts. A port the
// OS just called free is enormously more likely to be free than one chosen in 2026-08.

import net from "node:net";

/** @returns {Promise<number>} a port that was free a moment ago on 127.0.0.1 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
