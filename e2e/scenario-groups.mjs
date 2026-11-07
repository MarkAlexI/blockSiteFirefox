// Initial macOS acceptance reuses production-browser scenarios. Native desktop
// shortcuts, process suspension and audio require separate platform backends.
export const macosSmokeScenarioIds = Object.freeze([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13',
  '18', '19', '20', '21', '22', '23', '24', '25', '27', '28', '46'
]);

// This is a Firefox 128 compatibility check, not acceptance of the declared
// Firefox 113 minimum or Firefox Android. Reuse the native scenario bodies.
export const compatibilityScenarioIds = Object.freeze(['01', '05', '06', '07', '21', '25', '46']);

export function selectScenarioGroup(scenarios, group = 'all') {
  if (!['all', 'core', 'overdue', 'upgrade', 'macos-smoke', 'compatibility'].includes(group)) throw new Error(`Unknown BD_E2E_GROUP: ${group}`);
  if (group === 'compatibility') {
    const selected = scenarios.filter(scenario => compatibilityScenarioIds.includes(scenario.id));
    const ids = selected.map(scenario => scenario.id);
    if (ids.length !== compatibilityScenarioIds.length || new Set(ids).size !== ids.length ||
        compatibilityScenarioIds.some(id => !ids.includes(id))) {
      throw new Error('Incomplete or duplicate Firefox compatibility scenarios');
    }
    return selected;
  }
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
    (scenario.id === '67' || scenario.upgrade === true ? group === 'upgrade' : scenario.id === '65' ? group === 'overdue' : group === 'core'));
}
