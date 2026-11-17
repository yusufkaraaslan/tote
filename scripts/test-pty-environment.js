const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { Terminal } = require('@xterm/headless');
const { PtyManager } = require('../src/main/ptyManager');

test('real PTYs advertise color despite a color-disabled launcher', { timeout: 15000 }, async () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  const manager = new PtyManager();
  try {
    let output = '';
    const probe = `
      const ok = process.stdout.isTTY && !('NO_COLOR' in process.env)
        && process.env.TERM === 'xterm-256color' && process.env.COLORTERM === 'truecolor';
      process.stdout.write(ok ? '\\x1b[31mPTY_COLOR_OK\\x1b[0m\\r\\n' : 'PTY_COLOR_DISABLED\\r\\n');
    `;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Color probe PTY timed out')), 10000);
      try {
        manager.launch({ file: process.execPath, args: ['-e', probe], cwd: os.tmpdir(), cols: 120, rows: 24 }, null,
          data => { output += data; },
          code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error('Color probe exit: ' + code)); });
      } catch (error) { clearTimeout(timer); reject(error); }
    });
    // ConPTY can normalize escape sequences; check the rendered color instead
    // of requiring byte-identical SGR output on every platform.
    const terminal = new Terminal({ cols: 120, rows: 24, allowProposedApi: true });
    try {
      await new Promise(resolve => terminal.write(output, resolve));
      let cell;
      for (let i = 0; i < terminal.buffer.active.length; i++) {
        const line = terminal.buffer.active.getLine(i);
        const start = line.translateToString(true).indexOf('PTY_COLOR_OK');
        if (start !== -1) { cell = line.getCell(start); break; }
      }
      assert(cell && !cell.isFgDefault(), 'PTY child detects an interactive color terminal and emits colored text');
    } finally { terminal.dispose(); }
    assert.equal(process.env.NO_COLOR, '1', 'PTY setup must not mutate the host environment');
  } finally {
    manager.killAll();
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
