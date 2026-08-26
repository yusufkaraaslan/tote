// Preload: the only bridge between the sandboxed renderer and Electron.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('tote', {
  // workspaces (spaces)
  listWorkspaces: () => ipcRenderer.invoke('workspaces:list'),
  addWorkspace: (name) => ipcRenderer.invoke('workspaces:add', name),
  setActiveWorkspace: (id) => ipcRenderer.invoke('workspaces:setActive', id),
  removeWorkspace: (id) => ipcRenderer.invoke('workspaces:remove', id),
  renameWorkspace: (id, name) => ipcRenderer.invoke('workspaces:rename', id, name),
  // temp (scratch) spaces
  wsTempName: () => ipcRenderer.invoke('workspaces:tempName'),
  wsAddTemp: (name) => ipcRenderer.invoke('workspaces:addTemp', name),
  wsDiscard: (id, termLabels) => ipcRenderer.invoke('workspaces:discard', id, termLabels),
  wsPromote: (id) => ipcRenderer.invoke('workspaces:promote', id),
  setWorkspacePath: (id) => ipcRenderer.invoke('workspaces:setPath', id),

  // files (active workspace)
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
  claudeStatus: () => ipcRenderer.invoke('conn:claudeStatus'),
  bindClaude: () => ipcRenderer.invoke('conn:bindClaude'),
  mcpSnippet: () => ipcRenderer.invoke('conn:mcpSnippet'),
  ptyRun: (command) => ipcRenderer.invoke('pty:run', { command, args: [] }),

  // providers / tabs
  ensureLocal: (providerId) => ipcRenderer.invoke('provider:ensureLocal', providerId),
  sendFileToTab: (wcId, relPath) => ipcRenderer.invoke('tab:sendFile', { wcId, relPath }),
  openExternal: (url) => ipcRenderer.send('app:openExternal', url),

  // terminals
  ptyAvailable: () => ipcRenderer.invoke('pty:available'),
  ptySpawn: (profileId, cols, rows) => ipcRenderer.invoke('pty:spawn', { profileId, cols, rows }),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.send('pty:kill', { id }),
  checkCommand: (cmd) => ipcRenderer.invoke('cli:check', cmd),

  // events
  onPtyData: (cb) => ipcRenderer.on('pty:data', (e, m) => cb(m.id, m.data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (e, m) => cb(m.id, m.exitCode)),
  onWorkspaceChanged: (cb) => ipcRenderer.on('workspace:changed', () => cb()),
  onWorkspacesSwept: (cb) => ipcRenderer.on('workspace:swept', (e, list) => cb(list)),
  onDownloadDone: (cb) => ipcRenderer.on('download:done', (e, m) => cb(m)),
});
