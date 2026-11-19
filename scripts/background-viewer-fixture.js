// Real Electron main/preload/renderer, launched only by test-background-ui.js.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.TOTE_HOST_UI_TEST_DIR, phase = process.env.TOTE_HOST_UI_TEST_PHASE;
if (!dir || !['create', 'reopen', 'after-crash'].includes(phase)) throw Error('Missing isolated background UI fixture');
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(30); }
  throw Error('Background UI fixture timed out');
}
app.on('browser-window-created', (_event, win) => win.webContents.setBackgroundThrottling(false));
require('../src/main/main');
(async () => {
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0]);
  const run = code => win.webContents.executeJavaScript(code, true);
  await until(() => run("typeof state !== 'undefined' && state.sliceLoaded"));
  if (process.platform !== 'darwin') {
    assert.equal(win.isMenuBarAutoHide(), true);
    assert.equal(win.isMenuBarVisible(), false);
  }
  if (phase === 'create') {
    await run("spawnTerm(state.profiles.find(p => p.id === 'probe'))");
    await until(() => run('[...state.terms.values()].some(t => t.alive)'));
    await run('layoutSync().flush()');
    const sid = await run('[...state.terms.keys()][0]');
    fs.writeFileSync(path.join(dir, 'session'), sid);
    await run(`tote.ptyWrite(${JSON.stringify(sid)}, ${JSON.stringify("TOTE_UI_MARKER=still_running\r")})`);
  } else {
    const sid = fs.readFileSync(path.join(dir, 'session'), 'utf8');
    await until(() => run(`state.terms.get(${JSON.stringify(sid)})?.alive`));
    const query = "printf '\\nSURVIVED-%s\\n' \"$TOTE_UI_MARKER\"\r";
    await run(`tote.ptyWrite(${JSON.stringify(sid)}, ${JSON.stringify(query)})`);
    await until(() => run(`(()=>{ const b=state.terms.get(${JSON.stringify(sid)}).term.buffer.active; return Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString()).some(line => line.includes('SURVIVED-still_running')); })()`));
    assert.equal(await run('!!state.deviceDown'), false);
  }
  const status = await run('tote.hostStatus()');
  fs.writeFileSync(path.join(dir, phase + '.ready'), JSON.stringify(status));
  setInterval(() => { if (fs.existsSync(path.join(dir, 'close'))) app.quit(); }, 100);
})().catch(error => { fs.writeFileSync(path.join(dir, phase + '.error'), error.stack); app.exit(1); });
setTimeout(() => app.exit(1), 60000).unref();
