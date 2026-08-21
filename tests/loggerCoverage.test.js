import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

test('debug logging obeys synchronized settings while errors remain visible and debug controls persist choices', async () => {
  const api = createExtensionApi({ sync: { settings: { debugMode: false, mode: 'strict' } } });
  const calls = [];
  const previous = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    group: console.group,
    groupEnd: console.groupEnd
  };

  for (const name of Object.keys(previous)) {
    console[name] = (...values) => calls.push({ name, values });
  }

  try {
    await withExtensionEnvironment(api, async () => {
      const { default: Logger } = await import('../utils/logger.js');
      const logger = new Logger('Coverage');
      assert.match(logger.color, /^#[0-9A-F]{6}$/);
      assert.equal(globalThis.DebugController.status(), false);

      logger.log('hidden');
      logger.info('hidden');
      logger.warn('hidden');
      logger.group('hidden');
      logger.groupEnd();
      assert.equal(calls.length, 0);

      logger.error('visible error');
      assert.equal(calls.at(-1).name, 'error');
      assert.equal(calls.at(-1).values.at(-1), 'visible error');

      api.storage.onChanged.emit({ settings: { newValue: { debugMode: true } } }, 'local');
      assert.equal(globalThis.DebugController.status(), false);
      api.storage.onChanged.emit({ settings: { newValue: { debugMode: true } } }, 'sync');
      assert.equal(globalThis.DebugController.status(), true);

      logger.log('visible log');
      logger.info('visible info');
      logger.warn('visible warning');
      logger.group('visible group');
      logger.groupEnd();
      assert.equal(calls.some(call => call.name === 'log' && call.values.includes('visible log')), true);
      assert.equal(calls.some(call => call.name === 'info' && call.values.includes('visible info')), true);
      assert.equal(calls.some(call => call.name === 'warn' && call.values.includes('visible warning')), true);
      assert.equal(calls.some(call => call.name === 'group'), true);
      assert.equal(calls.some(call => call.name === 'groupEnd'), true);

      globalThis.DebugController.disable();
      assert.equal(api.storage.sync.data.settings.debugMode, false);
      assert.equal(api.storage.sync.data.settings.mode, 'strict');
      api.storage.onChanged.emit({ settings: { newValue: { debugMode: false } } }, 'sync');
      assert.equal(globalThis.DebugController.status(), false);

      globalThis.DebugController.enable();
      assert.equal(api.storage.sync.data.settings.debugMode, true);
      api.storage.onChanged.emit({ settings: { newValue: null } }, 'sync');
      assert.equal(globalThis.DebugController.status(), false);
    });
  } finally {
    Object.assign(console, previous);
  }
});
