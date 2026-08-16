import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';
import { validateSchedule } from '../schedules/scheduleValidator.js';
import {
  GENERAL_RULE_LIST_ID,
  MAX_RULE_LIST_NAME_LENGTH,
  createNextRuleListId,
  isKnownRuleListId,
  normalizeRuleListName,
  normalizeActiveRuleListId,
  prepareImportedRuleLists
} from './ruleListsManager.js';
import {
  addRuleAssignment,
  createAlwaysAssignment,
  createRuleAssignment,
  getRuleAssignment,
  getRuleAssignments,
  normalizeRuleAssignments,
  removeRuleAssignment,
  replaceRuleAssignment
} from './ruleAssignments.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_DAILY_LIMIT,
  getRuleBlockingMode
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

function findTargetRuleIndex(rules, blockURL, isWhitelist = false, excludeIndex = -1) {
  const cleanBlockURL = typeof blockURL === 'string' ? blockURL.trim() : '';

  return rules.findIndex((rule, index) => {
    if (excludeIndex !== -1 && index === excludeIndex) return false;
    if ((rule?.isWhitelist === true) !== isWhitelist) return false;
    return (rule?.blockURL || '').trim() === cleanBlockURL;
  });
}

function canonicalizeRuleTarget(rule, assignments = getRuleAssignments(rule)) {
  const canonical = {
    ...rule,
    assignments
  };
  for (const legacyKey of ['listId', 'listIds', 'blockingMode', 'schedule', 'dailyLimit']) {
    delete canonical[legacyKey];
  }
  return canonical;
}

function sanitizeTargetInput(payload = {}, fallbackWhitelist = false, fallbackRule = null) {
  const isWhitelist = payload.isWhitelist === undefined ? fallbackWhitelist : payload.isWhitelist === true;
  return {
    blockURL: typeof payload.blockURL === 'string' ? payload.blockURL : (fallbackRule?.blockURL || ''),
    redirectURL: typeof payload.redirectURL === 'string' ? payload.redirectURL : (fallbackRule?.redirectURL || ''),
    category: typeof payload.category === 'string' && payload.category
      ? payload.category
      : (fallbackRule?.category || (isWhitelist ? 'whitelist' : 'social')),
    disabledByUser: payload.disabledByUser === undefined
      ? fallbackRule?.disabledByUser === true
      : payload.disabledByUser === true,
    isWhitelist
  };
}

function getLegacyListIds(payload = {}, fallbackRule = null) {
  if (payload.assignment?.listId) return [payload.assignment.listId];
  if (payload.targetListId) return [payload.targetListId];
  if (payload.listId) return [payload.listId];
  if (Array.isArray(payload.listIds) && payload.listIds.length > 0) return payload.listIds;
  if (fallbackRule) return getRuleAssignments(fallbackRule).map(item => item.listId);
  return [GENERAL_RULE_LIST_ID];
}

