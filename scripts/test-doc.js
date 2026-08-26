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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
