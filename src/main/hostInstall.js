// Keep a packaged host's executable/resources outside the desktop install.
// An installer may replace the UI while the old host still owns live PTYs.
// Never overwrite or garbage-collect a runtime that could still be running.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const disk = process.versions.electron ? require('original-fs') : fs;

async function installRuntime({ dataDir, executable, appPath, packaged, platform = process.platform }) {
  if (!packaged) return { executable, entry: path.join(appPath, 'src/host/daemon.js') };
  const hash = crypto.createHash('sha256');
  for await (const chunk of disk.createReadStream(appPath)) hash.update(chunk);
  const id = hash.digest('hex').slice(0, 24);
  const source = platform === 'darwin' ? path.resolve(executable, '../../..') : path.dirname(executable);
  const root = path.join(dataDir, 'host-runtimes');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const relative = path.relative(source, root);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw Error('Host runtime cache must be outside the app installation');
  const target = path.join(root, id);
  const app = platform === 'darwin' ? path.join(target, 'Tote.app') : path.join(target, 'app');
  if (!fs.existsSync(path.join(target, 'complete'))) {
    const staging = fs.mkdtempSync(path.join(root, '.install-'));
    try {
      const copy = path.join(staging, path.basename(app));
      await disk.promises.cp(source, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
      fs.writeFileSync(path.join(staging, 'complete'), id, { mode: 0o600 });
      fs.renameSync(staging, target);
    } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  }
  const installedExe = path.join(app, path.relative(source, executable));
  const installedApp = path.join(app, path.relative(source, appPath));
  return { executable: installedExe, entry: path.join(installedApp, 'src/host/daemon.js') };
}
module.exports = { installRuntime };
