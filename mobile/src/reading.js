// Build a phone-readable snapshot from xterm's parsed buffer, never raw ANSI.
// Join physical wraps back into logical lines before the browser wraps to width.
export function readableTerminal(buffer, limit = 2000) {
  const lines = []; let current = null;
  for (let i = Math.max(0, buffer.length - limit); i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    if (!line.isWrapped || current === null) {
      if (current !== null) lines.push(current.trimEnd());
      current = line.translateToString(false);
    } else current += line.translateToString(false);
  }
  if (current !== null) lines.push(current.trimEnd());
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.join('\n');
}
