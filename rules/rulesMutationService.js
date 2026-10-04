import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';
import { validateSchedule } from '../schedules/scheduleValidator.js';
import {
  GENERAL_RULE_LIST_ID,
  MAX_RULE_LIST_NAME_LENGTH,
  MAX_RULE_LISTS,
  createNextRuleListId,
  isKnownRuleListId,
  normalizeRuleListName,
  normalizeActiveRuleListId,
  prepareImportedRuleLists
} from './ruleListsManager.js';
import {
  addRuleAssignment,
  countFreeRules,
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
  BLOCKING_MODE_SCHEDULE,
  getRuleBlockingMode,
  normalizeDailyLimit
} from './blockingMode.js';
import { sanitizeBackupPayload } from '../backup/backupFormat.js';

export class RulesMutationError extends Error {
  constructor(code, message = code, validationErrors = []) {
    super(message);
    this.name = 'RulesMutationError';
    this.code = code;
    this.validationErrors = Array.isArray(validationErrors) ? validationErrors : [];
  }
}

export function serializeRulesMutationError(error) {
  const serialized = {
    code: error?.code || 'rules_operation_failed',
    message: error?.message || 'Rules operation failed',
    validationErrors: Array.isArray(error?.validationErrors) ? error.validationErrors : []
  };
  // Conflict context stays in the local reply to Options, never telemetry.
  if (error?.code === 'rule_already_exists' &&
      error?.conflict?.listId === GENERAL_RULE_LIST_ID &&
      typeof error.conflict.blockURL === 'string') {
    serialized.conflict = {
      listId: GENERAL_RULE_LIST_ID,
      blockURL: error.conflict.blockURL
    };
  }
  return serialized;
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

function createRulesGeneration() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('');
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

function normalizeTargetBlockURL(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeTargetRedirectURL(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSameRuleTarget(rule, target) {
  const ruleIsWhitelist = rule?.isWhitelist === true;
  const targetIsWhitelist = target?.isWhitelist === true;
  if (ruleIsWhitelist !== targetIsWhitelist) return false;
  if (normalizeTargetBlockURL(rule?.blockURL) !== normalizeTargetBlockURL(target?.blockURL)) return false;
  if (ruleIsWhitelist) return true;
  return (
    normalizeTargetRedirectURL(rule?.redirectURL) === normalizeTargetRedirectURL(target?.redirectURL) &&
    (rule?.category || 'uncategorized') === (target?.category || 'uncategorized')
  );
}

function findTargetRuleIndex(rules, target, excludeIndex = -1) {
  return rules.findIndex((rule, index) => {
    if (excludeIndex !== -1 && index === excludeIndex) return false;
    return isSameRuleTarget(rule, target);
  });
}

function findAssignedBlockUrlRuleIndex(rules, blockURL, listId, excludeIndex = -1, enabledOnly = false) {
  const normalizedBlockURL = normalizeTargetBlockURL(blockURL);
  return rules.findIndex((rule, index) => {
    if (excludeIndex !== -1 && index === excludeIndex) return false;
    if (rule?.isWhitelist === true) return false;
    if (normalizeTargetBlockURL(rule?.blockURL) !== normalizedBlockURL) return false;
    const assignment = getRuleAssignment(rule, listId);
    return Boolean(assignment) && (!enabledOnly || assignment.disabledByUser !== true);
  });
}

// Disabled variants preserve settings without competing for an enabled target.
// Apply the same assignment policy to add, edit, move, packs and toggle.
function findEnabledAssignmentConflictIndex(rules, blockURL, assignment, excludeIndex = -1) {
  if (assignment.disabledByUser === true) return -1;
  return findAssignedBlockUrlRuleIndex(rules, blockURL, assignment.listId, excludeIndex, true);
}

function getRuleTargetKey(target) {
  const isWhitelist = target?.isWhitelist === true;
  const key = [isWhitelist, normalizeTargetBlockURL(target?.blockURL)];
  if (!isWhitelist) {
    key.push(
      normalizeTargetRedirectURL(target?.redirectURL),
      target?.category || 'uncategorized'
    );
  }
  return JSON.stringify(key);
}

function getAssignedBlockUrlKey(blockURL, listId) {
  return JSON.stringify([normalizeTargetBlockURL(blockURL), listId]);
}

function canonicalizeRuleTarget(rule, assignments = getRuleAssignments(rule)) {
  const canonical = {
    ...rule,
    assignments
  };
  for (const legacyKey of ['listId', 'listIds', 'disabledByUser', 'blockingMode', 'schedule', 'dailyLimit']) {
    delete canonical[legacyKey];
  }
  return canonical;
}

function didConfigureDailyLimit(previousAssignment, nextAssignment) {
  if (getRuleBlockingMode(nextAssignment) !== BLOCKING_MODE_DAILY_LIMIT) return false;

  const nextLimit = normalizeDailyLimit(nextAssignment?.dailyLimit);
  const previousLimit = previousAssignment &&
    getRuleBlockingMode(previousAssignment) === BLOCKING_MODE_DAILY_LIMIT
    ? normalizeDailyLimit(previousAssignment?.dailyLimit)
    : null;

  return Boolean(nextLimit) && previousLimit?.minutes !== nextLimit.minutes;
}

function sanitizeTargetInput(payload = {}, fallbackWhitelist = false, fallbackRule = null) {
  const isWhitelist = payload.isWhitelist === undefined ? fallbackWhitelist : payload.isWhitelist === true;
  return {
    blockURL: typeof payload.blockURL === 'string' ? payload.blockURL : (fallbackRule?.blockURL || ''),
    redirectURL: typeof payload.redirectURL === 'string' ? payload.redirectURL : (fallbackRule?.redirectURL || ''),
    category: typeof payload.category === 'string' && payload.category
      ? payload.category
      : (fallbackRule?.category || (isWhitelist ? 'whitelist' : 'social')),
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
    disabledByUser: source.disabledByUser === undefined
      ? (fallback?.disabledByUser ?? fallbackRule?.disabledByUser ?? false) === true
      : source.disabledByUser === true,
    blockingMode,
    schedule: source.schedule === undefined ? (fallback?.schedule ?? null) : source.schedule,
    dailyLimit: source.dailyLimit === undefined ? (fallback?.dailyLimit ?? null) : source.dailyLimit
  };

  return getLegacyListIds(payload, fallbackRule)
    .map(listId => createRuleAssignment(listId, config));
}

// Validate the full projected General state before any storage or usage write.
// Index surviving targets first so collision handling does not depend on order.
function ensureGeneralMovesHaveNoConflicts(nextRules, movedRules) {
  if (movedRules.length === 0) return;
  const moved = new Set(movedRules);
  const targetKeys = new Set();
  const enabledAssignmentKeys = new Set();
  function remember(rule, assignment) {
    targetKeys.add(getRuleTargetKey(rule));
    if (assignment.disabledByUser !== true) {
      enabledAssignmentKeys.add(getAssignedBlockUrlKey(rule.blockURL, GENERAL_RULE_LIST_ID));
    }
  }
  for (const rule of nextRules) {
    if (rule.isWhitelist === true || moved.has(rule)) continue;
    const assignment = getRuleAssignment(rule, GENERAL_RULE_LIST_ID);
    if (assignment) remember(rule, assignment);
  }
  for (const rule of movedRules) {
    const assignment = getRuleAssignment(rule, GENERAL_RULE_LIST_ID);
    if (targetKeys.has(getRuleTargetKey(rule)) ||
        (assignment.disabledByUser !== true &&
         enabledAssignmentKeys.has(getAssignedBlockUrlKey(rule.blockURL, GENERAL_RULE_LIST_ID)))) {
      const error = new RulesMutationError(
        'rule_already_exists',
        'Resolve conflicting targets in General before deleting this list'
      );
      error.conflict = { listId: GENERAL_RULE_LIST_ID, blockURL: rule.blockURL };
      throw error;
    }
    remember(rule, assignment);
  }
}

export function createRulesMutationService({
  rulesManager,
  ruleListsManager,
  dnrSynchronizer,
  dailyLimitManager = null,
  declarativeNetRequest,
  getAccess,
  getRulesGeneration = async () => undefined,
  getSettings,
  saveSettings,
  saveRulesAndLists,
  maxRulesLimit,
  notifyRulesChanged,
  resolveRulePackEntries,
  logger
}) {
  const mutationQueue = createAsyncQueue();

  async function ensureRulesGeneration(payload) {
    const current = await getRulesGeneration();
    // Optional for isolated service consumers; the worker always supplies it.
    if (current !== undefined && (payload.expectedGeneration ?? null) !== current) {
      throw new RulesMutationError('rules_state_changed', 'Rules changed; refresh the rule view and try again');
    }
  }

  async function getRulesSnapshot() {
    if (typeof rulesManager.getRulesSnapshot === 'function') {
      return rulesManager.getRulesSnapshot();
    }
    // Storage-free service consumers supply only getRules; the worker uses snapshots.
    return { rules: await rulesManager.getRules() };
  }

  function ensureRuleRevision(payload, snapshot) {
    if (snapshot.revisions !== undefined &&
        (payload.expectedRevision ?? null) !== (snapshot.revisions[toRuleId(payload.ruleId)] ?? null)) {
      throw new RulesMutationError('rules_state_changed', 'Rules changed; refresh the rule view and try again');
    }
  }

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

  async function getRuleListSnapshot() {
    if (typeof ruleListsManager?.getSnapshot === 'function') return ruleListsManager.getSnapshot();
    return getRuleListState();
  }

  function ensureRuleListRevision(payload, snapshot) {
    if (snapshot.revisions !== undefined &&
        (payload.expectedListRevision ?? null) !== (snapshot.revisions[payload.listId] ?? null)) {
      throw new RulesMutationError('rules_state_changed', 'Rules changed; refresh the rule view and try again');
    }
  }

  // Validate the lists selected by the captured form inside the mutation queue.
  function ensureAssignmentListContext(payload, snapshot, listIds) {
    const fail = () => { throw new RulesMutationError('rules_state_changed', 'Rules changed; refresh the rule view and try again'); };
    if (snapshot.generation !== undefined && (payload.expectedGeneration ?? null) !== snapshot.generation) fail();
    const expected = payload.expectedListRevisions;
    if (expected != null && (typeof expected !== 'object' || Array.isArray(expected))) fail();
    for (const listId of new Set(listIds)) {
      if (snapshot.revisions !== undefined &&
          (expected?.[listId] ?? null) !== (snapshot.revisions[listId] ?? null)) fail();
    }
  }

  async function getNextSafeRuleId(rules) {
    const dnrRules = await declarativeNetRequest.getDynamicRules();
    const occupiedIds = new Set([
      ...rules.map(rule => toRuleId(rule.id)).filter(Boolean),
      ...dnrRules.map(rule => toRuleId(rule.id)).filter(Boolean)
    ]);
    let safeId = 1;
    while (occupiedIds.has(safeId)) safeId++;
    return safeId;
  }

  async function remapDailyUsage(oldRuleId, oldListId, newRuleId, newListId) {
    if (typeof dailyLimitManager?.remapAssignmentKey !== 'function') return;
    await dailyLimitManager.remapAssignmentKey(oldRuleId, oldListId, newRuleId, newListId);
  }

  async function remapDailyUsageAfterCommit(oldRuleId, oldListId, newRuleId, newListId, staged = false) {
    try {
      if (staged) await dailyLimitManager.recoverPendingRemaps();
      else await remapDailyUsage(oldRuleId, oldListId, newRuleId, newListId);
      return false;
    } catch (error) {
      logger.warn('Daily Limit usage remapping failed after rules were committed:', error);
      return true;
    }
  }

  async function saveRulesAndRemapDailyUsage(
    rules,
    oldRuleId,
    oldListId,
    newRuleId,
    newListId,
    sourceAssignment,
    nextAssignment
  ) {
    const remap = { oldRuleId, oldListId, newRuleId, newListId };
    const protectUsage = getRuleBlockingMode(sourceAssignment) === BLOCKING_MODE_DAILY_LIMIT &&
      getRuleBlockingMode(nextAssignment) === BLOCKING_MODE_DAILY_LIMIT &&
      typeof dailyLimitManager?.stagePendingRemaps === 'function' &&
      typeof dailyLimitManager?.recoverPendingRemaps === 'function';

    if (protectUsage) {
      await dailyLimitManager.stagePendingRemaps(
        typeof rulesManager.prepareRulesState === 'function'
          ? await rulesManager.prepareRulesState(rules) : { rules },
        [remap]
      );
    } else {
      await rulesManager.saveRules(rules);
    }

    return remapDailyUsageAfterCommit(oldRuleId, oldListId, newRuleId, newListId, protectUsage);
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

  function validateAssignment(
    assignment,
    lists,
    hasProAccess,
    target,
    validationCode = 'validation_failed',
    existingAssignment = null
  ) {
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
    if (!target.isWhitelist && assignment.blockingMode === BLOCKING_MODE_SCHEDULE && !hasProAccess) {
      const preservesExistingSchedule = existingAssignment?.listId === listId &&
        existingAssignment.blockingMode === BLOCKING_MODE_SCHEDULE &&
        JSON.stringify(normalizeSchedule(existingAssignment.schedule)) ===
          JSON.stringify(normalizeSchedule(assignment.schedule));
      if (!preservesExistingSchedule) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }
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

  function validateAssignments(
    assignments,
    lists,
    hasProAccess,
    target,
    validationCode = 'validation_failed',
    existingRule = null
  ) {
    const normalized = target.isWhitelist
      ? [createAlwaysAssignment(GENERAL_RULE_LIST_ID)]
      : assignments;
    const seen = new Set();
    for (const assignment of normalized) {
      if (seen.has(assignment.listId)) {
        throw new RulesMutationError('rule_assignment_exists', 'Rule already has settings for this list');
      }
      seen.add(assignment.listId);
      validateAssignment(
        assignment,
        lists,
        hasProAccess,
        target,
        validationCode,
        existingRule ? getRuleAssignment(existingRule, assignment.listId) : null
      );
    }
    return normalized;
  }

  function ensureFreeRuleCapacity(rules, hasProAccess, currentRule, nextAssignments) {
    if (hasProAccess || !nextAssignments.some(assignment => assignment.listId === GENERAL_RULE_LIST_ID)) {
      return;
    }
    if (currentRule && getRuleAssignment(currentRule, GENERAL_RULE_LIST_ID)) return;
    if (countFreeRules(rules) >= maxRulesLimit) {
      throw new RulesMutationError('rule_limit_reached', 'Free rule limit reached');
    }
  }

  async function ensureBrowserRuleCapacity(rules, ruleListState = null) {
    if (typeof dnrSynchronizer?.validateRuleCapacity !== 'function') return;
    const capacity = await dnrSynchronizer.validateRuleCapacity(rules, ruleListState);
    if (capacity?.withinCapacity !== false) return;

    const unsafeLimit = capacity.limitType === 'unsafe_dynamic';
    const expected = unsafeLimit ? capacity.expectedUnsafeCount : capacity.expectedCount;
    const maximum = unsafeLimit ? capacity.maxUnsafeDynamicRules : capacity.maxDynamicRules;
    const label = unsafeLimit ? 'unsafe dynamic' : 'dynamic';
    throw new RulesMutationError(
      'dnr_rule_limit_reached',
      `Browser ${label} rule limit reached (${expected}/${maximum})`
    );
  }

  async function saveCombinedState(rules, lists, activeRuleListId = null, rulesGeneration = undefined, ruleRevisions = undefined, ruleListRevisions = undefined) {
    if (typeof saveRulesAndLists === 'function') {
      await saveRulesAndLists(rules, lists, activeRuleListId, rulesGeneration, ruleRevisions, ruleListRevisions);
      return;
    }
    await rulesManager.saveRules(rules);
    if (activeRuleListId) {
      await ruleListsManager.saveState(lists, activeRuleListId,
        ruleListRevisions !== undefined ? { ruleListRevisions } : {});
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
      const [rules, listSnapshot, hasProAccess] = await Promise.all([
        rulesManager.getRules(), getRuleListSnapshot(), getProAccess()
      ]);
      const { lists } = listSnapshot;
      const assignmentInputs = createAssignmentInputs(payload);
      ensureAssignmentListContext(payload, listSnapshot, target.isWhitelist
        ? [GENERAL_RULE_LIST_ID] : assignmentInputs.map(item => item.listId));

      if (target.isWhitelist && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      const assignments = validateAssignments(
        assignmentInputs, lists, hasProAccess, target
      );
      const dailyLimitConfigured = assignments.some(assignment =>
        didConfigureDailyLimit(null, assignment)
      );
      throwConflict(rulesManager.checkConflict(rules, target.blockURL, target.isWhitelist));

      const existingIndex = findTargetRuleIndex(rules, target);
      if (!target.isWhitelist) {
        ensureFreeRuleCapacity(
          rules,
          hasProAccess,
          existingIndex === -1 ? null : rules[existingIndex],
          assignments
        );
      }

      if (existingIndex !== -1) {
        if (target.isWhitelist) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists');
        }
        const existingRule = rules[existingIndex];
        let nextAssignments = getRuleAssignments(existingRule);
        let added = 0;
        for (const assignment of assignments) {
          const assignedVariantIndex = findEnabledAssignmentConflictIndex(
            rules,
            target.blockURL,
            assignment,
            existingIndex
          );
          if (assignedVariantIndex !== -1) {
            throw new RulesMutationError('rule_already_exists', 'This URL already has a target in this list');
          }
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
        await ensureBrowserRuleCapacity(nextRules);
        await rulesManager.saveRules(nextRules);
        return syncAndNotify(nextRules, {
          rule: updatedRule,
          assignmentAdded: true,
          membershipAdded: true,
          created: false,
          dailyLimitConfigured
        });
      }

      if (!target.isWhitelist) {
        for (const assignment of assignments) {
          if (findEnabledAssignmentConflictIndex(rules, target.blockURL, assignment) !== -1) {
            throw new RulesMutationError('rule_already_exists', 'This URL already has a target in this list');
          }
        }
      }

      const newRule = {
        id: await getNextSafeRuleId(rules),
        blockURL: target.blockURL.trim(),
        redirectURL: target.isWhitelist ? '' : target.redirectURL.trim(),
        category: target.isWhitelist ? 'whitelist' : target.category,
        assignments: target.isWhitelist ? [createAlwaysAssignment()] : assignments,
        isWhitelist: target.isWhitelist
      };
      const nextRules = [...rules, newRule];
      if (!target.isWhitelist) await ensureBrowserRuleCapacity(nextRules);
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, {
        rule: newRule,
        assignmentAdded: false,
        membershipAdded: false,
        created: true,
        dailyLimitConfigured
      });
    });
  }

  async function addMany(payload = {}) {
    return mutationQueue.enqueue(async () => {
      const hasProAccess = await getProAccess();
      if (!hasProAccess) throw new RulesMutationError('pro_required', 'Pro access is required');

      const listSnapshot = await getRuleListSnapshot();
      const { lists } = listSnapshot;
      const targetListId = payload.listId || GENERAL_RULE_LIST_ID;
      ensureAssignmentListContext(payload, listSnapshot, [targetListId]);
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

        const existingIndex = findTargetRuleIndex(nextRules, target);
        const assignedVariantIndex = findEnabledAssignmentConflictIndex(
          nextRules,
          target.blockURL,
          assignmentConfig,
          existingIndex
        );
        if (assignedVariantIndex !== -1) {
          duplicateEntries.push({ entryId: entry.id, blockURL: target.blockURL });
          continue;
        }
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
      await ensureBrowserRuleCapacity(nextRules);
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, result);
    });
  }

  async function updateRule(payload = {}) {
    return mutationQueue.enqueue(async () => {
      await ensureRulesGeneration(payload);
      const snapshot = await getRulesSnapshot();
      ensureRuleRevision(payload, snapshot);
      const { rules } = snapshot;
      const index = getRuleIndexById(rules, payload.ruleId);
      if (index === -1) throw new RulesMutationError('rule_not_found', 'Rule not found');

      const oldRule = rules[index];
      const target = sanitizeTargetInput(payload, oldRule.isWhitelist === true, oldRule);
      target.isWhitelist = oldRule.isWhitelist === true;
      const [listSnapshot, hasProAccess] = await Promise.all([getRuleListSnapshot(), getProAccess()]);
      const { lists } = listSnapshot;
      if (target.isWhitelist && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      const sourceListId = payload.assignmentListId || payload.sourceListId || null;
      if (target.isWhitelist) {
        const currentAssignment = getRuleAssignment(oldRule, GENERAL_RULE_LIST_ID);
        const nextAssignment = createRuleAssignment(GENERAL_RULE_LIST_ID, {
          disabledByUser: payload.assignment?.disabledByUser === undefined
            ? currentAssignment?.disabledByUser === true
            : payload.assignment.disabledByUser === true,
          blockingMode: BLOCKING_MODE_ALWAYS,
          schedule: null,
          dailyLimit: null
        });
        ensureAssignmentListContext(payload, listSnapshot, [GENERAL_RULE_LIST_ID]);
        validateAssignment(nextAssignment, lists, hasProAccess, target);
        throwConflict(rulesManager.checkConflict(rules, target.blockURL, true, index));
        if (findTargetRuleIndex(rules, target, index) !== -1) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists');
        }
        const updatedRule = canonicalizeRuleTarget({
          id: oldRule.id,
          blockURL: target.blockURL.trim(),
          redirectURL: '',
          category: 'whitelist',
          assignments: [nextAssignment],
          isWhitelist: true
        }, [nextAssignment]);
        const nextRules = [...rules];
        nextRules[index] = updatedRule;
        await ensureBrowserRuleCapacity(nextRules);
        await rulesManager.saveRules(nextRules);
        return syncAndNotify(nextRules, {
          rule: updatedRule,
          dailyLimitConfigured: false
        });
      }

      if (!sourceListId) {
        const inputs = createAssignmentInputs(payload, oldRule);
        ensureAssignmentListContext(payload, listSnapshot, [
          ...getRuleAssignments(oldRule).map(item => item.listId), ...inputs.map(item => item.listId)
        ]);
        const nextAssignments = validateAssignments(
          inputs,
          lists,
          hasProAccess,
          target,
          'validation_failed',
          oldRule
        );
        const dailyLimitConfigured = nextAssignments.some(assignment =>
          didConfigureDailyLimit(getRuleAssignment(oldRule, assignment.listId), assignment)
        );
        ensureFreeRuleCapacity(rules, hasProAccess, oldRule, nextAssignments);
        throwConflict(rulesManager.checkConflict(rules, target.blockURL, false, index));
        if (nextAssignments.some(assignment =>
          findEnabledAssignmentConflictIndex(rules, target.blockURL, assignment, index) !== -1
        )) {
          throw new RulesMutationError('rule_already_exists', 'This URL already has a target in this list');
        }
        if (findTargetRuleIndex(rules, target, index) !== -1) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists');
        }
        const updatedRule = canonicalizeRuleTarget({
          id: oldRule.id,
          blockURL: target.blockURL.trim(),
          redirectURL: target.redirectURL.trim(),
          category: target.category,
          assignments: nextAssignments,
          isWhitelist: false
        }, nextAssignments);
        const previousAssignments = getRuleAssignments(oldRule);
        const removed = previousAssignments.filter(item => !nextAssignments.some(next => next.listId === item.listId));
        const added = nextAssignments.filter(item => !previousAssignments.some(previous => previous.listId === item.listId));
        const hasDailyReplacement = removed.some(item => getRuleBlockingMode(item) === BLOCKING_MODE_DAILY_LIMIT) &&
          added.some(item => getRuleBlockingMode(item) === BLOCKING_MODE_DAILY_LIMIT);
        if (hasDailyReplacement && (removed.length !== 1 || added.length !== 1)) {
          throw new RulesMutationError('assignment_move_requires_source',
            'Move Daily Limit assignments individually so their spent time is preserved.');
        }
        const nextRules = [...rules];
        nextRules[index] = updatedRule;
        await ensureBrowserRuleCapacity(nextRules);
        let dailyUsageSyncPending = false;
        if (removed.length === 1 && added.length === 1) {
          dailyUsageSyncPending = await saveRulesAndRemapDailyUsage(
            nextRules, oldRule.id, removed[0].listId, oldRule.id, added[0].listId, removed[0], added[0]
          );
        } else {
          await rulesManager.saveRules(nextRules);
        }
        return syncAndNotify(nextRules, { rule: updatedRule, dailyLimitConfigured,
          ...(dailyUsageSyncPending ? { dailyUsageSyncPending } : {}) });
      }

      const currentAssignment = getRuleAssignment(oldRule, sourceListId);
      if (!currentAssignment) {
        throw new RulesMutationError('rule_assignment_not_found', 'Rule assignment not found');
      }
      const assignmentPayload = payload.assignment && typeof payload.assignment === 'object'
        ? {
            ...payload.assignment,
            disabledByUser: payload.assignment.disabledByUser === undefined
              ? currentAssignment.disabledByUser === true
              : payload.assignment.disabledByUser === true
          }
        : {
            listId: payload.targetListId || payload.listId || sourceListId,
            disabledByUser: payload.disabledByUser === undefined
              ? currentAssignment.disabledByUser === true
              : payload.disabledByUser === true,
            blockingMode: payload.blockingMode ?? currentAssignment.blockingMode,
            schedule: payload.schedule === undefined ? currentAssignment.schedule : payload.schedule,
            dailyLimit: payload.dailyLimit === undefined ? currentAssignment.dailyLimit : payload.dailyLimit
          };
      const nextAssignment = createRuleAssignment(
        assignmentPayload.listId || sourceListId,
        assignmentPayload
      );
      ensureAssignmentListContext(payload, listSnapshot, [sourceListId, nextAssignment.listId]);
      validateAssignment(nextAssignment, lists, hasProAccess, target, 'validation_failed', currentAssignment);
      const dailyLimitConfigured = didConfigureDailyLimit(currentAssignment, nextAssignment);
      ensureFreeRuleCapacity(rules, hasProAccess, oldRule, [nextAssignment]);
      throwConflict(rulesManager.checkConflict(rules, target.blockURL, false, index));

      if (nextAssignment.listId !== sourceListId && getRuleAssignment(oldRule, nextAssignment.listId)) {
        throw new RulesMutationError('rule_assignment_exists', 'Rule already has settings for this list');
      }
      if (findEnabledAssignmentConflictIndex(rules, target.blockURL, nextAssignment, index) !== -1) {
        throw new RulesMutationError('rule_already_exists', 'This URL already has a target in this list');
      }

      const targetChanged = !isSameRuleTarget(oldRule, target);
      if (!targetChanged) {
        let nextAssignments;
        try {
          nextAssignments = replaceRuleAssignment(oldRule, sourceListId, nextAssignment);
        } catch (error) {
          if (error.message === 'rule_assignment_exists') {
            throw new RulesMutationError('rule_assignment_exists', 'Rule already has settings for this list');
          }
          throw new RulesMutationError('rule_assignment_not_found', 'Rule assignment not found');
        }
        const updatedRule = canonicalizeRuleTarget(oldRule, nextAssignments);
        const nextRules = [...rules];
        nextRules[index] = updatedRule;
        await ensureBrowserRuleCapacity(nextRules);
        let dailyUsageSyncPending = false;
        if (nextAssignment.listId !== sourceListId) {
          dailyUsageSyncPending = await saveRulesAndRemapDailyUsage(
            nextRules,
            oldRule.id,
            sourceListId,
            oldRule.id,
            nextAssignment.listId,
            currentAssignment,
            nextAssignment
          );
        } else {
          await rulesManager.saveRules(nextRules);
        }
        return syncAndNotify(nextRules, {
          rule: updatedRule,
          dailyLimitConfigured,
          ...(dailyUsageSyncPending ? { dailyUsageSyncPending } : {})
        });
      }

      const currentAssignments = getRuleAssignments(oldRule);
      const remainingAssignments = removeRuleAssignment(oldRule, sourceListId, { fallbackToGeneral: false });
      const exactTargetIndex = findTargetRuleIndex(rules, target, index);

      if (exactTargetIndex !== -1) {
        const exactTarget = rules[exactTargetIndex];
        if (getRuleAssignment(exactTarget, nextAssignment.listId)) {
          throw new RulesMutationError('rule_assignment_exists', 'Rule already has settings for this list');
        }
        const mergedTarget = canonicalizeRuleTarget(
          exactTarget,
          addRuleAssignment(exactTarget, nextAssignment)
        );
        const nextRules = rules.map((rule, ruleIndex) => {
          if (ruleIndex === exactTargetIndex) return mergedTarget;
          if (ruleIndex === index) {
            return remainingAssignments.length > 0
              ? canonicalizeRuleTarget(oldRule, remainingAssignments)
              : null;
          }
          return rule;
        }).filter(Boolean);
        await ensureBrowserRuleCapacity(nextRules);
        const dailyUsageSyncPending = await saveRulesAndRemapDailyUsage(
          nextRules,
          oldRule.id,
          sourceListId,
          mergedTarget.id,
          nextAssignment.listId,
          currentAssignment,
          nextAssignment
        );
        return syncAndNotify(nextRules, {
          rule: mergedTarget,
          targetMerged: true,
          sourceRuleId: oldRule.id,
          dailyLimitConfigured,
          ...(dailyUsageSyncPending ? { dailyUsageSyncPending } : {})
        });
      }

      if (currentAssignments.length === 1) {
        const updatedRule = canonicalizeRuleTarget({
          id: oldRule.id,
          blockURL: target.blockURL.trim(),
          redirectURL: target.redirectURL.trim(),
          category: target.category,
          assignments: [nextAssignment],
          isWhitelist: false
        }, [nextAssignment]);
        const nextRules = [...rules];
        nextRules[index] = updatedRule;
        await ensureBrowserRuleCapacity(nextRules);
        let dailyUsageSyncPending = false;
        if (nextAssignment.listId !== sourceListId) {
          dailyUsageSyncPending = await saveRulesAndRemapDailyUsage(
            nextRules,
            oldRule.id,
            sourceListId,
            oldRule.id,
            nextAssignment.listId,
            currentAssignment,
            nextAssignment
          );
        } else {
          await rulesManager.saveRules(nextRules);
        }
        return syncAndNotify(nextRules, {
          rule: updatedRule,
          dailyLimitConfigured,
          ...(dailyUsageSyncPending ? { dailyUsageSyncPending } : {})
        });
      }

      const splitRule = canonicalizeRuleTarget({
        id: await getNextSafeRuleId(rules),
        blockURL: target.blockURL.trim(),
        redirectURL: target.redirectURL.trim(),
        category: target.category,
        assignments: [nextAssignment],
        isWhitelist: false
      }, [nextAssignment]);
      const retainedRule = canonicalizeRuleTarget(oldRule, remainingAssignments);
      const nextRules = [...rules];
      nextRules[index] = retainedRule;
      nextRules.push(splitRule);
      await ensureBrowserRuleCapacity(nextRules);
      const dailyUsageSyncPending = await saveRulesAndRemapDailyUsage(
        nextRules,
        oldRule.id,
        sourceListId,
        splitRule.id,
        nextAssignment.listId,
        currentAssignment,
        nextAssignment
      );
      return syncAndNotify(nextRules, {
        rule: splitRule,
        targetSplit: true,
        sourceRuleId: oldRule.id,
        dailyLimitConfigured,
        ...(dailyUsageSyncPending ? { dailyUsageSyncPending } : {})
      });
    });
  }

  async function removeAssignment(payload = {}) {
    return mutationQueue.enqueue(async () => {
      await ensureRulesGeneration(payload);
      const snapshot = await getRulesSnapshot();
      ensureRuleRevision(payload, snapshot);
      const { rules } = snapshot;
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
      await ensureRulesGeneration(payload);
      const snapshot = await getRulesSnapshot();
      ensureRuleRevision(payload, snapshot);
      const { rules } = snapshot;
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
      await ensureRulesGeneration(payload);
      const snapshot = await getRulesSnapshot();
      ensureRuleRevision(payload, snapshot);
      const { rules } = snapshot;
      const index = getRuleIndexById(rules, payload.ruleId);
      if (index === -1) throw new RulesMutationError('rule_not_found', 'Rule not found');
      const rule = rules[index];
      const listId = typeof payload.listId === 'string' && payload.listId
        ? payload.listId
        : GENERAL_RULE_LIST_ID;
      const currentAssignment = getRuleAssignment(rule, listId);
      if (!currentAssignment) {
        throw new RulesMutationError('rule_assignment_not_found', 'Rule assignment not found');
      }
      const nextAssignment = createRuleAssignment(listId, {
        ...currentAssignment,
        disabledByUser: currentAssignment.disabledByUser !== true
      });
      // A restored disabled variant must not enable a competing target in the
      // same list. Disabling a target always remains possible.
      if (!rule.isWhitelist &&
          findEnabledAssignmentConflictIndex(rules, rule.blockURL, nextAssignment, index) !== -1) {
        throw new RulesMutationError('rule_already_exists', 'This URL already has an enabled target in this list');
      }
      const nextAssignments = replaceRuleAssignment(rule, listId, nextAssignment);
      const updatedRule = canonicalizeRuleTarget(rule, nextAssignments);
      const nextRules = [...rules];
      nextRules[index] = updatedRule;
      if (!nextAssignment.disabledByUser) await ensureBrowserRuleCapacity(nextRules);
      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, {
        rule: updatedRule,
        assignment: nextAssignment,
        assignmentListId: listId
      });
    });
  }

  function prepareReplacementRules(importedRules, importedLists) {
    if (!Array.isArray(importedRules)) {
      throw new RulesMutationError('invalid_import', 'Invalid file format: missing rules array');
    }
    const preparedRules = [];
    const preparedWhitelistRules = [];
    const preparedTargets = new Map();
    const enabledAssignmentKeys = new Set();

    importedRules.forEach((rawRule, index) => {
      if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
        throw new RulesMutationError(
          'invalid_import',
          `Invalid file format: rule ${index + 1} must be an object`
        );
      }
      const target = sanitizeTargetInput(rawRule, rawRule?.isWhitelist === true);
      if (!target.isWhitelist && (!rawRule?.category || typeof rawRule.category !== 'string')) {
        target.category = 'uncategorized';
      }
      // Keep repeated list IDs visible to validation rather than silently
      // taking the first configuration while normalizing a backup row.
      const assignments = Array.isArray(rawRule.assignments)
        ? rawRule.assignments.map(item => createRuleAssignment(item.listId, item))
        : normalizeRuleAssignments(rawRule);
      // Import is a Pro-only operation, so custom list and Daily Limit access is
      // already established by replaceAll(). We still validate all references.
      validateAssignments(assignments, importedLists, true, target);
      // Blacklist entries can conflict only with existing whitelist patterns.
      // Keep their candidate set small while preserving full insertion order
      // and the original conflict semantics for imported whitelist entries.
      const conflictCandidates = target.isWhitelist ? preparedRules : preparedWhitelistRules;
      if (conflictCandidates.length > 0) {
        throwConflict(rulesManager.checkConflict(
          conflictCandidates,
          target.blockURL,
          target.isWhitelist
        ));
      }
      // Older stored configurations can include disabled target variants.
      // Restore them without dropping settings, but keep enabled targets unique
      // per URL/list regardless of current category, schedule or Focus state.
      if (!target.isWhitelist && assignments.some(assignment =>
        assignment.disabledByUser !== true &&
        enabledAssignmentKeys.has(getAssignedBlockUrlKey(target.blockURL, assignment.listId))
      )) {
        throw new RulesMutationError('rule_already_exists', 'This URL already has a target in this list');
      }
      const targetKey = getRuleTargetKey(target);
      const existingTarget = preparedTargets.get(targetKey);
      if (existingTarget) {
        // Migrated legacy storage may export separate rows of one exact
        // blacklist target. Combine only disjoint assignments; never choose
        // between two configurations for the same list, even if disabled.
        const existingListIds = new Set(existingTarget.assignments.map(item => item.listId));
        if (target.isWhitelist || assignments.some(item => existingListIds.has(item.listId))) {
          throw new RulesMutationError('rule_already_exists', 'Rule already exists');
        }
        existingTarget.assignments.push(...assignments);
      } else {
        const preparedRule = {
          id: preparedRules.length + 1,
          blockURL: target.blockURL.trim(),
          redirectURL: target.isWhitelist ? '' : target.redirectURL.trim(),
          category: target.isWhitelist ? 'whitelist' : (target.category || 'uncategorized'),
          assignments,
          isWhitelist: target.isWhitelist
        };
        preparedRules.push(preparedRule);
        preparedTargets.set(targetKey, preparedRule);
        if (target.isWhitelist) preparedWhitelistRules.push(preparedRule);
      }
      if (!target.isWhitelist) {
        for (const assignment of assignments) {
          if (assignment.disabledByUser !== true) {
            enabledAssignmentKeys.add(getAssignedBlockUrlKey(target.blockURL, assignment.listId));
          }
        }
      }
    });
    return preparedRules;
  }

  async function replaceAll(payload = {}) {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      let sanitizedPayload;
      try {
        sanitizedPayload = sanitizeBackupPayload(payload);
      } catch (error) {
        throw new RulesMutationError('invalid_import', error.message);
      }
      let importedLists;
      try {
        importedLists = prepareImportedRuleLists(
          sanitizedPayload.ruleLists,
          sanitizedPayload.settings?.disabledCategories || []
        );
      } catch (error) {
        throw new RulesMutationError('invalid_import', error.message);
      }
      const importedActiveRuleListId = normalizeActiveRuleListId(
        importedLists,
        sanitizedPayload.activeRuleListId || GENERAL_RULE_LIST_ID
      );
      const nextRules = prepareReplacementRules(sanitizedPayload.rules, importedLists);
      await ensureBrowserRuleCapacity(nextRules, {
        lists: importedLists,
        activeRuleListId: importedActiveRuleListId
      });
      const [previousSnapshot, previousRuleListState, currentSettings, previousGeneration] = await Promise.all([
        getRulesSnapshot(),
        getRuleListSnapshot(),
        getSettings(),
        getRulesGeneration()
      ]);
      const previousRules = previousSnapshot.rules;
      const nextGeneration = createRulesGeneration();
      let importedSettings = null;
      if (sanitizedPayload.settings) {
        const { disabledCategories: _legacyDisabledCategories, ...portableSettings } =
          sanitizedPayload.settings;
        importedSettings = {
          ...currentSettings,
          ...portableSettings,
          enablePassword: currentSettings.enablePassword,
          passwordHash: currentSettings.passwordHash
        };
      }

      let settingsCommitted = false;
      let localStateCommitted = false;
      try {
        if (importedSettings) {
          await saveSettings(importedSettings);
          settingsCommitted = true;
        }
        await saveCombinedState(nextRules, importedLists, importedActiveRuleListId, nextGeneration);
        localStateCommitted = true;
        const syncResult = await dnrSynchronizer.requestSync();
        if (syncResult?.success === false) {
          throw new RulesMutationError(
            'import_sync_failed',
            'Browser blocking rules could not be updated'
          );
        }
      } catch (error) {
        const rollbackErrors = [];
        if (localStateCommitted) {
          try {
            await saveCombinedState(
              previousRules,
              previousRuleListState.lists,
              previousRuleListState.activeRuleListId,
              previousGeneration,
              previousSnapshot.revisions,
              previousRuleListState.revisions
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (settingsCommitted) {
          try {
            await saveSettings(currentSettings);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (localStateCommitted) {
          try {
            const rollbackSyncResult = await dnrSynchronizer.requestSync();
            if (rollbackSyncResult?.success === false) {
              throw new Error('Browser blocking rules could not be restored');
            }
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          notifyRulesChanged(previousRules, {
            ruleLists: previousRuleListState.lists,
            activeRuleListId: previousRuleListState.activeRuleListId,
            importRolledBack: true
          });
        }
        if (rollbackErrors.length > 0) {
          const rollbackFailure = new RulesMutationError(
            'import_rollback_failed',
            `Import failed and the previous state could not be fully restored: ${rollbackErrors[0].message}`
          );
          rollbackFailure.cause = error;
          throw rollbackFailure;
        }
        throw error;
      }

      notifyRulesChanged(nextRules, {
        settings: importedSettings,
        ruleLists: importedLists,
        activeRuleListId: importedActiveRuleListId,
        syncPending: false
      });
      return {
        rules: nextRules,
        settings: importedSettings,
        ruleLists: importedLists,
        activeRuleListId: importedActiveRuleListId,
        syncPending: false
      };
    });
  }

  async function clearRules() {
    return mutationQueue.enqueue(async () => {
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const nextRules = [];
      const state = await getRuleListState();
      await saveCombinedState(nextRules, state.lists, state.activeRuleListId, createRulesGeneration());
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
      const rules = await rulesManager.getRules();
      if (current.includes(category)) {
        await ensureBrowserRuleCapacity(rules, {
          lists: nextLists,
          activeRuleListId: state.activeRuleListId
        });
      }
      await saveRuleListState(nextLists, state.activeRuleListId);
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
      if (state.lists.length >= MAX_RULE_LISTS) {
        throw new RulesMutationError('rule_list_limit_reached', `Rule List limit reached (${MAX_RULE_LISTS})`);
      }
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
        list,
        ruleListCreated: true
      });
    });
  }

  async function renameRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      await ensureRulesGeneration(payload);
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      if (listId === GENERAL_RULE_LIST_ID) {
        throw new RulesMutationError('rule_list_locked', 'General list cannot be renamed');
      }
      const state = await getRuleListSnapshot();
      ensureRuleListRevision(payload, state);
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
      await ensureRulesGeneration(payload);
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      const state = await getRuleListSnapshot();
      ensureRuleListRevision(payload, state);
      if (!state.lists.some(list => list.id === listId)) {
        throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      }
      const activeRuleListChanged = state.activeRuleListId !== listId;
      const rules = await rulesManager.getRules();
      await ensureBrowserRuleCapacity(rules, {
        lists: state.lists,
        activeRuleListId: listId
      });
      await saveRuleListState(state.lists, listId);
      return syncAndNotify(rules, {
        ruleLists: state.lists,
        activeRuleListId: listId,
        list: state.lists.find(list => list.id === listId),
        activeRuleListChanged
      });
    });
  }

  async function toggleRuleList(payload = {}) {
    return activateRuleList(payload);
  }

  async function deleteRuleList(payload = {}) {
    return mutationQueue.enqueue(async () => {
      await ensureRulesGeneration(payload);
      if (!await getProAccess()) throw new RulesMutationError('pro_required', 'Pro access is required');
      const listId = typeof payload.listId === 'string' ? payload.listId : '';
      if (listId === GENERAL_RULE_LIST_ID) {
        throw new RulesMutationError('rule_list_locked', 'General list cannot be deleted');
      }
      const [state, rules] = await Promise.all([getRuleListSnapshot(), rulesManager.getRules()]);
      ensureRuleListRevision(payload, state);
      if (!state.lists.some(list => list.id === listId)) {
        throw new RulesMutationError('rule_list_not_found', 'Rule list not found');
      }
      const nextLists = state.lists.filter(list => list.id !== listId);
      const nextRules = [];
      const usageRemaps = [];
      const movedToGeneral = [];

      for (let index = 0; index < rules.length; index++) {
        const rule = rules[index];
        if (rule.isWhitelist === true) {
          nextRules.push(canonicalizeRuleTarget(rule, getRuleAssignments(rule)));
          continue;
        }
        const removedAssignment = getRuleAssignment(rule, listId);
        if (!removedAssignment) {
          nextRules.push(rule);
          continue;
        }

        const remainingAssignments = removeRuleAssignment(rule, listId, { fallbackToGeneral: false });
        if (remainingAssignments.length > 0) {
          nextRules.push(canonicalizeRuleTarget(rule, remainingAssignments));
          continue;
        }

        const generalAssignment = createRuleAssignment(GENERAL_RULE_LIST_ID, removedAssignment);
        const movedRule = canonicalizeRuleTarget(rule, [generalAssignment]);
        nextRules.push(movedRule);
        movedToGeneral.push(movedRule);
        if (removedAssignment.blockingMode === BLOCKING_MODE_DAILY_LIMIT) {
          usageRemaps.push({
            oldRuleId: rule.id,
            oldListId: listId,
            newRuleId: rule.id,
            newListId: GENERAL_RULE_LIST_ID
          });
        }
      }

      ensureGeneralMovesHaveNoConflicts(nextRules, movedToGeneral);
      const activeRuleListId = state.activeRuleListId === listId
        ? GENERAL_RULE_LIST_ID
        : normalizeActiveRuleListId(nextLists, state.activeRuleListId);
      await ensureBrowserRuleCapacity(nextRules, {
        lists: nextLists,
        activeRuleListId
      });
      const stagedUsageRemaps = usageRemaps.length > 0 &&
        typeof dailyLimitManager?.stagePendingRemaps === 'function' &&
        typeof dailyLimitManager?.recoverPendingRemaps === 'function';
      if (stagedUsageRemaps) {
        const extraState = typeof ruleListsManager.prepareState === 'function'
          ? await ruleListsManager.prepareState(nextLists, activeRuleListId)
          : { ruleLists: nextLists, activeRuleListId };
        const patch = typeof rulesManager.prepareRulesState === 'function'
          ? await rulesManager.prepareRulesState(nextRules, extraState)
          : { rules: nextRules, ...extraState };
        await dailyLimitManager.stagePendingRemaps(patch, usageRemaps);
      } else {
        await saveCombinedState(nextRules, nextLists, activeRuleListId);
      }
      let dailyUsageSyncPending = false;
      if (stagedUsageRemaps) {
        try {
          await dailyLimitManager.recoverPendingRemaps();
        } catch (error) {
          logger.warn('Daily Limit usage remapping failed after a Rule List was deleted:', error);
          dailyUsageSyncPending = true;
        }
      } else if (usageRemaps.length > 0 && typeof dailyLimitManager?.remapAssignmentKeys === 'function') {
        try {
          await dailyLimitManager.remapAssignmentKeys(usageRemaps);
        } catch (error) {
          logger.warn('Daily Limit usage remapping failed after a Rule List was deleted:', error);
          dailyUsageSyncPending = true;
        }
      } else {
        for (const remap of usageRemaps) {
          dailyUsageSyncPending = await remapDailyUsageAfterCommit(
            remap.oldRuleId, remap.oldListId, remap.newRuleId, remap.newListId
          ) || dailyUsageSyncPending;
        }
      }
      return syncAndNotify(nextRules, {
        ruleLists: nextLists,
        activeRuleListId,
        deletedListId: listId,
        removedConflictingTargets: 0,
        ...(dailyUsageSyncPending ? { dailyUsageSyncPending } : {})
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
