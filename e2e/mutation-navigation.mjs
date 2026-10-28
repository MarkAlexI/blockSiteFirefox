import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export function createMutationNavigationProbe({ token = randomUUID(), port = '' } = {}) {
  assert.match(token, /^[a-z0-9-]+$/);
  const hosts = Object.fromEntries(['control', 'sentinel', 'old', 'edited', 'imported', 'study'].map(name =>
    [name, `${name}-${token}.bd-e2e.test`]));
  const receipts = [], observations = [];
  let sequence = 0, overflow = false;
  const owns = input => Object.values(hosts).includes(new URL(input).hostname);
  const url = (host, kind, attempt) => `http://${host}${port ? ':' + port : ''}/${token}/${kind}?attempt=${attempt}`;
  const htmlFor = input => {
    const target = new URL(input);
    if (!owns(target)) return null;
    const attempt = Number(target.searchParams.get('attempt'));
    const kind = target.pathname === `/${token}/control` ? 'control' : target.pathname === `/${token}/target` ? 'target' : null;
    if (!kind || !Number.isSafeInteger(attempt) || attempt < 1) return '<!doctype html><title>Invalid navigation probe</title>';
    if (receipts.length >= 1000) overflow = true;
    else receipts.push({ at: Date.now(), host: target.hostname, kind, attempt });
    return `<!doctype html><html data-mutation-token="${token}" data-attempt="${attempt}" data-kind="${kind}"><title>Mutation navigation fixture</title><body>Native HTTP receipt</body></html>`;
  };
  return { token, port, hosts, owns, htmlFor,
    snapshot: () => structuredClone({ token, receipts, observations, overflow }),
    async sample(page, host, { blocked, phase, extensionOrigin }) {
      assert.ok(Object.values(hosts).includes(host) && host !== hosts.control, 'owned ruled host');
      const attempt = ++sequence;
      const startedAt = Date.now();
      const inspect = () => page.evaluate(() => ({ url: location.href,
        token: document.documentElement.dataset.mutationToken,
        attempt: Number(document.documentElement.dataset.attempt), kind: document.documentElement.dataset.kind }));
      await page.goto(url(hosts.control, 'control', attempt));
      const control = await inspect();
      assert.equal(control.token, token, 'positive HTTP control is a genuine fixture document');
      assert.equal(control.attempt, attempt); assert.equal(control.kind, 'control');
      await page.goto(url(host, 'target', attempt));
      const document = await inspect();
      const observation = { attempt, phase, host, blocked, startedAt, endedAt: Date.now(), document, extensionOrigin };
      observations.push(observation);
      assertMutationNavigation({ token, receipts, observations: [observation], overflow });
      return observation;
    }
  };
}

export async function createMutationNavigationFixture() {
  let probe;
  const sockets = new Set();
  const server = createServer((request, response) => {
    const body = probe.htmlFor(new URL(request.url, `http://${request.headers.host}`));
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end(body ?? 'Unknown probe');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  probe = createMutationNavigationProbe({ port: server.address().port });
  return Object.assign(probe, { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } });
}

export function assertMutationNavigation({ token, receipts, observations, overflow }) {
  assert.equal(overflow, false, 'navigation evidence is complete');
  assert.ok(observations.length > 0, 'actual native navigation observations exist');
  for (const sample of observations) {
    const control = receipts.filter(item => item.attempt === sample.attempt && item.kind === 'control');
    const targets = receipts.filter(item => item.attempt === sample.attempt && item.kind === 'target');
    assert.equal(control.length, 1, 'one positive HTTP control for every attempt');
    assert.equal(control[0].host, `control-${token}.bd-e2e.test`, 'control belongs to this fixture');
    assert.ok(control[0].at >= sample.startedAt && control[0].at <= sample.endedAt, 'control belongs to the observation interval');
    const actual = new URL(sample.document.url);
    if (sample.blocked) {
      assert.equal(actual.protocol + '//' + actual.host, sample.extensionOrigin, 'redirect belongs to the installed extension');
      assert.equal(actual.pathname, '/blocked.html');
      assert.equal(actual.searchParams.get('url'), sample.host); assert.equal(actual.searchParams.get('reason'), 'always');
      assert.deepEqual(targets, [], 'a blocked navigation never reached the target HTTP server');
    } else {
      assert.equal(actual.protocol, 'http:'); assert.equal(actual.hostname, sample.host);
      assert.equal(sample.document.token, token); assert.equal(sample.document.kind, 'target');
      assert.equal(sample.document.attempt, sample.attempt);
      assert.equal(targets.length, 1, 'an allowed navigation really reached the target HTTP server');
      assert.equal(targets[0].host, sample.host);
    }
  }
}

export function assertSentinelHistory(probe, host) {
  const includes = rules => rules.some(rule => {
    try { return new URL(rule.action.redirect.url).searchParams.get('url') === host; }
    catch { return false; }
  });
  assert.equal(probe.overflow, false, 'DNR commit history is complete');
  assert.ok(probe.entered && probe.committed, 'the controlled production DNR call really completed');
  assert.ok(includes(probe.entered.before), 'sentinel was protected before the update');
  assert.ok(includes(probe.committed.rules), 'sentinel remains protected in the selected native commit');
  const commits = probe.events.filter(event => event.type === 'dnr-committed');
  assert.ok(commits.length > 0, 'native DNR commit observations exist');
  for (const commit of commits) assert.ok(includes(commit.rules), 'no observed native DNR commit dropped the unchanged sentinel');
}
