// firefox
import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';

export function sendRuntimeMessage(message) {
  return browser.runtime.sendMessage(message);
}

function createClientError(errorData = {}) {
  const error = new Error(errorData.message || errorData.code || 'Rules operation failed');
  error.code = errorData.code || 'rules_operation_failed';
  error.validationErrors = Array.isArray(errorData.validationErrors) ? errorData.validationErrors : [];
  if (error.code === 'rule_already_exists' &&
      errorData.conflict?.listId === GENERAL_RULE_LIST_ID &&
      typeof errorData.conflict.blockURL === 'string') {
    error.conflict = {
      listId: GENERAL_RULE_LIST_ID,
      blockURL: errorData.conflict.blockURL
    };
  }
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
    return sendRulesIntent('rules:add', { ...payload, expectedGeneration: payload.expectedGeneration ?? null, expectedListRevisions: payload.expectedListRevisions ?? {} });
  }

  addMany(packId, entryIds, schedule = null, listId = 'general', expectedGeneration = null, expectedListRevisions = {}) {
    return sendRulesIntent('rules:addMany', { packId, entryIds, schedule, listId, expectedGeneration, expectedListRevisions });
  }

  updateRule(payload) {
    return sendRulesIntent('rules:update', { ...payload, expectedGeneration: payload.expectedGeneration ?? null, expectedRevision: payload.expectedRevision ?? null, expectedListRevisions: payload.expectedListRevisions ?? {} });
  }

  removeAssignment(ruleId, listId, expectedGeneration = null, expectedRevision = null) {
    return sendRulesIntent('rules:removeAssignment', { ruleId, listId, expectedGeneration, expectedRevision });
  }

  deleteRule(ruleId, expectedGeneration = null, expectedRevision = null) {
    return sendRulesIntent('rules:delete', { ruleId, expectedGeneration, expectedRevision });
  }

  toggleRule(ruleId, listId = GENERAL_RULE_LIST_ID, expectedGeneration = null, expectedRevision = null) {
    return sendRulesIntent('rules:toggle', { ruleId, listId, expectedGeneration, expectedRevision });
  }

  replaceAll(backup, settings = null, ruleLists = null, activeRuleListId = null) {
    const payload = Array.isArray(backup)
      ? { rules: backup, settings, ruleLists, activeRuleListId }
      : backup;
    return sendRulesIntent('rules:replaceAll', payload);
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

  renameRuleList(listId, name, expectedGeneration = null, expectedListRevision = null) {
    return sendRulesIntent('rules:renameList', { listId, name, expectedGeneration, expectedListRevision });
  }

  activateRuleList(listId, expectedGeneration = null, expectedListRevision = null) {
    return sendRulesIntent('rules:activateList', { listId, expectedGeneration, expectedListRevision });
  }

  toggleRuleList(listId, expectedGeneration = null, expectedListRevision = null) {
    return this.activateRuleList(listId, expectedGeneration, expectedListRevision);
  }

  deleteRuleList(listId, expectedGeneration = null, expectedListRevision = null) {
    return sendRulesIntent('rules:deleteList', { listId, expectedGeneration, expectedListRevision });
  }
}
