import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRulePack,
  getRulePacks,
  resolveRulePackEntries
} from '../rules/rulePacks.js';

test('rule packs expose stable unique pack and entry IDs', () => {
  const packs = getRulePacks();
  const packIds = packs.map(pack => pack.id);

  assert.equal(new Set(packIds).size, packIds.length);
  assert.equal(packs.length, 5);

  for (const pack of packs) {
    assert.ok(pack.category);
    assert.ok(pack.titleKey);
    assert.ok(pack.descriptionKey);
    assert.ok(pack.entries.length > 0);
    assert.equal(
      new Set(pack.entries.map(entry => entry.id)).size,
      pack.entries.length
    );
  }
});

test('returned packs are defensive copies', () => {
  const first = getRulePack('social');
  first.entries[0].blockURL = 'changed.example';

  assert.equal(getRulePack('social').entries[0].blockURL, 'facebook.com');
});

test('selection preserves pack order and reports unknown entry IDs', () => {
  const result = resolveRulePackEntries('social', [
    'reddit',
    'facebook',
    'missing'
  ]);

  assert.deepEqual(
    result.entries.map(entry => entry.id),
    ['facebook', 'reddit']
  );
  assert.deepEqual(result.invalidEntryIds, ['missing']);
});

test('unknown packs resolve explicitly to an empty selection', () => {
  assert.deepEqual(
    resolveRulePackEntries('missing-pack', ['anything']),
    {
      pack: null,
      entries: [],
      invalidEntryIds: []
    }
  );
});
