// Clipboard gestures belong to the viewer, even for a remote PTY. Always use
// xterm.paste so bracketed paste and newline handling remain xterm's business.
(function (root) {
  function create(term, clipboard, { mac = false, onError = () => {} } = {}) {
    const copy = () => {
      const text = term.getSelection();
      if (text) return Promise.resolve(clipboard.writeText(text)).catch(onError);
    };
    const paste = () => Promise.resolve(clipboard.readText()).then((text) => {
      term.paste(text);
      term.focus();
    }).catch(onError);
    const key = (e) => {
      const letter = e.key.toLowerCase();
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey;
      const command = !e.altKey && mod && (letter === 'c' ? copy : letter === 'v' ? paste : null);
      if (!command) return true;
      // Suppress keypress/keyup too: a clipboard gesture must never type into
      // the agent, and the browser must not perform a second paste.
      e.preventDefault();
      if (e.type === 'keydown') command();
      return false;
    };
    return { copy, paste, key };
  }
  if (typeof module === 'object' && module.exports) module.exports = { create };
  else root.TermClipboard = { create };
})(typeof window === 'object' ? window : globalThis);
