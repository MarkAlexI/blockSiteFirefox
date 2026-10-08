import assert from 'node:assert/strict';
import test from 'node:test';
import { installOptionsFocusGate } from '../e2e/options-focus-gate.mjs';

function clock() {
  const tasks = [];
  const view = { Promise, setTimeout(callback, delay, ...args) {
    tasks.push({ callback, delay, args }); return tasks.length;
  } };
  return { view, tasks, deliver(task) { task.callback(...task.args); } };
}

test('Options focus gate keeps a native-delivered autofocus pending through a slow client and forwards its arguments', async () => {
  const c = clock(); const original = c.view.setTimeout;
  installOptionsFocusGate(c.view);
  const state = c.view.__bdOptionsFocusGate;
  state.begin();
  const field = { calls: [], focus(value) { this.calls.push(value); } };
  const id = c.view.setTimeout(value => field.focus(value), 100, 'native argument');
  assert.equal(id, 2, 'native timer ID is preserved');
  for (const task of c.tasks) c.deliver(task); // Browser deadline has passed before client field choice.
  assert.deepEqual(field.calls, [], 'delivery does not steal the chosen field');
  const result = await state.releaseAfterDeadline();
  assert.deepEqual(result, { deadlinePassed: true, registered: 1, delivered: 1, executed: 1 });
  assert.deepEqual(field.calls, ['native argument'], 'production callback runs on release');
  state.restore(); assert.equal(c.view.setTimeout, original);
});

test('Options focus gate forwards unrelated timers and waits for a later native autofocus delivery', async () => {
  const c = clock(); installOptionsFocusGate(c.view);
  const state = c.view.__bdOptionsFocusGate; state.begin();
  let unrelated = 0; const field = { focused: false, focus() { this.focused = true; } };
  c.view.setTimeout(value => { unrelated = value; }, 100, 7);
  c.view.setTimeout(() => field.focus(), 100);
  c.deliver(c.tasks[0]); c.deliver(c.tasks[1]);
  const finished = state.releaseAfterDeadline();
  await Promise.resolve();
  assert.equal(unrelated, 7); assert.equal(field.focused, false);
  c.deliver(c.tasks[2]);
  assert.equal((await finished).executed, 1); assert.equal(field.focused, true);
});
