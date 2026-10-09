import assert from 'node:assert/strict';

export const COLD_PAGE = 'http://cold-message.bd-e2e.test/producer';
export const COLD_SCHEDULE = { version: 1, enabled: false, days: [1, 3, 5], startTime: '11:37',
  durationMinutes: 5, revision: 7, notBefore: 0, handledKeys: [], skippedKeys: [] };

// A durable fixture with explicit metadata, rather than the nullable metadata
// of raw install seed. Written through one genuine storage.local.set.
export function coldMetadata(token) {
  return { rulesGeneration: `cold-generation-${token}`,
    ruleRevisions: { 21: `cold-daily-${token}`, 22: `cold-study-${token}` },
    ruleListRevisions: { general: `cold-general-${token}`, 'list-1': `cold-study-list-${token}`, 'list-2': `cold-work-list-${token}` } };
}

export function coldRequests(before, token) {
  const rename = { listId: 'list-1', name: 'Cold Study',
    expectedGeneration: before.rulesGeneration, expectedListRevision: before.ruleListRevisions['list-1'] };
  return [
    { id: 'pro', message: { type: 'check_pro_status' } },
    { id: 'schedule', message: { type: 'focus_schedule_get' } },
    { id: 'rename', message: { type: 'rules:renameList', payload: rename } },
    { id: 'stale-generation', message: { type: 'rules:renameList', payload: { ...rename, listId: 'list-2', name: 'Unexpected Work',
      expectedGeneration: `stale-${token}`, expectedListRevision: before.ruleListRevisions['list-2'] } } },
    { id: 'stale-revision', message: { type: 'rules:renameList', payload: { ...rename, listId: 'list-2', name: 'Unexpected Work',
      expectedListRevision: `stale-${token}` } } }
  ].map(request => ({ ...request, message: { ...request.message, __bdColdToken: token, __bdColdRequest: request.id } }));
}

// These three functions are serialized into native page/extension contexts.
// Strings cross Firefox's isolated-world boundary without page-owned objects.
export function installColdCollector({ token, count }) {
  const state = window.__bdColdMessages = { token, count, triggerAt: null, sent: [], replies: [], errors: [] };
  window.addEventListener('message', event => {
    if (event.source !== window || typeof event.data !== 'string') return;
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    if (packet.token !== token || packet.channel !== 'bd-cold-reply') return;
    if (packet.kind === 'sent') state.sent = packet.sent;
    else if (packet.kind === 'reply') {
      if (state.replies.some(reply => reply.id === packet.reply.id)) state.errors.push('Duplicate first reply');
      state.replies.push(packet.reply);
    }
    if (state.replies.length === count && state.sent.length === count) state.resolve?.();
  });
  return { href: location.href, token };
}

export async function injectColdSender({ url, token, requests }) {
  const api = typeof browser === 'object' ? browser : chrome;
  const tabs = (await api.tabs.query({})).filter(tab => tab.url === url);
  if (tabs.length !== 1) throw new Error(`Expected one cold-message producer, found ${tabs.length}`);
  const result = await api.scripting.executeScript({ target: { tabId: tabs[0].id },
    args: [{ token, requests }], func: function ({ token, requests }) {
      let triggered = false;
      const post = packet => window.postMessage(JSON.stringify({ channel: 'bd-cold-reply', token, ...packet }), '*');
      window.addEventListener('message', event => {
        if (event.source !== window || typeof event.data !== 'string') return;
        let packet;
        try { packet = JSON.parse(event.data); } catch { return; }
        if (packet.channel !== 'bd-cold-trigger' || packet.token !== token || triggered) return;
        triggered = true;
        const sent = [];
        for (const request of requests) {
          const sentAt = Date.now();
          sent.push({ id: request.id, type: request.message.type, at: sentAt });
          const complete = (response, error = null) => post({ kind: 'reply',
            reply: { id: request.id, sentAt, repliedAt: Date.now(), response: response ?? null, error } });
          // All requests are dispatched in this one isolated content context,
          // without a readiness message, timer between sends, or retry.
          if (typeof browser === 'object') {
            browser.runtime.sendMessage(request.message).then(response => complete(response), error => complete(null, String(error)));
          } else {
            chrome.runtime.sendMessage(request.message, response => complete(response, chrome.runtime.lastError?.message ?? null));
          }
        }
        post({ kind: 'sent', sent });
      });
      return { installed: true, count: requests.length };
    } });
  return { tabId: tabs[0].id, frames: result.map(item => ({ frameId: item.frameId, result: item.result })) };
}

