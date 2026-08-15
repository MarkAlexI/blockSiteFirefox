import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';
import { validateSchedule } from '../schedules/scheduleValidator.js';
import {
  GENERAL_RULE_LIST_ID,
  MAX_RULE_LIST_NAME_LENGTH,
  createNextRuleListId,
  isKnownRuleListId,
  normalizeRuleListName,
  prepareImportedRuleLists
} from './ruleListsManager.js';
import {
  getRuleListIds,
  normalizeRuleListIds,
  mergeRuleListIds,
  removeRuleListId,
  areRuleListIdsEqual
} from './ruleListMembership.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_DAILY_LIMIT,
  getRuleBlockingMode,
  normalizeBlockingConfig
} from './blockingMode.js';

export class RulesMutationError extends Error {
  constructor(code, message = code, validationErrors = []) {
    super(message);
    this.name = 'RulesMutationError';
    this.code = code;
    this.validationErrors = Array.isArray(validationErrors) ? validationErrors : [];
  }
}

export function serializeRulesMutationError(error) {
  return {
    code: error?.code || 'rules_operation_failed',
    message: error?.message || 'Rules operation failed',
    validationErrors: Array.isArray(error?.validationErrors) ? error.validationErrors : []
  };
}

function createAsyncQueue() {
  let tail = Promise.resolve();

  return {
    enqueue(task) {
      const result = tail.then(task, task);
      tail = result.catch(() => {});
      return result;
    }
  };
}

