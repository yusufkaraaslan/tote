// Config store: seeds defaults into userData on first run, so users can
// edit providers / CLI profiles / workspaces / apps without touching source.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DEFAULTS_DIR = path.join(__dirname, '..', '..', 'config');
const FILES = ['providers.json', 'cli-profiles.json', 'workspaces.json', 'apps.json', 'settings.json', 'views.json'];

// A sibling rename is the commit point. Never truncate the destination, even
// when replacing a backup. Windows cannot fsync directories through Node.
function replaceJson(file, text, io) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = io.openSync(temp, 'wx', 0o600);
    io.writeFileSync(fd, text, 'utf8');
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(temp, file);
    if (process.platform !== 'win32') {
      const dir = io.openSync(path.dirname(file), 'r');
      try { io.fsyncSync(dir); }
      catch (e) { if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e; }
      finally { io.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function inspect(file, io) {
  let text;
  try { text = io.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    throw e; // Permission and device failures must never become empty config.
  }
  try { return { text, data: JSON.parse(text) }; }
  catch (e) { return { text, invalid: true }; }
}

class ConfigStore {
  constructor(app, { io = fs, onRecovery = (event) => console.warn('Recovered Tote configuration:', event) } = {}) {
    this.io = io;
    this.onRecovery = onRecovery;
    this.dir = path.join(app.getPath('userData'), 'config');
    io.mkdirSync(this.dir, { recursive: true });
    for (const name of FILES) {
      const target = path.join(this.dir, name);
      // Only seed a new file when neither version exists. A missing primary
      // with an existing backup is recovery, including an interrupted seed.
      const primary = inspect(target, io);
      if (primary.missing && inspect(target + '.bak', io).missing) {
        const text = io.readFileSync(path.join(DEFAULTS_DIR, name), 'utf8');
        JSON.parse(text);
        replaceJson(target + '.bak', text, io);
        replaceJson(target, text, io);
      } else {
        this.read(name); // Validate every file before consumers start.
      }
    }
  }

  getDir() {
    return this.dir;
  }

  read(name) {
    const file = path.join(this.dir, name);
    const current = inspect(file, this.io);
    if (!current.missing && !current.invalid) {
      const backup = inspect(file + '.bak', this.io);
      if (backup.missing || backup.invalid) {
        if (backup.invalid) this.preserve(file + '.bak');
        replaceJson(file + '.bak', current.text, this.io);
      }
      return current.data;
    }
    const backup = inspect(file + '.bak', this.io);
    if (backup.missing || backup.invalid) {
      throw new Error(`Cannot load ${file}: configuration is ${current.missing ? 'missing' : 'invalid JSON'} and no valid backup is available. Restore this file before reopening Tote.`);
    }
    const preserved = current.invalid ? this.preserve(file) : null;
    replaceJson(file, backup.text, this.io);
    this.onRecovery({ file, backup: file + '.bak', preserved });
    return backup.data;
  }

  preserve(file) {
    const preserved = `${file}.corrupt-${randomUUID()}`;
    this.io.copyFileSync(file, preserved, fs.constants.COPYFILE_EXCL);
    return preserved;
  }

  write(name, data) {
    const text = JSON.stringify(data, null, 2);
    if (text === undefined) throw new TypeError('Configuration must be JSON serializable');
    const file = path.join(this.dir, name);
    this.read(name); // Recover first; never replace good backup data with damage.
    const current = inspect(file, this.io);
    if (current.missing || current.invalid) throw new Error(`Configuration changed while saving ${file}`);
    replaceJson(file + '.bak', current.text, this.io);
    replaceJson(file, text, this.io);
  }

  getProviders() { return this.read('providers.json'); }
  saveProviders(list) { this.write('providers.json', list); }

  getCliProfiles() { return this.read('cli-profiles.json'); }
  saveCliProfiles(list) { this.write('cli-profiles.json', list); }

  getWorkspaces() { return this.read('workspaces.json'); }
  saveWorkspaces(data) { this.write('workspaces.json', data); }

  getApps() { return this.read('apps.json'); }
  saveApps(data) { this.write('apps.json', data); }

  getSettings() { return this.read('settings.json'); }
  saveSettings(data) { this.write('settings.json', data); }

  // Per-workspace open views: { [wsId]: { tabs: [{id, providerId}],
  // groups: [{ id, name, tree, focus, zoom }], activeGroup, filesRatio } }
  getViews() { return this.read('views.json'); }
  saveViews(data) { this.write('views.json', data); }
}

module.exports = { ConfigStore };
