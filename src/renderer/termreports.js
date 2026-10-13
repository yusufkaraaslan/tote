/* Terminal REPORTS: the bytes a terminal emulator sends back to the program
 * when the program asks it something -- "what are you?" (DA), "where is the
 * cursor?" (CPR), "is this mode on?" (DECRQM), "what colour is your
 * background?" (OSC 11). xterm.js answers by emitting them through onData,
 * the same callback that carries keystrokes, so they travel to the pty as if
 * typed.
 *
 * That was fine with one window per pty. A session is shared now: every
 * window showing it has its own xterm, and every one of them answers, so the
 * program reads each reply once per window. vi took the second copy of a
 * DECRQM reply (`ESC[?12;2$y`) as typed input and was left with a pending
 * yank; an agent's prompt would get the same garbage. So the host's headless
 * mirror answers -- exactly once, whoever is watching -- and each window drops
 * the reports its own xterm generates, using this matcher.
 *
 * xterm emits each report as its own onData chunk, so the patterns are
 * anchored to the whole chunk; a keystroke never arrives glued to one. The
 * one real overlap is CPR: Shift+F3 is `ESC[1;2R`, which is also a cursor
 * position report. It is the price of the fix, and a rare key in an agent TUI.
 *
 * Pure and dual-exported like layout.js, so scripts/test-devices.js covers it. */
(function (root) {
  const REPORTS = [
    /^\x1b\[[?>=]?[\d;]*c$/,          // DA1 / DA2 / DA3: device attributes
    /^\x1b\[\d+;\d+R$/,               // CPR: cursor position (DSR 6)
    /^\x1b\[\?\d+;\d+;?\d*R$/,        // DECXCPR
    /^\x1b\[[0-3]n$/,                 // DSR 5: status
    /^\x1b\[\??[\d;]*\$y$/,           // DECRQM: mode report
    /^\x1b\[[\d;]*t$/,                // window manipulation reports
    /^\x1b\][\s\S]*(\x07|\x1b\\)$/,   // OSC replies: colours, clipboard reads
    /^\x1bP[\s\S]*\x1b\\$/,           // DCS replies: DECRQSS, XTGETTCAP
  ];

  function isTermReport(data) {
    if (typeof data !== 'string' || data.charCodeAt(0) !== 0x1b) return false;
    for (const re of REPORTS) if (re.test(data)) return true;
    return false;
  }

  const api = { isTermReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TermReports = api;
})(typeof window !== 'undefined' ? window : globalThis);
