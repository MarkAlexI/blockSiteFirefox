import assert from 'node:assert/strict';
import test from 'node:test';
import { selectLiveWindow } from '../e2e/window-selection.mjs';

class NoSuchWindowError extends Error {}

test('E2E selects a live tab after Classic WebDriver current tab was closed', async () => {
  let selected;
  const driver = {
    getWindowHandle: async () => { throw new NoSuchWindowError('Browsing context has been discarded'); },
    switchTo: () => ({ window: async target => { selected = target; } })
  };
  assert.equal(await selectLiveWindow(driver, 'options-tab', NoSuchWindowError), true);
  assert.equal(selected, 'options-tab');
});

test('E2E does not reactivate the already selected tab', async () => {
  const driver = { getWindowHandle: async () => 'options-tab',
    switchTo: () => assert.fail('An already selected tab must not be switched again') };
  assert.equal(await selectLiveWindow(driver, 'options-tab', NoSuchWindowError), false);
});

test('E2E switches from a different live tab', async () => {
  let selected;
  const driver = { getWindowHandle: async () => 'browsing-tab',
    switchTo: () => ({ window: async target => { selected = target; } }) };
  assert.equal(await selectLiveWindow(driver, 'options-tab', NoSuchWindowError), true);
  assert.equal(selected, 'options-tab');
});

test('E2E propagates unrelated driver errors and a discarded target', async () => {
  const connectionError = new Error('connection lost');
  await assert.rejects(selectLiveWindow({ getWindowHandle: async () => { throw connectionError; },
    switchTo: () => assert.fail('Connection failures must not attempt a switch') },
  'options-tab', NoSuchWindowError), error => error === connectionError);
  const targetError = new NoSuchWindowError('target was closed');
  await assert.rejects(selectLiveWindow({ getWindowHandle: async () => 'browsing-tab',
    switchTo: () => ({ window: async () => { throw targetError; } }) },
  'options-tab', NoSuchWindowError), error => error === targetError);
});
