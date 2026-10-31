import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/app.js'], bundle: true, outfile: 'dist/app.js', format: 'iife', target: 'chrome100' });
await Promise.all([
  copyFile('src/index.html', 'dist/index.html'), copyFile('src/styles.css', 'dist/styles.css'),
  copyFile('node_modules/@xterm/xterm/css/xterm.css', 'dist/xterm.css'),
]);
