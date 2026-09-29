// Which viewer a service control speaks for, when it types into or resizes a terminal.
//
// ONLY THE DASHBOARD'S OWN SURFACES ARE THE DASHBOARD. A control carries `requestedBy`, and aify-comms
// names its console surfaces `dashboard-console` (keystrokes and the console's own resizes),
// `dashboard-attach` (the size a console opens at) and `dashboard-refresh` (the Refresh repaint).
// Everything else that types is not a viewer at all: the resume-menu auto-answer writes as
// `console-prompt`, and an agent's console input writes under the agent's own id. Treating those as the
// dashboard made an auto-answer snap the PTY back to the size of a dashboard console opened once,
// scrambling the Herdr pane the viewer rule exists to protect (external review, 2026-09-29).
//
// BARE `dashboard` IS NOT A SURFACE. A chat message the operator sends, a Compact, and any input whose
// caller named nobody all reach the host as `dashboard` (aify-comms defaults an unnamed requester to
// it), and none of them is a screen. Counted as the viewer, each one resized the terminal to the last
// dashboard console's size (review of 0.7.6, ST1).
//
// A RULE, NOT A LIST: any `dashboard-` surface, so a new console surface is covered without an edit
// here. Everything else is the unnamed viewer, whose keystrokes never resize (terminal-size-owner.mjs).

/** Every dashboard console tab is one viewer: controls carry no tab identity. */
export const DASHBOARD_VIEWER = "dashboard";

/** The viewer `control` acts as: DASHBOARD_VIEWER for a dashboard surface, "" for anything else. */
export function viewerOfControl(control) {
  const who = String(control?.requestedBy ?? "").trim();
  return who.startsWith(`${DASHBOARD_VIEWER}-`) ? DASHBOARD_VIEWER : "";
}
