import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readableTerminal, styledTerminal, TERMINAL_THEME } from '../src/reading.js';
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

test('reading preserves ANSI, 256-color, truecolor, background and inverse styles', async () => {
  const term=new Terminal({cols:80,rows:4,allowProposedApi:true});
  try {
    await write(term,'\x1b[31mred\x1b[0m \x1b[1;32mbold\x1b[0m \x1b[38;5;196mindexed\x1b[0m \x1b[38;2;12;34;56mtruecolor\x1b[0m \x1b[44;97mbackground\x1b[0m \x1b[7minverse\x1b[0m');
    const runs=styledTerminal(term.buffer.active),style=word=>runs.find(r=>r.text===word).style;
    assert.equal(style('red').color,TERMINAL_THEME.red);
    assert.equal(style('bold').color,TERMINAL_THEME.brightGreen);assert.equal(style('bold').fontWeight,'bold');
    assert.equal(style('indexed').color,'#ff0000');assert.equal(style('truecolor').color,'#0c2238');
    assert.equal(style('background').backgroundColor,TERMINAL_THEME.blue);
    assert.equal(style('inverse').color,TERMINAL_THEME.background);assert.equal(style('inverse').backgroundColor,TERMINAL_THEME.foreground);
  } finally {term.dispose();}
});
test('colored soft wraps preserve wide and combined characters and decorations', async () => {
  const term=new Terminal({cols:6,rows:8,allowProposedApi:true});
  try {
    await write(term,'\x1b[3;4;9;38;5;244m你好e\u0301 colored text\x1b[0m');
    const runs=styledTerminal(term.buffer.active);
    assert.equal(runs.map(r=>r.text).join(''),'你好e\u0301 colored text');
    assert.equal(runs[0].style.color,'#808080');assert.equal(runs[0].style.fontStyle,'italic');
    assert.equal(runs[0].style.textDecorationLine,'underline line-through');
  } finally {term.dispose();}
});
