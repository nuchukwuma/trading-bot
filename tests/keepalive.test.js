'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { startKeepAlive } = require('../src/index');

function get(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

const listening = (server) =>
  new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));

test('keep-alive: answers on its port so the host sees the app running', async () => {
  const server = startKeepAlive(0); // 0 = any free port
  await listening(server);
  const res = await get(server.address().port);
  assert.equal(res.status, 200);
  assert.equal(res.body, 'SMC bot alive');
  await new Promise((r) => server.close(r));
});

test('keep-alive: a port already in use is logged, not thrown', async () => {
  const first = startKeepAlive(0);
  await listening(first);
  const port = first.address().port;

  const second = startKeepAlive(port);
  const failed = await new Promise((resolve) => second.once('error', () => resolve(true)));
  assert.equal(failed, true, 'the clash surfaces as an error event the handler absorbs');

  await new Promise((r) => first.close(r));
});

test('keep-alive: requiring the entry file does not open a port', () => {
  // The server starts inside main(), never at module load. If it opened on
  // require, this child process would never exit and spawnSync would time out.
  const { spawnSync } = require('child_process');
  const path = require('path');
  const child = spawnSync(process.execPath, ['-e', "require('./src/index')"], {
    cwd: path.join(__dirname, '..'),
    timeout: 15000,
    env: { ...process.env, PORT: '0' },
  });
  assert.equal(child.error, undefined, 'the process exited on its own instead of hanging');
  assert.equal(child.status, 0);
});
