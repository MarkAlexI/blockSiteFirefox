import { createServer } from 'node:http';

// Real loopback responses, including Location headers. Nothing is fulfilled
// through Playwright/BiDi, and the server never contacts an external host.
export async function startNavigationHttpFixture() {
  const requests = [], sockets = new Set();
  let origin;
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    const entry = { path: url.pathname, at: Date.now() }; requests.push(entry);
    response.on('finish', () => { entry.status = response.statusCode; entry.location = response.getHeader('location') ?? null; });
    response.setHeader('cache-control', 'no-store');
    if (/^\/server\/(301|302)$/.test(url.pathname)) {
      const status = Number(url.pathname.split('/').at(-1));
      // Bound the unfixed baseline too: fail the test instead of leaving a
      // browser in an unbounded loop while gathering its failure evidence.
      const hits = requests.filter(item => item.path === url.pathname).length;
      response.writeHead(hits <= 6 ? status : 508,
        hits <= 6 ? { location: `${origin}/blocked/${status}` } : {});
      response.end('server redirect fixture'); return;
    }
    if (url.pathname === '/server/safe-301' || url.pathname === '/server/safe-302') {
      const first = url.pathname.endsWith('301');
      response.writeHead(first ? 301 : 302, { location: `${origin}${first ? '/server/safe-302' : '/landing'}` });
      response.end(); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>BD navigation fixture</title></head><body><h1>BD navigation fixture</h1></body></html>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests,
    owns: url => url.protocol === 'http:' && url.origin === origin,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
