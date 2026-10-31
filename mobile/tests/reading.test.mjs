import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readableTerminal } from '../src/reading.js';
const require = createRequire(import.meta.url);
const { Terminal } = require('../../node_modules/@xterm/headless');
const write = (t,text) => new Promise(resolve => t.write(text,resolve));
test('phone reading joins soft wraps, keeps real line breaks, and parses ANSI', async () => {
  const term = new Terminal({cols:10,rows:8,allowProposedApi:true});
  try {
    await write(term,'\x1b[31malpha beta gamma delta\x1b[0m\r\n\r\nNext line');
    assert.equal(readableTerminal(term.buffer.active),'alpha beta gamma delta\n\nNext line');
    assert.equal(term.cols,10,'reading never resizes the terminal');
    await write(term,'\r\x1b[2KReplacement');
    assert.equal(readableTerminal(term.buffer.active),'alpha beta gamma delta\n\nReplacement');
  } finally { term.dispose(); }
});
test('reading follows alternate-screen updates and leaves HTML literal', async () => {
  const term = new Terminal({cols:40,rows:8,allowProposedApi:true});
  try {
    await write(term,'Old log\x1b[?1049h\x1b[H<script>literal</script>\r\nNew screen');
    const text=readableTerminal(term.buffer.active);
    assert.equal(text,'<script>literal</script>\nNew screen');
    assert(!text.includes('Old log'));
    await write(term,'\x1b[?1049l');assert(readableTerminal(term.buffer.active).includes('Old log'));
  } finally { term.dispose(); }
});
