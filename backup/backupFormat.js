import { CATEGORIES } from '../rules/categoryManager.js';
import {
  BLOCKING_MODE_ALWAYS,
  BLOCKING_MODE_DAILY_LIMIT,
  BLOCKING_MODE_SCHEDULE,
  BLOCKING_MODES,
  normalizeDailyLimit,
  validateBlockingConfig
} from '../rules/blockingMode.js';
import { GENERAL_RULE_LIST_ID } from '../rules/ruleListsManager.js';
import { normalizeSchedule } from '../schedules/scheduleNormalizer.js';
import { validateSchedule } from '../schedules/scheduleValidator.js';

export const BACKUP_FORMAT = 'blockdistraction-backup';
export const BACKUP_SCHEMA_VERSION = 1;
export const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;

const BOOLEAN_SETTING_KEYS = Object.freeze([
  'confirmBeforeDelete',
  'showNotifications',
  'focusSessionSound'
]);
const CATEGORY_SET = new Set(CATEGORIES);

export class BackupValidationError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = 'BackupValidationError';
    this.code = 'invalid_import';
  }
}

function invalid(message) {
  throw new BackupValidationError(`Invalid backup: ${message}`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sanitizeBoolean(value, path) {
  if (typeof value !== 'boolean') invalid(`${path} must be a boolean`);
  return value;
}

function sanitizeString(value, path, { allowEmpty = false, maxLength = 4096 } = {}) {
  if (typeof value !== 'string') invalid(`${path} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) invalid(`${path} must not be empty`);
  if (normalized.length > maxLength) invalid(`${path} is too long`);
  return normalized;
}

function sanitizeCategories(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(`${path} must be an array`);
  const seen = new Set();
  return value.map((category, index) => {
    if (typeof category !== 'string' || !CATEGORY_SET.has(category)) {
      invalid(`${path}[${index}] is not a supported category`);
    }
    if (seen.has(category)) invalid(`${path} contains a duplicate category`);
    seen.add(category);
    return category;
  });
}

function sanitizeSchedule(schedule, path) {
  if (!isRecord(schedule)) invalid(`${path} must be an object`);
  const normalized = normalizeSchedule(schedule);
  const validation = validateSchedule(normalized);
  if (!validation.isValid) {
    invalid(`${path} is invalid (${validation.errors.join(', ')})`);
  }
  return normalized;
}

function sanitizeDailyLimit(dailyLimit, path) {
  if (!isRecord(dailyLimit)) invalid(`${path} must be an object`);
  const normalized = normalizeDailyLimit(dailyLimit);
  if (!normalized || !Number.isInteger(dailyLimit.minutes)) {
    invalid(`${path}.minutes must be an integer from 1 to 1440`);
  }
  return normalized;
}

function sanitizeBlockingConfig(source, path, isWhitelist = false) {
  const hasSchedule = hasOwn(source, 'schedule') && source.schedule !== null;
  const hasDailyLimit = hasOwn(source, 'dailyLimit') && source.dailyLimit !== null;
  let blockingMode;

  if (hasOwn(source, 'blockingMode')) {
    if (typeof source.blockingMode !== 'string' || !BLOCKING_MODES.includes(source.blockingMode)) {
      invalid(`${path}.blockingMode is not supported`);
    }
    blockingMode = source.blockingMode;
  } else if (hasSchedule) {
    blockingMode = BLOCKING_MODE_SCHEDULE;
  } else if (hasDailyLimit) {
    blockingMode = BLOCKING_MODE_DAILY_LIMIT;
  } else {
    blockingMode = BLOCKING_MODE_ALWAYS;
  }

  const schedule = hasSchedule ? sanitizeSchedule(source.schedule, `${path}.schedule`) : null;
  const dailyLimit = hasDailyLimit
    ? sanitizeDailyLimit(source.dailyLimit, `${path}.dailyLimit`)
    : null;
  const validation = validateBlockingConfig({
    blockingMode,
    schedule,
    dailyLimit,
    isWhitelist
  });
  if (!validation.isValid) {
    invalid(`${path} has conflicting blocking settings (${validation.errors.join(', ')})`);
  }
  return { blockingMode, schedule, dailyLimit };
}

function sanitizeAssignment(rawAssignment, path, isWhitelist) {
  if (!isRecord(rawAssignment)) invalid(`${path} must be an object`);
  const listId = hasOwn(rawAssignment, 'listId')
    ? sanitizeString(rawAssignment.listId, `${path}.listId`, { maxLength: 64 })
    : GENERAL_RULE_LIST_ID;
  const disabledByUser = hasOwn(rawAssignment, 'disabledByUser')
    ? sanitizeBoolean(rawAssignment.disabledByUser, `${path}.disabledByUser`)
    : false;
  const blocking = sanitizeBlockingConfig(rawAssignment, path, isWhitelist);

  if (isWhitelist && (
    listId !== GENERAL_RULE_LIST_ID ||
    blocking.blockingMode !== BLOCKING_MODE_ALWAYS ||
    blocking.schedule ||
    blocking.dailyLimit
  )) {
    invalid(`${path} contains unsupported whitelist settings`);
  }

  return {
    listId,
    disabledByUser,
    ...blocking
  };
}

function sanitizeLegacyRuleConfig(rawRule, path, isWhitelist) {
  const result = {};
  if (hasOwn(rawRule, 'listId')) {
    result.listId = sanitizeString(rawRule.listId, `${path}.listId`, { maxLength: 64 });
  }
  if (hasOwn(rawRule, 'listIds')) {
    if (!Array.isArray(rawRule.listIds) || rawRule.listIds.length === 0) {
      invalid(`${path}.listIds must be a non-empty array`);
    }
    const seen = new Set();
    result.listIds = rawRule.listIds.map((listId, index) => {
      const normalized = sanitizeString(listId, `${path}.listIds[${index}]`, { maxLength: 64 });
      if (seen.has(normalized)) invalid(`${path}.listIds contains a duplicate id`);
      seen.add(normalized);
      return normalized;
    });
  }
  if (hasOwn(result, 'listId') && hasOwn(result, 'listIds')) {
    invalid(`${path} cannot contain both listId and listIds`);
  }
  if (hasOwn(rawRule, 'disabledByUser')) {
    result.disabledByUser = sanitizeBoolean(rawRule.disabledByUser, `${path}.disabledByUser`);
  }
  Object.assign(result, sanitizeBlockingConfig(rawRule, path, isWhitelist));
  return result;
}

function sanitizeRule(rawRule, index) {
  const path = `rules[${index}]`;
  if (!isRecord(rawRule)) invalid(`${path} must be an object`);
  const isWhitelist = hasOwn(rawRule, 'isWhitelist')
    ? sanitizeBoolean(rawRule.isWhitelist, `${path}.isWhitelist`)
    : false;
  const blockURL = sanitizeString(rawRule.blockURL, `${path}.blockURL`);
  const redirectURL = hasOwn(rawRule, 'redirectURL')
    ? sanitizeString(rawRule.redirectURL, `${path}.redirectURL`, { allowEmpty: true })
    : '';
  let category = isWhitelist ? 'whitelist' : 'uncategorized';
  if (!isWhitelist && hasOwn(rawRule, 'category')) {
    if (typeof rawRule.category !== 'string' || !CATEGORY_SET.has(rawRule.category)) {
      invalid(`${path}.category is not supported`);
    }
    category = rawRule.category;
  }

  const result = { blockURL, redirectURL: isWhitelist ? '' : redirectURL, category, isWhitelist };
  if (hasOwn(rawRule, 'assignments')) {
    if (!Array.isArray(rawRule.assignments) || rawRule.assignments.length === 0) {
      invalid(`${path}.assignments must be a non-empty array`);
    }
    result.assignments = rawRule.assignments.map((assignment, assignmentIndex) =>
      sanitizeAssignment(assignment, `${path}.assignments[${assignmentIndex}]`, isWhitelist)
    );
    if (isWhitelist && result.assignments.length !== 1) {
      invalid(`${path}.assignments must contain one General whitelist assignment`);
    }
  } else {
    const legacyConfig = sanitizeLegacyRuleConfig(rawRule, path, isWhitelist);
    if (isWhitelist && (
      (legacyConfig.listId && legacyConfig.listId !== GENERAL_RULE_LIST_ID) ||
      legacyConfig.listIds?.some(listId => listId !== GENERAL_RULE_LIST_ID) ||
      legacyConfig.blockingMode !== BLOCKING_MODE_ALWAYS ||
      legacyConfig.schedule ||
      legacyConfig.dailyLimit
    )) {
      invalid(`${path} contains unsupported whitelist settings`);
    }
    Object.assign(result, legacyConfig);
  }
  return result;
}

function sanitizeSettings(rawSettings) {
  if (rawSettings === undefined || rawSettings === null) return null;
  if (!isRecord(rawSettings)) invalid('settings must be an object');
  const result = {};
  if (hasOwn(rawSettings, 'mode')) {
    if (rawSettings.mode !== 'normal' && rawSettings.mode !== 'strict') {
      invalid('settings.mode is not supported');
    }
    result.mode = rawSettings.mode;
  }
  for (const key of BOOLEAN_SETTING_KEYS) {
    if (hasOwn(rawSettings, key)) {
      result[key] = sanitizeBoolean(rawSettings[key], `settings.${key}`);
    }
  }
  if (hasOwn(rawSettings, 'disabledCategories')) {
    result.disabledCategories = sanitizeCategories(
      rawSettings.disabledCategories,
      'settings.disabledCategories'
    );
  }
  return result;
}

function sanitizeRuleLists(rawLists) {
  if (rawLists === undefined || rawLists === null) return null;
  if (!Array.isArray(rawLists)) invalid('ruleLists must be an array');
  return rawLists.map((rawList, index) => {
    const path = `ruleLists[${index}]`;
    if (!isRecord(rawList)) invalid(`${path} must be an object`);
    const id = sanitizeString(rawList.id, `${path}.id`, { maxLength: 64 });
    const result = {
      id,
      disabledCategories: sanitizeCategories(rawList.disabledCategories, `${path}.disabledCategories`)
    };
    if (id !== GENERAL_RULE_LIST_ID || hasOwn(rawList, 'name')) {
      result.name = sanitizeString(
        rawList.name ?? 'General',
        `${path}.name`,
        { maxLength: 40 }
      );
    }
    return result;
  });
}

export function sanitizeBackupPayload(payload) {
  if (!isRecord(payload)) invalid('root must be an object');
  if (hasOwn(payload, 'format') && payload.format !== BACKUP_FORMAT) {
    invalid('format is not supported');
  }
  if (hasOwn(payload, 'schemaVersion') && payload.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    invalid('schema version is not supported');
  }
  if (!Array.isArray(payload.rules)) invalid('missing rules array');

  const ruleLists = sanitizeRuleLists(payload.ruleLists);
  const activeRuleListId = payload.activeRuleListId === undefined || payload.activeRuleListId === null
    ? GENERAL_RULE_LIST_ID
    : sanitizeString(payload.activeRuleListId, 'activeRuleListId', { maxLength: 64 });
  if (!ruleLists && activeRuleListId !== GENERAL_RULE_LIST_ID) {
    invalid('activeRuleListId requires imported Rule Lists');
  }
  if (ruleLists && !ruleLists.some(list => list.id === activeRuleListId)) {
    invalid('activeRuleListId does not reference an imported Rule List');
  }

  return {
    rules: payload.rules.map(sanitizeRule),
    settings: sanitizeSettings(payload.settings),
    ruleLists,
    activeRuleListId
  };
}

export function parseBackupText(text) {
  if (typeof text !== 'string') invalid('file content must be text');
  if (text.length > MAX_BACKUP_FILE_BYTES) invalid('file is too large');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BackupValidationError('File content is not valid JSON', { cause: error });
  }
  return sanitizeBackupPayload(parsed);
}

export function createBackupDocument({
  rules,
  ruleLists,
  activeRuleListId,
  settings,
  version,
  exportDate = new Date().toISOString()
}) {
  const sanitized = sanitizeBackupPayload({
    rules,
    ruleLists,
    activeRuleListId,
    settings
  });
  const { disabledCategories: _legacyDisabledCategories, ...portableSettings } =
    sanitized.settings || {};
  return {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    version: typeof version === 'string' ? version : '',
    exportDate,
    ...sanitized,
    settings: portableSettings
  };
}
