import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { createFixtureProxy } from '../e2e/fixture-proxy.mjs';

const payload = { key: 'BD-E2E-VALID-KEY', version: '5.3.18' };
const verifyUrl = 'https://blockdistraction.com/api/verifyKey';

function httpRequest(port, target) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: target }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('HTTP fixture test timed out')));
  });
}

function connect(port, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method: 'CONNECT', path: target });
    request.on('connect', (response, socket) => resolve({ status: response.statusCode, socket }));
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('CONNECT fixture test timed out')));
    request.end();
  });
}

async function httpsRequest(proxy, { method = 'POST', body = payload,
  servername = 'blockdistraction.com', ca = proxy.ca, url = '/api/verifyKey' } = {}) {
  const tunnel = await connect(proxy.port, 'blockdistraction.com:443');
  assert.equal(tunnel.status, 200);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: tunnel.socket, servername, ca, rejectUnauthorized: true });
    socket.once('error', reject);
    socket.setTimeout(3000, () => socket.destroy(new Error('TLS fixture test timed out')));
    socket.once('secureConnect', () => {
      assert.equal(socket.authorized, true, 'real TLS verification must succeed');
      const bytes = method === 'OPTIONS' ? '' : JSON.stringify(body);
      socket.write(`${method} ${url} HTTP/1.1\r\nHost: blockdistraction.com\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(bytes)}\r\n` +
        `Connection: close\r\n\r\n${bytes}`);
    });
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('end', () => {
      const response = Buffer.concat(chunks).toString();
      const split = response.indexOf('\r\n\r\n');
      assert.ok(split > 0, 'fixture must send a complete HTTP response');
      resolve({ status: Number(response.split(' ')[1]), body: response.slice(split + 4) });
    });
  });
}

test('Firefox E2E proxy serves native HTTP/TLS without external forwarding', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bd-proxy-test-'));
  const calls = [], events = [], errors = [];
  let handler = async () => ({ status: 200, body: { isPro: true } });
  let proxy;
  try {
    proxy = await createFixtureProxy({ root, html: '<h1>Local fixture</h1>', verifyUrl,
      expectedPayload: payload, verificationHandler: () => handler(),
      onVerification: call => calls.push(call), onEvent: event => events.push(event),
      onError: error => errors.push(error) });

    await t.test('synthetic HTTP pages are local and other HTTP origins are denied', async () => {
      assert.deepEqual(await httpRequest(proxy.port, 'http://usage.bd-e2e.test/page'),
        { status: 200, body: '<h1>Local fixture</h1>' });
      assert.equal((await httpRequest(proxy.port, 'http://blockdistraction.com/api/verifyKey')).status, 502);
      assert.equal((await httpRequest(proxy.port, 'http://example.com/')).status, 502);
      assert.equal((await httpRequest(proxy.port, 'http://evil.bd-e2e.test.example.com/')).status, 502);
    });

    await t.test('only the exact verification TLS authority can open a tunnel', async () => {
      for (const authority of ['example.com:443', 'blockdistraction.com.evil:443', 'blockdistraction.com:8443']) {
        const denied = await connect(proxy.port, authority);
        try { assert.equal(denied.status, 502); } finally { denied.socket.destroy(); }
      }
    });

    await t.test('TLS requires the fixture CA and the correct hostname', async () => {
      await assert.rejects(httpsRequest(proxy, { ca: [] }),
        error => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
      await assert.rejects(httpsRequest(proxy, { servername: 'example.com' }),
        { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
      assert.equal(calls.length, 0);
    });

    await t.test('preflight does not count as verification and other HTTPS paths are denied', async () => {
      assert.equal((await httpsRequest(proxy, { method: 'OPTIONS' })).status, 204);
      assert.equal((await httpsRequest(proxy, { url: '/not-verification' })).status, 502);
      assert.equal(calls.length, 0);
    });

    await t.test('native JSON POST, HTTP 500 and later recovery reach the chosen handler', async () => {
      handler = async () => ({ status: 500, body: { error: 'temporary failure' } });
      const failed = await httpsRequest(proxy);
      assert.equal(failed.status, 500);
      assert.deepEqual(JSON.parse(failed.body), { error: 'temporary failure' });
      handler = async () => ({ status: 200, body: { isPro: true, licenseValid: true } });
      const recovered = await httpsRequest(proxy);
      assert.equal(recovered.status, 200);
      assert.deepEqual(JSON.parse(recovered.body), { isPro: true, licenseValid: true });
      assert.deepEqual(calls.map(call => call.payload), [payload, payload]);
    });

    await t.test('holding verification delays the real HTTP response, then releases it', async () => {
      let release, arrived;
      const held = new Promise(resolve => { release = resolve; });
      const received = new Promise(resolve => { arrived = resolve; });
      handler = async () => { arrived(); await held; return { status: 200, body: { isPro: true } }; };
      let finished = false;
      const response = httpsRequest(proxy).then(reply => { finished = true; return reply; });
      try {
        await received;
        assert.equal(finished, false);
        assert.equal(calls.length, 3, 'request is observable before its response');
      } finally { release(); }
      assert.equal((await response).status, 200);
    });

    await t.test('an unexpected key/version is recorded as an error and never reaches the handler', async () => {
      const rejected = await httpsRequest(proxy, { body: { ...payload, version: 'unexpected-version' } });
      assert.equal(rejected.status, 502);
      assert.equal(calls.length, 3);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /native verification key and manifest version/);
      assert.equal(events.filter(event => event.url === verifyUrl && event.method === 'POST').length, 3);
    });
  } finally {
    if (proxy) await proxy.close();
    await rm(root, { recursive: true, force: true });
  }
});
