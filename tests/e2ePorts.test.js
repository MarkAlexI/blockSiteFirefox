import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { allocateLoopbackPorts, assertLoopbackPortsAvailable } from '../e2e/ports.mjs';

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


test('an occupied pre-launch port is an explicit setup failure and all other probes are released', async () => {
  const ports = await allocateLoopbackPorts(3);
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(ports[1], '127.0.0.1', resolve));
  try {
    await assert.rejects(assertLoopbackPortsAvailable(ports), /Firefox setup port .* unavailable: EADDRINUSE/);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  await assertLoopbackPortsAvailable(ports);
});
