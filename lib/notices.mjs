// What the daemon has to say, held for the view instead of thrown at the screen.
//
// THE DEFECT THIS EXISTS FOR, reported by the operator 2026-09-04 from their own terminal. The
// plugin log sink wrote to stderr (`bin/aify-env.mjs`: `log: (m) => process.stderr.write(...)`)
// while `dashboard.mjs` wrote frames to stdout. Both land on one terminal, and `frameUpdate` is a
// DIFFERENTIAL writer -- it repaints only the rows that changed, addressed by cursor position. A
// stray line shifts every row below it, so the writer's idea of the screen stops matching the
// screen, and subsequent frames paint into the wrong places. What the operator saw was three
// `terminal ... output not delivered: fetch failed` lines wedged between the header, the SERVICES
// table and the PROCESSES heading, with the layout coming apart around them.
//
// SILENCING THEM WOULD BE THE WRONG FIX. "output not delivered: fetch failed" is the environment
// saying it could not hand a running agent's console to the service -- exactly the kind of thing a
// dashboard exists to show. So the messages are kept and rendered as a section; the view is the
// right destination for them, and stderr was only ever the default one.
//
// BOUNDED, because this runs for the life of the daemon. A ring of the last `limit` is enough for a
// glance panel, and the alternative is a leak that grows with every failed fetch -- which is
// precisely the condition that produces them fastest.
//
// COUNTED, NOT JUST KEPT. A repeated message is collapsed to one row carrying `count`, because the
// failure that matters here repeats every poll: fifty identical rows would push everything else off
// the screen and say no more than one row plus a number.

/** Wall-clock is injected for the same reason the renderer takes `nowMs`: a clock inside makes a test flaky. */
export function createNotices({ limit = 20, now = () => Date.now() } = {}) {
  const entries = [];

  return {
    /** Record one message. Repeats of the newest entry bump its count rather than adding a row. */
    add(message) {
      const text = String(message ?? "").trim();
      if (!text) return;
      const at = now();
      const newest = entries[entries.length - 1];
      if (newest && newest.text === text) {
        newest.count += 1;
        newest.atMs = at;
        return;
      }
      entries.push({ text, count: 1, atMs: at });
      while (entries.length > limit) entries.shift();
    },

    /** Newest last, as stored. The renderer decides its own order. */
    recent() {
      return entries.map((e) => ({ ...e }));
    },

    /** For the caller that has to decide whether a section is worth drawing at all. */
    get size() {
      return entries.length;
    },
  };
}
