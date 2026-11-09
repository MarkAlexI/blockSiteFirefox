import test from 'node:test';
import assert from 'node:assert/strict';
import { RulesManager } from '../rules/rulesManager.js';

const manager = new RulesManager();
const row = (blockURL, isWhitelist) => ({ blockURL, isWhitelist });

test('Empty conflicts: blank saved targets cannot conflict with unrelated valid targets', () => {
  for (const empty of ['', ' ', '\t\r\n']) {
    assert.equal(manager.checkConflict([row(empty, true)], 'valid.example', false), null);
    assert.equal(manager.checkConflict([row(empty, true)], 'valid.example', true), null);
    assert.equal(manager.checkConflict([row(empty, false)], 'valid.example', true), null);
  }
});

test('Empty conflicts: blank entries cannot mask real conflicts or defeat an excluded row', () => {
  const rules = [row('', true), row('YouTube.com', false), row('allowed.example', true)];
  assert.equal(manager.checkConflict(rules, 'yout', true), 'conflict_blacklist');
  assert.equal(manager.checkConflict(rules, 'allow', false), 'conflict_whitelist');
  assert.equal(manager.checkConflict(rules, 'allow', true), 'redundant_whitelist');
  assert.equal(manager.checkConflict(rules, 'allow', true, 2), null);
  assert.equal(manager.checkConflict(rules, 'yout', true, 1), null);
});

test('Empty conflicts: short string targets retain conflicts and empty new input still fails validation', () => {
  assert.equal(manager.checkConflict([row('wikipedia.org', true)], 'w', false), 'conflict_whitelist');
  assert.equal(manager.checkConflict([row('w', false)], 'wikipedia.org', true), 'conflict_blacklist');
  assert.equal(manager.checkConflict([row('youtube.com', true)], 'yout', true), 'redundant_whitelist');
  assert.equal(manager.checkConflict([row('youtube.com', false)], 'yout', false), null);
  for (const isWhitelist of [false, true]) {
    const result = manager.validateRule('   ', '', null, 'social', isWhitelist);
    assert.equal(result.isValid, false);
    assert.ok(result.errors.includes('blockurl_empty'));
  }
});
