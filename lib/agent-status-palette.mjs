// One colour per agent status: the dashboard's own, in the terminal's eight.
//
// THE OPERATOR, 2026-09-28: "are all statuses in sync, like same colors everywhere? otherwise it is
// confusing". The dashboard paints a status with its `.status-dot.<kind>` rule
// (aify-comms service/new_dashboard/styles.css); this is the same hue on a terminal. aify-comms'
// `status-colours-match-aify-env.test.mjs` reads this table and that stylesheet and fails when a hue
// here is not the one the dashboard shows, so the two cannot drift apart quietly.
//
// THE HUES ARE RESERVED. A hue that means a status here must not also mean "selected" or "an id"
// elsewhere on the same screen, or the reader takes one for the other: a cyan selected row read as
// an agent running a shell.

export const AGENT_STATUS_HUES = Object.freeze({
  working: "yellow",
  starting: "yellow",
  shell: "cyan",
  online: "green",
  available: "blue",
  blocked: "red",
  offline: "grey",
  stopped: "grey",
  misconfigured: "grey",
});

/** aify-env's own words that the dashboard says differently: a live agent at its prompt is `online` there. */
const DASHBOARD_WORDS = Object.freeze({ idle: "online" });

/** The word the dashboard shows for a status, so this terminal and the dashboard name one state alike. */
export function dashboardWord(status) {
  const word = String(status ?? "").trim().toLowerCase();
  return DASHBOARD_WORDS[word] ?? word;
}

/** The hue for a status, or "" for one this table does not know: painted plainly, never guessed. */
export function hueOf(status) {
  return AGENT_STATUS_HUES[dashboardWord(status)] ?? "";
}
