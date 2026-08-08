import test from 'node:test';
import assert from 'node:assert/strict';
import { installPageErrorReporter } from '../telemetry/pageErrorReporter.js';

function createGlobal() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    emit(type, event) { listeners.get(type)?.(event); }
  };
}

test('page error reporter sends only coarse error metadata', () => {
  const globalRef = createGlobal();
  const messages = [];
  const runtimeApi = {
    sendMessage(message) { messages.push(message); return Promise.resolve(); }
  };
  const uninstall = installPageErrorReporter('options', { runtimeApi, globalRef });

  globalRef.emit('error', {
    message: 'secret https://example.com',
    filename: 'https://example.com/private.js',
    error: Object.assign(new TypeError('secret@example.com'), { stack: 'PRIVATE STACK' })
  });
  globalRef.emit('unhandledrejection', {
    reason: new RangeError('private')
  });

  assert.deepEqual(messages, [
    {
      type: 'telemetry:recordError',
      payload: {
        source: 'options',
        code: 'uncaught_error',
        operation: 'page_runtime',
        errorName: 'TypeError'
      }
    },
    {
      type: 'telemetry:recordError',
      payload: {
        source: 'options',
        code: 'unhandled_rejection',
        operation: 'page_runtime',
        errorName: 'RangeError'
      }
    }
  ]);
  assert.equal(JSON.stringify(messages).includes('example.com'), false);
  assert.equal(JSON.stringify(messages).includes('secret@example.com'), false);
  assert.equal(JSON.stringify(messages).includes('STACK'), false);

  uninstall();
});
