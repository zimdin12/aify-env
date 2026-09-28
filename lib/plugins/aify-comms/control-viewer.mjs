// Which viewer a service control speaks for, when it types into or resizes a terminal.
//
// ONLY THE DASHBOARD'S OWN SURFACES ARE THE DASHBOARD. A control carries `requestedBy`, and aify-comms
// names its console surfaces `dashboard` (keystrokes), `dashboard-attach` (the size a console opens
// at) and `dashboard-refresh` (the Refresh repaint). Everything else that types is not a viewer at all:
// the resume-menu auto-answer writes as `console-prompt`, and an agent's console input writes under the
// agent's own id. Treating those as the dashboard made an auto-answer snap the PTY back to the size of
// a dashboard console opened once, scrambling the Herdr pane the viewer rule exists to protect
// (external review, 2026-09-29).
//
// A RULE, NOT A LIST: `dashboard` or any `dashboard-` surface, so a new console surface is covered
// without an edit here. Everything else is the unnamed viewer, whose keystrokes never resize
// (terminal-size-owner.mjs).

/** Every dashboard console tab is one viewer: controls carry no tab identity. */
export const DASHBOARD_VIEWER = "dashboard";

/** The viewer `control` acts as: DASHBOARD_VIEWER for a dashboard surface, "" for anything else. */
export function viewerOfControl(control) {
  const who = String(control?.requestedBy ?? "").trim();
  return who === DASHBOARD_VIEWER || who.startsWith(`${DASHBOARD_VIEWER}-`) ? DASHBOARD_VIEWER : "";
}