function toRuleId(value) {
  const id = Math.floor(Number(value));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function getRuleIndexById(rules, ruleId) {
  const normalizedId = toRuleId(ruleId);
  if (normalizedId === null) return -1;
  return rules.findIndex(rule => toRuleId(rule.id) === normalizedId);
}

function findExactRuleIndex(rules, blockURL, redirectURL = '', isWhitelist = false, excludeIndex = -1) {
  const cleanBlockURL = typeof blockURL === 'string' ? blockURL.trim() : '';
  const cleanRedirectURL = typeof redirectURL === 'string' ? redirectURL.trim() : '';

  return rules.findIndex((rule, index) => {
    if (excludeIndex !== -1 && index === excludeIndex) return false;
    if ((rule?.isWhitelist === true) !== isWhitelist) return false;
    if ((rule?.blockURL || '').trim() !== cleanBlockURL) return false;
    if (isWhitelist) return true;
    return (rule?.redirectURL || '').trim() === cleanRedirectURL;
  });
}

function cloneSchedule(schedule) {
  return schedule ? normalizeSchedule(schedule) : null;
}

function sanitizeRuleInput(
  payload = {},
  fallbackWhitelist = false,
  fallbackListIds = [GENERAL_RULE_LIST_ID],
  fallbackRule = null
) {
  const isWhitelist = payload.isWhitelist === undefined ? fallbackWhitelist : payload.isWhitelist === true;
  const schedule = payload.schedule === undefined ? (fallbackRule?.schedule ?? null) : payload.schedule;
  const dailyLimit = payload.dailyLimit === undefined ? (fallbackRule?.dailyLimit ?? null) : payload.dailyLimit;
  const blockingMode = typeof payload.blockingMode === 'string' && payload.blockingMode ?
    payload.blockingMode :
    getRuleBlockingMode(fallbackRule || { schedule, dailyLimit, isWhitelist });
  const rawListIds = payload.listIds !== undefined
    ? payload.listIds
    : (payload.listId !== undefined
      ? payload.listId
      : (fallbackRule ? getRuleListIds(fallbackRule) : fallbackListIds));

  return {
    blockURL: typeof payload.blockURL === 'string' ? payload.blockURL : (fallbackRule?.blockURL || ''),
    redirectURL: typeof payload.redirectURL === 'string' ? payload.redirectURL : (fallbackRule?.redirectURL || ''),
    schedule,
    dailyLimit,
    blockingMode,
    category: typeof payload.category === 'string' && payload.category ? payload.category : (fallbackRule?.category || (isWhitelist ? 'whitelist' : 'social')),
    disabledByUser: payload.disabledByUser === undefined ? fallbackRule?.disabledByUser === true : payload.disabledByUser === true,
    listIds: isWhitelist ? [GENERAL_RULE_LIST_ID] : normalizeRuleListIds(rawListIds),
    isWhitelist
  };
}

function getStoredBlockingConfig(input) {
  if (input.isWhitelist) {
    return { blockingMode: BLOCKING_MODE_ALWAYS, schedule: null, dailyLimit: null };
  }
  return normalizeBlockingConfig(input);
}


export function createRulesMutationService({
  rulesManager,
  ruleListsManager,
  dnrSynchronizer,
  declarativeNetRequest,
  getAccess,
  getSettings,
  saveSettings,
  saveRulesAndLists,
  maxRulesLimit,
  notifyRulesChanged,
  resolveRulePackEntries,
  logger
}) {
  const mutationQueue = createAsyncQueue();

  function throwValidation(validation) {
    if (!validation.isValid) {
      throw new RulesMutationError(
        'validation_failed',
        `Validation failed: ${validation.errors.join(', ')}`,
        validation.errors
      );
    }
  }

  function throwConflict(conflict) {
    if (conflict) {
      throw new RulesMutationError(conflict, conflict);
    }
  }

  async function getProAccess() {
    const access = await getAccess();
    return Boolean(access?.isPro || access?.isLegacyUser);
  }

  async function getRuleLists() {
    return ruleListsManager?.getLists?.() || [{ id: GENERAL_RULE_LIST_ID, name: 'General', disabled: false }];
  }

  function validateListName(name, lists, excludeId = null) {
    const normalized = normalizeRuleListName(name);
    const rawTrimmed = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!normalized || rawTrimmed.length > MAX_RULE_LIST_NAME_LENGTH) {
      throw new RulesMutationError('rule_list_name_invalid', 'Rule list name is invalid');
    }
    if (lists.some(list => list.id !== excludeId && list.name.toLowerCase() === normalized.toLowerCase())) {
      throw new RulesMutationError('rule_list_name_exists', 'Rule list name already exists');
    }
    return normalized;
  }

  function validateRuleListSelection(listIds, lists, hasProAccess, isWhitelist = false) {
    if (isWhitelist) return [GENERAL_RULE_LIST_ID];
    const normalizedIds = normalizeRuleListIds(listIds);
    for (const listId of normalizedIds) {
      if (!isKnownRuleListId(lists, listId)) {
        throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      }
      if (listId !== GENERAL_RULE_LIST_ID && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }
    }
    return normalizedIds;
  }

  async function saveCombinedState(rules, lists) {
    if (typeof saveRulesAndLists === 'function') {
      await saveRulesAndLists(rules, lists);
      return;
    }
    await rulesManager.saveRules(rules);
    await ruleListsManager.saveLists(lists);
  }

  function notifyWithoutSync(rules, extra = {}) {
    notifyRulesChanged(rules, extra);
    return { rules, syncPending: false, ...extra };
  }

  async function syncAndNotify(rules, extra = {}) {
    const syncResult = await dnrSynchronizer.requestSync();
    const syncPending = syncResult?.success === false;

    notifyRulesChanged(rules, {
      ...extra,
      syncPending
    });

    return {
      rules,
      syncPending,
      ...extra
    };
  }

  async function addRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const input = sanitizeRuleInput(payload);
      const [rules, lists, hasProAccess] = await Promise.all([
        rulesManager.getRules(),
        getRuleLists(),
        getProAccess()
      ]);

      if (input.isWhitelist && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      input.listIds = validateRuleListSelection(input.listIds, lists, hasProAccess, input.isWhitelist);

      if (!input.isWhitelist && input.blockingMode === BLOCKING_MODE_DAILY_LIMIT && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      throwValidation(rulesManager.validateRule(
        input.blockURL,
        input.redirectURL,
        input.schedule,
        input.category,
        input.isWhitelist,
        input.blockingMode,
        input.dailyLimit
      ));

      throwConflict(rulesManager.checkConflict(rules, input.blockURL, input.isWhitelist));

      const existingIndex = findExactRuleIndex(
        rules,
        input.blockURL,
        input.redirectURL,
        input.isWhitelist
      );

      if (existingIndex !== -1) {
        if (input.isWhitelist) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists');
        }

        const existingRule = rules[existingIndex];
        const mergedListIds = mergeRuleListIds(getRuleListIds(existingRule), input.listIds);
        if (areRuleListIdsEqual(mergedListIds, getRuleListIds(existingRule))) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists');
        }

        const updatedRule = {
          ...existingRule,
          listIds: mergedListIds
        };
        delete updatedRule.listId;

        const nextRules = [...rules];
        nextRules[existingIndex] = updatedRule;
        await rulesManager.saveRules(nextRules);
        return syncAndNotify(nextRules, {
          rule: updatedRule,
          membershipAdded: true,
          created: false
        });
      }

      if (!input.isWhitelist && !hasProAccess && rules.length >= maxRulesLimit) {
        throw new RulesMutationError('rule_limit_reached', 'Free rule limit reached');
      }

      const dnrRules = await declarativeNetRequest.getDynamicRules();
      const occupiedIds = new Set([
        ...rules.map(rule => toRuleId(rule.id)).filter(Boolean),
        ...dnrRules.map(rule => toRuleId(rule.id)).filter(Boolean)
      ]);

      let safeId = 1;
      while (occupiedIds.has(safeId)) safeId++;

      const blockingConfig = getStoredBlockingConfig(input);
      const newRule = {
        id: safeId,
        blockURL: input.blockURL.trim(),
        redirectURL: input.isWhitelist ? '' : input.redirectURL.trim(),
        schedule: blockingConfig.schedule,
        blockingMode: blockingConfig.blockingMode,
        dailyLimit: blockingConfig.dailyLimit,
        category: input.isWhitelist ? 'whitelist' : input.category,
        disabledByUser: false,
        listIds: input.isWhitelist ? [GENERAL_RULE_LIST_ID] : input.listIds,
        isWhitelist: input.isWhitelist
      };

      const nextRules = [...rules, newRule];
      await rulesManager.saveRules(nextRules);

      return syncAndNotify(nextRules, { rule: newRule, membershipAdded: false, created: true });
    });
  }

  async function addMany(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const hasProAccess = await getProAccess();
      if (!hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      const lists = await getRuleLists();
      const [targetListId] = validateRuleListSelection(
        [payload.listId || GENERAL_RULE_LIST_ID],
        lists,
        hasProAccess,
        false
      );

      if (typeof resolveRulePackEntries !== 'function') {
        throw new RulesMutationError('rule_pack_unavailable', 'Rule packs are unavailable');
      }

      const selection = resolveRulePackEntries(payload.packId, payload.entryIds);
      if (!selection.pack) {
        throw new RulesMutationError('rule_pack_not_found', 'Rule pack not found');
      }
      if (selection.invalidEntryIds.length > 0) {
        throw new RulesMutationError('rule_pack_invalid_selection', 'Rule pack selection is invalid');
      }
      if (selection.entries.length === 0) {
        throw new RulesMutationError('rule_pack_empty', 'Select at least one rule');
      }

      const sharedSchedule = payload.schedule == null
        ? null
        : normalizeSchedule(payload.schedule);
      const scheduleValidation = validateSchedule(sharedSchedule);
      throwValidation(scheduleValidation);

      const rules = await rulesManager.getRules();
      const nextRules = [...rules];
      const addedEntries = [];
      const membershipAddedEntries = [];
      const duplicateEntries = [];
      const conflicts = [];
      let newRuleCount = 0;

      const dnrRules = await declarativeNetRequest.getDynamicRules();
      const occupiedIds = new Set([
        ...rules.map(rule => toRuleId(rule.id)).filter(Boolean),
        ...dnrRules.map(rule => toRuleId(rule.id)).filter(Boolean)
      ]);

      function getNextSafeId() {
        let safeId = 1;
        while (occupiedIds.has(safeId)) safeId++;
        occupiedIds.add(safeId);
        return safeId;
      }

      for (const entry of selection.entries) {
        const input = sanitizeRuleInput({
          blockURL: entry.blockURL,
          redirectURL: '',
          schedule: sharedSchedule,
          category: selection.pack.category,
          listIds: [targetListId],
          isWhitelist: false
        });

        const validation = rulesManager.validateRule(
          input.blockURL,
          input.redirectURL,
          input.schedule,
          input.category,
          false,
          input.blockingMode,
          input.dailyLimit
        );

        if (!validation.isValid) {
          throw new RulesMutationError(
            'rule_pack_invalid',
            `Invalid rule pack entry: ${input.blockURL}`,
            validation.errors
          );
        }

        const conflict = rulesManager.checkConflict(nextRules, input.blockURL, false);
        if (conflict) {
          conflicts.push({
            entryId: entry.id,
            blockURL: input.blockURL,
            code: conflict
          });
          continue;
        }

        const existingIndex = findExactRuleIndex(nextRules, input.blockURL, '', false);
        if (existingIndex !== -1) {
          const existingRule = nextRules[existingIndex];
          const mergedListIds = mergeRuleListIds(getRuleListIds(existingRule), [targetListId]);
          if (areRuleListIdsEqual(mergedListIds, getRuleListIds(existingRule))) {
            duplicateEntries.push({
              entryId: entry.id,
              blockURL: input.blockURL
            });
            continue;
          }

          const updatedRule = { ...existingRule, listIds: mergedListIds };
          delete updatedRule.listId;
          nextRules[existingIndex] = updatedRule;
          const reportEntry = {
            entryId: entry.id,
            blockURL: input.blockURL,
            membershipOnly: true
          };
          addedEntries.push(reportEntry);
          membershipAddedEntries.push(reportEntry);
          continue;
        }

        const blockingConfig = getStoredBlockingConfig(input);
        nextRules.push({
          id: getNextSafeId(),
          blockURL: input.blockURL.trim(),
          redirectURL: '',
          schedule: blockingConfig.schedule ? cloneSchedule(blockingConfig.schedule) : null,
          blockingMode: blockingConfig.blockingMode,
          dailyLimit: null,
          category: selection.pack.category,
          disabledByUser: false,
          listIds: [targetListId],
          isWhitelist: false
        });
        addedEntries.push({
          entryId: entry.id,
          blockURL: input.blockURL
        });
        newRuleCount++;
      }

      const addedCount = addedEntries.length;
      const result = {
        addedCount,
        newRuleCount,
        membershipAddedCount: membershipAddedEntries.length,
        skippedDuplicates: duplicateEntries.length,
        addedEntries,
        membershipAddedEntries,
        duplicateEntries,
        conflicts,
        packId: selection.pack.id,
        listId: targetListId,
        scheduleApplied: sharedSchedule !== null
      };

      if (addedCount === 0) {
        return {
          rules,
          syncPending: false,
          ...result
        };
      }

      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, result);
    });
  }

  async function updateRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const rules = await rulesManager.getRules();
      const index = getRuleIndexById(rules, payload.ruleId);

      if (index === -1) {
        throw new RulesMutationError('rule_not_found', 'Rule not found');
      }

      const oldRule = rules[index];
      const input = sanitizeRuleInput(
        payload,
        oldRule.isWhitelist === true,
        getRuleListIds(oldRule),
        oldRule
      );
      input.isWhitelist = oldRule.isWhitelist === true;

      const hasProAccess = await getProAccess();
      if (input.isWhitelist && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }
      const lists = await getRuleLists();
      input.listIds = validateRuleListSelection(input.listIds, lists, hasProAccess, input.isWhitelist);

      if (!input.isWhitelist && input.blockingMode === BLOCKING_MODE_DAILY_LIMIT && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      throwValidation(rulesManager.validateRule(
        input.blockURL,
        input.redirectURL,
        input.schedule,
        input.category,
        input.isWhitelist,
        input.blockingMode,
        input.dailyLimit
      ));

      throwConflict(rulesManager.checkConflict(
        rules,
        input.blockURL,
        input.isWhitelist,
        index
      ));

      if (rulesManager.ruleExists(
        rules,
        input.blockURL,
        input.redirectURL,
        index,
        input.isWhitelist
      )) {
        throw new RulesMutationError('rule_already_exists', 'Rule already exists');
      }

      let disabledByUser = payload.disabledByUser === null || payload.disabledByUser === undefined ?
        oldRule.disabledByUser === true :
        payload.disabledByUser === true;

      if ((payload.disabledByUser === null || payload.disabledByUser === undefined) && !oldRule.schedule && input.schedule) {
        disabledByUser = false;
      }

      const blockingConfig = getStoredBlockingConfig(input);
      const updatedRule = {
        id: oldRule.id,
        blockURL: input.blockURL.trim(),
        redirectURL: input.isWhitelist ? '' : input.redirectURL.trim(),
        schedule: blockingConfig.schedule,
        blockingMode: blockingConfig.blockingMode,
        dailyLimit: blockingConfig.dailyLimit,
        category: input.isWhitelist ? 'whitelist' : input.category,
        disabledByUser,
        listIds: input.isWhitelist ? [GENERAL_RULE_LIST_ID] : input.listIds,
        isWhitelist: input.isWhitelist
      };

      const nextRules = [...rules];
      nextRules[index] = updatedRule;
      await rulesManager.saveRules(nextRules);

      return syncAndNotify(nextRules, { rule: updatedRule });
    });
  }

  async function deleteRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const rules = await rulesManager.getRules();
      const index = getRuleIndexById(rules, payload.ruleId);

      if (index === -1) {
        throw new RulesMutationError('rule_not_found', 'Rule not found');
      }

      const deletedRule = rules[index];
      const nextRules = rules.filter((_, ruleIndex) => ruleIndex !== index);
      await rulesManager.saveRules(nextRules);

      return syncAndNotify(nextRules, { rule: deletedRule });
    });
  }

  async function toggleRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const rules = await rulesManager.getRules();
      const index = getRuleIndexById(rules, payload.ruleId);

      if (index === -1) {
        throw new RulesMutationError('rule_not_found', 'Rule not found');
      }

      const updatedRule = {
        ...rules[index],
        disabledByUser: !rules[index].disabledByUser
      };

      const nextRules = [...rules];
      nextRules[index] = updatedRule;
      await rulesManager.saveRules(nextRules);

      return syncAndNotify(nextRules, { rule: updatedRule });
    });
  }

  function prepareReplacementRules(importedRules, importedLists) {
    if (!Array.isArray(importedRules)) {
      throw new RulesMutationError('invalid_import', 'Invalid file format: missing rules array');
    }

    const preparedRules = [];

    importedRules.forEach((rawRule, index) => {
      const input = sanitizeRuleInput(rawRule, rawRule?.isWhitelist === true, [GENERAL_RULE_LIST_ID]);
      if (!input.isWhitelist && (!rawRule?.category || typeof rawRule.category !== 'string')) {
        input.category = 'uncategorized';
      }

      if (input.listIds.some(listId => !isKnownRuleListId(importedLists, listId))) {
        throw new RulesMutationError('invalid_import', `Unknown rule list for imported rule ${index + 1}`);
      }

      const validation = rulesManager.validateRule(
        input.blockURL,
        input.redirectURL,
        input.schedule,
        input.category,
        input.isWhitelist,
        input.blockingMode,
        input.dailyLimit
      );

      if (!validation.isValid) {
        throw new RulesMutationError(
          'validation_failed',
          `Validation failed for imported rule ${index + 1}: ${validation.errors.join(', ')}`,
          validation.errors
        );
      }

      throwConflict(rulesManager.checkConflict(
        preparedRules,
        input.blockURL,
        input.isWhitelist
      ));

      if (rulesManager.ruleExists(
        preparedRules,
        input.blockURL,
        input.redirectURL,
        -1,
        input.isWhitelist
      )) {
        throw new RulesMutationError('rule_already_exists', 'Rule already exists');
      }

      const blockingConfig = getStoredBlockingConfig(input);
      preparedRules.push({
        id: index + 1,
        blockURL: input.blockURL.trim(),
        redirectURL: input.isWhitelist ? '' : input.redirectURL.trim(),
        schedule: blockingConfig.schedule,
        blockingMode: blockingConfig.blockingMode,
        dailyLimit: blockingConfig.dailyLimit,
        category: input.isWhitelist ? 'whitelist' : (input.category || 'uncategorized'),
        disabledByUser: input.disabledByUser,
        listIds: input.isWhitelist ? [GENERAL_RULE_LIST_ID] : input.listIds,
        isWhitelist: input.isWhitelist
      });
    });

    return preparedRules;
  }

  async function replaceAll(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      let importedLists;
      try {
        importedLists = prepareImportedRuleLists(payload.ruleLists);
      } catch (error) {
        throw new RulesMutationError('invalid_import', error.message);
      }
      const nextRules = prepareReplacementRules(payload.rules, importedLists);
      let importedSettings = null;

      if (payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)) {
        const currentSettings = await getSettings();
        const sanitizedSettings = { ...payload.settings };

        delete sanitizedSettings.enablePassword;
        delete sanitizedSettings.passwordHash;

        importedSettings = {
          ...currentSettings,
          ...sanitizedSettings,
          enablePassword: currentSettings.enablePassword,
          passwordHash: currentSettings.passwordHash
        };

        await saveSettings(importedSettings);
      }

      await saveCombinedState(nextRules, importedLists);
      return syncAndNotify(nextRules, { settings: importedSettings, ruleLists: importedLists });
    });
  }

  async function clearRules() {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      const nextRules = [];
      await rulesManager.saveRules(nextRules);

      // The synchronizer obtains every current DNR rule ID and calls updateDynamicRules with both removeRuleIds and addRules: [].
      return syncAndNotify(nextRules);
    });
  }

  async function toggleCategory(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      const category = typeof payload.category === 'string' ? payload.category : '';
      if (!category) {
        throw new RulesMutationError('category_required', 'Category is required', ['category_required']);
      }

      const settings = await getSettings();
      const disabledCategories = Array.isArray(settings.disabledCategories) ? settings.disabledCategories : [];
      const nextDisabledCategories = disabledCategories.includes(category) ?
        disabledCategories.filter(item => item !== category) :
        [...disabledCategories, category];
      const nextSettings = {
        ...settings,
        disabledCategories: nextDisabledCategories
      };

      await saveSettings(nextSettings);
      const rules = await rulesManager.getRules();
      return syncAndNotify(rules, { settings: nextSettings });
    });
  }

  async function createRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }
      const lists = await getRuleLists();
      const name = validateListName(payload.name, lists);
      const list = { id: createNextRuleListId(lists), name, disabled: false };
      const nextLists = [...lists, list];
      await ruleListsManager.saveLists(nextLists);
      const rules = await rulesManager.getRules();
      return notifyWithoutSync(rules, { ruleLists: nextLists, list });
    });
  }

  async function renameRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      if (listId === GENERAL_RULE_LIST_ID) {
        throw new RulesMutationError('rule_list_locked', 'General list cannot be renamed');
      }
      const lists = await getRuleLists();
      const index = lists.findIndex(list => list.id === listId);
      if (index === -1) throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      const name = validateListName(payload.name, lists, listId);
      const nextLists = lists.map((list, itemIndex) => itemIndex === index ? { ...list, name } : list);
      await ruleListsManager.saveLists(nextLists);
      const rules = await rulesManager.getRules();
      return notifyWithoutSync(rules, { ruleLists: nextLists, list: nextLists[index] });
    });
  }

  async function toggleRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      const lists = await getRuleLists();
      const index = lists.findIndex(list => list.id === listId);
      if (index === -1) throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      const nextLists = lists.map((list, itemIndex) => itemIndex === index ? { ...list, disabled: !list.disabled } : list);
      await ruleListsManager.saveLists(nextLists);
      const rules = await rulesManager.getRules();
      return syncAndNotify(rules, { ruleLists: nextLists, list: nextLists[index] });
    });
  }

  async function deleteRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      if (listId === GENERAL_RULE_LIST_ID) {
        throw new RulesMutationError('rule_list_locked', 'General list cannot be deleted');
      }
      const [lists, rules] = await Promise.all([getRuleLists(), rulesManager.getRules()]);
      if (!lists.some(list => list.id === listId)) {
        throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      }
      const nextLists = lists.filter(list => list.id !== listId);
      const nextRules = rules.map(rule => {
        if (rule.isWhitelist === true) return { ...rule, listIds: [GENERAL_RULE_LIST_ID] };
        const currentIds = getRuleListIds(rule);
        if (!currentIds.includes(listId)) return rule;
        const updatedRule = { ...rule, listIds: removeRuleListId(currentIds, listId) };
        delete updatedRule.listId;
        return updatedRule;
      });
      await saveCombinedState(nextRules, nextLists);
      return syncAndNotify(nextRules, { ruleLists: nextLists, deletedListId: listId });
    });
  }

  function runExclusive(task) {
    return mutationQueue.enqueue(task);
  }

  return {
    addRule,
    addMany,
    updateRule,
    deleteRule,
    toggleRule,
    replaceAll,
    clearRules,
    toggleCategory,
    createRuleList,
    renameRuleList,
    toggleRuleList,
    deleteRuleList,
    runExclusive
  };
}
