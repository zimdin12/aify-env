// Terminal styling, in one place so nothing leaks an escape. Used by the dashboard and the start list.

const ESC = String.fromCharCode(27);
const SGR = {
  reset: "0", bold: "1", dim: "2",
  red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", grey: "90",
};

/** Style text, or return it untouched when colour is off. */
export function paint(text, codes, on) {
  if (!on || !codes.length) return String(text);
  return `${ESC}[${codes.map((c) => SGR[c]).join(";")}m${text}${ESC}[${SGR.reset}m`;
}
