import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { selectScenarioGroup } from '../e2e/scenario-groups.mjs';

test('Firefox CI groups preserve original order, include overdue once and reject unknown groups', async () => {
  const scenarios = [{ id: '01' }, { id: '64' }, { id: '65' }, { id: '67' }];
  assert.deepEqual(selectScenarioGroup(scenarios), scenarios);
  assert.deepEqual(selectScenarioGroup(scenarios, 'core'), scenarios.slice(0,2));
  assert.deepEqual(selectScenarioGroup(scenarios, 'overdue'), scenarios.slice(2,3));
  assert.deepEqual(selectScenarioGroup(scenarios, 'upgrade'), scenarios.slice(3));
  for (const group of ['typo', '', null]) assert.throws(() => selectScenarioGroup(scenarios, group), /Unknown/);
  const workflow = await readFile(new URL('../.github/workflows/e2e-firefox.yml', import.meta.url), 'utf8');
  assert.match(workflow, /group: \[core, overdue, upgrade\]/);
  assert.match(workflow, /needs: scenarios/);
  assert.match(workflow, /SCENARIO_RESULT.*success/);
});
