// Each pane's name and the key that collapses or expands it in the pane menu (`c`, 0.9.6).
//
// ITS OWN MODULE so the key router (lib/keys.mjs) can read it without importing the panes, which import the router:
// lib/tui-panes/index.mjs holds the same names in the same order, and a test holds the two equal.
//
// A LETTER EACH, and only in the pane menu: there `s` is SERVICES, not start, because the menu takes every key until it
// is closed, as the actions menu does.

export const PANE_KEYS = Object.freeze({ services: "s", health: "h", agents: "a", roster: "r", exits: "x", notices: "n", traffic: "t" });
