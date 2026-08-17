// PTY manager: spawns CLI agents (Claude Code, Kimi CLI, ...) in real
// pseudo-terminals so their TUIs render correctly in xterm.js.
let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e.message;
}

// Single-quote a word for the shell: end the quote, escape the quote, reopen.
function shq(word) {
  return `'${String(word).replace(/'/g, `'\\''`)}'`;
}

// What to actually hand pty.spawn() for a CLI profile.
//
// A GUI-launched app inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin on
// macOS), so exec'ing `codex` or `claude` directly fails with posix_spawnp on
// every install that puts its binaries behind a version manager (fnm, nvm,
// asdf, volta) or in ~/.local/bin. Going through a login shell gives each
// terminal the same environment the user's own terminal has. It has to be
// resolved per terminal rather than captured once, because setups like fnm
// build their bin dir per shell and can switch node version by directory.
function shellCommand(profile) {
  const args = profile.args || [];
  // Windows has no login-shell concept and PowerShell already starts with the
  // user's full PATH, so keep exec'ing directly there.
  if (process.platform === 'win32') {
    return { file: profile.command || 'powershell.exe', args };
  }
  const shell = process.env.SHELL || '/bin/bash';
  // -l for the profile files, -i so the interactive rc file (where fnm/nvm/asdf
  // hook in) is sourced too.
  if (!profile.command) return { file: shell, args: ['-l', '-i'] }; // "user's default shell"
  // exec replaces the shell, so the agent ends up owning the PTY directly:
  // signals, exit code and TUI repaint behave exactly as before, and no prompt
  // is ever drawn.
  const line = 'exec ' + [profile.command, ...args].map(shq).join(' ');
  return { file: shell, args: ['-l', '-i', '-c', line] };
}

class PtyManager {
  constructor() {
    this.sessions = new Map();
    this.nextId = 1;
  }

  available() {
    return { ok: !!pty, error: ptyLoadError };
  }

  spawn(profile, cwd, cols, rows, sender) {
    if (!pty) {
      throw new Error('node-pty failed to load: ' + ptyLoadError);
    }
    const { file, args } = shellCommand(profile);
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: process.env,
    });
    const id = this.nextId++;
    this.sessions.set(id, proc);
    proc.onData((data) => {
      try {
        sender.send('pty:data', { id, data });
      } catch {}
    });
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      try {
        sender.send('pty:exit', { id, exitCode });
      } catch {}
    });
    return id;
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s) s.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s) {
      try {
        s.resize(cols, rows);
      } catch {}
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (s) {
      try {
        s.kill();
      } catch {}
      this.sessions.delete(id);
    }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

module.exports = { PtyManager };
