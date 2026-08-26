/* Markdown -> tokens. Pure: no DOM, no Electron, so `node scripts/test-doc.js`
 * can cover it. The renderer builds DOM from these tokens with createElement.
 *
 * Two rules make rendering safe by construction rather than by sanitising:
 *   1. raw HTML never passes through -- it stays literal text;
 *   2. hrefs are filtered here, so the builder can trust every link it sees.
 *
 * A deliberate subset. Not supported: setext headings (Title\n===), reference
 * links, footnotes, definition lists, inline HTML, autolinks without brackets.
 *
 * Loaded as a plain <script> in the renderer (exposes window.Markdown) and as
 * a CommonJS module by the test script. CSP is script-src 'self', so no
 * bundler and no module syntax.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SAFE_SCHEME = /^(https?:|mailto:)/i;
  const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  // A relative path has no scheme at all; anything carrying one must be on the
  // allowlist. That rejects javascript:, data:, file:, vbscript: in one rule.
  const safeHref = (h) => !HAS_SCHEME.test(h) || SAFE_SCHEME.test(h);

  const RE_FENCE = /^ {0,3}(```+|~~~+)\s*([^`]*)$/;
  const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
  const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const BLANK = /^[ \t]*$/;

  const ESCAPABLE = '\\`*_~[]()!#+-.>|';
  const WORD = /[0-9A-Za-z]/;

  /* ---------------- inline ---------------- */

  // Scan once, left to right. Anything that does not close stays literal --
  // that is what keeps a stray asterisk in prose from eating the rest of a
  // paragraph, and what makes an unparseable link render as its own source.
  function inline(src) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
    let i = 0;

    while (i < src.length) {
      const c = src[i];

      if (c === '\\' && ESCAPABLE.indexOf(src[i + 1]) >= 0) {
        buf += src[i + 1];
        i += 2;
        continue;
      }

      if (c === '`') {
        const run = /^`+/.exec(src.slice(i))[0];
        const close = src.indexOf(run, i + run.length);
        if (close > 0 && src[close + run.length] !== '`') {
          flush();
          out.push({ type: 'code', text: src.slice(i + run.length, close).trim() });
          i = close + run.length;
          continue;
        }
      }

      if ((c === '!' && src[i + 1] === '[') || c === '[') {
        const img = c === '!';
        const link = linkAt(src, img ? i + 1 : i);
        if (link) {
          flush();
          out.push(img
            ? { type: 'image', src: link.dest, alt: plain(link.label) }
            : { type: 'link', href: link.dest, spans: inline(link.label) });
          i = link.end;
          continue;
        }
      }

      if (c === '~' && src[i + 1] === '~') {
        const close = closerAt(src, i, '~~');
        if (close >= 0) {
          flush();
          out.push({ type: 'strike', spans: inline(src.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
      }

      if (c === '*' || c === '_') {
        const run = c === src[i + 1] ? (c === src[i + 2] ? 3 : 2) : 1;
        const marker = c.repeat(run);
        // Underscores inside a word (snake_case) are not emphasis.
        const opens = c === '*' || i === 0 || !WORD.test(src[i - 1]);
        const close = opens ? closerAt(src, i, marker) : -1;
        if (close >= 0 && (c === '*' || !WORD.test(src[close + run] || ''))) {
          const spans = inline(src.slice(i + run, close));
          flush();
          out.push(run === 3 ? { type: 'strong', spans: [{ type: 'em', spans: spans }] }
            : run === 2 ? { type: 'strong', spans: spans }
              : { type: 'em', spans: spans });
          i = close + run;
          continue;
        }
      }

      buf += c;
      i++;
    }

    flush();
    return out;
  }

  // Index of the next unescaped `marker`, or -1. Never matches an empty span.
  function closerAt(src, start, marker) {
    let j = start + marker.length;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src.startsWith(marker, j)) return j > start + marker.length ? j : -1;
      j++;
    }
    return -1;
  }

  // [label](dest) starting at `start`. Both halves are bracket-balanced, so a
  // link label may contain brackets and a destination may contain parens.
  function linkAt(src, start) {
    const label = balanced(src, start, '[', ']');
    if (label < 0 || src[label + 1] !== '(') return null;
    const dest = balanced(src, label + 1, '(', ')');
    if (dest < 0) return null;
    let raw = src.slice(label + 2, dest).trim();
    // A title after the destination -- [t](url "title") -- is dropped.
    const sp = raw.search(/\s/);
    if (sp >= 0) raw = raw.slice(0, sp);
    if (!safeHref(raw)) return null;
    return { label: src.slice(start + 1, label), dest: raw, end: dest + 1 };
  }

  function balanced(src, start, open, close) {
    let depth = 0;
    for (let j = start; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === open) depth++;
      else if (src[j] === close && --depth === 0) return j;
    }
    return -1;
  }

  const plain = (s) => s.replace(/\\([\\`*_~[\]()!#+\-.>|])/g, '$1');

  /* ---------------- blocks ---------------- */

  function parse(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    return parseBlocks(lines);
  }

  const startsBlock = (line) =>
    BLANK.test(line) || RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line);

  function parseBlocks(lines) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (BLANK.test(line)) { i++; continue; }

      const fence = RE_FENCE.exec(line);
      if (fence) {
        const close = fence[1][0].repeat(3);
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].trimStart().startsWith(close) && !lines[i].trim().slice(3).trim())) {
          body.push(lines[i]);
          i++;
        }
        i++; // the closing fence, or past the end for an unclosed one
        out.push({ type: 'code', lang: fence[2].trim(), text: body.join('\n') });
        continue;
      }

      const heading = RE_HEADING.exec(line);
      if (heading) {
        const body = (heading[2] || '').replace(/[ \t]+#+[ \t]*$/, '');
        out.push({ type: 'heading', level: heading[1].length, spans: inline(body) });
        i++;
        continue;
      }

      if (RE_HR.test(line)) { out.push({ type: 'hr' }); i++; continue; }

      const para = [];
      while (i < lines.length && !startsBlock(lines[i])) { para.push(lines[i].trim()); i++; }
      out.push({ type: 'paragraph', spans: inline(para.join('\n')) });
    }

    return out;
  }

  return { parse: parse, inline: inline, safeHref: safeHref };
});
