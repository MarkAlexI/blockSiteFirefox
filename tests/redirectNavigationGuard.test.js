import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedirectNavigationGuard } from '../utils/redirectAuthorization.js';

function fixture() {
  const data = {}, tabs = new Map();
  const sessionStorage = { async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(patch) { Object.assign(data, structuredClone(patch)); } };
  const runtimeApi = { getURL: path => 'chrome-extension://own/' + path };
  const tabsApi = { async get(id) { if (!tabs.has(id)) throw Error('closed'); return { ...tabs.get(id) }; } };
  const create = () => createRedirectNavigationGuard({ tabsApi, runtimeApi, sessionStorage });
  const sender = (id, documentId = 'document-1') => ({ tab: { id }, documentId,
    url: runtimeApi.getURL('redirect.html?from=a&to=b') });
  const put = (id, url) => tabs.set(id, { id, url, status: 'complete' });
  return { data, tabs, create, sender, put, runtimeApi, tabsApi, sessionStorage };
}
const target = { from: 'blocked.example', to: 'https://allowed.example/server-302' };

test('a long acyclic sequence of distinct installed targets is allowed until a target repeats', async () => {
  const f = fixture(), guard = f.create(); f.put(1, f.sender(1).url);
  for (let i = 0; i < 40; i++) assert.equal((await guard.authorize(f.sender(1, 'document-' + i), {
    from: 'rule-' + i, to: 'https://allowed.example/' + i
  })).allowed, true, 'distinct hop ' + i);
  assert.equal((await guard.authorize(f.sender(1, 'server-return'), {
    from: 'rule-0', to: 'https://allowed.example/0'
  })).allowed, false);
});

test('a 302 return to the same authorized rule stops once and survives a worker restart', async () => {
  const f = fixture(), sender = f.sender(7); f.put(7, sender.url);
  const first = f.create();
  assert.deepEqual(await first.authorize(sender, target), { allowed: true, recordRedirect: true });
  assert.deepEqual(await first.authorize(sender, target), { allowed: true, recordRedirect: false }, 'same document is idempotent');
  const restarted = f.create();
  assert.deepEqual(await restarted.authorize(f.sender(7, 'server-return'), target), { allowed: false, recordBlock: true });
  assert.deepEqual(await restarted.authorize(f.sender(7, 'another-return'), target), { allowed: false }, 'one terminal block');
});

test('separate tabs, completed visits and the final blocked page begin independent chains', async () => {
  const f = fixture(), guard = f.create();
  for (const id of [1, 2]) {
    const sender = f.sender(id); f.put(id, sender.url);
    assert.equal((await guard.authorize(sender, target)).recordRedirect, true);
  }
  f.put(1, target.to); await guard.completed(1, target.to);
  f.put(1, f.sender(1).url);
  assert.equal((await guard.authorize(f.sender(1, 'visit-2'), target)).allowed, true);
  assert.equal((await guard.authorize(f.sender(2, 'return'), target)).allowed, false);
  const blocked = f.runtimeApi.getURL('blocked.html'); f.put(2, blocked); await guard.completed(2, blocked);
  f.put(2, f.sender(2).url);
  assert.equal((await guard.authorize(f.sender(2, 'manual-retry'), target)).allowed, true);
});

test('intermediary completion, stale completion and pending navigation cannot clear or authorize a chain', async () => {
  const f = fixture(), guard = f.create(), sender = f.sender(1); f.put(1, sender.url);
  await guard.authorize(sender, target);
  await guard.completed(1, sender.url);
  await guard.completed(1, target.to);
  assert.equal((await guard.authorize(f.sender(1, 'return'), target)).allowed, false);
  await guard.removed(1); f.put(1, 'https://new.example/');
  assert.equal((await guard.authorize(sender, target)).allowed, false);
  f.put(1, sender.url); f.tabs.get(1).pendingUrl = 'https://new.example/';
  assert.deepEqual(await guard.authorize(sender, target), { allowed: false, obsolete: true });
});

