const { execFileSync } = require('child_process');

// --- inherited agent session ------------------------------------------------
// The environment that opened Tote is not the environment Tote should hand to
// its children, and it hands process.env to all of them: every pty, the
// wizard's installs, `cli:check`, local services.
//
// That matters when the thing that opened it was itself a CLI agent session.
// `npm run install:mac` is normally run from a docked terminal, its watcher
// reopens the app with `open`, and macOS passes that shell's environment
// straight through (the app comes up with ppid 1 and the agent's full marker
// set). Every terminal spawned afterwards then looks to Claude Code like a
// nested child of a session that has long since ended, so it turns transcript
// saving off and prints `inherited CLAUDE_CODE_CHILD_SESSION marker` -- for the
// entire life of that app instance, in every space.
//
// A terminal in Tote is a fresh top-level session, so the markers are dropped
// once, here, rather than at each spawn site.
//
// The list is explicit rather than a `CLAUDE_*` / `CLAUDE_CODE_*` wildcard on
// purpose: real user configuration lives under the same prefixes
// (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK` / `_USE_VERTEX`,
// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, an api-key helper's TTL), and silently
// deleting somebody's Bedrock or config-dir setting would be a worse bug than
// the one this fixes. A marker that is not on the list costs a warning; a
// config var that is costs a broken install.
const AGENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_VERSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
];
function dropInheritedAgentSession() {
  const found = AGENT_SESSION_VARS.filter((k) => process.env[k] !== undefined);
  for (const k of found) delete process.env[k];
  if (found.length) {
    console.log('[tote] dropped inherited agent-session vars: ' + found.join(', '));
  }
}

// --- login-shell PATH ------------------------------------------------------
// A GUI launch (Finder, Dock, .desktop entry) hands the app a minimal PATH —
// /usr/bin:/bin:/usr/sbin:/sbin on macOS — so npm, git and any CLI behind a
// version manager are invisible to everything we exec from here: the wizard's
// system check reports them missing, `cli:check` marks every profile
// uninstalled, and local services fail to start. Read the real PATH from the
// user's login shell once and adopt it. Agent terminals don't rely on this —
// ptyManager gives each one its own login shell so per-shell setups stay live.
function adoptLoginShellPath() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || '/bin/bash';
  const mark = '__TOTE_PATH__';
  try {
    // -i so the interactive rc file (where fnm/nvm/asdf hook in) is sourced;
    // markers because rc files are free to print banners around our output.
    const out = execFileSync(shell, ['-l', '-i', '-c', `printf '${mark}%s${mark}' "$PATH"`], {
      stdio: ['ignore', 'pipe', 'ignore'], // stdin closed: an rc file that reads gets EOF, not a hang
      timeout: 5000,
      encoding: 'utf8',
    });
    const found = out.split(mark)[1];
    if (!found) return;
    // Login shell wins on order, but keep anything it didn't mention.
    const seen = new Set();
    const merged = [];
    for (const dir of [...found.split(':'), ...(process.env.PATH || '').split(':')]) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        merged.push(dir);
      }
    }
    process.env.PATH = merged.join(':');
  } catch (e) {
    console.error('could not read PATH from login shell:', e.message);
  }
}

module.exports = { dropInheritedAgentSession, adoptLoginShellPath };
