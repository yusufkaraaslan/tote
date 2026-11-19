import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webUrl } from '../src/web.js';
test('web URLs are explicit HTTP(S), with actionable loopback guidance', () => {
  assert.equal(webUrl(' https://chatgpt.com '), 'https://chatgpt.com/');
  assert.equal(webUrl('http://100.64.1.2:3080/?token=test'), 'http://100.64.1.2:3080/?token=test');
  for (const value of ['javascript:alert(1)', 'file:///private', 'intent://app', 'https://user:secret@example.com', 'example.com']) assert.throws(() => webUrl(value));
  for (const value of ['http://127.0.0.1:3080', 'http://127.1', 'http://localhost.', 'http://a.localhost', 'http://[::1]']) assert.throws(() => webUrl(value), /points to the phone/);
});
