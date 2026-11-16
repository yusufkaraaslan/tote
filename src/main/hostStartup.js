const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const desktopArg = value => '"' + String(value).replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%') + '"';

function plan({ executable, entry, dataDir, platform = process.platform, home = os.homedir(), configHome = process.env.XDG_CONFIG_HOME, appData = process.env.APPDATA }) {
  const args = [executable, entry, '--data-dir', dataDir];
  if (args.some(v => /[\r\n\0]/.test(v))) throw Error('Startup paths must be single-line paths');
  if (platform === 'darwin') {
    return { file: path.join(home, 'Library/LaunchAgents/com.tote.host.plist'), content:
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict><key>Label</key><string>com.tote.host</string><key>ProgramArguments</key><array>' +
      args.map(a => '<string>' + xml(a) + '</string>').join('') + '</array><key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict><key>RunAtLoad</key><true/></dict></plist>\n' };
  }
  if (platform === 'win32') {
    // PowerShell encoded command avoids cmd expansion of %, &, and profile paths.
    const literal = s => "'" + s.replace(/'/g, "''") + "'";
    const command = "$env:ELECTRON_RUN_AS_NODE='1'; & " + args.map(literal).join(' ');
    const shell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const shellArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(command, 'utf16le').toString('base64');
    return { file: path.join(appData || path.join(home, 'AppData/Roaming'), 'Microsoft/Windows/Start Menu/Programs/Startup/ToteHost.lnk'),
      shortcut: true, shell, args: shellArgs, command: '"' + shell + '" ' + shellArgs };
  }
  if (platform !== 'linux') throw Error('Start at login is not supported on this platform');
  return { file: path.join(configHome && path.isAbsolute(configHome) ? configHome : path.join(home, '.config'), 'autostart/tote-host.desktop'),
    content: '[Desktop Entry]\nType=Application\nName=Tote background host\nComment=Keep Tote agents available without opening a window\nTerminal=false\nExec=env ELECTRON_RUN_AS_NODE=1 ' + args.map(desktopArg).join(' ') + '\n' };
}

function enabled(options) { return fs.existsSync(plan(options).file); }

function setEnabled(on, options) {
  const p = plan(options);
  if (on) {
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    if (p.shortcut) {
      const literal = value => "'" + value.replace(/'/g, "''") + "'";
      const script = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + literal(p.file) + '); $s.TargetPath=' + literal(p.shell) + '; $s.Arguments=' + literal(p.args) + '; $s.WindowStyle=7; $s.Save()';
      execFileSync(p.shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, stdio: 'pipe' });
    } else {
      const temporary = p.file + '.tmp-' + process.pid;
      fs.writeFileSync(temporary, p.content, { mode: 0o600 }); fs.renameSync(temporary, p.file);
    }
  } else fs.rmSync(p.file, { force: true });
  return enabled(options);
}
module.exports = { plan, enabled, setEnabled };
