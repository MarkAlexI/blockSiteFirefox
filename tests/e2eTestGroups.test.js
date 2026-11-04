import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { macosSmokeScenarioIds, selectScenarioGroup } from '../e2e/scenario-groups.mjs';

test('Firefox CI groups preserve original order, include overdue once and reject unknown groups', async () => {
  const scenarios = [{ id: '01' }, { id: '64' }, { id: '65' }, { id: '67' }];
  assert.deepEqual(selectScenarioGroup(scenarios), scenarios);
  assert.deepEqual(selectScenarioGroup(scenarios, 'core'), scenarios.slice(0,2));
  assert.deepEqual(selectScenarioGroup(scenarios, 'overdue'), scenarios.slice(2,3));
  assert.deepEqual(selectScenarioGroup(scenarios, 'upgrade'), scenarios.slice(3));
  for (const group of ['typo', '', null]) assert.throws(() => selectScenarioGroup(scenarios, group), /Unknown/);
  const workflow = await readFile(new URL('../.github/workflows/e2e-firefox.yml', import.meta.url), 'utf8');
  assert.match(workflow, /group: \[core, overdue, upgrade\]/);
  assert.match(workflow, /needs: \[scenarios, macos\]/);
  assert.match(workflow, /SCENARIO_RESULT.*success/);
  assert.match(workflow, /MACOS_RESULT.*success/);
});

test('macOS smoke covers rules, accounting, paid access, readers and scheduled Focus in original order', () => {
  const scenarios = [...macosSmokeScenarioIds].reverse().map(id => ({ id }));
  scenarios.splice(3, 0, { id: '39', nativeKeyboard: true });
  const selected = selectScenarioGroup(scenarios, 'macos-smoke');
  assert.deepEqual(selected.map(item => item.id), [...macosSmokeScenarioIds].reverse());
  for (const required of ['01', '04', '05', '07', '08', '09', '10', '12', '18', '20', '25', '46']) {
    assert.ok(selected.some(item => item.id === required), `missing acceptance scenario ${required}`);
  }
  assert.equal(selected.length, 24);
  assert.ok(selected.every(item => !item.nativeKeyboard));
  assert.equal(scenarios.length, 25, 'selection does not mutate the suite');
});

test('macOS selection fails on a missing or duplicate scenario instead of reporting partial acceptance', () => {
  const scenarios = macosSmokeScenarioIds.map(id => ({ id }));
  assert.throws(() => selectScenarioGroup(scenarios.slice(1), 'macos-smoke'), /Incomplete/);
  assert.throws(() => selectScenarioGroup([...scenarios, scenarios[0]], 'macos-smoke'), /duplicate/);
  assert.throws(() => selectScenarioGroup([...scenarios.slice(1), scenarios[1]], 'macos-smoke'), /duplicate/);
});