function createAssignmentInputs(payload = {}, fallbackRule = null, fallbackAssignment = null) {
  if (Array.isArray(payload.assignments) && payload.assignments.length > 0) {
    return payload.assignments.map(item => createRuleAssignment(item.listId, item));
  }

  const source = payload.assignment && typeof payload.assignment === 'object'
    ? payload.assignment
    : payload;
  const fallback = fallbackAssignment || (fallbackRule ? getRuleAssignments(fallbackRule)[0] : null);
  const blockingMode = typeof source.blockingMode === 'string' && source.blockingMode
    ? source.blockingMode
    : getRuleBlockingMode(fallback || source);
  const config = {
    blockingMode,
    schedule: source.schedule === undefined ? (fallback?.schedule ?? null) : source.schedule,
    dailyLimit: source.dailyLimit === undefined ? (fallback?.dailyLimit ?? null) : source.dailyLimit
  };

  return getLegacyListIds(payload, fallbackRule)
    .map(listId => createRuleAssignment(listId, config));
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
    if (conflict) throw new RulesMutationError(conflict, conflict);
  }

  async function getProAccess() {
    const access = await getAccess();
    return Boolean(access?.isPro || access?.isLegacyUser);
  }

  async function getRuleLists() {
    return ruleListsManager?.getLists?.() || [{ id: GENERAL_RULE_LIST_ID, name: 'General', disabledCategories: [] }];
  }

  async function getRuleListState() {
    if (typeof ruleListsManager?.getState === 'function') return ruleListsManager.getState();
    const lists = await getRuleLists();
    return { lists, activeRuleListId: GENERAL_RULE_LIST_ID };
  }

  async function saveRuleListState(lists, activeRuleListId) {
    if (typeof ruleListsManager?.saveState === 'function') {
      return ruleListsManager.saveState(lists, activeRuleListId);
    }
    const savedLists = await ruleListsManager.saveLists(lists);
    return { lists: savedLists || lists, activeRuleListId };
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

  function validateAssignment(assignment, lists, hasProAccess, target, validationCode = 'validation_failed') {
    const listId = assignment?.listId || GENERAL_RULE_LIST_ID;
    if (!isKnownRuleListId(lists, listId)) {
      throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
    }
    if (listId !== GENERAL_RULE_LIST_ID && !hasProAccess) {
      throw new RulesMutationError('pro_required', 'Pro access is required');
    }
    if (!target.isWhitelist && assignment.blockingMode === BLOCKING_MODE_DAILY_LIMIT && !hasProAccess) {
      throw new RulesMutationError('pro_required', 'Pro access is required');
    }

    const validation = rulesManager.validateRule(
      target.blockURL,
      target.redirectURL,
      assignment.schedule,
      target.category,
      target.isWhitelist,
      assignment.blockingMode,
      assignment.dailyLimit
    );
    if (!validation.isValid) {
      throw new RulesMutationError(
        validationCode,
        `Validation failed: ${validation.errors.join(', ')}`,
        validation.errors
      );
    }
    return assignment;
  }

  function validateAssignments(assignments, lists, hasProAccess, target, validationCode = 'validation_failed') {
    const normalized = target.isWhitelist
      ? [createAlwaysAssignment(GENERAL_RULE_LIST_ID)]
      : assignments;
    const seen = new Set();
    for (const assignment of normalized) {
      if (seen.has(assignment.listId)) {
        throw new RulesMutationError('rule_assignment_exists', 'Rule already has settings for this list');
      }
      seen.add(assignment.listId);
      validateAssignment(assignment, lists, hasProAccess, target, validationCode);
    }
    return normalized;
  }

  async function saveCombinedState(rules, lists, activeRuleListId = null) {
    if (typeof saveRulesAndLists === 'function') {
      await saveRulesAndLists(rules, lists, activeRuleListId);
      return;
    }
    await rulesManager.saveRules(rules);
    if (activeRuleListId) {
      await ruleListsManager.saveState(lists, activeRuleListId);
    } else {
      await ruleListsManager.saveLists(lists);
    }
  }

  function notifyWithoutSync(rules, extra = {}) {
    notifyRulesChanged(rules, extra);
    return { rules, syncPending: false, ...extra };
  }

  async function syncAndNotify(rules, extra = {}) {
    const syncResult = await dnrSynchronizer.requestSync();
    const syncPending = syncResult?.success === false;
    notifyRulesChanged(rules, { ...extra, syncPending });
    return { rules, syncPending, ...extra };
  }

  async function addRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const target = sanitizeTargetInput(payload);
      const [rules, lists, hasProAccess] = await Promise.all([
        rulesManager.getRules(), getRuleLists(), getProAccess()
      ]);

      if (target.isWhitelist && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      const assignments = validateAssignments(
        createAssignmentInputs(payload), lists, hasProAccess, target
      );
      throwConflict(rulesManager.checkConflict(rules, target.blockURL, target.isWhitelist));

      const existingIndex = findTargetRuleIndex(rules, target.blockURL, target.isWhitelist);
      if (existingIndex !== -1) {
        if (target.isWhitelist) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists');
        }
        const existingRule = rules[existingIndex];
        let nextAssignments = getRuleAssignments(existingRule);
        let added = 0;
        for (const assignment of assignments) {
          if (getRuleAssignment({ ...existingRule, assignments: nextAssignments }, assignment.listId)) continue;
          nextAssignments = addRuleAssignment({ ...existingRule, assignments: nextAssignments }, assignment);
          added++;
        }
        if (added === 0) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists in this list');
        }
        const updatedRule = canonicalizeRuleTarget(existingRule, nextAssignments);
        const nextRules = [...rules];
        nextRules[existingIndex] = updatedRule;
        await rulesManager.saveRules(nextRules);
        return syncAndNotify(nextRules, {
          rule: updatedRule,
          assignmentAdded: true,
          membershipAdded: true,
          created: false
        });
      }

      if (!target.isWhitelist && !hasProAccess && rules.length >= maxRulesLimit) {
        throw new RulesMutationError('rule_limit_reached', 'Free rule limit reached');
      }

      const dnrRules = await declarativeNetRequest.getDynamicRules();
      const occupiedIds = new Set([
        ...rules.map(rule => toRuleId(rule.id)).filter(Boolean),
        ...dnrRules.map(rule => toRuleId(rule.id)).filter(Boolean)
      ]);
      let safeId = 1;
      while (occupiedIds.has(safeId)) safeId++;

      const newRule = {
        id: safeId,
        blockURL: target.blockURL.trim(),
        redirectURL: target.isWhitelist ? '' : target.redirectURL.trim(),
        category: target.isWhitelist ? 'whitelist' : target.category,
        disabledByUser: false,
        assignments: target.isWhitelist ? [createAlwaysAssignment()] : assignments,
        isWhitelist: target.isWhitelist
      };
      const nextRules = [...rules, newRule];
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, {
        rule: newRule,
        assignmentAdded: false,
        membershipAdded: false,
        created: true
      });
    });
  }

  async function addMany(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const hasProAccess = await getProAccess();
      if (!hasProAccess) throw new RulesMutationError('pro_required', 'Pro access is required');

      const lists = await getRuleLists();
      const targetListId = payload.listId || GENERAL_RULE_LIST_ID;
      if (!isKnownRuleListId(lists, targetListId)) {
        throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      }
      if (targetListId !== GENERAL_RULE_LIST_ID && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      if (typeof resolveRulePackEntries !== 'function') {
        throw new RulesMutationError('rule_pack_unavailable', 'Rule packs are unavailable');
      }
      const selection = resolveRulePackEntries(payload.packId, payload.entryIds);
      if (!selection.pack) throw new RulesMutationError('rule_pack_not_found', 'Rule pack not found');
      if (selection.invalidEntryIds.length > 0) {
        throw new RulesMutationError('rule_pack_invalid_selection', 'Rule pack selection is invalid');
      }
      if (selection.entries.length === 0) {
        throw new RulesMutationError('rule_pack_empty', 'Select at least one rule');
      }

      const sharedSchedule = payload.schedule == null ? null : normalizeSchedule(payload.schedule);
      if (sharedSchedule) throwValidation(validateSchedule(sharedSchedule));
      const assignmentConfig = createRuleAssignment(targetListId, sharedSchedule
        ? { blockingMode: 'schedule', schedule: sharedSchedule, dailyLimit: null }
        : { blockingMode: BLOCKING_MODE_ALWAYS, schedule: null, dailyLimit: null });

      const rules = await rulesManager.getRules();
      const nextRules = [...rules];
      const addedEntries = [];
      const assignmentAddedEntries = [];
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
        const target = sanitizeTargetInput({
          blockURL: entry.blockURL,
          redirectURL: '',
          category: selection.pack.category,
          isWhitelist: false
        });
        validateAssignment(assignmentConfig, lists, hasProAccess, target, 'rule_pack_invalid');

        const conflict = rulesManager.checkConflict(nextRules, target.blockURL, false);
        if (conflict) {
          conflicts.push({ entryId: entry.id, blockURL: target.blockURL, code: conflict });
          continue;
        }

        const existingIndex = findTargetRuleIndex(nextRules, target.blockURL, false);
        if (existingIndex !== -1) {
          const existingRule = nextRules[existingIndex];
          if (getRuleAssignment(existingRule, targetListId)) {
            duplicateEntries.push({ entryId: entry.id, blockURL: target.blockURL });
            continue;
          }
          const updatedRule = canonicalizeRuleTarget(
            existingRule,
            addRuleAssignment(existingRule, assignmentConfig)
          );
          nextRules[existingIndex] = updatedRule;
          const reportEntry = { entryId: entry.id, blockURL: target.blockURL };
          addedEntries.push(reportEntry);
          assignmentAddedEntries.push(reportEntry);
          continue;
        }

        nextRules.push({
          id: getNextSafeId(),
          blockURL: target.blockURL.trim(),
          redirectURL: '',
          category: selection.pack.category,
          disabledByUser: false,
          assignments: [assignmentConfig],
          isWhitelist: false
        });
        const reportEntry = { entryId: entry.id, blockURL: target.blockURL };
        addedEntries.push(reportEntry);
        newRuleCount++;
      }

      const result = {
        addedCount: addedEntries.length,
        newRuleCount,
        assignmentAddedCount: assignmentAddedEntries.length,
        membershipAddedCount: assignmentAddedEntries.length,
        skippedDuplicates: duplicateEntries.length,
        addedEntries,
        assignmentAddedEntries,
        membershipAddedEntries: assignmentAddedEntries,
        duplicateEntries,
        conflicts,
        packId: selection.pack.id,
        listId: targetListId,
        scheduleApplied: sharedSchedule !== null
      };

      if (addedEntries.length === 0) {
        return { rules, syncPending: false, ...result };
      }
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, result);
    });
  }

  async function updateRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const rules = await rulesManager.getRules();
      const index = getRuleIndexById(rules, payload.ruleId);
      if (index === -1) throw new RulesMutationError('rule_not_found', 'Rule not found');

      const oldRule = rules[index];
      const target = sanitizeTargetInput(payload, oldRule.isWhitelist === true, oldRule);
      target.isWhitelist = oldRule.isWhitelist === true;
      const [lists, hasProAccess] = await Promise.all([getRuleLists(), getProAccess()]);
      if (target.isWhitelist && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      let nextAssignments;
      const sourceListId = payload.assignmentListId || payload.sourceListId || null;
      if (target.isWhitelist) {
        nextAssignments = [createAlwaysAssignment()];
      } else if (sourceListId) {
        const currentAssignment = getRuleAssignment(oldRule, sourceListId);
        if (!currentAssignment) {
          throw new RulesMutationError('rule_assignment_not_found', 'Rule assignment not found');
        }
        const assignmentPayload = payload.assignment && typeof payload.assignment === 'object'
          ? payload.assignment
          : {
              listId: payload.targetListId || payload.listId || sourceListId,
              blockingMode: payload.blockingMode ?? currentAssignment.blockingMode,
              schedule: payload.schedule === undefined ? currentAssignment.schedule : payload.schedule,
              dailyLimit: payload.dailyLimit === undefined ? currentAssignment.dailyLimit : payload.dailyLimit
            };
        const nextAssignment = createRuleAssignment(
          assignmentPayload.listId || sourceListId,
          assignmentPayload
        );
        validateAssignment(nextAssignment, lists, hasProAccess, target);
        try {
          nextAssignments = replaceRuleAssignment(oldRule, sourceListId, nextAssignment);
        } catch (error) {
          if (error.message === 'rule_assignment_exists') {
            throw new RulesMutationError('rule_assignment_exists', 'Rule already has settings for this list');
          }
          throw new RulesMutationError('rule_assignment_not_found', 'Rule assignment not found');
        }
      } else {
        // Backward-compatible RC4 update path: the old UI submitted listIds and
        // one shared blocking config. Convert that request into assignments.
        nextAssignments = validateAssignments(
          createAssignmentInputs(payload, oldRule), lists, hasProAccess, target
        );
      }

      validateAssignments(nextAssignments, lists, hasProAccess, target);
      throwConflict(rulesManager.checkConflict(rules, target.blockURL, target.isWhitelist, index));
      if (findTargetRuleIndex(rules, target.blockURL, target.isWhitelist, index) !== -1) {
        throw new RulesMutationError('rule_already_exists', 'Rule already exists');
      }

      let disabledByUser = payload.disabledByUser == null
        ? oldRule.disabledByUser === true
        : payload.disabledByUser === true;

      const updatedRule = canonicalizeRuleTarget({
        id: oldRule.id,
        blockURL: target.blockURL.trim(),
        redirectURL: target.isWhitelist ? '' : target.redirectURL.trim(),
        category: target.isWhitelist ? 'whitelist' : target.category,
        disabledByUser,
        assignments: nextAssignments,
        isWhitelist: target.isWhitelist
      }, nextAssignments);
      const nextRules = [...rules];
      nextRules[index] = updatedRule;
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, { rule: updatedRule });
    });
  }

  async function removeAssignment(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const rules = await rulesManager.getRules();
      const index = getRuleIndexById(rules, payload.ruleId);
      if (index === -1) throw new RulesMutationError('rule_not_found', 'Rule not found');
      const rule = rules[index];
      if (rule.isWhitelist) throw new RulesMutationError('rule_assignment_locked', 'Whitelist assignment cannot be removed');
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      if (!getRuleAssignment(rule, listId)) {
        throw new RulesMutationError('rule_assignment_not_found', 'Rule assignment not found');
      }
      const currentAssignments = getRuleAssignments(rule);
      if (currentAssignments.length === 1) {
        const nextRules = rules.filter((_, ruleIndex) => ruleIndex !== index);
        await rulesManager.saveRules(nextRules);
        return syncAndNotify(nextRules, {
          rule,
          removedAssignmentListId: listId,
          targetDeleted: true
        });
      }
      const nextAssignments = removeRuleAssignment(rule, listId, { fallbackToGeneral: false });
      const updatedRule = canonicalizeRuleTarget(rule, nextAssignments);
      const nextRules = [...rules];
      nextRules[index] = updatedRule;
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, {
        rule: updatedRule,
        removedAssignmentListId: listId,
        targetDeleted: false
      });
    });
  }

  async function deleteRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const rules = await rulesManager.getRules();
      const index = getRuleIndexById(rules, payload.ruleId);
      if (index === -1) throw new RulesMutationError('rule_not_found', 'Rule not found');
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
      if (index === -1) throw new RulesMutationError('rule_not_found', 'Rule not found');
      const updatedRule = { ...rules[index], disabledByUser: !rules[index].disabledByUser };
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
      const target = sanitizeTargetInput(rawRule, rawRule?.isWhitelist === true);
      if (!target.isWhitelist && (!rawRule?.category || typeof rawRule.category !== 'string')) {
        target.category = 'uncategorized';
      }
      const assignments = rawRule?.isWhitelist === true
        ? [createAlwaysAssignment()]
        : normalizeRuleAssignments(rawRule);
      // Import is a Pro-only operation, so custom list and Daily Limit access is
      // already established by replaceAll(). We still validate all references.
      validateAssignments(assignments, importedLists, true, target);
      throwConflict(rulesManager.checkConflict(preparedRules, target.blockURL, target.isWhitelist));
      if (findTargetRuleIndex(preparedRules, target.blockURL, target.isWhitelist) !== -1) {
        throw new RulesMutationError('rule_already_exists', 'Rule already exists');
      }

      preparedRules.push({
        id: index + 1,
        blockURL: target.blockURL.trim(),
        redirectURL: target.isWhitelist ? '' : target.redirectURL.trim(),
        category: target.isWhitelist ? 'whitelist' : (target.category || 'uncategorized'),
        disabledByUser: target.disabledByUser,
        assignments,
        isWhitelist: target.isWhitelist
      });
    });
    return preparedRules;
  }

  async function replaceAll(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      let importedLists;
      try {
        importedLists = prepareImportedRuleLists(
          payload.ruleLists,
          payload.settings?.disabledCategories || []
        );
      } catch (error) {
        throw new RulesMutationError('invalid_import', error.message);
      }
      const importedActiveRuleListId = normalizeActiveRuleListId(
        importedLists,
        payload.activeRuleListId || GENERAL_RULE_LIST_ID
      );
      const nextRules = prepareReplacementRules(payload.rules, importedLists);
      let importedSettings = null;

      if (payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)) {
        const currentSettings = await getSettings();
        const sanitizedSettings = { ...payload.settings };
        delete sanitizedSettings.enablePassword;
        delete sanitizedSettings.passwordHash;
        delete sanitizedSettings.disabledCategories;
        importedSettings = {
          ...currentSettings,
          ...sanitizedSettings,
          enablePassword: currentSettings.enablePassword,
          passwordHash: currentSettings.passwordHash
        };
        await saveSettings(importedSettings);
      }

      await saveCombinedState(nextRules, importedLists, importedActiveRuleListId);
      return syncAndNotify(nextRules, {
        settings: importedSettings,
        ruleLists: importedLists,
        activeRuleListId: importedActiveRuleListId
      });
    });
  }

  async function clearRules() {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const nextRules = [];
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules);
    });
  }

  async function toggleCategory(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const category = typeof payload.category === 'string' ? payload.category : '';
      if (!category) {
        throw new RulesMutationError('category_required', 'Category is required', ['category_required']);
      }
      const state = await getRuleListState();
      const index = state.lists.findIndex(list => list.id === state.activeRuleListId);
      if (index === -1) throw new RulesMutationError('rule_list_not_found', 'Active Rule List not found');
      const current = Array.isArray(state.lists[index].disabledCategories)
        ? state.lists[index].disabledCategories
        : [];
      const disabledCategories = current.includes(category)
        ? current.filter(item => item !== category)
        : [...current, category];
      const nextLists = state.lists.map((list, itemIndex) => itemIndex === index
        ? { ...list, disabledCategories }
        : list);
      await saveRuleListState(nextLists, state.activeRuleListId);
      const rules = await rulesManager.getRules();
      return syncAndNotify(rules, {
        ruleLists: nextLists,
        activeRuleListId: state.activeRuleListId
      });
    });
  }

  async function createRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const state = await getRuleListState();
      const name = validateListName(payload.name, state.lists);
      const list = {
        id: createNextRuleListId(state.lists),
        name,
        disabledCategories: []
      };
      const nextLists = [...state.lists, list];
      await saveRuleListState(nextLists, list.id);
      const rules = await rulesManager.getRules();
      return syncAndNotify(rules, {
        ruleLists: nextLists,
        activeRuleListId: list.id,
        list
      });
    });
  }

  async function renameRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      if (listId === GENERAL_RULE_LIST_ID) {
        throw new RulesMutationError('rule_list_locked', 'General list cannot be renamed');
      }
      const state = await getRuleListState();
      const index = state.lists.findIndex(list => list.id === listId);
      if (index === -1) throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      const name = validateListName(payload.name, state.lists, listId);
      const nextLists = state.lists.map((list, itemIndex) => itemIndex === index ? { ...list, name } : list);
      await saveRuleListState(nextLists, state.activeRuleListId);
      const rules = await rulesManager.getRules();
      return notifyWithoutSync(rules, {
        ruleLists: nextLists,
        activeRuleListId: state.activeRuleListId,
        list: nextLists[index]
      });
    });
  }

  async function activateRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      const state = await getRuleListState();
      if (!state.lists.some(list => list.id === listId)) {
        throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      }
      await saveRuleListState(state.lists, listId);
      const rules = await rulesManager.getRules();
      return syncAndNotify(rules, {
        ruleLists: state.lists,
        activeRuleListId: listId,
        list: state.lists.find(list => list.id === listId)
      });
    });
  }

  async function toggleRuleList(payload = {}) {
    return activateRuleList(payload);
  }

  async function deleteRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      if (listId === GENERAL_RULE_LIST_ID) {
        throw new RulesMutationError('rule_list_locked', 'General list cannot be deleted');
      }
      const [state, rules] = await Promise.all([getRuleListState(), rulesManager.getRules()]);
      if (!state.lists.some(list => list.id === listId)) {
        throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      }
      const nextLists = state.lists.filter(list => list.id !== listId);
      const nextRules = rules.map(rule => {
        if (rule.isWhitelist === true) return canonicalizeRuleTarget(rule, [createAlwaysAssignment()]);
        if (!getRuleAssignment(rule, listId)) return rule;
        return canonicalizeRuleTarget(rule, removeRuleAssignment(rule, listId, { fallbackToGeneral: true }));
      });
      const activeRuleListId = state.activeRuleListId === listId
        ? GENERAL_RULE_LIST_ID
        : normalizeActiveRuleListId(nextLists, state.activeRuleListId);
      await saveCombinedState(nextRules, nextLists, activeRuleListId);
      return syncAndNotify(nextRules, {
        ruleLists: nextLists,
        activeRuleListId,
        deletedListId: listId
      });
    });
  }

  function runExclusive(task) {
    return mutationQueue.enqueue(task);
  }

  return {
    addRule,
    addMany,
    updateRule,
    removeAssignment,
    deleteRule,
    toggleRule,
    replaceAll,
    clearRules,
    toggleCategory,
    createRuleList,
    renameRuleList,
    activateRuleList,
    toggleRuleList,
    deleteRuleList,
    runExclusive
  };
}
