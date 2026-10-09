import test from 'node:test';
import assert from 'node:assert/strict';
import { installLiveDayProbe } from '../e2e/live-day-probes.mjs';

function environment(set) {
  const listeners = new Set();
  return { crypto: { randomUUID: () => 'global-token' }, Date, Error, Promise,
    browser: { storage: { local: { set }, onChanged: {
      addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener)
    } } }, listeners };
}
const journal = { rules: [{ id: 35 }], ruleLists: [{ id: 'general' }],
  pendingDailyUsageRemaps: [{ oldRuleId: 35, oldListId: 'list-1', newRuleId: 35, newListId: 'general' }] };

test('journal-delivery probe commits the native write first and holds only Promise delivery', async () => {
  let calls = 0, durable;
  const set = async values => { calls++; durable = structuredClone(values); return 'native-result'; };
  const view = environment(set); installLiveDayProbe(view);
  view.__bdLiveDay.gate = { label: 'native-journal', entered: false };
  let delivered = false;
  const pending = view.browser.storage.local.set(journal).then(result => { delivered = true; return result; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1); assert.deepEqual(durable, journal);
  assert.equal(view.__bdLiveDay.gate.entered, true); assert.equal(delivered, false);
  assert.equal(await view.browser.storage.local.set({ dailyRuleUsage: { date: '2026-10-09', usageSeconds: {} } }), 'native-result');
  assert.equal(calls, 2, 'ordinary writes retain native completion');
  view.__bdLiveDay.release(); assert.equal(await pending, 'native-result');
  view.__bdLiveDay.restore(); assert.equal(view.browser.storage.local.set, set); assert.equal(view.listeners.size, 0);
});

test('journal-delivery probe propagates native API rejection and does not invent a commit', async () => {
  const failure = new Error('native storage failure');
  const view = environment(async () => { throw failure; }); installLiveDayProbe(view);
  view.__bdLiveDay.gate = { entered: false };
  await assert.rejects(view.browser.storage.local.set(journal), error => error === failure);
  assert.equal(view.__bdLiveDay.gate.entered, false);
  assert.equal(view.__bdLiveDay.events.some(event => event.type === 'journal-committed'), false);
  view.__bdLiveDay.restore();
});

test('journal-delivery probe restores a pending delivery and leaves unrelated journal writes alone', async () => {
  const set = async () => 42;
  const view = environment(set); installLiveDayProbe(view);
  view.__bdLiveDay.gate = { entered: false };
  assert.equal(await view.browser.storage.local.set({ pendingDailyUsageRemaps: journal.pendingDailyUsageRemaps }), 42);
  assert.equal(view.__bdLiveDay.gate.entered, false);
  const pending = view.browser.storage.local.set(journal);
  await Promise.resolve(); await Promise.resolve();
  view.__bdLiveDay.restore(); assert.equal(await pending, 42);
  assert.equal(view.listeners.size, 0);
});
