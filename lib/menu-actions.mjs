// The actions menu's vocabulary, and which of its actions need a yes (0.9.8, moved verbatim out of lib/keys.mjs).
//
// ITS OWN MODULE because the view (lib/tui-panes/processes.mjs) and the router both read it, and what a menu may
// offer is a decision about stopping workers, not about keys.

/**
 * The full action vocabulary, in the order a menu shows them.
 *
 * WHAT A MENU ACTUALLY OFFERS IS A SUBSET, chosen by the caller, and that is honesty rather than
 * courtesy. `aify-env` can stop a process it owns; it cannot RESTART a managed agent, because
 * respawning one is the service's business and this tier has no primitive for it. A menu listing
 * `restart` anyway would be a control that does nothing -- the same defect this codebase keeps
 * finding from the other end, where a field has no reader.
 *
 * So the caller declares what it can perform and the view offers that. An entrypoint that wires no
 * executor offers only `attach`, which it can always do.
 */
export const MENU_ACTIONS = Object.freeze(["attach", "restart", "stop"]);

/** The actions this focus offers, defaulting to attach alone -- the one nothing has to wire. */
export function menuActionsIn(state) {
  const declared = Array.isArray(state?.menuActions) ? state.menuActions : null;
  const usable = (declared ?? []).filter((name) => MENU_ACTIONS.includes(name));
  return usable.length ? usable : ["attach"];
}

//: The ones that need a yes before they happen. Derived from a property -- "does this end work the
//: operator cannot get back" -- rather than listed twice, so adding a destructive action to the menu
//: above cannot quietly skip the confirmation.
const DESTRUCTIVE = Object.freeze(new Set(["restart", "stop"]));

/** Whether choosing this action must be confirmed before it is reported. */
export function needsConfirming(action) {
  return DESTRUCTIVE.has(String(action || ""));
}
