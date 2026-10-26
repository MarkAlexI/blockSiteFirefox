import test from 'node:test';
import assert from 'node:assert/strict';
import { assertVersionUpgrade, upgradeTimezone } from '../e2e/version-upgrade.mjs';
import { expectedVersion } from '../e2e/target-version.mjs';

function sample(){
  const before={id:'fixture-id',version:'5.4.14',now:1000,__bdUpgradeToken:'durable-marker',rules:[{id:901},{id:902}],
    ruleLists:[{id:'general'},{id:'list-1'}],activeRuleListId:'general',rulesGeneration:'generation',
    ruleRevisions:{901:'r1',902:'r2'},ruleListRevisions:{general:'g1'},
    credentials:{isPro:true,isLegacyUser:false,installationDate:'2026-08-01',licenseKey:'BD-E2E-VALID-KEY'},
    settings:{debugMode:true},focusSession:{focusActive:true,focusEndTime:301000},focusSchedule:{enabled:true,revision:1},
    pendingDailyUsageRemaps:[],dailyRuleUsage:{date:'2026-10-26',usageSeconds:{'902:general':45,'902:list-1':840}},
    dnr:[{id:901},{id:902}],alarms:[{name:'end_focus_session',scheduledTime:301000},
      {name:'start_scheduled_focus',scheduledTime:3601000}]};
  const after={...structuredClone(before),version:expectedVersion,now:1100};
  const receipt={before:{id:before.id,version:before.version,pid:123,profile:'/owned/profile'},
    after:{id:after.id,version:after.version,pid:123,profile:'/owned/profile'},
    events:[{at:1050,extensionId:before.id,details:{reason:'update',previousVersion:before.version}}]};
  return {before,after,receipt};
}

test('upgrade acceptance requires a native version transition and preserved old state',()=>{
  const s=sample();assertVersionUpgrade(s.before,s.after,s.receipt);
});
for(const [name,change] of [
  ['fresh installation',s=>s.receipt.events[0].details.reason='install'],
  ['wrong previous version',s=>s.receipt.events[0].details.previousVersion='5.4.13'],
  ['same-version reload',s=>s.after.version='5.4.14'],
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
  ['lost browser blocking',s=>s.after.dnr=[]]
])test(`upgrade acceptance rejects ${name}`,()=>{
  const s=sample();change(s);assert.throws(()=>assertVersionUpgrade(s.before,s.after,s.receipt));
});

test('the preservation fixture avoids midnight without changing the host clock',()=>{
  for(const hour of [0,23])assert.equal(upgradeTimezone(Date.UTC(2026,9,26,hour)),'Etc/GMT+12');
  for(const hour of [1,12,22])assert.equal(upgradeTimezone(Date.UTC(2026,9,26,hour)),'UTC');
});
