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
