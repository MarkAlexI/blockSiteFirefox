export const GENERAL_RULE_LIST_ID = 'general';
export const MAX_RULE_LIST_NAME_LENGTH = 40;

export const GENERAL_RULE_LIST = Object.freeze({
  id: GENERAL_RULE_LIST_ID,
  name: 'General',
  disabled: false
});

const LIST_ID_PATTERN = /^list-(\d+)$/;

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function normalizeRuleListName(value) {
  return normalizeName(value).slice(0, MAX_RULE_LIST_NAME_LENGTH);
}

export function normalizeRuleLists(value) {
  const source = Array.isArray(value) ? value : [];
  const lists = [{ ...GENERAL_RULE_LIST }];
  const seenIds = new Set([GENERAL_RULE_LIST_ID]);
  const seenNames = new Set([GENERAL_RULE_LIST.name.toLowerCase()]);

  const storedGeneral = source.find(item => item?.id === GENERAL_RULE_LIST_ID);
  if (storedGeneral) {
    lists[0].disabled = storedGeneral.disabled === true;
  }

  for (const item of source) {
    if (!item || item.id === GENERAL_RULE_LIST_ID) continue;

    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const name = normalizeRuleListName(item.name);
    if (!LIST_ID_PATTERN.test(id) || !name) continue;

    const normalizedName = name.toLowerCase();
    if (seenIds.has(id) || seenNames.has(normalizedName)) continue;

    seenIds.add(id);
    seenNames.add(normalizedName);
    lists.push({
      id,
      name,
      disabled: item.disabled === true
    });

  }

  return lists;
}

export function areRuleListsEqual(left, right) {
  return JSON.stringify(normalizeRuleLists(left)) === JSON.stringify(normalizeRuleLists(right));
}

export function createNextRuleListId(lists) {
  let highest = 0;
  for (const list of normalizeRuleLists(lists)) {
    const match = LIST_ID_PATTERN.exec(list.id);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `list-${highest + 1}`;
}

export function getDisabledRuleListIds(lists) {
  return normalizeRuleLists(lists)
    .filter(list => list.disabled)
    .map(list => list.id);
}

export function isKnownRuleListId(lists, listId) {
  const normalizedId = typeof listId === 'string' && listId ? listId : GENERAL_RULE_LIST_ID;
  return normalizeRuleLists(lists).some(list => list.id === normalizedId);
}

export function prepareImportedRuleLists(rawLists) {
  if (rawLists === undefined || rawLists === null) {
    return [{ ...GENERAL_RULE_LIST }];
  }
  if (!Array.isArray(rawLists)) {
    throw new Error('Invalid rule lists format');
  }

  const normalized = normalizeRuleLists(rawLists);
  const sourceCustomCount = rawLists.filter(item => item?.id !== GENERAL_RULE_LIST_ID).length;
  const normalizedCustomCount = normalized.length - 1;

  if (sourceCustomCount !== normalizedCustomCount) {
    throw new Error('Invalid or duplicate rule list');
  }

  return normalized;
}

export class RuleListsManager {
  constructor(storageArea = browser.storage.local) {
    this.storageArea = storageArea;
  }

  async getLists() {
    const result = await this.storageArea.get('ruleLists');
    return normalizeRuleLists(result.ruleLists);
  }

  async saveLists(lists) {
    const normalized = normalizeRuleLists(lists);
    await this.storageArea.set({ ruleLists: normalized });
    return normalized;
  }

  async ensureInitialized() {
    const result = await this.storageArea.get('ruleLists');
    const normalized = normalizeRuleLists(result.ruleLists);
    const migrated = !Array.isArray(result.ruleLists) || !areRuleListsEqual(result.ruleLists, normalized);

    if (migrated) {
      await this.storageArea.set({ ruleLists: normalized });
    }

    return { migrated, lists: normalized };
  }
}
