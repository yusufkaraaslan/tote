// Setup & connection helpers for the first-run wizard.
// System checks, CLI install status, and wiring external apps
// (Claude Desktop, any MCP client) to the active workspace.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prefixPlan } = require('../renderer/npmfix.js');

function cmdVersion(cmd) {
  try {
    return execSync(`${cmd} --version`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32' ? undefined : '/bin/sh',
      timeout: 8000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function systemCheck(ptys) {
  let homeWritable = true;
  const probe = path.join(os.homedir(), '.tote-write-test');
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
  } catch {
    homeWritable = false;
  }
  return {
    node: process.versions.node,
    npm: cmdVersion('npm'),
    git: cmdVersion('git'),
    pty: ptys.available(),
    homeWritable,
    platform: process.platform,
  };
}

// The wizard calls this when an `npm i -g` died with EACCES: a distro npm
// (pacman, apt) has its global prefix under /usr, which no regular user can
// write. The decision of whether ~/.local is a safe replacement is pure and
// lives in npmfix.js (covered by test-npmfix.js); this half only gathers the
// facts and, if the plan says fix, appends the prefix line to ~/.npmrc — the
// same file `npm config set prefix` writes.
function fixNpmPrefix() {
  let prefix;
  try {
    prefix = execSync('npm prefix -g', {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32' ? undefined : '/bin/sh',
      timeout: 8000,
    })
      .toString()
      .trim();
  } catch {
    return { fixed: false, reason: 'npm not found' };
  }
  // The write target of a global install; probe the deepest dir that exists.
  let target = path.join(prefix, 'lib', 'node_modules');
  while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  let writable = true;
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const npmrcPath = path.join(os.homedir(), '.npmrc');
  let npmrc = null;
  try {
    npmrc = fs.readFileSync(npmrcPath, 'utf8');
  } catch {}
  const plan = prefixPlan({
    platform: process.platform,
    writable,
    npmrc,
    pathEnv: process.env.PATH,
    home: os.homedir(),
  });
  if (!plan.fix) return { fixed: false, reason: plan.reason };
  const lead = npmrc && !npmrc.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(npmrcPath, `${lead}prefix=${plan.prefix}\n`);
  return { fixed: true, prefix: plan.prefix };
}

/* ----- Claude Desktop binding ----- */

function claudeConfigPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  }
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function claudeStatus() {
  const cfgPath = claudeConfigPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const entry = cfg.mcpServers && (cfg.mcpServers['tote-workspace'] || cfg.mcpServers['omnihub-workspace']);
    const bound = !!entry;
    const boundTo = bound ? (entry.args || []).slice(-1)[0] : null;
    return { configExists: true, bound, boundTo, cfgPath };
  } catch {
    return { configExists: fs.existsSync(cfgPath), bound: false, boundTo: null, cfgPath };
  }
}

// Merge an MCP filesystem server for the workspace into Claude Desktop's
// config (timestamped .bak first). Takes effect on next Claude Desktop start.
function bindClaudeToWorkspace(rootPath) {
  const cfgPath = claudeConfigPath();
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  if (fs.existsSync(cfgPath)) {
    fs.copyFileSync(cfgPath, cfgPath + '.bak-' + Date.now());
  }
  cfg.mcpServers = cfg.mcpServers || {};
  delete cfg.mcpServers['omnihub-workspace']; // pre-rename key
  cfg.mcpServers['tote-workspace'] = {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', rootPath],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

// Generic snippet for any MCP-capable app (Cursor, Cherry Studio, Kimi Code
// via /mcp-config, ...) to mount the workspace.
function mcpSnippet(rootPath) {
  return JSON.stringify(
    {
      mcpServers: {
        'tote-workspace': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', rootPath],
        },
      },
    },
    null,
    2,
  );
}

module.exports = { systemCheck, fixNpmPrefix, claudeStatus, bindClaudeToWorkspace, mcpSnippet };
