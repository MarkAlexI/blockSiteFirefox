import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVersionUpgrade, assertUpgradeOptionsView, assertUpgradeOptionsEditing, upgradeTimezone,
  openUpgradeOptionsFromPopup, readUpgradeRuleToggle, assertUpgradeRuleToggle } from '../e2e/version-upgrade.mjs';
import { expectedVersion } from '../e2e/target-version.mjs';
import { assignDnrRulePriorities, createDnrRuleFactory } from '../rules/dnrRuleFactory.js';
import { FakeDocument, createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';

function sample(version='5.4.14'){
  const before={id:'fixture-id',version,now:1000,__bdUpgradeToken:'durable-marker',rules:[{id:901},{id:902}],
    ruleLists:[{id:'general'},{id:'list-1'}],activeRuleListId:'general',rulesGeneration:'generation',
    ruleRevisions:{901:'r1',902:'r2'},ruleListRevisions:{general:'g1'},
    credentials:{isPro:true,isLegacyUser:false,installationDate:'2026-08-01',licenseKey:'BD-E2E-VALID-KEY'},
    settings:{debugMode:true},focusSession:{focusActive:true,focusEndTime:301000},focusSchedule:{enabled:true,revision:1},
    pendingDailyUsageRemaps:[],dailyRuleUsage:{date:'2026-10-26',usageSeconds:{'902:general':45,'902:list-1':840}},
    dnr:[{id:901},{id:902}],alarms:[{name:'end_focus_session',scheduledTime:301000},
      {name:'start_scheduled_focus',scheduledTime:3601000}]};
  const factory = createDnrRuleFactory(path => `https://extension.invalid/${path}`);
  before.dnr = [factory(901, 'upgrade-basic.test', '', 'focus'), factory(902, 'upgrade-daily.test', '', 'focus')];
  const after={...structuredClone(before),version:expectedVersion,now:1100};
  after.dnr = assignDnrRulePriorities(after.dnr);
  const receipt={before:{id:before.id,version:before.version,pid:123,profile:'/owned/profile'},
    after:{id:after.id,version:after.version,pid:123,profile:'/owned/profile'},
    events:[{at:1050,extensionId:before.id,details:{reason:'update',previousVersion:before.version}}]};
  return {before,after,receipt};
}

for(const version of ['5.4.14','5.6.9']) {
test(`upgrade acceptance requires the actual ${version} transition and preserved old state`,()=>{
  const s=sample(version);assertVersionUpgrade(s.before,s.after,s.receipt,version);
});
for(const [name,change] of [
  ['fresh installation',s=>s.receipt.events[0].details.reason='install'],
  ['wrong previous version',s=>s.receipt.events[0].details.previousVersion='5.4.13'],
  ['same-version reload',s=>s.after.version=s.before.version],
  ['different extension',s=>s.after.id='another-id'],
  ['another profile',s=>s.receipt.after.profile='/other/profile'],
  ['browser restart',s=>s.receipt.after.pid=456],
  ['duplicate update delivery',s=>s.receipt.events.push(structuredClone(s.receipt.events[0]))],
  ['foreign lifecycle event',s=>s.receipt.events[0].extensionId='another-id'],
  ['cleared old storage',s=>delete s.after.__bdUpgradeToken],
  ['lost Pro',s=>s.after.credentials.isPro=false],
  ['reset settings',s=>s.after.settings.debugMode=false],
  ['reset spent budget',s=>s.after.dailyRuleUsage.usageSeconds['902:general']=0],
  ['reset other profile budget',s=>s.after.dailyRuleUsage.usageSeconds['902:list-1']=0],
  ['extended Focus deadline',s=>s.after.focusSession.focusEndTime+=60000],
  ['missing completion alarm',s=>s.after.alarms.shift()],
  ['lost schedule alarm',s=>s.after.alarms.pop()],
  ['lost browser blocking',s=>s.after.dnr=[]],
  ['changed native URL condition',s=>s.after.dnr[0].condition.urlFilter='||other.test'],
  ['changed native redirect',s=>s.after.dnr[0].action.redirect.url='https://other.test/'],
  ['changed native resource type',s=>s.after.dnr[0].condition.resourceTypes=['sub_frame']],
  ['equal native priorities',s=>s.after.dnr[0].priority=s.after.dnr[1].priority],
  ['reversed native precedence',s=>[s.after.dnr[0].priority,s.after.dnr[1].priority]=[100,101]]
])test(`${version} upgrade acceptance rejects ${name}`,()=>{
  const s=sample(version);change(s);assert.throws(()=>assertVersionUpgrade(s.before,s.after,s.receipt,version));
});
}

test('a consistent but wrong source version cannot replace the selected pinned baseline',()=>{
  const s=sample('5.4.14');
  assert.throws(()=>assertVersionUpgrade(s.before,s.after,s.receipt,'5.6.9'));
});

test('the preservation fixture avoids midnight without changing the host clock',()=>{
  for(const hour of [0,23])assert.equal(upgradeTimezone(Date.UTC(2026,9,26,hour)),'Etc/GMT+12');
  for(const hour of [1,12,22])assert.equal(upgradeTimezone(Date.UTC(2026,9,26,hour)),'UTC');
});

test('update acceptance requires rendered, interactive current Options rather than preserved storage alone', () => {
  const view = { versionText: `v${expectedVersion}`, state: 'ready', bannerHidden: true,
    ruleIds: [901, 902], addLocked: false, tableLocked: false };
  assertUpgradeOptionsView(view);
  for (const change of [v=>v.versionText='v5.4.14', v=>v.state='failed', v=>v.state='missing',
    v=>v.bannerHidden=false, v=>v.ruleIds=[], v=>v.ruleIds=[901],
    v=>v.addLocked=true, v=>v.tableLocked=true]) {
    const broken = structuredClone(view);change(broken);
    assert.throws(() => assertUpgradeOptionsView(broken));
  }
});

test('a healthy Options view remains read-only during Focus and must unlock before native editing', () => {
  const view = { versionText: `v${expectedVersion}`, state: 'ready', bannerHidden: true,
    ruleIds: [901, 902], addLocked: false, tableLocked: false, focusLocked: true };
  assertUpgradeOptionsView(view);
  assert.throws(() => assertUpgradeOptionsEditing(view), /Focus/);
  assertUpgradeOptionsEditing({ ...view, focusLocked: false });
  assert.throws(() => assertUpgradeOptionsEditing({ ...view, focusLocked: false, state: 'failed' }));
});

test('a single native Popup link opens a new Options context without navigating the retained tab',async()=>{
  const calls=[],existing=['retained','other'],expected='moz-extension://fixture/options/options.html#focus-schedule';
  const retained={context:'retained'};
  const page={async front(options){calls.push(['front',options]);}};
  let clicked=false;
  const popup={async evaluate(){return {ready:true};},async click(selector){
    calls.push(['click',selector]);clicked=true;
  }};
  const e={baseUrl:'moz-extension://fixture',options:[retained],driver:{async getAllWindowHandles(){return existing;}},
    async openPopup(){return popup;},async command(method){assert.equal(method,'browsingContext.getTree');assert.equal(clicked,true);
      return {contexts:[{context:'retained',url:expected},{context:'unrelated',url:'about:blank'},
        {context:'new-options',url:expected}]};},pageForContext(context){assert.equal(context,'new-options');return page;}};
  assert.equal(await openUpgradeOptionsFromPopup(e),page);
  assert.deepEqual(e.options,[retained,page]);
  assert.deepEqual(calls,[['click','a.focus-schedule-popup-link'],['front',{reselect:true}]]);
});

test('upgrade native-action readiness rejects a storage commit before the actual toggle finishes rendering', async () => {
  const document = new FakeDocument();
  await withExtensionEnvironment(createExtensionApi(), async () => {
    const { RulesUI } = await import('../rules/rulesUI.js');
    const ui = new RulesUI(), container = document.addElement('rules-container', 'tbody');
    const assignment = { listId: 'general', disabledByUser: false, blockingMode: 'always', schedule: null, dailyLimit: null };
    const rule = { id: 901, blockURL: 'upgrade-basic.test', category: 'social', isWhitelist: false };
    let committed = false, release;
    const response = new Promise(resolve => { release = resolve; });
    const create = (config, onToggle = () => {}) => ui.createRuleDisplayRow(rule, config, 0, () => {}, () => {}, onToggle);
    try {
      const row = create(assignment, async () => { committed = true; await response; });
      container.appendChild(row);
      assertUpgradeRuleToggle(readUpgradeRuleToggle(), true);
      const first = row.querySelector('.rule-toggle').dispatch('click');
      assert.equal(committed, true, 'the modeled storage commit precedes the pending response');
      assert.throws(() => assertUpgradeRuleToggle(readUpgradeRuleToggle(), true), /previous rule action/);
      assert.throws(() => assertUpgradeRuleToggle(readUpgradeRuleToggle(), false), /committed state/);
      release(); await first;
      assert.throws(() => assertUpgradeRuleToggle(readUpgradeRuleToggle(), false), /committed state/);
      container.replaceChildren(create({ ...assignment, disabledByUser: true }));
      assertUpgradeRuleToggle(readUpgradeRuleToggle(), false);
      const button = container.querySelector('.rule-toggle');
      button.disabled = true;
      assert.throws(() => assertUpgradeRuleToggle(readUpgradeRuleToggle(), false), /available/);
      container.replaceChildren();
      assert.throws(() => assertUpgradeRuleToggle(readUpgradeRuleToggle(), false), /rendered/);
    } finally { release(); ui.cleanup(); }
  }, { document });
});
