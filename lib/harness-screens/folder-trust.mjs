// Recognize a Claude folder-trust prompt at the end of the current viewport. No input is sent here.
const ROW = /^\s*(?:│\s*)?([❯›▶])?\s*(.*?)\s*│?$/u;
const KEY_HINT = /^\s*(?:│\s*)?Enter to confirm/u;

function menuRow(line) {
  const match = ROW.exec(line);
  return { cursor: Boolean(match?.[1]), label: match?.[2] ?? '' };
}

export function folderTrustStep(screen) {
  const lines = String(screen ?? '').split('\n').map(line => line.trimEnd());
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.length || !KEY_HINT.test(lines.at(-1))) return null;
  let last = lines.length - 2;
  while (last >= 0 && !lines[last].trim()) last--;
  if (last < 1) return null;
  const no = menuRow(lines[last - 1]);
  const yes = menuRow(lines[last]);
  if (no.label !== 'No, exit' || yes.label !== 'Yes, I trust this folder' || no.cursor === yes.cursor) return null;
  return no.cursor ? 'leave-no' : 'accept-yes';
}
