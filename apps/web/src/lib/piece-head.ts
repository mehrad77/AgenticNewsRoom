// A piece's rendered body split after its head (the title and the AI label), so the reader site
// can put the piece's date and labels under the title rather than above it.

const HEAD_END = [/<p class="anr-disclosure">[\s\S]*?<\/p>/, /<\/h1>/];

/** The body's head and the rest; the whole body as the rest when it has no head. */
export function splitHead(html: string): [string, string] {
  for (const re of HEAD_END) {
    const m = re.exec(html);
    if (m) {
      const at = m.index + m[0].length;
      return [html.slice(0, at), html.slice(at)];
    }
  }
  return ["", html];
}
