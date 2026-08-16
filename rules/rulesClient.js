// firefox
export function sendRuntimeMessage(message) {
  return browser.runtime.sendMessage(message);
}

function createClientError(errorData = {}) {
  const error = new Error(errorData.message || errorData.code || 'Rules operation failed');
  error.code = errorData.code || 'rules_operation_failed';
  error.validationErrors = Array.isArray(errorData.validationErrors) ? errorData.validationErrors : [];
  return error;
}

async function sendRulesIntent(type, payload = {}) {
  const response = await sendRuntimeMessage({ type, payload });

  if (!response?.success) {
    throw createClientError(response?.error);
  }

  return response;
}

export class RulesClient {
  addRule(payload) {
    return sendRulesIntent('rules:add', payload);
  }

  addMany(packId, entryIds, schedule = null, listId = 'general') {
    return sendRulesIntent('rules:addMany', { packId, entryIds, schedule, listId });
  }

  updateRule(payload) {
    return sendRulesIntent('rules:update', payload);
  }

  removeAssignment(ruleId, listId) {
    return sendRulesIntent('rules:removeAssignment', { ruleId, listId });
  }

  deleteRule(ruleId) {
    return sendRulesIntent('rules:delete', { ruleId });
  }

  toggleRule(ruleId) {
    return sendRulesIntent('rules:toggle', { ruleId });
  }

  replaceAll(rules, settings = null, ruleLists = null, activeRuleListId = null) {
    return sendRulesIntent('rules:replaceAll', { rules, settings, ruleLists, activeRuleListId });
  }

  clearRules() {
    return sendRulesIntent('rules:clear');
  }

  toggleCategory(category) {
    return sendRulesIntent('rules:toggleCategory', { category });
  }

  createRuleList(name) {
    return sendRulesIntent('rules:createList', { name });
  }

  renameRuleList(listId, name) {
    return sendRulesIntent('rules:renameList', { listId, name });
  }

  activateRuleList(listId) {
    return sendRulesIntent('rules:activateList', { listId });
  }

  toggleRuleList(listId) {
    return this.activateRuleList(listId);
  }

  deleteRuleList(listId) {
    return sendRulesIntent('rules:deleteList', { listId });
  }
}
