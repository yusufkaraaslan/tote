// Setup & connection helpers for the first-run wizard.
// System checks, CLI install status, and wiring external apps
// (Claude Desktop, any MCP client) to the active workspace.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

module.exports = { systemCheck, claudeStatus, bindClaudeToWorkspace, mcpSnippet };
