import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFocusActionReadiness } from './focus-action-readiness.mjs';
import { expectedVersion } from './target-version.mjs';

// Keep this preservation scenario away from a legitimate local-day rollover.
export const upgradeTimezone = (at=Date.now()) => [0,23].includes(new Date(at).getUTCHours()) ? 'Etc/GMT+12' : 'UTC';

export async function upgradeUntil(read,check,label,timeout=15000) {
  const end=Date.now()+timeout;
  let value;
  do { value=await read();if(check(value))return value;await new Promise(r=>setTimeout(r,100)); }
  while(Date.now()<end);
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}

export async function upgradeSnapshot() {
  const api=globalThis.browser||globalThis.chrome;
  const local=await api.storage.local.get(['rules','ruleLists','activeRuleListId','rulesGeneration',
    'ruleRevisions','ruleListRevisions','focusSession','focusSchedule','dailyRuleUsage','pendingDailyUsageRemaps','__bdUpgradeToken']);
  const sync=await api.storage.sync.get(['credentials','settings']);
  return {...local,...sync,id:api.runtime.id,version:api.runtime.getManifest().version,
    alarms:await api.alarms.getAll(),dnr:(await api.declarativeNetRequest.getDynamicRules()).sort((a,b)=>a.id-b.id),now:Date.now()};
}

// Read the rendered view, not just storage: a preserved database can coexist
// with an unusable Options tab after an update.
export function readUpgradeOptionsView() {
  return {
    versionText: document.getElementById('ext-version')?.textContent || '',
    state: window.bdOptionsRecovery?.state || 'missing',
    bannerHidden: document.getElementById('options-recovery')?.hidden === true,
    ruleIds: [...document.querySelectorAll('#rules-container tr[data-rule-id]')]
      .map(row => Number(row.dataset.ruleId)).sort((a, b) => a - b),
    addLocked: !document.getElementById('add-rule') ||
      document.getElementById('add-rule').inert === true || document.getElementById('add-rule').disabled === true,
    tableLocked: !document.getElementById('rules-table') || document.getElementById('rules-table').inert === true,
    focusLocked: Boolean(document.getElementById('rules-table')?.closest('.focus-lock-active')),
    recovery: window.bdOptionsRecovery?.getReport?.() || null
  };
}

export function assertUpgradeOptionsView(view) {
  assert.ok(view.versionText.includes(expectedVersion), 'current Options version is rendered');
  assert.equal(view.state, 'ready', 'Options bootstrap and its reads are ready');
  assert.equal(view.bannerHidden, true, 'no recovery warning remains');
  assert.deepEqual(view.ruleIds, [901, 902], 'both saved General rules are actually rendered');
  assert.equal(view.addLocked, false, 'recovery releases its Add rule lock');
  assert.equal(view.tableLocked, false, 'recovery releases its table lock');
}

export function assertUpgradeOptionsEditing(view) {
  assertUpgradeOptionsView(view);
  assert.equal(view.focusLocked, false, 'Focus must release its editing lock before a native rule action');
}

export function assertVersionUpgrade(before,after,receipt) {
  assert.equal(before.version,'5.4.14');assert.equal(after.version,expectedVersion);
  assert.notEqual(before.version,after.version);
  assert.equal(after.id,before.id,'same installed extension');
  assert.equal(receipt.before.profile,receipt.after.profile,'same native profile');
  assert.equal(receipt.before.pid,receipt.after.pid,'upgrade does not restart the browser');
  assert.ok(Number.isInteger(receipt.before.pid)&&receipt.before.pid>0);
  for (const [identity,state] of [[receipt.before,before],[receipt.after,after]]) {
    assert.equal(identity.id,state.id);assert.equal(identity.version,state.version);
  }
  if(receipt.before.installDate!==undefined)assert.equal(receipt.after.installDate,receipt.before.installDate);
  if(receipt.after.temporary!==undefined)assert.equal(receipt.after.temporary,false);
  assert.ok(before.__bdUpgradeToken);assert.equal(after.__bdUpgradeToken,before.__bdUpgradeToken,'old durable state survives');
  assert.deepEqual(receipt.events.map(event=>event.details),[{reason:'update',previousVersion:'5.4.14'}],
    'exactly one native update event with the real previous version');
  assert.ok(receipt.events.every(event=>event.extensionId===after.id&&Number.isFinite(event.at)));
  for(const key of ['rules','ruleLists','activeRuleListId','rulesGeneration','ruleRevisions','ruleListRevisions',
    'credentials','settings','focusSession','focusSchedule','pendingDailyUsageRemaps','dnr']) {
    assert.deepEqual(after[key],before[key],key+' survives the version update');
  }
  assert.equal(before.credentials.isPro,true);assert.equal(before.credentials.isLegacyUser,false);
  assert.equal(before.settings.debugMode,true,'non-default setting distinguishes preservation from reset');
  assert.equal(before.focusSession.focusActive,true);
  assert.ok(before.focusSession.focusEndTime>after.now,'the original Focus deadline remains future');
  assert.equal(after.alarms.find(a=>a.name==='end_focus_session')?.scheduledTime,before.focusSession.focusEndTime);
  assert.equal(after.alarms.find(a=>a.name==='start_scheduled_focus')?.scheduledTime,
    before.alarms.find(a=>a.name==='start_scheduled_focus')?.scheduledTime);
  assert.ok(after.alarms.some(a=>a.name==='start_scheduled_focus'&&a.scheduledTime>after.now));
  assert.deepEqual(after.dailyRuleUsage.usageSeconds,before.dailyRuleUsage.usageSeconds,'spent usage is not reset');
  assert.equal(after.dailyRuleUsage.date,before.dailyRuleUsage.date,'preservation fixture stays in one local day');
  assert.equal(before.dailyRuleUsage.usageSeconds['902:general'],45);
  assert.equal(after.dailyRuleUsage.usageSeconds['902:list-1'],840);
}

