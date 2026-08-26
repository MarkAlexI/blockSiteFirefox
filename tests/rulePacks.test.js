import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRulePack,
  getRulePacks,
  resolveRulePackEntries
} from '../rules/rulePacks.js';
import { RulesManager } from '../rules/rulesManager.js';

test('rule packs expose stable unique pack and entry IDs', () => {
  const packs = getRulePacks();
  const packIds = packs.map(pack => pack.id);

  assert.equal(new Set(packIds).size, packIds.length);
  assert.deepEqual(packIds, [
    'social',
    'messaging',
    'video',
    'short-video',
    'streaming',
    'news',
    'shopping',
    'gaming'
  ]);
  assert.equal(packs.reduce((total, pack) => total + pack.entries.length, 0), 57);

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

  const entryIds = packs.flatMap(pack => pack.entries.map(entry => entry.id));
  assert.equal(new Set(entryIds).size, entryIds.length);
});

test('expanded packs expose the curated targets and only the intentional overlap', () => {
  assert.deepEqual(getRulePack('social').entries.slice(-3), [
    { id: 'bluesky', blockURL: 'bsky.app' },
    { id: 'tumblr', blockURL: 'tumblr.com' },
    { id: 'quora', blockURL: 'quora.com' }
  ]);
  assert.deepEqual(getRulePack('messaging').entries, [
    { id: 'discord', blockURL: 'discord.com/channels' },
    { id: 'telegram-web', blockURL: 'web.telegram.org' },
    { id: 'whatsapp-web', blockURL: 'web.whatsapp.com' },
    { id: 'messenger', blockURL: 'messenger.com' },
    { id: 'snapchat-web', blockURL: 'snapchat.com/web' }
  ]);
  assert.deepEqual(getRulePack('short-video').entries, [
    { id: 'youtube-shorts', blockURL: 'youtube.com/shorts' },
    { id: 'tiktok-short-video', blockURL: 'tiktok.com' },
    { id: 'instagram-reels', blockURL: 'instagram.com/reel' },
    { id: 'facebook-reels', blockURL: 'facebook.com/reel' }
  ]);
  assert.deepEqual(getRulePack('streaming').entries.map(entry => entry.blockURL), [
    'netflix.com',
    'disneyplus.com',
    'primevideo.com',
    'tv.apple.com',
    'max.com',
    'hulu.com',
    'paramountplus.com',
    'crunchyroll.com'
  ]);
  assert.deepEqual(getRulePack('gaming').entries.slice(-4).map(entry => entry.blockURL), [
    'chess.com',
    'lichess.org',
    'poki.com',
    'crazygames.com'
  ]);

  const targetCounts = new Map();
  for (const pack of getRulePacks()) {
    for (const entry of pack.entries) {
      targetCounts.set(entry.blockURL, (targetCounts.get(entry.blockURL) || 0) + 1);
    }
  }
  assert.deepEqual(
    [...targetCounts].filter(([, count]) => count > 1).map(([target]) => target),
    ['tiktok.com']
  );
});

test('every curated target passes the authoritative rule validator', () => {
  const manager = new RulesManager();

  for (const pack of getRulePacks()) {
    for (const entry of pack.entries) {
      const result = manager.validateRule(entry.blockURL, '', null, pack.category);
      assert.equal(result.isValid, true, `${pack.id}/${entry.id}: ${entry.blockURL}`);
    }
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
