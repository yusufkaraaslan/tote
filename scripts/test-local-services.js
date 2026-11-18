const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createLocalServices, startupUrl } = require('../src/main/localServices');

const provider = { id: 'local', url: 'http://127.0.0.1:3080', local: { startCommand: 'fixture', waitForUrl: true, startupUrlPrefix: 'dsh web:' } };
function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), unref() {} });
}

test('startup URLs preserve tokens but reject other origins and credentials', () => {
  assert.equal(startupUrl('Log: http://127.0.0.1:3080/unrelated', provider.url, 'dsh web:'), null);
  assert.equal(startupUrl('\x1b[32mdsh web: http://127.0.0.1:3080/?token=secret\x1b[0m\n', provider.url), provider.url + '/?token=secret');
  for (const url of ['https://example.com/?token=secret', 'http://127.0.0.1:9999/', 'http://user:secret@127.0.0.1:3080/']) {
    assert.equal(startupUrl(url, provider.url), null);
  }
});

test('an existing server is reused without launching a second process', async () => {
  const services = createLocalServices({ probe: async () => true, launch: () => assert.fail('must not spawn') });
  assert.deepEqual(await services.ensure(provider), { started: true, alreadyRunning: true, url: provider.url });
});

test('concurrent opens share startup and wait for the complete login URL', async () => {
  let running = false, launches = 0;
  const proc = child();
  const services = createLocalServices({
    interval: 1, timeout: 1000, probe: async () => running,
    launch: () => { launches++; running = true; return proc; },
  });
  const first = services.ensure(provider), second = services.ensure(provider);
  assert.equal(first, second);
  await new Promise(resolve => setTimeout(resolve, 10));
  let completed = false;
  first.then(() => { completed = true; });
  proc.stdout.write('dsh web: http://127.0.0.1:3080/?token=');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(completed, false);
  proc.stdout.write('complete-token\n');
  const result = await first;
  assert.equal(result.url, provider.url + '/?token=complete-token');
  assert.equal(launches, 1);
  proc.stdout.write('dsh web: http://127.0.0.1:3080/?token=unrelated-output\n');
  assert.equal((await services.ensure(provider)).url, result.url, 'later panes authenticate with the same live process');
  proc.emit('exit', 0);
  assert.equal((await services.ensure(provider)).url, provider.url, 'never reuse a token from an exited process');
});

test('spawn failures are handled promptly and raw output is not included in errors', async () => {
  const services = createLocalServices({
    interval: 1, timeout: 1000, probe: async () => false,
    launch: () => {
      const proc = child();
      setImmediate(() => { proc.stderr.write('secret-token\n'); proc.emit('error', Error('private path')); });
      return proc;
    },
  });
  await assert.rejects(services.ensure(provider), error => /exited/.test(error.message) && !/secret|private/.test(error.message));
});

test('startup timeout does not spawn duplicates on retry; exited services can restart', async () => {
  let launches = 0, proc;
  const services = createLocalServices({
    interval: 1, timeout: 10, probe: async () => false,
    launch: () => { launches++; return proc = child(); },
  });
  await assert.rejects(services.ensure(provider), /timeout/);
  await assert.rejects(services.ensure(provider), /timeout/);
  assert.equal(launches, 1);
  proc.emit('exit', 1);
  await assert.rejects(services.ensure(provider), /timeout/);
  assert.equal(launches, 2);
});

test('overlong output cannot contribute a truncated startup URL', async () => {
  let running = false;
  const proc = child();
  const services = createLocalServices({ interval: 1, timeout: 20, probe: async () => running,
    launch: () => {
      setImmediate(() => {
        running = true;
        proc.stdout.write('x'.repeat(9000));
        proc.stdout.write('dsh web: http://127.0.0.1:3080/?token=truncated\n');
      });
      return proc;
    },
  });
  await assert.rejects(services.ensure(provider), /timeout/);
});
