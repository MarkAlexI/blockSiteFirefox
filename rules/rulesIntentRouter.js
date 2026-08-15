export const RULES_INTENT_TYPES = new Set([
  'rules:add',
  'rules:addMany',
  'rules:update',
  'rules:delete',
  'rules:toggle',
  'rules:replaceAll',
  'rules:clear',
  'rules:toggleCategory',
  'rules:createList',
  'rules:renameList',
  'rules:toggleList',
  'rules:deleteList'
]);

/**
 * Creates the rules command router used by the service worker. Keeping the
 * mapping outside the worker makes the browser message listener smaller and
 * lets command routing be tested without a WebExtension runtime.
 */
export function createRulesIntentHandler(rulesMutationService) {
  return async function handleRulesIntent(message) {
    switch (message.type) {
      case 'rules:add':
        return rulesMutationService.addRule(message.payload);
      case 'rules:addMany':
        return rulesMutationService.addMany(message.payload);
      case 'rules:update':
        return rulesMutationService.updateRule(message.payload);
      case 'rules:delete':
        return rulesMutationService.deleteRule(message.payload);
      case 'rules:toggle':
        return rulesMutationService.toggleRule(message.payload);
      case 'rules:replaceAll':
        return rulesMutationService.replaceAll(message.payload);
      case 'rules:clear':
        return rulesMutationService.clearRules();
      case 'rules:toggleCategory':
        return rulesMutationService.toggleCategory(message.payload);
      case 'rules:createList':
        return rulesMutationService.createRuleList(message.payload);
      case 'rules:renameList':
        return rulesMutationService.renameRuleList(message.payload);
      case 'rules:toggleList':
        return rulesMutationService.toggleRuleList(message.payload);
      case 'rules:deleteList':
        return rulesMutationService.deleteRuleList(message.payload);
      default:
        throw new Error(`Unsupported rules intent: ${message.type}`);
    }
  };
}
