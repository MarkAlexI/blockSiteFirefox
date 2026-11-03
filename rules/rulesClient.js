// firefox
import { GENERAL_RULE_LIST_ID } from './ruleListsManager.js';

export function sendRuntimeMessage(message) {
  return browser.runtime.sendMessage(message);
}

// Read-only, bounded liveness check. A timeout never retries a mutation or
// claims an unanswered save failed; the Options view stays blocked until read again.
export function checkRulesConnection({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Rules connection did not respond');
      error.code = 'rules_connection_timeout';
      reject(error);
    }, timeoutMs);
    Promise.resolve().then(() => sendRuntimeMessage({ type: 'rules:health' })).then(response => {
      clearTimeout(timer);
      if (response?.success === true && response.protocol === 1) resolve();
      else {
        const error = new Error('Rules connection is unavailable');
        error.code = response?.code === 'rules_health_forbidden' ? 'rules_health_forbidden' : 'rules_connection_unavailable';
        reject(error);
      }
    }, error => { clearTimeout(timer); reject(error); });
  });
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

  clearRules(expectedGeneration = null) {
    return sendRulesIntent('rules:clear', { expectedGeneration });
  }

  toggleCategory(category, listId, expectedGeneration = null, expectedListRevision = null) {
    return sendRulesIntent('rules:toggleCategory', { category, listId, expectedGeneration, expectedListRevision });
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
