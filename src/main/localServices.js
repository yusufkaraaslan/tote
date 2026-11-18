// Local web providers belong to the viewer machine. Startup URLs (which can
// contain login tokens) stay in memory and never enter config or diagnostics.
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

function ping(url) {
  return new Promise(resolve => {
    let req;
    try {
      const client = new URL(url).protocol === 'https:' ? https : http;
      req = client.get(url, { timeout: 1500 }, res => {
        res.resume();
        // An authentication challenge still means the server is running.
        resolve(res.statusCode < 500);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

function startupUrl(line, base, prefix) {
  // Only consume complete lines, so a split token is never navigated to.
  const plain = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (prefix && !plain.trimStart().startsWith(prefix)) return null;
  for (const match of plain.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.origin === new URL(base).origin && !url.username && !url.password) return url.href;
    } catch {}
  }
  return null;
}

function createLocalServices({ probe = ping, launch = spawn, timeout = 90000, interval = 300 } = {}) {
  const pending = new Map();
  const launches = new Map();
  async function start(provider, key) {
    if (await probe(provider.url)) {
      return { started: true, alreadyRunning: true, url: launches.get(key)?.url || provider.url };
    }
    // Do not launch duplicates after a slow startup timed out.
    let record = launches.get(key);
    if (!record || record.exited) {
      record = { url: null, exited: false };
      launches.set(key, record);
      let child;
      try {
        child = launch(provider.local.startCommand, {
          shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { record.exited = true; throw Error('Could not start the local web service. Check its start command.'); }
      child.on('error', () => { record.exited = true; });
      child.on('exit', () => { record.exited = true; record.url = null; });
      for (const stream of [child.stdout, child.stderr]) {
        let buffer = '', dropping = false;
        stream.on('data', chunk => {
          // Bound each line and discard overlong lines, including their tails.
          for (const part of chunk.toString().split(/(?<=\n)/)) {
            if (!dropping) buffer += part;
            if (buffer.length > 8192) { buffer = ''; dropping = true; }
            if (part.endsWith('\n')) {
              if (!dropping && !record.url) record.url = startupUrl(buffer, provider.url, provider.local.startupUrlPrefix);
              buffer = ''; dropping = false;
            }
          }
        });
        stream.on('error', () => {});
        stream.unref?.();
      }
      child.unref();
    }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (record.exited) throw Error('The local web service exited before it was ready. Run its start command in a terminal to inspect the error.');
      if ((!provider.local.waitForUrl || record.url) && await probe(provider.url)) {
        return { started: true, alreadyRunning: false, url: record.url || provider.url };
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw Error('The local web service did not become ready within the startup timeout. Retry or paste its startup URL.');
  }
  return {
    ensure(provider) {
      const key = JSON.stringify([provider.id, provider.url, provider.local]);
      if (!pending.has(key)) {
        const promise = start(provider, key).finally(() => pending.delete(key));
        pending.set(key, promise);
      }
      return pending.get(key);
    },
  };
}

module.exports = { createLocalServices, startupUrl };
