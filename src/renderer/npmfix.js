/* Self-healing wizard installs: pure detectors over npm's output, plus the
 * decision of whether it is safe to point npm's global prefix at ~/.local.
 * Pure: no fs, no exec, no DOM, so `node scripts/test-npmfix.js` can cover it.
 *
 * The wizard buffers a pty:run's output and, when the process exits, asks
 * this module what went wrong; the impure halves live at the call sites
 * (app.js re-runs the install, installer.js gathers facts and edits ~/.npmrc).
 *
 * Loaded as a plain <script> in the renderer (exposes window.NpmFix) and as a
 * CommonJS module by the test script and by installer.js in the main process.
 * CSP is script-src 'self', so no bundler and no module syntax.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NpmFix = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

  // npm >= 12 blocks dependency install scripts not covered by allowScripts and
  // prints the exact flag that would allow them. Prefer that suggestion; fall
  // back to collecting the per-package "npm warn install-scripts  name@version"
  // lines (greedy \S+ then backtracking to @<digit> keeps scoped names whole).
  function blockedScripts(out) {
    const text = stripAnsi(out);
    const suggested = text.match(/--allow-scripts=([^\s`'"]+)/);
    if (suggested) return suggested[1];
    const names = new Set();
    const re = /npm warn install-scripts\s+(\S+)@\d[^\s]*\s*\(/g;
    let m;
    while ((m = re.exec(text))) names.add(m[1]);
    return names.size ? [...names].join(',') : null;
  }

  // npm's permission failure on a root-owned global prefix. Both conditions,
  // so a CLI merely mentioning EACCES in its own output doesn't trigger a fix.
  function eacces(out) {
    const text = stripAnsi(out);
    return /npm error/i.test(text) && /\bEACCES\b/.test(text);
  }

  // Is it safe to write prefix=<home>/.local into ~/.npmrc? Only when the
  // current global prefix is genuinely unwritable, the user hasn't chosen a
  // prefix themselves, and <home>/.local/bin is already on PATH (otherwise the
  // installed binary wouldn't resolve and the "fix" would just move the hole).
  function prefixPlan({ platform, writable, npmrc, pathEnv, home }) {
    if (platform === 'win32') return { fix: false, reason: 'not needed on Windows' };
    if (writable) return { fix: false, reason: 'the global prefix is already writable' };
    if (/^\s*prefix\s*=/m.test(npmrc || '')) {
      return { fix: false, reason: 'a custom prefix is already set in ~/.npmrc' };
    }
    const localBin = home + '/.local/bin';
    if (!String(pathEnv || '').split(':').includes(localBin)) {
      return { fix: false, reason: localBin + ' is not on your PATH' };
    }
    return { fix: true, prefix: home + '/.local' };
  }

  return { stripAnsi, blockedScripts, eacces, prefixPlan };
});
