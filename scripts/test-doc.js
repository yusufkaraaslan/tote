#!/usr/bin/env node
// Dependency-free tests for the doc panes: the markdown parser and the
// extension -> kind map. Run: node scripts/test-doc.js
const assert = require('assert');
const M = require('../src/renderer/markdown.js');

let pass = 0, fail = 0;
const describe = (name, fn) => { console.log('\n' + name); fn(); };
const test = (name, fn) => {
  try { fn(); pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  catch (e) { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message); }
};
const txt = (s) => ({ type: 'text', text: s });

describe('parse: headings', () => {
  test('# through ###### set the level', () => {
    assert.deepStrictEqual(M.parse('# Tote'), [{ type: 'heading', level: 1, spans: [txt('Tote')] }]);
    assert.strictEqual(M.parse('###### deep')[0].level, 6);
  });
  test('seven hashes is a paragraph, not a heading', () => {
    assert.strictEqual(M.parse('####### nope')[0].type, 'paragraph');
  });
  test('a hash with no space is a paragraph', () => {
    assert.strictEqual(M.parse('#tag')[0].type, 'paragraph');
  });
});

describe('parse: paragraphs and hr', () => {
  test('blank lines separate paragraphs', () => {
    assert.strictEqual(M.parse('one\n\ntwo').length, 2);
  });
  test('consecutive lines join into one paragraph', () => {
    assert.deepStrictEqual(M.parse('one\ntwo')[0].spans, [txt('one\ntwo')]);
  });
  test('--- and *** are horizontal rules', () => {
    assert.deepStrictEqual(M.parse('---'), [{ type: 'hr' }]);
    assert.strictEqual(M.parse('***')[0].type, 'hr');
  });
  test('an empty document is an empty list', () => {
    assert.deepStrictEqual(M.parse(''), []);
    assert.deepStrictEqual(M.parse('\n\n  \n'), []);
  });
});

describe('parse: fenced code', () => {
  test('keeps the language and the body verbatim', () => {
    const b = M.parse('```js\nlet a = 1;\n```')[0];
    assert.deepStrictEqual(b, { type: 'code', lang: 'js', text: 'let a = 1;' });
  });
  test('tilde fences work too', () => {
    assert.strictEqual(M.parse('~~~\nx\n~~~')[0].type, 'code');
  });
  test('an unclosed fence runs to the end of the document', () => {
    assert.deepStrictEqual(M.parse('```\nx\ny')[0].text, 'x\ny');
  });
  test('markdown inside a fence is not parsed', () => {
    assert.strictEqual(M.parse('```\n# not a heading\n```')[0].text, '# not a heading');
  });
});

describe('parse: inline spans', () => {
  test('**bold** and *italic* and _italic_', () => {
    assert.deepStrictEqual(M.parse('a **b** c')[0].spans,
      [txt('a '), { type: 'strong', spans: [txt('b')] }, txt(' c')]);
    assert.strictEqual(M.parse('*i*')[0].spans[0].type, 'em');
    assert.strictEqual(M.parse('_i_')[0].spans[0].type, 'em');
  });
  test('~~strike~~', () => {
    assert.strictEqual(M.parse('~~gone~~')[0].spans[0].type, 'strike');
  });
  test('inline code is literal, asterisks inside are not emphasis', () => {
    assert.deepStrictEqual(M.parse('`a * b`')[0].spans, [{ type: 'code', text: 'a * b' }]);
  });
  test('a backslash escapes a marker', () => {
    assert.deepStrictEqual(M.parse('\\*not em\\*')[0].spans, [txt('*not em*')]);
  });
  test('an unclosed marker stays literal', () => {
    assert.deepStrictEqual(M.parse('a * b')[0].spans, [txt('a * b')]);
  });
});

