import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadPopupDocument } from '../e2e/popup-tab-target-scenarios.mjs';

test('Popup reload ignores the old ready document, a missing view and the new document before rows render', async () => {
  let reloads = 0, snapshots = 0, rows = 0;
  const oldView = { __bdTabTargetDocumentToken: 'old',
    document: { readyState: 'complete', querySelectorAll: () => [{ dataset: { ruleId: '1' } }],
      getElementById: () => ({}) }, location: { reload() { reloads++; } } };
  const newView = { crypto: { randomUUID: () => 'new' },
    document: { readyState: 'loading', querySelectorAll: () => rows ? [{ dataset: { ruleId: '1' } }] : [],
      getElementById: () => null } };
  let calls = 0;
  const view = { async evaluate(fn) {
    if (++calls <= 2) return fn(oldView); // Token capture, then reload request.
    snapshots++;
    if (snapshots === 1) return fn(oldView); // Reload has not started yet.
    if (snapshots === 2) return null; // getViews() temporarily has no document.
    if (snapshots === 4) newView.document.readyState = 'complete';
    if (snapshots === 5) rows = 1;
    return fn(newView);
  } };
  const result = await reloadPopupDocument(view, 1);
  assert.equal(reloads, 1);
  assert.equal(snapshots, 5);
  assert.deepEqual(result, { token: 'new', ready: true, rows: 1, button: false });
});
