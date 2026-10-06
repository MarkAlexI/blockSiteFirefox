import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { allocateLoopbackPorts } from '../e2e/ports.mjs';

test('Firefox driver, Marionette and BiDi receive distinct released loopback ports', async () => {
  const ports = await allocateLoopbackPorts(3);
  assert.equal(ports.length, 3);
  assert.equal(new Set(ports).size, 3);
  const servers = ports.map(() => createServer());
  try {
    await Promise.all(servers.map((server, index) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(ports[index], '127.0.0.1', resolve);
    })));
    assert.deepEqual(servers.map(server => server.address().port), ports);
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server =>
      new Promise(resolve => server.close(resolve))));
  }
});
