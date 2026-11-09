import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { macosSmokeScenarioIds, selectScenarioGroup } from '../e2e/scenario-groups.mjs';

test('Firefox CI groups preserve original order, include overdue once and reject unknown groups', async () => {
  const scenarios = [{ id: '01' }, { id: '64' }, { id: '65' }, { id: '67' }, { id: '67-5.5.11', upgrade: true }];
  assert.deepEqual(selectScenarioGroup(scenarios), scenarios);
  assert.deepEqual(selectScenarioGroup(scenarios, 'core'), scenarios.slice(0,2));
  assert.deepEqual(selectScenarioGroup(scenarios, 'overdue'), scenarios.slice(2,3));
  assert.deepEqual(selectScenarioGroup(scenarios, 'upgrade'), scenarios.slice(3));
  for (const group of ['typo', '', null]) assert.throws(() => selectScenarioGroup(scenarios, group), /Unknown/);
  const workflow = await readFile(new URL('../.github/workflows/e2e-firefox.yml', import.meta.url), 'utf8');
  assert.match(workflow, /group: \[core, lifecycle, overdue, upgrade\]/);
  assert.match(workflow, /needs: \[scenarios, macos, compatibility\]/);
  assert.match(workflow, /SCENARIO_RESULT.*success/);
  assert.match(workflow, /MACOS_RESULT.*success/);
  assert.match(workflow, /COMPATIBILITY_RESULT.*success/);
});

test('Firefox lifecycle split retains every slow native scenario once and keeps future coverage in core', () => {
  const lifecycle = ['32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43']
    .toReversed().map(id => ({ id }));
  const core = [{ id: '31' }, { id: '44' }, { id: '81' }, { id: '82' }];
  const overdue = { id: '65' };
  const upgrade = [{ id: '67' }, { id: '67-5.5.11', upgrade: true }, { id: '83', upgrade: true }];
  const scenarios = [core[0], ...lifecycle, core[1], overdue, core[2], ...upgrade, core[3]];
  const groups = Object.fromEntries(['core', 'lifecycle', 'overdue', 'upgrade']
    .map(group => [group, selectScenarioGroup(scenarios, group)]));
  assert.deepEqual(groups.lifecycle, lifecycle, 'slow native bodies retain their original order');
  assert.deepEqual(groups.core, core, 'URL safety and future scenarios remain required');
  assert.deepEqual(groups.overdue, [overdue]);
  assert.deepEqual(groups.upgrade, upgrade);
  const partition = Object.values(groups).flat();
  assert.equal(partition.length, scenarios.length, 'no scenario runs in two Linux groups');
  assert.deepEqual(new Set(partition), new Set(scenarios), 'no scenario is omitted');
  assert.deepEqual(selectScenarioGroup(scenarios), scenarios, 'the full local suite remains intact');
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
