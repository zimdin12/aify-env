// Which process an operator means when they say `aify-env attach sc-lead`.
//
// THEY THINK IN AGENT NAMES, not in `f07a10b2-f95f-4f56-82aa-6d63912bcf63-p1`. The id is what the
// protocol uses and what the TUI shows; the label is what the person typed, and requiring the id
// would make the command unusable for the case it exists for -- looking at a lane that is misbehaving,
// right now, without first running a second command to find its handle.
//
// AN AMBIGUOUS NAME IS REFUSED, never guessed. Two processes can carry one label: a restart that
// overlapped, or a host running the same agent for two services. Picking one would attach the
// operator's keyboard to a process they did not choose, and everything they typed would go to it --
// the one failure here that writes rather than reads. Refusing costs them one more word.
//
// PURE, so the choosing can be tested without a daemon, a socket or a terminal. The bin resolves the
// list and hands it here; nothing in this file knows how a process is reached.

/** A process this can actually be addressed by. An entry with no id is not a target: the client
 *  would POST to `/processes//input`, which is a different route or a 404 -- and neither is the
 *  operator's keystroke reaching their agent. Its own test caught this: a malformed listing entry
 *  carrying only a label resolved to `{ id: "" }`, which reads as success everywhere downstream. */
const addressable = (entry) => String(entry?.id ?? "").trim() !== "";

/** An exact id always wins: it is unambiguous by construction and is what a script would pass. */
function byId(processes, wanted) {
  return processes.filter((entry) => addressable(entry) && String(entry.id) === wanted);
}

/** Then the label, which is what a person types. Case-insensitive: agent ids are lowercase by
 *  convention and an operator typing `SC-Lead` means the same lane. */
function byLabel(processes, wanted) {
  const needle = wanted.toLowerCase();
  return processes.filter((entry) => addressable(entry)
    && String(entry.label ?? "").toLowerCase() === needle);
}

/**
 * @param {object[]} processes as `/health` or `/processes` reports them
 * @param {string} wanted an id or a label
 * @returns {{id: string} | {error: string, fix?: string}}
 */
export function resolveAttachTarget(processes, wanted) {
  const list = Array.isArray(processes) ? processes : [];
  const name = String(wanted ?? "").trim();

  if (!name) {
    // NAMING THE CANDIDATES IS THE WHOLE ANSWER for someone who does not know what is running --
    // which is most of the reason to reach for this command at all.
    const running = list.map((entry) => String(entry?.label || entry?.id || "")).filter(Boolean);
    return {
      error: running.length
        ? `attach needs an agent or a process id. Running here: ${running.join(", ")}`
        : "attach needs an agent or a process id, and this environment is running nothing",
    };
  }

  const exact = byId(list, name);
  if (exact.length === 1) return { id: String(exact[0].id) };

  const labelled = byLabel(list, name);
  if (labelled.length === 1) return { id: String(labelled[0].id) };

  if (labelled.length > 1) {
    return {
      error: `"${name}" names ${labelled.length} processes here`,
      fix: `Attach by id instead: ${labelled.map((entry) => String(entry.id)).join(", ")}`,
    };
  }

  const running = list.map((entry) => String(entry?.label || entry?.id || "")).filter(Boolean);
  return {
    error: running.length
      ? `nothing here is called "${name}". Running: ${running.join(", ")}`
      : `nothing here is called "${name}", and this environment is running nothing`,
  };
}