const message=(page,input)=>page.evaluate(input=>(globalThis.browser||globalThis.chrome).runtime.sendMessage(input),input);
const click=(page,selector)=>page.locator?page.locator(selector).click():page.click(selector);
const fill=(page,selector,value)=>page.locator?page.locator(selector).fill(value):page.fill(selector,value);
const front=page=>page.bringToFront?page.bringToFront():page.front();

export async function runVersionUpgrade(e,backend) {
  const token=randomUUID();
  const rules=[{id:901,blockURL:'upgrade-basic.bd-e2e.test',redirectURL:'',category:'social',isWhitelist:false,
    assignments:[{listId:'general',disabledByUser:false,blockingMode:'always',schedule:null,dailyLimit:null}]},
  {id:902,blockURL:'upgrade-daily.bd-e2e.test',redirectURL:'',category:'social',isWhitelist:false,
    assignments:['general','list-1'].map(listId=>({listId,disabledByUser:false,blockingMode:'daily_limit',schedule:null,
      dailyLimit:{minutes:listId==='general'?1:20}}))}];
  const evidence={scenario:'67',scope:'native development-package version upgrade in the same profile',
    baseline:e.upgradeBaseline.receipt,stage:'seed previous version'};
  try {
    await e.seed({rules,usage:{'902:general':45,'902:list-1':840}});
    const options=await e.openOptions();await e.reconcile(options);
    await options.evaluate(async token=>{
      const api=globalThis.browser||globalThis.chrome;
      const {settings}=await api.storage.sync.get('settings');
      await api.storage.sync.set({settings:{...settings,debugMode:true}});
      await api.storage.local.set({__bdUpgradeToken:token});
    },token);
    const config=await options.evaluate(()=>{
      const start=new Date(Date.now()+3600000);
      return {enabled:true,days:[0,1,2,3,4,5,6],durationMinutes:5,
        startTime:`${String(start.getHours()).padStart(2,'0')}:${String(start.getMinutes()).padStart(2,'0')}`};
    });
    const shown=await message(options,{type:'focus_schedule_get'});
    assert.equal((await message(options,{type:'focus_schedule_save',config,revision:shown.revision})).success,true);
    const popup=await e.openPopup();
    await upgradeUntil(()=>popup.evaluate(readFocusActionReadiness,'start'),v=>v.ready,'old Focus Start ready');
    await fill(popup,'#focus-duration','5');await click(popup,'#start-focus-btn');
    evidence.before=await upgradeUntil(()=>options.evaluate(upgradeSnapshot),v=>v.focusSession.focusActive&&
      v.dnr.length===2&&v.alarms.some(a=>a.name==='end_focus_session'&&a.scheduledTime===v.focusSession.focusEndTime),
    'previous version has committed Focus and native blocking');
    assert.ok(evidence.before.focusSession.focusEndTime-evidence.before.now>240000&&
      evidence.before.focusSession.focusEndTime-evidence.before.now<=300000,'real Pro custom duration was started');
    // Keep a non-extension document alive through replacement of old views.
    const keeper=await e.newPage('http://upgrade-control.bd-e2e.test/keeper');await front(keeper);
    evidence.native={before:await backend.identity()};
    evidence.stage='native version update';
    await backend.installObserver();
    await backend.update();
    evidence.events=await upgradeUntil(backend.events,events=>events.length>0,'native version-update event');
    evidence.optionsViews = {};
    const inspectOptions = async (page, label, editable = false) => {
      let last;
      try {
        return await upgradeUntil(async () => (last = await page.evaluate(readUpgradeOptionsView)), view => {
          try {
            (editable ? assertUpgradeOptionsEditing : assertUpgradeOptionsView)(view);
            return true;
          } catch { return false; }
        }, label);
      } finally { evidence.optionsViews[label] = last; }
    };
    evidence.stage='reload the retained Options tab';
    // Native browsers may close an extension view on replacement. Record that
    // branch explicitly; never call a newly opened tab a retained-tab reload.
    evidence.retainedOptions = await backend.reloadRetainedOptions(options);
    assert.ok(['reloaded', 'closed_by_browser'].includes(evidence.retainedOptions));
    if (evidence.retainedOptions === 'reloaded') await inspectOptions(options, 'retained tab after reload');
    evidence.stage='open current Options';
    const current=await e.openOptions();
    await inspectOptions(current, 'fresh Options');
    evidence.after=await upgradeUntil(()=>current.evaluate(upgradeSnapshot),v=>v.version===expectedVersion&&
      v.focusSession.focusActive&&v.dnr.length===2&&v.alarms.some(a=>a.name==='end_focus_session'&&
        a.scheduledTime===v.focusSession.focusEndTime),'updated version restores native Focus protection');
    evidence.native.after=await backend.identity();
    assertVersionUpgrade(evidence.before,evidence.after,{...evidence.native,events:evidence.events});
    // The preservation assertions above deliberately require active Focus.
    // Stop it through the real Popup before testing edits blocked by Focus.
    const currentPopup=await e.openPopup();
    await upgradeUntil(()=>currentPopup.evaluate(readFocusActionReadiness,'stop'),v=>v.ready,'updated Focus Stop ready');
    await click(currentPopup,'#stop-focus-btn');
    await upgradeUntil(()=>current.evaluate(upgradeSnapshot),v=>!v.focusSession.focusActive&&
      v.dnr.length===1&&v.dnr[0].id===901,'native UI Stop retains Basic protection');
    evidence.stage='save a real rule action after update';
    const toggle = '#rules-container tr[data-rule-id="901"] .rule-toggle';
    const editPage = evidence.retainedOptions === 'reloaded' ? options : current;
    await front(editPage);
    await inspectOptions(editPage, 'Focus editing lock released', true);
    await click(editPage, toggle);
    await upgradeUntil(()=>e.state(), value=>value.rules.find(rule=>rule.id===901)?.assignments[0]?.disabledByUser===true,
      'post-update Options toggle is committed');
    await inspectOptions(editPage, 'after disabling a rule');
    await click(editPage, toggle);
    await upgradeUntil(()=>e.state(), value=>value.rules.find(rule=>rule.id===901)?.assignments[0]?.disabledByUser===false,
      'post-update Options toggle is restored');
    await inspectOptions(editPage, 'after restoring a rule');
    await inspectOptions(current, 'fresh Options sees restored rule');
    assert.deepEqual((await e.state()).rules, evidence.before.rules, 'the UI control restores the original rules');
    evidence.stage='native remaining-budget control';
    const foreground=await e.newPage('http://upgrade-daily.bd-e2e.test/remaining');await front(foreground);
    evidence.foreground=await upgradeUntil(()=>current.evaluate(upgradeSnapshot),v=>
      v.dailyRuleUsage.lastSample?.assignmentKeys.includes('902:general')&&
      v.alarms.some(a=>a.name==='daily_limit_deadline'&&a.scheduledTime>v.now),'post-update native deadline');
    assert.ok(evidence.foreground.dailyRuleUsage.usageSeconds['902:general']>=45);
    assert.ok(evidence.foreground.dailyRuleUsage.usageSeconds['902:general']<60);
    evidence.exhausted=await upgradeUntil(()=>current.evaluate(upgradeSnapshot),v=>
      v.dailyRuleUsage.usageSeconds['902:general']>=60&&v.dnr.some(rule=>rule.id===902),
    'only the remaining awake budget is consumed',30000);
    assert.equal(evidence.exhausted.dailyRuleUsage.usageSeconds['902:list-1'],840);
    await e.assertBlocked('http://upgrade-daily.bd-e2e.test/blocked','daily_limit');
    await e.assertBlocked('http://upgrade-basic.bd-e2e.test/blocked');
    evidence.events=await backend.events();
    assertVersionUpgrade(evidence.before,evidence.after,{...evidence.native,events:evidence.events});
    evidence.stage='complete';
  } finally {try{await backend.evidence(evidence);}finally{await backend.removeObserver?.();}}
}
