/** Greedy word-wrap matching Ink's own `<Text wrap="wrap">` closely enough
 *  to precompute a line count. Used to reserve a fixed-height block for
 *  copy that changes with cursor position (a highlighted option's
 *  description, a field's help text) so cycling through options never
 *  grows/shrinks the surrounding layout. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Wrap `text` to `width`, then pad with blank lines up to `targetLines` —
 *  the fixed-height half of the pattern above. `targetLines` should come
 *  from the max wrapped length across every candidate string that can
 *  occupy this slot (every option's description, every field's explain
 *  text), not just the one currently shown. */
export function wrapPadded(text: string, width: number, targetLines: number): string[] {
  const lines = wrapText(text, width);
  const pad = Math.max(0, targetLines - lines.length);
  return pad > 0 ? [...lines, ...Array(pad).fill(" ")] : lines;
}
