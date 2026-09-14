// What a runtime's screen says it is doing: working, idle or blocked.
//
// HERDR'S RULES, HERDR'S ENGINE, THIS HOST'S SCREEN. Herdr (herdrdev/herdr, Apache-2.0) publishes a
// manifest of screen rules per coding-agent runtime and evaluates them against each pane; its pane
// dot is the most accurate status an operator here has. The manifests are vendored as JSON beside
// this file (`agent-detection/`, provenance and NOTICE there) and this module is a port of the
// evaluation in src/detect/manifest.rs at v0.9.0: rules in manifest order, a match replaces the pick
// only on a strictly higher priority, no match on a known runtime is idle with no visible flag.
//
// IN THE PLUGIN, NOT THE HOST CORE. The boundary, as the operator amended it on 2026-09-14: aify-env's
// host core stays PTY-only -- it exposes screen text and PTY activity, never what a runtime's screen
// means (`lib/activity.mjs`) -- and a service's screen knowledge may live in that service's own plugin
// directory, because the plugin runs next to the authoritative screen. This is aify-comms' screen
// knowledge, so it lives here; the core offers only `screenText`.
//
// PURE. No clock, no I/O beyond loading the three JSON files once.
//
// KNOWN DIFFERENCES FROM HERDR, each small and each stated rather than hidden:
//   - The screen is the checkpoint's viewport only. Herdr's primary-screen window can reach back
//     into scrollback when the content ends above the bottom row; the checkpoint keeps none.
//   - Regex translation: Rust `\d` and `\b` are Unicode-aware, JavaScript's are ASCII. None of the
//     vendored patterns depends on a non-ASCII digit or word boundary.
//   - Lower-casing uses JavaScript's `toLowerCase`, which agrees with Rust's `to_lowercase` for
//     every needle in the vendored manifests.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MANIFESTS = ["claude", "codex", "hermes"].map((name) => require(`./agent-detection/${name}.json`));

const KNOWN_STATES = new Set(["idle", "working", "blocked", "unknown"]);
const MAX_TOP_REGION_LINE_COUNT = 65535;

/** The vendored manifest for a runtime name (its id or an alias), or null when there is none. */
export function manifestForRuntime(runtime) {
  const name = String(runtime ?? "").trim().toLowerCase();
  if (!name) return null;
  return MANIFESTS.find((m) => m.id === name || (m.aliases || []).includes(name)) || null;
}

/**
 * The text Herdr hands its rules, built from the screen's rows (pane/terminal.rs): each row with its
 * trailing whitespace trimmed, trailing blank rows dropped, joined by newlines and ended with one.
 */
