import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesClient } from '../rules/rulesClient.js';

test('rules client preserves error code and all validation keys from the worker', async () => {
  const previousBrowser = globalThis.browser;
  let sentMessage = null;

  globalThis.browser = {
    runtime: {
      sendMessage(message) {
        sentMessage = message;
        return Promise.resolve({
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
    globalThis.browser = previousBrowser;
  }
});

test('rules client sends a structured addMany intent for a local rule pack', async () => {
  const previousBrowser = globalThis.browser;
  let sentMessage = null;

  globalThis.browser = {
    runtime: {
      sendMessage(message) {
        sentMessage = message;
        return Promise.resolve({ success: true, addedCount: 2, rules: [] });
      }
    }
  };

  try {
    const client = new RulesClient();
    const schedule = {
      version: 2,
      periods: [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' }]
    };
    const result = await client.addMany('shopping', ['amazon', 'etsy'], schedule);

    assert.deepEqual(sentMessage, {
      type: 'rules:addMany',
      payload: {
        packId: 'shopping',
        entryIds: ['amazon', 'etsy'],
        schedule
      }
    });
    assert.equal(result.addedCount, 2);
  } finally {
    globalThis.browser = previousBrowser;
  }
});
