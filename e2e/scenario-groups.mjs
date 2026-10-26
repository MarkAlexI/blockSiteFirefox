export function selectScenarioGroup(scenarios, group = 'all') {
  if (!['all', 'core', 'overdue'].includes(group)) throw new Error(`Unknown BD_E2E_GROUP: ${group}`);
  return scenarios.filter(scenario => group === 'all' ||
    (scenario.id === '65' ? group === 'overdue' : group === 'core'));
}
