// Which side of Tote owns each IPC channel. Pure, so scripts/test-devices.js
// can hold the table against preload.js and the host's method table.
//
// host   -- the device's own state: spaces, files, views, terminals. Forwarded
//           as-is to a host, which today is always this process and in the
//           devices design may be another machine (see
//           docs/superpowers/specs/2026-10-12-devices-design.md, section 2).
// viewer -- the machine you are sitting at: web providers, native apps, the
//           setup wizard, the system browser and file manager. Always local.
// split  -- a picker or confirm on the viewer, then the operation on the host
//           through one of the host-only methods below.
//
// Adding a channel means picking its row here. A channel in no row fails
// `npm test`, which is the point: the question has to be asked.

const HOST = new Set([
  'workspaces:list', 'workspaces:setActive', 'workspaces:remove', 'workspaces:reorder',
  'workspaces:rename', 'workspaces:addRemote', 'workspaces:tempName', 'workspaces:addTemp',
  'remote:connect', 'remote:state', 'remote:disconnect',
  'workspace:getRoot', 'workspace:tree', 'workspace:read', 'workspace:readDoc',
  'workspace:write', 'workspace:createFile', 'workspace:createFolder', 'workspace:rename',
  'workspace:trash',
  'config:getCliProfiles', 'config:saveCliProfiles',
  'views:get', 'views:save',
  'pty:available', 'pty:spawn', 'pty:list', 'pty:attach', 'pty:detach',
  'pty:write', 'pty:resize', 'pty:kill',
  'cli:check',
]);

// Host channels the renderer sends without waiting for a reply (ipcRenderer.send).
const FIRE = new Set(['pty:write', 'pty:resize', 'pty:kill', 'pty:detach']);

const VIEWER = new Set([
  'config:getProviders', 'config:saveProviders', 'config:openDir',
  'settings:get', 'settings:save',
  'apps:list', 'apps:add', 'apps:remove', 'apps:launch',
  'setup:systemCheck', 'setup:fixNpmPrefix',
  'conn:claudeStatus', 'conn:bindClaude', 'conn:mcpSnippet',
  'pty:run', 'provider:ensureLocal',
  'workspace:openPath', 'workspace:revealPath',
  'app:openExternal', 'app:newWindow',
  // Which machine this WINDOW looks at is the viewer's business by definition.
  'devices:list', 'devices:current', 'devices:view',
]);

const SPLIT = new Set([
  'workspaces:add', 'workspaces:setPath', 'workspaces:discard', 'workspaces:promote',
  'tab:sendFile',
]);

// Host methods with no channel of their own: the second half of a split one.
const HOST_ONLY = new Set([
  'workspaces:addLocal', 'workspaces:setPathTo', 'workspaces:measure',
  'workspaces:discardConfirmed', 'workspaces:promoteTo', 'workspace:fileBytes',
]);

function kindOf(channel) {
  if (HOST.has(channel)) return 'host';
  if (VIEWER.has(channel)) return 'viewer';
  if (SPLIT.has(channel)) return 'split';
  return null;
}

module.exports = { HOST, FIRE, VIEWER, SPLIT, HOST_ONLY, kindOf };
