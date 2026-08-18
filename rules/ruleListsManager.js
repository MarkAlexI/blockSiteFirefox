import { CATEGORIES } from './categoryManager.js';

export const GENERAL_RULE_LIST_ID = 'general';
export const ACTIVE_RULE_LIST_KEY = 'activeRuleListId';
export const MAX_RULE_LIST_NAME_LENGTH = 40;
export const MAX_RULE_LISTS = 7;

export const GENERAL_RULE_LIST = Object.freeze({
  id: GENERAL_RULE_LIST_ID,
  name: 'General',
  disabledCategories: Object.freeze([])
});

const LIST_ID_PATTERN = /^list-(\d+)$/;
const CATEGORY_SET = new Set(CATEGORIES);

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export function normalizeRuleListName(value) {
  return normalizeName(value).slice(0, MAX_RULE_LIST_NAME_LENGTH);
}

export function normalizeDisabledCategories(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    if (typeof item !== 'string' || !CATEGORY_SET.has(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function normalizeRuleLists(value) {
  const source = Array.isArray(value) ? value : [];
  const storedGeneral = source.find(item => item?.id === GENERAL_RULE_LIST_ID);
  const lists = [{
    ...GENERAL_RULE_LIST,
    disabledCategories: normalizeDisabledCategories(storedGeneral?.disabledCategories)
  }];
  const seenIds = new Set([GENERAL_RULE_LIST_ID]);
  const seenNames = new Set([GENERAL_RULE_LIST.name.toLowerCase()]);

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
      disabledCategories: normalizeDisabledCategories(item.disabledCategories)
    });
  }

  return lists;
}

export function normalizeActiveRuleListId(lists, value) {
  const normalizedLists = normalizeRuleLists(lists);
  const requested = typeof value === 'string' && value ? value : GENERAL_RULE_LIST_ID;
  return normalizedLists.some(list => list.id === requested)
    ? requested
    : GENERAL_RULE_LIST_ID;
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

export function isKnownRuleListId(lists, listId) {
  const normalizedId = typeof listId === 'string' && listId ? listId : GENERAL_RULE_LIST_ID;
  return normalizeRuleLists(lists).some(list => list.id === normalizedId);
}

export function getRuleListById(lists, listId) {
  const id = normalizeActiveRuleListId(lists, listId);
  return normalizeRuleLists(lists).find(list => list.id === id) || { ...GENERAL_RULE_LIST };
}

export function prepareImportedRuleLists(rawLists, legacyDisabledCategories = []) {
  if (rawLists === undefined || rawLists === null) {
    return [{
      ...GENERAL_RULE_LIST,
      disabledCategories: normalizeDisabledCategories(legacyDisabledCategories)
    }];
  }
  if (!Array.isArray(rawLists)) {
    throw new Error('Invalid rule lists format');
  }

  const normalized = normalizeRuleLists(rawLists);
  if (normalized.length > MAX_RULE_LISTS) {
    throw new Error(`Rule List limit exceeded (${MAX_RULE_LISTS})`);
  }
  const sourceCustomCount = rawLists.filter(item => item?.id !== GENERAL_RULE_LIST_ID).length;
  const normalizedCustomCount = normalized.length - 1;

  if (sourceCustomCount !== normalizedCustomCount) {
    throw new Error('Invalid or duplicate rule list');
  }

  if (legacyDisabledCategories?.length > 0) {
    normalized[0] = {
      ...normalized[0],
      disabledCategories: normalized[0].disabledCategories.length > 0
        ? normalized[0].disabledCategories
        : normalizeDisabledCategories(legacyDisabledCategories)
    };
  }

  return normalized;
}

export class RuleListsManager {
  constructor(storageArea = browser.storage.local) {
    this.storageArea = storageArea;
  }

  async getState() {
    const result = await this.storageArea.get(['ruleLists', ACTIVE_RULE_LIST_KEY]);
    const lists = normalizeRuleLists(result.ruleLists);
    return {
      lists,
      activeRuleListId: normalizeActiveRuleListId(lists, result[ACTIVE_RULE_LIST_KEY])
    };
  }

  async getLists() {
    return (await this.getState()).lists;
  }

  async getActiveListId() {
    return (await this.getState()).activeRuleListId;
  }

  async saveLists(lists) {
    const current = await this.getState();
    const normalized = normalizeRuleLists(lists);
    const activeRuleListId = normalizeActiveRuleListId(normalized, current.activeRuleListId);
    await this.storageArea.set({ ruleLists: normalized, [ACTIVE_RULE_LIST_KEY]: activeRuleListId });
    return normalized;
  }

  async saveState(lists, activeRuleListId) {
    const normalized = normalizeRuleLists(lists);
    const active = normalizeActiveRuleListId(normalized, activeRuleListId);
    await this.storageArea.set({ ruleLists: normalized, [ACTIVE_RULE_LIST_KEY]: active });
    return { lists: normalized, activeRuleListId: active };
  }

  async setActiveListId(listId) {
    const state = await this.getState();
    const activeRuleListId = normalizeActiveRuleListId(state.lists, listId);
    if (activeRuleListId !== listId) throw new Error('rule_list_not_found');
    await this.storageArea.set({ [ACTIVE_RULE_LIST_KEY]: activeRuleListId });
    return activeRuleListId;
  }

  async ensureInitialized({ legacyDisabledCategories = [] } = {}) {
    const result = await this.storageArea.get(['ruleLists', ACTIVE_RULE_LIST_KEY]);
    let normalized = normalizeRuleLists(result.ruleLists);
    if (normalizeDisabledCategories(legacyDisabledCategories).length > 0 &&
        normalized[0].disabledCategories.length === 0) {
      normalized[0] = {
        ...normalized[0],
        disabledCategories: normalizeDisabledCategories(legacyDisabledCategories)
      };
    }
    const activeRuleListId = normalizeActiveRuleListId(normalized, result[ACTIVE_RULE_LIST_KEY]);
    const migrated = !Array.isArray(result.ruleLists) ||
      !areRuleListsEqual(result.ruleLists, normalized) ||
      result[ACTIVE_RULE_LIST_KEY] !== activeRuleListId;

    if (migrated) {
      await this.storageArea.set({ ruleLists: normalized, [ACTIVE_RULE_LIST_KEY]: activeRuleListId });
    }

    return { migrated, lists: normalized, activeRuleListId };
  }
}
