import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesClient } from '../rules/rulesClient.js';
import { createRulesIntentHandler } from '../rules/rulesIntentRouter.js';

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
    await client.activateRuleList('list-1');
    await client.deleteRuleList('list-1');

    assert.deepEqual(sentMessages, [
      { type: 'rules:createList', payload: { name: 'Work' } },
      { type: 'rules:renameList', payload: { listId: 'list-1', name: 'Study' } },
      { type: 'rules:activateList', payload: { listId: 'list-1' } },
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
      { id: 'general', name: 'General', disabledCategories: [] },
      { id: 'list-1', name: 'Work', disabledCategories: ['social'] }
    ];

    await client.replaceAll(rules, settings, ruleLists, 'list-1');

    assert.deepEqual(sentMessage, {
      type: 'rules:replaceAll',
      payload: { rules, settings, ruleLists, activeRuleListId: 'list-1' }
    });
  } finally {
    globalThis.browser = previousBrowser;
  }
});

test('rules client scopes toggle intent to the selected Rule List assignment', async () => {
  const previousBrowser = globalThis.browser;
  let sentMessage = null;

  globalThis.browser = {
    runtime: {
      sendMessage(message) {
        sentMessage = message;
        return Promise.resolve({ success: true, rules: [] });
      }
    }
  };

  try {
    const client = new RulesClient();
    await client.toggleRule(17, 'study');
    assert.deepEqual(sentMessage, {
      type: 'rules:toggle',
      payload: { ruleId: 17, listId: 'study' }
    });
  } finally {
    globalThis.browser = previousBrowser;
  }
});

test('deletion intents cross the client and worker router with stable IDs', async () => {
  const previousBrowser = globalThis.browser;
  const calls = [];
  const handler = createRulesIntentHandler({
    async removeAssignment(payload) {
      calls.push(['removeAssignment', payload]);
      return {
        rules: [],
        removedAssignmentListId: payload.listId,
        targetDeleted: true
      };
    },
    async deleteRule(payload) {
      calls.push(['deleteRule', payload]);
      return { rules: [] };
    }
  });

  globalThis.browser = {
    runtime: {
      async sendMessage(message) {
        return { success: true, ...await handler(message) };
      }
    }
  };

  try {
    const client = new RulesClient();
    const assignmentResult = await client.removeAssignment(23, 'general');
    await client.deleteRule(41);

    assert.equal(assignmentResult.targetDeleted, true);
    assert.deepEqual(calls, [
      ['removeAssignment', { ruleId: 23, listId: 'general' }],
      ['deleteRule', { ruleId: 41 }]
    ]);
  } finally {
    globalThis.browser = previousBrowser;
  }
});