test('a completed web visit remains a chain boundary after its SPA changes the observed completion URL', async () => {
  const f = fixture(), guard = f.create(), sender = f.sender(1); f.put(1, sender.url);
  await guard.authorize(sender, target);
  f.put(1, target.to + '#new-route');
  f.tabs.get(1).status = 'loading';
  await guard.completed(1, target.to);
  f.put(1, sender.url);
  assert.equal((await guard.authorize(f.sender(1, 'return-before-completion'), target)).allowed, false);
  f.put(1, target.to + '#new-route');
  await guard.completed(1, target.to);
  f.put(1, sender.url);
  assert.equal((await guard.authorize(f.sender(1, 'intentional-revisit'), target)).allowed, true);
});

test('server chains can contain distinct authorized redirects but never repeat a previous target', async () => {
  const f = fixture(), guard = f.create(); f.put(1, f.sender(1).url);
  for (let i = 0; i < 3; i++) assert.equal((await guard.authorize(f.sender(1, 'doc-' + i), {
    from: 'rule-' + i, to: 'https://allowed.example/' + i
  })).allowed, true);
  assert.equal((await guard.authorize(f.sender(1, 'returned'), { from: 'rule-0', to: 'https://allowed.example/0' })).allowed, false);
});

test('page tokens provide idempotence when native document IDs or session storage are unavailable', async () => {
  const f = fixture(), guard = createRedirectNavigationGuard({ tabsApi: f.tabsApi, runtimeApi: f.runtimeApi });
  const sender = f.sender(1); delete sender.documentId; f.put(1, sender.url);
  const options = { documentToken: 'native-page-token-0001' };
  assert.equal((await guard.authorize(sender, target, options)).recordRedirect, true);
  assert.equal((await guard.authorize(sender, target, options)).recordRedirect, false);
  assert.equal((await guard.authorize(sender, target, { documentToken: 'native-page-token-0002' })).recordBlock, true);
});


for (const decision of ['redirect', 'loop block']) for (const change of ['replaced document', 'pending navigation', 'closed tab']) {
  test(`a ${decision} checkpoint cannot authorize or count a ${change}, and a fresh visit is independent`, async () => {
    const f = fixture(), guard = f.create(), sender = f.sender(1);
    f.put(1, sender.url); f.put(2, f.sender(2).url);
    await guard.authorize(f.sender(2), target);
    if (decision === 'loop block') await guard.authorize(sender, target);
    const original = f.sessionStorage.set;
    let entered, release;
    const captured = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let hold = true;
    f.sessionStorage.set = async patch => {
      await original(patch);
      if (hold) { hold = false; entered(); await gate; }
    };
    const pending = guard.authorize(f.sender(1, 'replacement-redirect-document'), target);
    try {
      await captured;
      if (change === 'closed tab') f.tabs.delete(1);
      else if (change === 'pending navigation') f.tabs.get(1).pendingUrl = 'https://new.example/';
      else f.put(1, 'https://new.example/');
      release();
      assert.deepEqual(await pending, { allowed: false, obsolete: true });
      const saved = f.data.redirectNavigationChainsV1;
      assert.equal(saved[1], undefined, 'the abandoned checkpoint cannot poison a new visit');
      assert.ok(saved[2], 'an unrelated tab retains its independent unfinished chain');
      f.put(1, sender.url);
      assert.deepEqual(await guard.authorize(f.sender(1, 'fresh-visit'), target), { allowed: true, recordRedirect: true });
    } finally { release(); await pending; f.sessionStorage.set = original; }
  });
}

test('a failed checkpoint cannot authorize a navigation, and revoked decisions never authorize', async () => {
  const f = fixture(); f.put(1, f.sender(1).url);
  f.sessionStorage.set = async () => { throw Error('checkpoint failed'); };
  await assert.rejects(f.create().authorize(f.sender(1), target), /checkpoint failed/);
  assert.deepEqual(await f.create().authorize(f.sender(1), target, { isCurrent: () => false }), { allowed: false });
});
