import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Daily Limit worker restarts visibility accounting after navigation completes', async () => {
  const source = await readFile(new URL('../scripts/service_worker.js', import.meta.url), 'utf8');
  assert.match(source, /changeInfo\.status === 'complete'[\s\S]{0,300}dailyLimitTracker\.sample\('tab_load_complete'/);
});

test('Daily Limit worker handles the one-shot deadline alarm', async () => {
  const source = await readFile(new URL('../scripts/service_worker.js', import.meta.url), 'utf8');
  assert.match(source, /alarm\.name === DAILY_LIMIT_DEADLINE_ALARM[\s\S]{0,160}dailyLimitTracker\.sample\('deadline_alarm'/);
});

test('window focus loss closes Daily Limit accounting instead of leaving the segment active', async () => {
  const source = await readFile(new URL('../scripts/service_worker.js', import.meta.url), 'utf8');
  assert.match(source, /WINDOW_ID_NONE[\s\S]{0,160}dailyLimitTracker\.pause\('window_focus_lost'/);
  assert.match(source, /dailyLimitTracker\.sample\('window_focus_gained'/);
});
