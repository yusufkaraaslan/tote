// PTY manager: spawns CLI agents (Claude Code, Kimi CLI, ...) in real
// pseudo-terminals so their TUIs render correctly in xterm.js.
let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e.message;
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
    const cmd =
      profile.command ||
      (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash');
    const args = profile.args || [];
    const proc = pty.spawn(cmd, args, {
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