describe('parse: links and images', () => {
  test('an http link keeps its href', () => {
    assert.deepStrictEqual(M.parse('[t](https://x.dev)')[0].spans,
      [{ type: 'link', href: 'https://x.dev', spans: [txt('t')] }]);
  });
  test('a relative link is kept for in-app navigation', () => {
    assert.strictEqual(M.parse('[a](./docs/a.md)')[0].spans[0].href, './docs/a.md');
  });
  test('a javascript: link degrades to plain text', () => {
    assert.deepStrictEqual(M.parse('[x](javascript:alert(1))')[0].spans, [txt('[x](javascript:alert(1))')]);
  });
  test('a data: link degrades to plain text', () => {
    assert.strictEqual(M.parse('[x](data:text/html,<script>)')[0].spans[0].type, 'text');
  });
  test('mailto is allowed', () => {
    assert.strictEqual(M.parse('[m](mailto:a@b.c)')[0].spans[0].type, 'link');
  });
  test('an image keeps src and alt', () => {
    assert.deepStrictEqual(M.parse('![alt](a.png)')[0].spans, [{ type: 'image', src: 'a.png', alt: 'alt' }]);
  });
});

describe('parse: html is never markup', () => {
  test('a script tag is literal text', () => {
    assert.deepStrictEqual(M.parse('<script>alert(1)</script>')[0].spans,
      [txt('<script>alert(1)</script>')]);
  });
  test('an img with onerror is literal text', () => {
    assert.strictEqual(M.parse('<img src=x onerror=alert(1)>')[0].spans[0].type, 'text');
  });
});

describe('parse: lists', () => {
  test('a dash list becomes one unordered block', () => {
    const b = M.parse('- a\n- b')[0];
    assert.strictEqual(b.type, 'list');
    assert.strictEqual(b.ordered, false);
    assert.strictEqual(b.items.length, 2);
    assert.deepStrictEqual(b.items[0].spans, [txt('a')]);
  });
  test('*, - and + all start a list', () => {
    for (const m of ['*', '-', '+']) assert.strictEqual(M.parse(m + ' x')[0].type, 'list');
  });
  test('an ordered list keeps its start number', () => {
    const b = M.parse('3. a\n4. b')[0];
    assert.strictEqual(b.ordered, true);
    assert.strictEqual(b.start, 3);
  });
  test('an indented item nests as blocks on its parent', () => {
    const b = M.parse('- a\n  - b')[0];
    assert.strictEqual(b.items.length, 1);
    assert.strictEqual(b.items[0].blocks[0].type, 'list');
    assert.deepStrictEqual(b.items[0].blocks[0].items[0].spans, [txt('b')]);
  });
  test('a task list records checked state', () => {
    const b = M.parse('- [x] done\n- [ ] todo')[0];
    assert.strictEqual(b.items[0].checked, true);
    assert.deepStrictEqual(b.items[0].spans, [txt('done')]);
    assert.strictEqual(b.items[1].checked, false);
  });
  test('a plain item has checked null', () => {
    assert.strictEqual(M.parse('- a')[0].items[0].checked, null);
  });
  test('a lazy continuation line joins the item', () => {
    assert.deepStrictEqual(M.parse('- a\n  more')[0].items[0].spans, [txt('a\nmore')]);
  });
  test('a blank line ends the list', () => {
    assert.strictEqual(M.parse('- a\n\npara').length, 2);
  });
  test('inline markup inside an item is parsed', () => {
    assert.strictEqual(M.parse('- **b**')[0].items[0].spans[0].type, 'strong');
  });
  test('a change of marker type starts a new list', () => {
    const bs = M.parse('- a\n1. b');
    assert.strictEqual(bs.length, 2);
    assert.strictEqual(bs[0].ordered, false);
    assert.strictEqual(bs[1].ordered, true);
  });
  test('a blank line does not merge a bullet list into an ordered one', () => {
    const bs = M.parse('- a\n\n1. b\n2. c');
    assert.strictEqual(bs.length, 2);
    assert.strictEqual(bs[0].items.length, 1);
    assert.strictEqual(bs[1].items.length, 2);
    assert.strictEqual(bs[1].ordered, true);
  });
  test('a blank line between items of the same type keeps one list', () => {
    const b = M.parse('- a\n\n- b');
    assert.strictEqual(b.length, 1);
    assert.strictEqual(b[0].items.length, 2);
  });
  test('a hyphen rule is not a list', () => {
    assert.strictEqual(M.parse('- - -')[0].type, 'hr');
  });
});

