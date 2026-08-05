import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesClient } from '../rules/rulesClient.js';

test('rules client preserves error code and all validation keys from the worker', async () => {
  const previousChrome = globalThis.browser;
  let sentMessage = null;

  globalThis.browser = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        sentMessage = message;
        callback({
          success: false,
          error: {
            code: 'validation_failed',
            message: 'Validation failed',
            validationErrors: ['blockurl_empty', 'blockurl_invalid']
          }
        });
      }
    }
  };

  try {
    const client = new RulesClient();

    await assert.rejects(
      client.addRule({ blockURL: '', redirectURL: '' }),
      (error) => {
        assert.equal(error.code, 'validation_failed');
        assert.deepEqual(error.validationErrors, ['blockurl_empty', 'blockurl_invalid']);
        return true;
      }
    );

    assert.equal(sentMessage.type, 'rules:add');
  } finally {
    globalThis.browser = previousChrome;
  }
});
