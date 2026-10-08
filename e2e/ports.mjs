import { createServer } from 'node:net';

// Keep every selected socket bound until all ports have been chosen. This
// prevents a sequential free-port probe from selecting the same port twice.
export async function allocateLoopbackPorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server =>
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  }
}

// This is an early collision check, not a claim of reservation until exec.
export async function assertLoopbackPortsAvailable(ports) {
  if (ports.length !== 3 || new Set(ports).size !== 3 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Firefox launch requires three distinct valid ports.');
  }
  const servers = [];
  try {
    for (const port of ports) {
      const server = createServer(); servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', error => reject(new Error(`Firefox setup port ${port} unavailable: ${error.code}`, { cause: error })));
        server.listen(port, '127.0.0.1', resolve);
      });
    }
  } finally {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
  }
}
