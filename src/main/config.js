// Config store: seeds defaults into userData on first run, so users can
// edit providers / CLI profiles / workspaces / apps without touching source.
const fs = require('fs');
const path = require('path');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config');
const FILES = ['providers.json', 'cli-profiles.json', 'workspaces.json', 'apps.json', 'settings.json', 'views.json'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class ConfigStore {
  constructor(app) {
    this.dir = path.join(app.getPath('userData'), 'config');
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of FILES) {
      const target = path.join(this.dir, name);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(DEFAULTS_DIR, name), target);
      }
    }
  }

  getDir() {
    return this.dir;
  }

  read(name, fallback) {
    return readJson(path.join(this.dir, name), fallback);
  }

  write(name, data) {
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 2));
  }

  getProviders() { return this.read('providers.json', []); }
  saveProviders(list) { this.write('providers.json', list); }

  getCliProfiles() { return this.read('cli-profiles.json', []); }
  saveCliProfiles(list) { this.write('cli-profiles.json', list); }

  getWorkspaces() { return this.read('workspaces.json', { active: 'global', list: [] }); }
  saveWorkspaces(data) { this.write('workspaces.json', data); }

  getApps() { return this.read('apps.json', { list: [] }); }
  saveApps(data) { this.write('apps.json', data); }

  getSettings() { return this.read('settings.json', { bridgeDownloads: true }); }
  saveSettings(data) { this.write('settings.json', data); }

  // Per-workspace open views: { [wsId]: { tabs: [{id, providerId}],
  // groups: [{ id, name, tree, focus, zoom }], activeGroup, filesRatio } }
  getViews() { return this.read('views.json', {}); }
  saveViews(data) { this.write('views.json', data); }
}

module.exports = { ConfigStore };
