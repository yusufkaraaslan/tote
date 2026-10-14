// Preload: the only bridge between the sandboxed renderer and Electron.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tote', {
  readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  // workspaces (spaces)
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  addWorkspace: (name) => ipcRenderer.invoke('workspaces:add', name),
  setActiveWorkspace: (id) => ipcRenderer.invoke('workspaces:setActive', id),
  removeWorkspace: (id) => ipcRenderer.invoke('workspaces:remove', id),
  renameWorkspace: (id, name) => ipcRenderer.invoke('workspaces:rename', id, name),
  reorderWorkspaces: (ids) => ipcRenderer.invoke('workspaces:reorder', ids),
  // temp (scratch) spaces
  wsTempName: () => ipcRenderer.invoke('workspaces:tempName'),
  wsAddTemp: (name) => ipcRenderer.invoke('workspaces:addTemp', name),
  wsDiscard: (id) => ipcRenderer.invoke('workspaces:discard', id),
  wsPromote: (id) => ipcRenderer.invoke('workspaces:promote', id),
  setWorkspacePath: (id) => ipcRenderer.invoke('workspaces:setPath', id),
  // the same three with a typed path, for another machine's disk
  addWorkspaceAt: (name, path) => ipcRenderer.invoke('workspaces:addLocal', name, path),
  setWorkspacePathTo: (id, path) => ipcRenderer.invoke('workspaces:setPathTo', id, path),
  wsPromoteTo: (id, path) => ipcRenderer.invoke('workspaces:promoteTo', id, path),

  // remote spaces (ssh, e.g. over Tailscale)
  addRemoteWorkspace: (name, host, path) =>
    ipcRenderer.invoke('workspaces:addRemote', { name, host, path }),
  remoteConnect: (id, cols, rows, mkdir, sid) =>
    ipcRenderer.invoke('remote:connect', { id, cols, rows, mkdir, sid }),
  remoteState: (id) => ipcRenderer.invoke('remote:state', id),
  remoteDisconnect: (id) => ipcRenderer.invoke('remote:disconnect', id),

  // files (this window's space)
  getRoot: () => ipcRenderer.invoke('workspace:getRoot'),
  tree: () => ipcRenderer.invoke('workspace:tree'),
  readFile: (rel) => ipcRenderer.invoke('workspace:read', rel),
  readDoc: (rel) => ipcRenderer.invoke('workspace:readDoc', rel),
  writeFile: (rel, content) => ipcRenderer.invoke('workspace:write', rel, content),
  createFile: (rel) => ipcRenderer.invoke('workspace:createFile', rel),
  createFolder: (rel) => ipcRenderer.invoke('workspace:createFolder', rel),
  rename: (from, to) => ipcRenderer.invoke('workspace:rename', from, to),
  trash: (rel) => ipcRenderer.invoke('workspace:trash', rel),
  openPath: (rel) => ipcRenderer.invoke('workspace:openPath', rel),
  revealPath: (rel) => ipcRenderer.invoke('workspace:revealPath', rel),
  // Electron 32 removed File.path; webUtils is the supported way to turn a
  // dropped File back into an absolute path, and it must run in the renderer.
  filePath: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },

  // config
  getProviders: () => ipcRenderer.invoke('config:getProviders'),
  saveProviders: (list) => ipcRenderer.invoke('config:saveProviders', list),
  getCliProfiles: () => ipcRenderer.invoke('config:getCliProfiles'),
  saveCliProfiles: (list) => ipcRenderer.invoke('config:saveCliProfiles', list),
  openConfigDir: () => ipcRenderer.invoke('config:openDir'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getViews: () => ipcRenderer.invoke('views:get'),
  saveViews: (v) => ipcRenderer.invoke('views:save', v),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  // native apps
  listApps: () => ipcRenderer.invoke('apps:list'),
  addApp: (name) => ipcRenderer.invoke('apps:add', name),
  removeApp: (id) => ipcRenderer.invoke('apps:remove', id),
  launchApp: (id) => ipcRenderer.invoke('apps:launch', id),

  // setup wizard / connections
  systemCheck: () => ipcRenderer.invoke('setup:systemCheck'),
  fixNpmPrefix: () => ipcRenderer.invoke('setup:fixNpmPrefix'),
  claudeStatus: () => ipcRenderer.invoke('conn:claudeStatus'),
  bindClaude: () => ipcRenderer.invoke('conn:bindClaude'),
  mcpSnippet: () => ipcRenderer.invoke('conn:mcpSnippet'),
  ptyRun: (command) => ipcRenderer.invoke('pty:run', { command, args: [] }),

  // providers / tabs
  ensureLocal: (providerId) => ipcRenderer.invoke('provider:ensureLocal', providerId),
  sendFileToTab: (wcId, relPath) => ipcRenderer.invoke('tab:sendFile', { wcId, relPath }),
  openExternal: (url) => ipcRenderer.send('app:openExternal', url),
  appVersion: () => ipcRenderer.invoke('app:version'),
  newWindow: () => ipcRenderer.invoke('app:newWindow'),

  // devices: other machines' Tote, over the tailnet
  devicesList: () => ipcRenderer.invoke('devices:list'),
  deviceCurrent: () => ipcRenderer.invoke('devices:current'),
  deviceView: (target) => ipcRenderer.invoke('devices:view', target),
  devicesOpen: () => ipcRenderer.invoke('devices:open'),
  deviceSettings: () => ipcRenderer.invoke('device:settings'),
  setKeepAwake: (on) => ipcRenderer.invoke('device:setKeepAwake', on),

  // terminals -- host sessions, keyed by an id the renderer picks (see sessions.js)
  ptyAvailable: () => ipcRenderer.invoke('pty:available'),
  ptySpawn: (sid, profileId, cols, rows) =>
    ipcRenderer.invoke('pty:spawn', { sid, profileId, cols, rows }),
  ptyList: () => ipcRenderer.invoke('pty:list'),
  ptyAttach: (id) => ipcRenderer.invoke('pty:attach', id),
  ptyDetach: (id) => ipcRenderer.send('pty:detach', { id }),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  checkCommand: (cmd) => ipcRenderer.invoke('cli:check', cmd),

  // events. Another machine's events carry its device key as a trailing
  // argument (undefined for this machine), so the renderer can file each one
  // under the right device even while that device's panes are hidden.
  onPtyData: (cb) => ipcRenderer.on('pty:data', (e, m, dev) => cb(m.id, m.data, dev, !!m.replay)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (e, m, dev) => cb(m.id, m.exitCode, dev)),
  onWorkspaceChanged: (cb) => ipcRenderer.on('workspace:changed', (e, wsId, dev) => cb(dev)),
  onWorkspacesChanged: (cb) => ipcRenderer.on('workspaces:changed', (e, x, dev) => cb(dev)),
  onViewsChanged: (cb) => ipcRenderer.on('views:changed', (e, views, dev) => cb(views, dev)),
  onRemoteState: (cb) => ipcRenderer.on('remote:state', (e, info, dev) => cb(info, dev)),
  onRemoteAuth: (cb) => ipcRenderer.on('remote:auth', (e, m, dev) => cb(m, dev)),
  onWorkspacesSwept: (cb) => ipcRenderer.on('workspace:swept', (e, list) => cb(list)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (e, m) => cb(m)),
  onWindowFocus: (cb) => ipcRenderer.on('win:focus', () => cb()),
  onWindowKey: (cb) => ipcRenderer.on('win:key', (e, k) => cb(k)),
  onDeviceLost: (cb) => ipcRenderer.on('devices:lost', (e, m) => cb(m)),
  onDeviceBack: (cb) => ipcRenderer.on('devices:back', (e, m) => cb(m)),
});
