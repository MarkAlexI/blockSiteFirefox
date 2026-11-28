// Initial macOS acceptance reuses production-browser scenarios. Native desktop
// shortcuts, process suspension and audio require separate platform backends.
export const macosSmokeScenarioIds = Object.freeze([
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13',
  '18', '19', '20', '21', '22', '23', '24', '25', '27', '28', '46'
]);

// Keep the historical ESR 115 inventory separate from current Firefox 128
// acceptance. Cold DNR must also work before opening extension UI on 128.
export const compatibilityScenarioIds = Object.freeze(['01', '05', '06', '07', '21', '25', '46']);
export const desktop128ScenarioIds = Object.freeze([...compatibilityScenarioIds, '66']);
export const compatibilityIdsFor = group => group === 'esr115' ? compatibilityScenarioIds : desktop128ScenarioIds;

// Calendar boundaries, scheduled expiry and native idle/alarm wake deliberately
// wait for real browser time. Keep them out of the growing core CI lane.
const lifecycleScenarioIds = new Set([
  '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43'
]);

export function selectScenarioGroup(scenarios, group = 'all') {
  if (!['all', 'core', 'lifecycle', 'overdue', 'upgrade', 'macos-smoke', 'compatibility', 'esr115'].includes(group)) throw new Error(`Unknown BD_E2E_GROUP: ${group}`);
  if (group === 'compatibility' || group === 'esr115') {
    const expected = compatibilityIdsFor(group);
    const selected = scenarios.filter(scenario => expected.includes(scenario.id));
    const ids = selected.map(scenario => scenario.id);
    if (ids.length !== expected.length || new Set(ids).size !== ids.length ||
        expected.some(id => !ids.includes(id))) {
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
  return scenarios.filter(scenario => {
    if (group === 'all') return true;
    if (scenario.id === '67' || scenario.upgrade === true) return group === 'upgrade';
    if (scenario.id === '65') return group === 'overdue';
    return group === (lifecycleScenarioIds.has(scenario.id) ? 'lifecycle' : 'core');
  });
}
