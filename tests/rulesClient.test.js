import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesClient } from '../rules/rulesClient.js';

test('rules client preserves error code and all validation keys from the worker', async () => {
  const previousBrowser = globalThis.browser;
  let sentMessage = null;

  globalThis.browser = {
    runtime: {
      lastError: null,
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
      lastError: null,
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
    const result = await client.addMany('shopping', ['amazon', 'etsy'], schedule, 'list-1');

    assert.deepEqual(sentMessage, {
      type: 'rules:addMany',
      payload: {
        packId: 'shopping',
        entryIds: ['amazon', 'etsy'],
        schedule,
        listId: 'list-1'
      }
    });
    assert.equal(result.addedCount, 2);
  } finally {
    globalThis.browser = previousBrowser;
  }
});


test('rules client sends Rule List management intents', async () => {
  const previousBrowser = globalThis.browser;
  const sentMessages = [];

  globalThis.browser = {
    runtime: {
      lastError: null,
      sendMessage(message) {
        sentMessages.push(message);
        return Promise.resolve({ success: true, ruleLists: [] });
      }
    }
  };

  try {
    const client = new RulesClient();
    await client.createRuleList('Work');
    await client.renameRuleList('list-1', 'Study');
    await client.toggleRuleList('list-1');
    await client.deleteRuleList('list-1');

    assert.deepEqual(sentMessages, [
      { type: 'rules:createList', payload: { name: 'Work' } },
      { type: 'rules:renameList', payload: { listId: 'list-1', name: 'Study' } },
      { type: 'rules:toggleList', payload: { listId: 'list-1' } },
      { type: 'rules:deleteList', payload: { listId: 'list-1' } }
    ]);
  } finally {
    globalThis.browser = previousBrowser;
  }
});

test('rules client includes Rule Lists in replaceAll imports', async () => {
  const previousBrowser = globalThis.browser;
  let sentMessage = null;

  globalThis.browser = {
    runtime: {
      lastError: null,
      sendMessage(message) {
        sentMessage = message;
        return Promise.resolve({ success: true, rules: [], ruleLists: [] });
      }
    }
  };

  try {
    const client = new RulesClient();
    const rules = [{ id: 1, blockURL: 'example.com', listId: 'list-1' }];
    const settings = { mode: 'normal' };
    const ruleLists = [
      { id: 'general', name: 'General', disabled: false },
      { id: 'list-1', name: 'Work', disabled: false }
    ];

    await client.replaceAll(rules, settings, ruleLists);

    assert.deepEqual(sentMessage, {
      type: 'rules:replaceAll',
      payload: { rules, settings, ruleLists }
    });
  } finally {
    globalThis.browser = previousBrowser;
  }
});
