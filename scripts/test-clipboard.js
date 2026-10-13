const assert = require('node:assert/strict');
const { create } = require('../src/renderer/termclipboard');
const { editMenu } = require('../src/main/editMenu');

async function run() {
  let copied, pasted, focused = 0, prevented = 0;
  const text = 'first\nsecond\n';
  const term = { getSelection: () => 'selected output', paste: (s) => { pasted = s; }, focus: () => focused++ };
  const clipboard = { writeText: async (s) => { copied = s; }, readText: async () => text };
  const clip = create(term, clipboard);
  const event = (key, extra = {}) => ({ type: 'keydown', key, ctrlKey: true, shiftKey: true,
    altKey: false, metaKey: false, preventDefault: () => prevented++, ...extra });
  assert.equal(clip.key(event('C')), false);
  assert.equal(copied, 'selected output');
  assert.equal(clip.key(event('c', { shiftKey: false })), true, 'Ctrl+C must still interrupt');
  assert.equal(clip.key(event('v', { shiftKey: false })), true, 'Ctrl+V belongs to the terminal');
  assert.equal(clip.key(event('C', { altKey: true })), true);
  assert.equal(clip.key(event('V')), false);
  await Promise.resolve();
  assert.equal(pasted, text, 'paste goes through xterm with newlines intact');
  assert.equal(focused, 1);
  assert.equal(clip.key(event('V', { type: 'keyup' })), false);
  await Promise.resolve();
  assert.equal(focused, 1, 'keyup must not paste again');
  assert.equal(prevented, 3);
  const mac = create(term, clipboard, { mac: true });
  assert.equal(mac.key(event('c', { ctrlKey: false, metaKey: true, shiftKey: false })), false);
  assert.equal(mac.key(event('c', { shiftKey: false })), true);
  let error;
  await create(term, { readText: async () => { throw new Error('denied'); } },
    { onError: (e) => { error = e.message; } }).paste();
  assert.equal(error, 'denied');

  // Native actions target the clicked guest, including when focus changes.
  let destroyed = false, action;
  const guest = { isDestroyed: () => destroyed, copy: () => { action = 'copy'; }, paste: () => { action = 'paste'; } };
  const menu = editMenu(guest, { isEditable: true, editFlags: { canCopy: true, canPaste: true } }, clipboard);
  assert.equal(menu.find((i) => i.label === 'Cut').enabled, false);
  menu.find((i) => i.label === 'Paste').click();
  assert.equal(action, 'paste');
  destroyed = true;
  menu.find((i) => i.label === 'Copy').click();
  assert.equal(action, 'paste', 'closed guests are ignored');
  assert.deepEqual(editMenu(guest, {}, clipboard), [], 'do not replace structural menus with an empty edit menu');
  const selection = editMenu(guest, { selectionText: 'hello', editFlags: { canCopy: true } }, clipboard);
  assert.deepEqual(selection.map((i) => i.label), ['Copy']);
  const link = editMenu(guest, { linkURL: 'https://example.com/' }, clipboard);
  link[0].click();
  assert.equal(copied, 'https://example.com/');
  console.log('Clipboard and edit menu tests passed');
}
run().catch((e) => { console.error(e); process.exitCode = 1; });
