import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  MAX_BACKUP_FILE_BYTES,
  createBackupDocument,
  parseBackupText,
  sanitizeBackupPayload
} from '../backup/backupFormat.js';

function validRule(overrides = {}) {
  return {
    id: 44,
    blockURL: 'example.com',
    redirectURL: '',
    category: 'social',
    isWhitelist: false,
    assignments: [{
      listId: 'general',
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null,
      injectedAssignmentState: 'drop-me'
    }],
    statistics: { blocked: 9000 },
    injectedRuleState: 'drop-me',
    ...overrides
  };
}

test('exports contain only the portable backup schema and never security or account state', () => {
  const backup = createBackupDocument({
    rules: [validRule()],
    ruleLists: [{
      id: 'general',
      name: 'General',
      disabledCategories: ['adult'],
      internalFlag: true
    }],
    activeRuleListId: 'general',
    settings: {
      mode: 'strict',
      confirmBeforeDelete: true,
      showNotifications: false,
      debugMode: true,
      focusSessionSound: false,
      enablePassword: true,
      passwordHash: 'private-hash',
      disabledCategories: ['news'],
      licenseKey: 'private-license',
      userId: 'private-user',
      telemetryId: 'private-telemetry'
    },
    version: '5.2.23',
    exportDate: '2026-09-28T12:00:00.000Z'
  });

  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.schemaVersion, BACKUP_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(backup.settings).sort(), [
    'confirmBeforeDelete',
    'focusSessionSound',
    'mode',
    'showNotifications'
  ]);
  assert.deepEqual(Object.keys(backup.rules[0]).sort(), [
    'assignments', 'blockURL', 'category', 'isWhitelist', 'redirectURL'
  ]);
  assert.deepEqual(Object.keys(backup.rules[0].assignments[0]).sort(), [
    'blockingMode', 'dailyLimit', 'disabledByUser', 'listId', 'schedule'
  ]);
  assert.deepEqual(Object.keys(backup.ruleLists[0]).sort(), [
    'disabledCategories', 'id', 'name'
  ]);
  assert.equal(JSON.stringify(backup).includes('private-'), false);
});

test('legacy backups remain importable while password, license, telemetry, usage, and unknown fields are dropped', () => {
  const imported = parseBackupText(JSON.stringify({
    rules: [{
      id: 9,
      blockURL: ' legacy.example ',
      redirectURL: '',
      category: 'work',
      listId: 'general',
      disabledByUser: true,
      focusSession: { focusActive: true },
      dailyUsage: 120
    }],
    settings: {
      mode: 'strict',
      enablePassword: false,
      passwordHash: 'attacker-controlled',
      licenseKey: 'attacker-controlled',
      telemetryId: 'attacker-controlled',
      unknownSetting: true
    },
    credentials: { isPro: true },
    statistics: { totalBlocked: 100 }
  }));

  assert.deepEqual(imported.settings, { mode: 'strict' });
  assert.equal(imported.rules[0].blockURL, 'legacy.example');
  assert.equal(imported.rules[0].id, undefined);
  assert.equal(imported.rules[0].focusSession, undefined);
  assert.equal(imported.rules[0].dailyUsage, undefined);
  assert.equal(imported.credentials, undefined);
  assert.equal(imported.statistics, undefined);
});

test('strict validation rejects malformed nested state before it reaches storage', () => {
  const invalidPayloads = [
    { rules: [null] },
    { rules: [{ blockURL: 7 }] },
    { rules: [validRule({ category: 'invented' })] },
    { rules: [validRule({ assignments: [{ listId: 'general', disabledByUser: 'yes' }] })] },
    { rules: [validRule({ assignments: [{ listId: 'general', blockingMode: 'daily_limit', dailyLimit: { minutes: 1.5 } }] })] },
    { rules: [validRule({ assignments: [{ listId: 'general', blockingMode: 'schedule', schedule: { days: [8], startTime: '09:00', endTime: '10:00' } }] })] },
    { rules: [validRule()], settings: { mode: 'maximum' } },
    { rules: [validRule()], ruleLists: [{ id: 'general' }], activeRuleListId: 'missing' },
    { format: BACKUP_FORMAT, schemaVersion: 2, rules: [validRule()] }
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => sanitizeBackupPayload(payload),
      error => error.code === 'invalid_import' && /Invalid backup/.test(error.message)
    );
  }
});

test('whitelist imports retain their disabled state but reject profile and schedule injection', () => {
  const imported = sanitizeBackupPayload({
    rules: [validRule({
      isWhitelist: true,
      category: 'whitelist',
      assignments: [{
        listId: 'general',
        disabledByUser: true,
        blockingMode: 'always',
        schedule: null,
        dailyLimit: null
      }]
    })]
  });
  assert.equal(imported.rules[0].assignments[0].disabledByUser, true);

  assert.throws(() => sanitizeBackupPayload({
    rules: [validRule({
      isWhitelist: true,
      assignments: [{ listId: 'list-1', blockingMode: 'always' }]
    })]
  }), /unsupported whitelist settings/);
});

test('backup text parser rejects malformed and oversized input', () => {
  assert.throws(() => parseBackupText('{broken'), /not valid JSON/);
  assert.throws(
    () => parseBackupText(' '.repeat(MAX_BACKUP_FILE_BYTES + 1)),
    /file is too large/
  );
});
