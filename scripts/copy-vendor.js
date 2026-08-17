// Postinstall: (1) copies xterm.js assets into the renderer so no bundler is
// needed; (2) restores the exec bit on node-pty's prebuilt spawn-helper, which
// npm strips on extract — without it every spawn fails with "posix_spawnp failed".
const fs = require('fs');
const path = require('path');

const FILES = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

const outDir = path.join(__dirname, '..', 'src', 'renderer', 'vendor');
fs.mkdirSync(outDir, { recursive: true });

for (const [mod, name] of FILES) {
  const src = require.resolve(mod);
  fs.copyFileSync(src, path.join(outDir, name));
  console.log('vendored:', name);
}

if (process.platform !== 'win32') {
  const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
  let dirs = [];
  try { dirs = fs.readdirSync(prebuilds); } catch {}
  for (const d of dirs) {
    const helper = path.join(prebuilds, d, 'spawn-helper');
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log('chmod +x:', path.relative(process.cwd(), helper));
    }
  }
}
