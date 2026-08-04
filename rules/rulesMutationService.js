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

function sanitizeRuleInput(payload = {}, fallbackWhitelist = false) {
  const isWhitelist = payload.isWhitelist === undefined ? fallbackWhitelist : payload.isWhitelist === true;

  return {
    blockURL: typeof payload.blockURL === 'string' ? payload.blockURL : '',
    redirectURL: typeof payload.redirectURL === 'string' ? payload.redirectURL : '',
    schedule: payload.schedule ?? null,
    category: typeof payload.category === 'string' && payload.category ? payload.category : (isWhitelist ? 'whitelist' : 'social'),
    disabledByUser: payload.disabledByUser === true,
    isWhitelist
  };
}

export function createRulesMutationService({
  rulesManager,
  dnrSynchronizer,
  declarativeNetRequest,
  getAccess,
  getSettings,
  saveSettings,
  maxRulesLimit,
  notifyRulesChanged,
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
      const rules = await rulesManager.getRules();
      const hasProAccess = await getProAccess();

      if (input.isWhitelist && !hasProAccess) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      if (!input.isWhitelist && !hasProAccess && rules.length >= maxRulesLimit) {
        throw new RulesMutationError('rule_limit_reached', 'Free rule limit reached');
      }

      throwValidation(rulesManager.validateRule(
        input.blockURL,
        input.redirectURL,
        input.schedule,
        input.category,
        input.isWhitelist
      ));

      throwConflict(rulesManager.checkConflict(rules, input.blockURL, input.isWhitelist));

      if (rulesManager.ruleExists(rules, input.blockURL, input.redirectURL, -1, input.isWhitelist)) {
        throw new RulesMutationError('rule_already_exists', 'Rule already exists');
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
        blockURL: input.blockURL.trim(),
        redirectURL: input.isWhitelist ? '' : input.redirectURL.trim(),
        schedule: input.isWhitelist ? null : input.schedule,
        category: input.isWhitelist ? 'whitelist' : input.category,
        disabledByUser: false,
        isWhitelist: input.isWhitelist
      };

      const nextRules = [...rules, newRule];
      await rulesManager.saveRules(nextRules);

      return syncAndNotify(nextRules, { rule: newRule });
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
      const input = sanitizeRuleInput(payload, oldRule.isWhitelist === true);
      input.isWhitelist = oldRule.isWhitelist === true;

      if (input.isWhitelist && !await getProAccess()) {
        throw new RulesMutationError('pro_required', 'Pro access is required');
      }

      throwValidation(rulesManager.validateRule(
        input.blockURL,
        input.redirectURL,
        input.schedule,
        input.category,
        input.isWhitelist
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

      const updatedRule = {
        id: oldRule.id,
        blockURL: input.blockURL.trim(),
        redirectURL: input.isWhitelist ? '' : input.redirectURL.trim(),
        schedule: input.isWhitelist ? null : input.schedule,
        category: input.isWhitelist ? 'whitelist' : input.category,
        disabledByUser,
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

  function prepareReplacementRules(importedRules) {
    if (!Array.isArray(importedRules)) {
      throw new RulesMutationError('invalid_import', 'Invalid file format: missing rules array');
    }

    const preparedRules = [];

    importedRules.forEach((rawRule, index) => {
      const input = sanitizeRuleInput(rawRule, rawRule?.isWhitelist === true);
      if (!input.isWhitelist && (!rawRule?.category || typeof rawRule.category !== 'string')) {
        input.category = 'uncategorized';
      }

      const validation = rulesManager.validateRule(
        input.blockURL,
        input.redirectURL,
        input.schedule,
        input.category,
        input.isWhitelist
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

      preparedRules.push({
        id: index + 1,
        blockURL: input.blockURL.trim(),
        redirectURL: input.isWhitelist ? '' : input.redirectURL.trim(),
        schedule: input.isWhitelist ? null : input.schedule,
        category: input.isWhitelist ? 'whitelist' : (input.category || 'uncategorized'),
        disabledByUser: input.disabledByUser,
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

      const nextRules = prepareReplacementRules(payload.rules);
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

      await rulesManager.saveRules(nextRules);
      return syncAndNotify(nextRules, { settings: importedSettings });
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

  function runExclusive(task) {
    return mutationQueue.enqueue(task);
  }

  return {
    addRule,
    updateRule,
    deleteRule,
    toggleRule,
    replaceAll,
    clearRules,
    toggleCategory,
    runExclusive
  };
}