describe('parse: blockquotes', () => {
  test('> lines become a quote holding blocks', () => {
    const b = M.parse('> hi')[0];
    assert.strictEqual(b.type, 'quote');
    assert.deepStrictEqual(b.blocks[0].spans, [txt('hi')]);
  });
  test('a quote can hold a heading and a list', () => {
    const b = M.parse('> # h\n> - a')[0];
    assert.strictEqual(b.blocks[0].type, 'heading');
    assert.strictEqual(b.blocks[1].type, 'list');
  });
  test('nested quotes nest', () => {
    assert.strictEqual(M.parse('> > deep')[0].blocks[0].type, 'quote');
  });
});

describe('parse: tables', () => {
  test('a header plus delimiter plus rows', () => {
    const b = M.parse('| a | b |\n| --- | --- |\n| 1 | 2 |')[0];
    assert.strictEqual(b.type, 'table');
    assert.deepStrictEqual(b.head[0], [txt('a')]);
    assert.strictEqual(b.rows.length, 1);
    assert.deepStrictEqual(b.rows[0][1], [txt('2')]);
  });
  test('the delimiter row sets alignment', () => {
    const b = M.parse('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')[0];
    assert.deepStrictEqual(b.align, ['left', 'center', 'right']);
  });
  test('a missing cell is an empty cell, not a dropped column', () => {
    const b = M.parse('| a | b |\n| --- | --- |\n| 1 |')[0];
    assert.strictEqual(b.rows[0].length, 2);
    assert.deepStrictEqual(b.rows[0][1], []);
  });
  test('leading and trailing pipes are optional', () => {
    assert.strictEqual(M.parse('a | b\n--- | ---\n1 | 2')[0].type, 'table');
  });
  test('a header with no delimiter row stays a paragraph', () => {
    assert.strictEqual(M.parse('| a | b |\nnope')[0].type, 'paragraph');
  });
  test('an escaped pipe does not split a cell', () => {
    const b = M.parse('| a | b |\n| --- | --- |\n| x \\| y | 2 |')[0];
    assert.deepStrictEqual(b.rows[0][0], [txt('x | y')]);
  });
});

const { docKind } = require('../src/main/workspace.js');

describe('docKind', () => {
  test('markdown is its own kind', () => {
    assert.strictEqual(docKind('a.md'), 'md');
    assert.strictEqual(docKind('a.markdown'), 'md');
  });
  test('the rest of TEXT_EXT is text', () => {
    for (const n of ['a.js', 'a.json', 'a.py', 'a.yml', 'a.log', '.gitignore'])
      assert.strictEqual(docKind(n), 'text');
  });
  test('images are image', () => {
    for (const n of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.ico'])
      assert.strictEqual(docKind(n), 'image');
  });
  test('svg is an image even though it is also text', () => {
    assert.strictEqual(docKind('a.svg'), 'image');
  });
  test('pdf is pdf', () => {
    assert.strictEqual(docKind('a.pdf'), 'pdf');
  });
  test('anything else is binary', () => {
    for (const n of ['a.zip', 'a.mp4', 'noextension']) assert.strictEqual(docKind(n), 'binary');
  });
  test('the extension match is case-insensitive', () => {
    assert.strictEqual(docKind('README.MD'), 'md');
  });
  test('a path, not just a bare name, classifies by its extension', () => {
    assert.strictEqual(docKind('docs/notes/a.md'), 'md');
  });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
