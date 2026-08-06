const RULE_PACKS = [
  {
    id: 'social',
    titleKey: 'rulepack_social_title',
    descriptionKey: 'rulepack_social_desc',
    category: 'social',
    entries: [
      { id: 'facebook', blockURL: 'facebook.com' },
      { id: 'instagram', blockURL: 'instagram.com' },
      { id: 'x', blockURL: 'x.com' },
      { id: 'tiktok', blockURL: 'tiktok.com' },
      { id: 'threads', blockURL: 'threads.net' },
      { id: 'reddit', blockURL: 'reddit.com' },
      { id: 'linkedin', blockURL: 'linkedin.com' },
      { id: 'pinterest', blockURL: 'pinterest.com' }
    ]
  },
  {
    id: 'video',
    titleKey: 'rulepack_video_title',
    descriptionKey: 'rulepack_video_desc',
    category: 'entertainment',
    entries: [
      { id: 'youtube', blockURL: 'youtube.com' },
      { id: 'twitch', blockURL: 'twitch.tv' },
      { id: 'vimeo', blockURL: 'vimeo.com' },
      { id: 'dailymotion', blockURL: 'dailymotion.com' },
      { id: 'kick', blockURL: 'kick.com' }
    ]
  },
  {
    id: 'news',
    titleKey: 'rulepack_news_title',
    descriptionKey: 'rulepack_news_desc',
    category: 'news',
    entries: [
      { id: 'google-news', blockURL: 'news.google.com' },
      { id: 'cnn', blockURL: 'cnn.com' },
      { id: 'bbc-news', blockURL: 'bbc.com/news' },
      { id: 'nytimes', blockURL: 'nytimes.com' },
      { id: 'guardian', blockURL: 'theguardian.com' },
      { id: 'reuters', blockURL: 'reuters.com' },
      { id: 'apnews', blockURL: 'apnews.com' },
      { id: 'yahoo-news', blockURL: 'news.yahoo.com' }
    ]
  },
  {
    id: 'shopping',
    titleKey: 'rulepack_shopping_title',
    descriptionKey: 'rulepack_shopping_desc',
    category: 'shopping',
    entries: [
      { id: 'amazon', blockURL: 'amazon.com' },
      { id: 'ebay', blockURL: 'ebay.com' },
      { id: 'aliexpress', blockURL: 'aliexpress.com' },
      { id: 'temu', blockURL: 'temu.com' },
      { id: 'shein', blockURL: 'shein.com' },
      { id: 'etsy', blockURL: 'etsy.com' }
    ]
  },
  {
    id: 'gaming',
    titleKey: 'rulepack_gaming_title',
    descriptionKey: 'rulepack_gaming_desc',
    category: 'gaming',
    entries: [
      { id: 'steam-store', blockURL: 'store.steampowered.com' },
      { id: 'epic-store', blockURL: 'epicgames.com/store' },
      { id: 'itch', blockURL: 'itch.io' },
      { id: 'roblox', blockURL: 'roblox.com' },
      { id: 'miniclip', blockURL: 'miniclip.com' },
      { id: 'kongregate', blockURL: 'kongregate.com' }
    ]
  }
];

function clonePack(pack) {
  return {
    ...pack,
    entries: pack.entries.map(entry => ({ ...entry }))
  };
}

export function getRulePacks() {
  return RULE_PACKS.map(clonePack);
}

export function getRulePack(packId) {
  const pack = RULE_PACKS.find(item => item.id === packId);
  return pack ? clonePack(pack) : null;
}

export function resolveRulePackEntries(packId, entryIds) {
  const pack = getRulePack(packId);
  if (!pack) {
    return { pack: null, entries: [], invalidEntryIds: [] };
  }

  const requestedIds = Array.isArray(entryIds) ? entryIds : [];
  const requestedSet = new Set(requestedIds);
  const validIds = new Set(pack.entries.map(entry => entry.id));
  const invalidEntryIds = requestedIds.filter(id => !validIds.has(id));
  const entries = pack.entries.filter(entry => requestedSet.has(entry.id));

  return {
    pack,
    entries,
    invalidEntryIds
  };
}