export function screenText(rows) {
  const trimmed = (Array.isArray(rows) ? rows : []).map((row) => String(row ?? "").trimEnd());
  while (trimmed.length && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed.length ? `${trimmed.join("\n")}\n` : "";
}

/**
 * Evaluate a manifest against one screen.
 *
 * @param manifest  a vendored manifest (or any object of the same shape)
 * @param input     `{screen, title, progress}` -- screen text, the OSC 0/2 title, the OSC 9 payload
 * @returns {{state: string, rule: string|null, visibleIdle: boolean, visibleBlocker: boolean,
 *            visibleWorking: boolean, skipStateUpdate: boolean}}
 */
export function evaluateScreen(manifest, input = {}) {
  const compiled = compile(manifest);
  const regions = new Map();
  let picked = null;
  for (const entry of compiled) {
    let region = regions.get(entry.region);
    if (!region) {
      const text = regionText(input, entry.region);
      region = { text, lower: text.toLowerCase(), lines: null };
      regions.set(entry.region, region);
    }
    if (!gateMatches(entry.gate, region)) continue;
    if (picked && picked.priority >= entry.priority) continue;
    picked = entry;
  }
  if (!picked) {
    return { state: "idle", rule: null, visibleIdle: false, visibleBlocker: false, visibleWorking: false, skipStateUpdate: false };
  }
  const { state } = picked;
  return {
    state,
    rule: picked.id,
    visibleIdle: picked.visibleIdle && state === "idle",
    visibleBlocker: picked.visibleBlocker && state === "blocked",
    visibleWorking: picked.visibleWorking && state === "working",
    skipStateUpdate: picked.skipStateUpdate,
  };
}

// ── compiling ──────────────────────────────────────────────────────────────────────────────────

const compiledCache = new WeakMap();

function compile(manifest) {
  let compiled = compiledCache.get(manifest);
  if (compiled) return compiled;
  compiled = (manifest?.rules || []).map((rule) => {
    try {
      return {
        id: String(rule.id),
        state: KNOWN_STATES.has(rule.state) ? rule.state : "unknown",
        priority: Number(rule.priority) || 0,
        region: String(rule.region ?? "whole_recent").trim(),
        visibleIdle: rule.visible_idle === true,
        visibleBlocker: rule.visible_blocker === true,
        visibleWorking: rule.visible_working === true,
        skipStateUpdate: rule.skip_state_update === true,
        gate: compileGate(rule),
      };
    } catch (error) {
      throw new Error(`manifest ${manifest?.id} rule ${rule?.id} could not be compiled: ${error.message}`);
    }
  });
  compiledCache.set(manifest, compiled);
  return compiled;
}

function compileGate(gate) {
  return {
    contains: (gate.contains || []).map((needle) => String(needle).toLowerCase()),
    regex: (gate.regex || []).map(rustRegex),
    lineRegex: (gate.line_regex || []).map(rustRegex),
    all: (gate.all || []).map(compileGate),
    any: (gate.any || []).map(compileGate),
    not: (gate.not || []).map(compileGate),
  };
}

/**
 * A Rust `regex` pattern as a JavaScript RegExp. Covers exactly the syntax the vendored manifests
 * use: leading inline flags, `\x{H..}` escapes, and `\A` / `\z` anchors. Anything else is passed
 * through, and the `u` flag makes JavaScript refuse an escape it does not understand rather than
 * reading it as a literal.
 */
export function rustRegex(pattern) {
  let source = String(pattern);
  let flags = "u";
  for (let lead = /^\(\?([ims]+)\)/.exec(source); lead; lead = /^\(\?([ims]+)\)/.exec(source)) {
    for (const flag of lead[1]) if (!flags.includes(flag)) flags += flag;
    source = source.slice(lead[0].length);
  }
  if (/\(\?[a-zA-Z-]+[):]/.test(source)) throw new Error(`inline flags inside a pattern are not translated: ${pattern}`);
  if (flags.includes("m") && /\\[Az]/.test(source)) throw new Error(`\\A or \\z under (?m) is not translated: ${pattern}`);
  source = source.replace(/\\x\{([0-9a-fA-F]+)\}/g, "\\u{$1}").replace(/\\A/g, "^").replace(/\\z/g, "$");
  return new RegExp(source, flags);
}

function gateMatches(gate, region) {
  if (!gate.contains.every((needle) => region.lower.includes(needle))) return false;
  if (!gate.regex.every((re) => re.test(region.text))) return false;
  if (gate.lineRegex.length) {
    region.lines ??= lines(region.text);
    if (!gate.lineRegex.every((re) => region.lines.some((line) => re.test(line)))) return false;
  }
  if (!gate.all.every((nested) => gateMatches(nested, region))) return false;
  if (gate.any.length && !gate.any.some((nested) => gateMatches(nested, region))) return false;
  if (gate.not.some((nested) => gateMatches(nested, region))) return false;
  return true;
}

// ── regions (manifest.rs `region`) ─────────────────────────────────────────────────────────────

/** The text a region name selects from `{screen, title, progress}`; an unknown name selects "". */
export function regionText(input, spec) {
  const name = String(spec ?? "").trim();
  if (name === "osc_title") return String(input?.title ?? "");
  if (name === "osc_progress") return String(input?.progress ?? "");
  const content = String(input?.screen ?? "");
  const ls = lines(content);
  switch (name) {
    case "whole_recent": return content;
    case "after_last_prompt_marker": {
      const index = lastIndex(ls, codexPromptLine);
      return index === -1 ? content : fromLine(content, ls, index + 1);
    }
    case "before_current_prompt_marker": {
      const index = currentCodexPromptIndex(ls);
      return index === -1 ? content : content.slice(0, Math.min(lineOffset(ls, index), content.length));
    }
    case "whole_recent_without_current_prompt_marker":
      return currentCodexPromptIndex(ls) === -1 ? content : "";
    case "current_prompt_block_marker": {
      const prompt = currentCodexPromptIndex(ls);
      if (prompt === -1) return "";
      const block = lastIndex(ls.slice(0, prompt), codexBlockMarkerLine);
      return block === -1 ? "" : ls[block];
    }
    case "after_current_prompt_block_marker": {
      const prompt = currentCodexPromptIndex(ls);
      if (prompt === -1) return "";
      const block = lastIndex(ls.slice(0, prompt), codexBlockMarkerLine);
      return block === -1 ? "" : fromLine(content, ls, block);
    }
    case "prompt_box_body": {
      const top = promptBoxTopBorderIndex(ls);
      if (top === -1) return "";
      const relative = ls.slice(top + 1).findIndex(isHorizontalRule);
      const end = relative === -1 ? ls.length : top + 1 + relative;
      return content.slice(lineOffset(ls, top + 1, content), lineOffset(ls, end, content));
    }
    case "above_prompt_box": return abovePromptBox(content, ls);
    case "last_non_empty_above_prompt_box": {
      const above = lines(abovePromptBox(content, ls));
      const index = lastIndex(above, (line) => line.trim() !== "");
      return index === -1 ? "" : above[index];
    }
    case "after_last_horizontal_rule": {
      let lastRuleEnd = 0;
      let offset = 0;
      for (const line of ls) {
        const next = offset + line.length + 1;
        if (isHorizontalRule(line)) lastRuleEnd = Math.min(next, content.length);
        offset = next;
      }
      return content.slice(lastRuleEnd);
    }
    default: break;
  }
  let count = regionCount(name, "bottom_lines");
  if (count !== null) return fromLine(content, ls, Math.max(0, ls.length - count));
  count = regionCount(name, "bottom_non_empty_lines");
  if (count !== null) {
    const nonEmpty = [];
    for (let i = ls.length - 1; i >= 0 && nonEmpty.length < count; i -= 1) if (ls[i].trim() !== "") nonEmpty.push(i);
    return nonEmpty.length ? fromLine(content, ls, nonEmpty[nonEmpty.length - 1]) : "";
  }
  count = topRegionCount(name);
  if (count !== null) {
    const nonEmpty = [];
    for (let i = 0; i < ls.length && nonEmpty.length < count; i += 1) if (ls[i].trim() !== "") nonEmpty.push(i);
    return nonEmpty.length ? content.slice(0, lineOffset(ls, nonEmpty[nonEmpty.length - 1] + 1, content)) : "";
  }
  return "";
}

/** Rust's `str::lines`: split on LF, drop one trailing empty piece, strip a CR ending a line. */
function lines(text) {
  if (!text) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function lineOffset(ls, index, content = null) {
  let offset = 0;
  for (let i = 0; i < Math.min(index, ls.length); i += 1) offset += ls[i].length + 1;
  return content === null ? offset : Math.min(offset, content.length);
}

function fromLine(content, ls, index) {
  return content.slice(lineOffset(ls, index, content));
}

function lastIndex(list, predicate) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (predicate(list[i])) return i;
  return -1;
}

function regionCount(spec, name) {
  if (!spec.startsWith(`${name}(`) || !spec.endsWith(")")) return null;
  const count = spec.slice(name.length + 1, -1);
  // Rust's usize parse: ASCII digits with an optional leading `+`, nothing else.
  if (!/^\+?\d+$/.test(count)) return null;
  const value = Number(count);
  return Number.isSafeInteger(value) ? value : null;
}

function topRegionCount(spec) {
  const name = "top_non_empty_lines";
  if (!spec.startsWith(`${name}(`) || !spec.endsWith(")")) return null;
  const count = spec.slice(name.length + 1, -1);
  if (!/^\d+$/.test(count) || count.startsWith("0")) return null;
  const value = Number(count);
  return value <= MAX_TOP_REGION_LINE_COUNT ? value : null;
}

function codexPromptLine(line) {
  return line === "›" || line.startsWith("› ");
}

function codexBlockMarkerLine(line) {
  return line.startsWith("•") || line.startsWith("■") || line.startsWith("✗") || line.startsWith("✓");
}

function currentCodexPromptIndex(ls) {
  const prompt = lastIndex(ls, codexPromptLine);
  if (prompt === -1) return -1;
  return ls.slice(prompt + 1).some(codexBlockMarkerLine) ? -1 : prompt;
}

function promptBoxTopBorderIndex(ls) {
  let borders = 0;
  for (let i = ls.length - 1; i >= 0; i -= 1) {
    if (isHorizontalRule(ls[i])) {
      borders += 1;
      if (borders === 2) return i;
    }
  }
  return -1;
}

function abovePromptBox(content, ls) {
  const top = promptBoxTopBorderIndex(ls);
  return top === -1 ? content : content.slice(0, lineOffset(ls, top, content));
}

function isHorizontalRule(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let rules = 0;
  while (rules < trimmed.length && trimmed[rules] === "─") rules += 1;
  if (rules === 0) return false;
  return trimmed.slice(rules).trimStart() === "" || rules >= 3;
}
