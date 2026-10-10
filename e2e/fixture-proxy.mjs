import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_BODY_BYTES = 4096;

// All certificates and keys are generated inside a disposable test directory.
// The CA is trusted only by the harness's new Firefox profile, never by the OS.
async function certificates(root, hostname) {
  const file = name => path.join(root, name);
  const openssl = args => execute(process.env.BD_OPENSSL || 'openssl', args,
    { timeout: 15_000, windowsHide: true });
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', file('ca.key'), '-out', file('ca.pem'), '-days', '2',
    '-subj', '/CN=BlockDistraction E2E Test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', file('server.key'), '-out', file('server.csr'),
    '-subj', `/CN=${hostname}`]);
  await writeFile(file('server.ext'), [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth', `subjectAltName=DNS:${hostname}`
  ].join('\n'));
  await openssl(['x509', '-req', '-in', file('server.csr'),
    '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial',
    '-out', file('server.pem'), '-days', '2', '-extfile', file('server.ext')]);
  return { ca: await readFile(file('ca.pem'), 'utf8'),
    key: await readFile(file('server.key')), cert: await readFile(file('server.pem')) };
}

async function jsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    assert.ok(size <= MAX_BODY_BYTES, 'verification payload exceeds fixture limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Real HTTP/TLS at the unchanged production URL, served only on loopback.
// There is no outbound connection or forwarding path in this proxy.
export async function createFixtureProxy({ root, html, verifyUrl, expectedPayload,
  verificationHandler, onVerification = () => {}, onEvent = () => {}, onError = () => {}, onTlsError = () => {} }) {
  const target = new URL(verifyUrl);
  assert.equal(target.protocol, 'https:');
  assert.equal(target.port, '');
  const tls = await certificates(root, target.hostname);
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  const respond = (response, status, body, contentType) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body), connection: 'close',
      'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type' });
    response.end(body);
  };
  const deny = response => respond(response, 502, 'BD E2E offline', 'text/plain');
  const secure = createHttpsServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    const url = new URL(request.url, target.origin);
    if (request.headers.host !== target.host || url.href !== target.href) {
      deny(response); return;
    }
    if (request.method === 'OPTIONS') {
      onEvent({ url: url.href, method: 'OPTIONS', status: 204, at: Date.now() });
      respond(response, 204, '', 'application/json'); return;
    }
    (async () => {
      assert.equal(request.method, 'POST', 'license mock only accepts POST');
      const payload = await jsonBody(request);
      assert.deepEqual(payload, expectedPayload, 'native verification key and manifest version');
      onVerification({ method: request.method, payload, transport: 'https-proxy' });
      const reply = await verificationHandler();
      onEvent({ url: url.href, method: request.method, status: reply.status, at: Date.now() });
      respond(response, reply.status, JSON.stringify(reply.body), 'application/json');
    })().catch(error => {
      onError(error);
      respond(response, 502, 'BD E2E fixture error', 'text/plain');
    });
  });
  // A disconnected/aborted client is allowed; malformed fixture payloads above
  // remain failures and are recorded separately by onError.
  secure.on('tlsClientError', (error, socket) => {
    onTlsError({ code: error.code, message: error.message });
    socket.destroy();
  });
  secure.on('clientError', (_error, socket) => socket.destroy());
  const server = createServer((request, response) => {
    let url;
    try { url = new URL(request.url); } catch { deny(response); return; }
    if (url.protocol !== 'http:' || !url.hostname.endsWith('.bd-e2e.test') ||
        !['GET', 'HEAD'].includes(request.method)) {
      deny(response); return;
    }
    onEvent({ url: url.href, method: request.method, status: 200, at: Date.now() });
    respond(response, 200, request.method === 'HEAD' ? '' : typeof html === 'function' ? html(url) : html, 'text/html');
  });
  server.on('connection', track);
  server.on('connect', (request, socket, head) => {
    if (request.url !== `${target.hostname}:443`) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    // Hand the existing loopback socket to the TLS server; no DNS lookup and
    // no connection to the real domain is made.
    secure.emit('connection', socket);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', onError);
  return { port: server.address().port, ca: tls.ca,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}
