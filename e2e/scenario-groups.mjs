// Initial macOS acceptance reuses production-browser scenarios. Native desktop
// shortcuts, process suspension and audio require separate platform backends.
export const macosSmokeScenarioIds = Object.freeze([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13',
  '18', '19', '20', '21', '22', '23', '24', '25', '27', '28', '46'
]);

export function selectScenarioGroup(scenarios, group = 'all') {
  if (!['all', 'core', 'overdue', 'upgrade', 'macos-smoke'].includes(group)) throw new Error(`Unknown BD_E2E_GROUP: ${group}`);
  if (group === 'macos-smoke') {
    const selected = scenarios.filter(scenario => macosSmokeScenarioIds.includes(scenario.id));
    const ids = selected.map(scenario => scenario.id);
    if (ids.length !== macosSmokeScenarioIds.length || new Set(ids).size !== ids.length ||
        macosSmokeScenarioIds.some(id => !ids.includes(id))) {
      throw new Error('Incomplete or duplicate macOS smoke scenarios');
    }
    return selected;
  }
  return scenarios.filter(scenario => group === 'all' ||
    (scenario.id === '67' ? group === 'upgrade' : scenario.id === '65' ? group === 'overdue' : group === 'core'));
}
