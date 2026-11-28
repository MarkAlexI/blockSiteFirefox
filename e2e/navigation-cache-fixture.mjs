import { createServer } from 'node:http';

const documentHtml = (source, extra = '') => `<!doctype html><html><head><title>BD navigation boundary fixture</title></head><body data-source="${source}"><h1>BD navigation boundary fixture</h1>${extra}</body></html>`;
const historyProbe = `<script>
window.__bdHistoryDocument = { token: crypto.randomUUID(), timeOrigin: performance.timeOrigin };
addEventListener('pageshow', event => {
  const events = JSON.parse(sessionStorage.getItem('bd-history-events') || '[]');
  events.push({ path: location.pathname, persisted: event.persisted, ...window.__bdHistoryDocument });
  sessionStorage.setItem('bd-history-events', JSON.stringify(events));
});
</script>`;

// Genuine browser cache and service-worker responses. The fixture is never
// fulfilled through automation and has no route to a public website.
export async function startNavigationCacheFixture() {
  const requests = [], sockets = new Set();
  let origin;
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin);
    const entry = { path: url.pathname, at: Date.now() }; requests.push(entry);
    response.on('finish', () => { entry.status = response.statusCode; });
    response.setHeader('cache-control', 'no-store');
    if (url.pathname === '/cache/sw/worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(`
const cached = ${JSON.stringify(documentHtml('cache-storage'))};
const generated = ${JSON.stringify(documentHtml('service-worker-response'))};
addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open('bd-navigation-boundary-v1');
  await cache.put('/cache/sw/cached', new Response(cached, { headers: { 'content-type': 'text/html' } }));
  await skipWaiting();
})()));
addEventListener('activate', event => event.waitUntil(clients.claim()));
addEventListener('fetch', event => {
  const path = new URL(event.request.url).pathname;
  if (path === '/cache/sw/cached') event.respondWith(caches.match('/cache/sw/cached'));
  if (path === '/cache/sw/generated') event.respondWith(new Response(generated, { headers: { 'content-type': 'text/html' } }));
});`);
      return;
    }
    const redirect = /^\/cache\/redirect\/(301|302)$/.exec(url.pathname);
    if (redirect) {
      response.writeHead(Number(redirect[1]), { 'cache-control': 'public, max-age=3600',
        location: `${origin}/cache/landing/${redirect[1]}` });
      response.end(); return;
    }
    if (url.pathname.startsWith('/cache/history/')) response.setHeader('cache-control', 'public, max-age=600');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(documentHtml('network', url.pathname.startsWith('/cache/history/') ? historyProbe : ''));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, owns: url => url.protocol === 'http:' && url.origin === origin,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
