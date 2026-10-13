// PTY manager: spawns CLI agents (Claude Code, Kimi CLI, ...) in real
// pseudo-terminals so their TUIs render correctly in xterm.js.
const S = require('./sshfix');

let pty = null;
let ptyLoadError = null;
try {
  pty = require('node-pty');
} catch (e) {
  ptyLoadError = e.message;
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
//
// A remote space's terminal is still a real local pty -- it just has ssh in it,
// so node-pty, xterm, SIGWINCH on resize, the Shift+Enter handler and the
// scrollback keys are all untouched: ssh is transparent to a tty. It goes
// through the *remote* login shell for exactly the reason above.
function shellCommand(profile, remote) {
  if (remote) {
    return { file: 'ssh', args: S.termArgs({ host: remote.host, socket: remote.socket,
                                             command: S.termCommand(remote.root, profile) }) };
  }
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
  const line = 'exec ' + [profile.command, ...args].map(S.shq).join(' ');
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

  // `remote` is a live RemoteConn when the space lives on another machine; cwd
  // is then only the local process's working directory, since the real one is
  // set by the `cd` inside the ssh command.
  spawn(profile, cwd, cols, rows, sender, remote) {
    const { file, args } = shellCommand(profile, remote);
    return this.launch({ file, args, cwd, cols, rows }, sender);
  }

  // The one place a pty is created. `onData`/`onExit` let the main process
  // observe a session it is also streaming to the renderer -- which is how
  // RemoteConn reads its own connect output while the user watches it in a pane.
  launch({ file, args, cwd, cols, rows }, sender, onData, onExit) {
    if (!pty) {
      throw new Error('node-pty failed to load: ' + ptyLoadError);
    }
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
        if (sender) sender.send('pty:data', { id, data });
      } catch {}
      if (onData) onData(data);
    });
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      // node-pty reports exit when the master hits EOF, which is not always the
      // same moment the child dies: a shell that never got the pty as its
      // controlling terminal (seen for real with the main process near its
      // descriptor limit) keeps running after its pane has already printed
      // "process exited", orphaned with nothing left to read it. Reap it here --
      // for a child that really is gone this throws ESRCH and costs nothing.
      try {
        proc.kill();
      } catch {}
      try {
        if (sender) sender.send('pty:exit', { id, exitCode });
      } catch {}
      if (onExit) onExit(exitCode);
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

module.exports = { PtyManager, shellCommand };