export async function triggerColdMessages(token) {
  const state = window.__bdColdMessages;
  if (!state || state.token !== token || state.triggerAt !== null) throw new Error('Cold producer missing or already triggered');
  state.triggerAt = Date.now();
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('First cold message replies did not complete')), 15_000);
    state.resolve = () => { clearTimeout(deadline); resolve(); };
    window.postMessage(JSON.stringify({ channel: 'bd-cold-trigger', token }), '*');
  });
  delete state.resolve;
  return { ...state, completedAt: Date.now() };
}

export function assertColdReplies(packet, before, earliestAlarm) {
  const ids = ['pro', 'schedule', 'rename', 'stale-generation', 'stale-revision'];
  assert.deepEqual(packet.errors, [], 'no duplicate first responses');
  assert.deepEqual(packet.sent.map(item => item.id), ids, 'one immediate burst, no readiness probe or retry');
  assert.deepEqual(packet.replies.map(item => item.id).sort(), [...ids].sort(), 'exactly one first response per request');
  assert.ok(packet.sent.every(item => item.at >= packet.triggerAt && item.at <= packet.completedAt));
  assert.ok(Math.max(...packet.sent.map(item => item.at)) - Math.min(...packet.sent.map(item => item.at)) < 100,
    'all first requests dispatched in the same early burst');
  assert.ok(packet.completedAt < earliestAlarm, 'all first responses precede every native alarm');
  const replies = Object.fromEntries(packet.replies.map(reply => {
    assert.equal(reply.error, null, `${reply.id}: native runtime transport succeeded`);
    assert.ok(reply.repliedAt >= reply.sentAt && reply.repliedAt <= packet.completedAt);
    return [reply.id, reply.response];
  }));
  assert.deepEqual(replies.pro, { isPro: true }, 'first response reads the persisted paid state');
  assert.deepEqual(replies.schedule, { success: true,
    config: { enabled: false, days: [1, 3, 5], startTime: '11:37', durationMinutes: 5 },
    revision: 7, hasAccess: true, next: null, skipped: null }, 'first schedule response reads its persisted revision/config');
  assert.equal(replies.rename?.success, true, 'first valid intent accepts the persisted generation and list revision');
  assert.deepEqual(replies.rename.rules, before.rules, 'first intent responds with the complete stored rules');
  assert.deepEqual(replies.rename.ruleLists, before.ruleLists.map(list => list.id === 'list-1' ? { ...list, name: 'Cold Study' } : list));
  assert.equal(replies.rename.activeRuleListId, before.activeRuleListId);
  assert.equal(replies.rename.list?.name, 'Cold Study');
  for (const id of ['stale-generation', 'stale-revision']) {
    assert.equal(replies[id]?.success, false, `${id}: first stale intent is rejected`);
    assert.equal(replies[id].error?.code, 'rules_state_changed');
  }
}

export function assertColdState(after, before) {
  for (const key of ['rules', 'activeRuleListId', 'rulesGeneration', 'ruleRevisions', 'focusSession', 'dnr']) {
    assert.deepEqual(after[key], before[key], `${key} survives the first cold messages`);
  }
  assert.deepEqual(after.ruleLists, before.ruleLists.map(list => list.id === 'list-1' ? { ...list, name: 'Cold Study' } : list));
  assert.notEqual(after.ruleListRevisions['list-1'], before.ruleListRevisions['list-1'], 'rename advances only its list revision');
  for (const id of ['general', 'list-2']) assert.equal(after.ruleListRevisions[id], before.ruleListRevisions[id]);
  assert.deepEqual(after.dailyRuleUsage.usageSeconds, { '21:general': 840 });
  assert.deepEqual(after.pendingDailyUsageRemaps, []);
}
