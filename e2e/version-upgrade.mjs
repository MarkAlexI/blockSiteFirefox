import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFocusActionReadiness } from './focus-action-readiness.mjs';
import { expectedVersion } from './target-version.mjs';
import { assertUpgradeFocusCompletion } from './upgrade-focus-completion.mjs';

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

export function readUpgradeRuleToggle() {
  const button = document.querySelector('#rules-container tr[data-rule-id="901"] .rule-toggle');
  let disabled = button?.disabled === true;
  for (let node = button; node; node = node.parentNode) {
    if (node.inert === true) disabled = true;
  }
  return {
    present: Boolean(button),
    pressed: button?.getAttribute('aria-pressed') ?? null,
    pending: button?.getAttribute('aria-disabled') === 'true',
    disabled
  };
}

export function assertUpgradeRuleToggle(state, enabled) {
  assert.equal(state.present, true, 'the current rule toggle is rendered');
  assert.equal(state.pressed, String(enabled), 'the rendered toggle reflects the committed state');
  assert.equal(state.pending, false, 'the previous rule action has finished');
  assert.equal(state.disabled, false, 'the native rule action is available');
}

export function assertUpgradeDnrRules(before, after) {
  const definitions = rules => rules.map(({ priority, ...definition }) => definition);
  assert.deepEqual(definitions(after.dnr), definitions(before.dnr), 'native blocking definitions survive the update');
  // Priorities intentionally change from the old all-100 batch. Verify the
  // new policy instead of treating that deliberate field change as data loss.
  const positions = new Map(after.rules.map((rule, index) => [rule.id, index]));
  const ranked = [...after.dnr].sort((left, right) =>
    right.condition.urlFilter.length - left.condition.urlFilter.length ||
    positions.get(left.id) - positions.get(right.id));
  assert.deepEqual(ranked.map(rule => rule.priority), ranked.map((_, index) => 100 + ranked.length - index - 1),
    'updated native priorities follow longest compiled filter then first stored rule');
}

export function assertVersionUpgrade(before,after,receipt,fromVersion='5.4.14') {
  assert.equal(before.version,fromVersion);assert.equal(after.version,expectedVersion);
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
  assert.deepEqual(receipt.events.map(event=>event.details),[{reason:'update',previousVersion:fromVersion}],
    'exactly one native update event with the real previous version');
  assert.ok(receipt.events.every(event=>event.extensionId===after.id&&Number.isFinite(event.at)));
  for(const key of ['rules','ruleLists','activeRuleListId','rulesGeneration','ruleRevisions','ruleListRevisions',
    'credentials','settings','focusSession','focusSchedule','pendingDailyUsageRemaps']) {
    assert.deepEqual(after[key],before[key],key+' survives the version update');
  }
  assertUpgradeDnrRules(before, after);
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

export async function openUpgradeOptionsFromPopup(e) {
  const popup=await e.openPopup();
  await upgradeUntil(()=>popup.evaluate(readFocusActionReadiness,'stop'),v=>v.ready,'updated Popup is ready');
  const existing=new Set(await e.driver.getAllWindowHandles());
  await click(popup,'a.focus-schedule-popup-link');
  const expected=e.baseUrl+'/options/options.html#focus-schedule';
  const context=await upgradeUntil(async()=>{
    const tree=await e.command('browsingContext.getTree',{maxDepth:0});
    const candidates=tree.contexts.filter(view=>!existing.has(view.context)&&view.url===expected);
    assert.ok(candidates.length<=1,'one new Options document comes from the Popup link');
    return candidates[0]?.context;
  },Boolean,'the Popup opens a fresh Options document');
  const page=e.pageForContext(context);
  await page.front({reselect:true});
  e.options.push(page);
  return page;
}

export async function runVersionUpgrade(e,backend,{completion='stop'}={}) {
  assert.ok(['stop','alarm'].includes(completion));
  const natural=completion==='alarm', minutes=natural?1:5;
  const fromVersion=e.upgradeBaseline.receipt.version;
  const token=randomUUID();
  const rules=[{id:901,blockURL:'upgrade-basic.bd-e2e.test',redirectURL:'',category:'social',isWhitelist:false,
    assignments:[{listId:'general',disabledByUser:false,blockingMode:'always',schedule:null,dailyLimit:null}]},
  {id:902,blockURL:'upgrade-daily.bd-e2e.test',redirectURL:'',category:'social',isWhitelist:false,
    assignments:['general','list-1'].map(listId=>({listId,disabledByUser:false,blockingMode:'daily_limit',schedule:null,
      dailyLimit:{minutes:listId==='general'?1:20}}))}];
  const evidence={scenario:natural?`67-${fromVersion}`:'67',completion,scope:'native development-package version upgrade in the same profile',
    baseline:e.upgradeBaseline.receipt,stage:'seed previous version'};
  try {
    await e.seed({rules,usage:{'902:general':45,'902:list-1':840}});
    const options=await e.openOptions();await e.reconcile(options);
    await options.evaluate(async ({token,sound})=>{
      const api=globalThis.browser||globalThis.chrome;
      const {settings}=await api.storage.sync.get('settings');
      await api.storage.sync.set({settings:{...settings,debugMode:true,focusSessionSound:sound}});
      await api.storage.local.set({__bdUpgradeToken:token});
    },{token,sound:natural});
    const config=await options.evaluate(()=>{
      const start=new Date(Date.now()+3600000);
      return {enabled:true,days:[0,1,2,3,4,5,6],durationMinutes:5,
        startTime:`${String(start.getHours()).padStart(2,'0')}:${String(start.getMinutes()).padStart(2,'0')}`};
    });
    const shown=await message(options,{type:'focus_schedule_get'});
    assert.equal((await message(options,{type:'focus_schedule_save',config,revision:shown.revision})).success,true);
    const popup=await e.openPopup();
    await upgradeUntil(()=>popup.evaluate(readFocusActionReadiness,'start'),v=>v.ready,'old Focus Start ready');
    await fill(popup,'#focus-duration',String(minutes));await click(popup,'#start-focus-btn');
    evidence.before=await upgradeUntil(()=>options.evaluate(upgradeSnapshot),v=>v.focusSession.focusActive&&
      v.dnr.length===2&&v.alarms.some(a=>a.name==='end_focus_session'&&a.scheduledTime===v.focusSession.focusEndTime),
    'previous version has committed Focus and native blocking');
    assert.ok(evidence.before.focusSession.focusEndTime-evidence.before.now>minutes*60000-(natural?15000:60000)&&
      evidence.before.focusSession.focusEndTime-evidence.before.now<=minutes*60000,'real Pro custom duration was started');
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
    evidence.stage='open fresh Options before reloading the retained tab';
    evidence.retainedOptionsBeforeFresh = await backend.retainedOptionsState(options);
    assert.ok(['open', 'closed_by_browser'].includes(evidence.retainedOptionsBeforeFresh));
    // Readiness includes the real background health reply. Do this before
    // navigating the old document: its reload could otherwise release a
    // waiting worker and hide the reported update failure.
    const current=natural?await openUpgradeOptionsFromPopup(e):await e.openOptions();
    evidence.freshOptionsSource=natural?'Popup Scheduled focus link (_blank)':'direct current Options';
    await inspectOptions(current, 'fresh Options before retained-tab reload');
    if(natural) evidence.audioObservation=await backend.startAudioObservation(current);
    evidence.stage='reload the retained Options tab';
    // Native browsers may close an extension view on replacement. Record that
    // branch explicitly; never call a newly opened tab a retained-tab reload.
    evidence.retainedOptions = await backend.reloadRetainedOptions(options);
    assert.ok(['reloaded', 'closed_by_browser'].includes(evidence.retainedOptions));
    if (evidence.retainedOptions === 'reloaded') await inspectOptions(options, 'retained tab after reload');
    evidence.after=await upgradeUntil(()=>current.evaluate(upgradeSnapshot),v=>v.version===expectedVersion&&
      v.focusSession.focusActive&&v.dnr.length===2&&v.alarms.some(a=>a.name==='end_focus_session'&&
        a.scheduledTime===v.focusSession.focusEndTime),'updated version restores native Focus protection');
    evidence.native.after=await backend.identity();
    assertVersionUpgrade(evidence.before,evidence.after,{...evidence.native,events:evidence.events},fromVersion);
    // Preservation requires active Focus. Test edits only after the inherited
    // alarm completes it, or after the older baseline's real Popup Stop click.
    if(natural) {
      evidence.stage='natural completion at the preserved Focus deadline';
      await upgradeUntil(()=>current.evaluate(async()=>({now:Date.now(),
        focus:(await (globalThis.browser||chrome).storage.local.get('focusSession')).focusSession})),
      value=>value.now>=evidence.before.focusSession.focusEndTime&&!value.focus.focusActive,
      'the inherited Focus deadline expires naturally',
      Math.max(15000,evidence.before.focusSession.focusEndTime-Date.now()+15000));
      evidence.completed=await upgradeUntil(()=>current.evaluate(upgradeSnapshot),v=>!v.focusSession.focusActive&&
        v.now>=evidence.before.focusSession.focusEndTime&&v.dnr.length===1&&v.dnr[0].id===901,
      'the original native Focus deadline restores Basic protection');
      evidence.completionAudio=await upgradeUntil(backend.readCompletionAudio,audio=>{
        try {assertUpgradeFocusCompletion(evidence.before,evidence.completed,audio);return true;}catch{return false;}
      },'one completed native Focus sound after the update');
    } else {
      const currentPopup=await e.openPopup();
      await upgradeUntil(()=>currentPopup.evaluate(readFocusActionReadiness,'stop'),v=>v.ready,'updated Focus Stop ready');
      await click(currentPopup,'#stop-focus-btn');
      await upgradeUntil(()=>current.evaluate(upgradeSnapshot),v=>!v.focusSession.focusActive&&
        v.dnr.length===1&&v.dnr[0].id===901,'native UI Stop retains Basic protection');
    }
    evidence.stage='save a real rule action after update';
    const toggle = '#rules-container tr[data-rule-id="901"] .rule-toggle';
    const editPage = evidence.retainedOptions === 'reloaded' ? options : current;
    const readyToggle = async (enabled, label) => {
      evidence.ruleToggles ||= {};
      let last;
      try {
        return await upgradeUntil(async () => (last = await editPage.evaluate(readUpgradeRuleToggle)), value => {
          try { assertUpgradeRuleToggle(value, enabled); return true; } catch { return false; }
        }, label);
      } finally { evidence.ruleToggles[label] = last; }
    };
    await front(editPage);
    await inspectOptions(editPage, 'Focus editing lock released', true);
    await readyToggle(true, 'enabled rule toggle ready');
    await click(editPage, toggle);
    await upgradeUntil(()=>e.state(), value=>value.rules.find(rule=>rule.id===901)?.assignments[0]?.disabledByUser===true,
      'post-update Options toggle is committed');
    await inspectOptions(editPage, 'after disabling a rule');
    await readyToggle(false, 'disabled rule toggle ready before restoring');
    await click(editPage, toggle);
    await upgradeUntil(()=>e.state(), value=>value.rules.find(rule=>rule.id===901)?.assignments[0]?.disabledByUser===false,
      'post-update Options toggle is restored');
    await inspectOptions(editPage, 'after restoring a rule');
    await readyToggle(true, 'restored rule toggle is rendered');
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
    assertVersionUpgrade(evidence.before,evidence.after,{...evidence.native,events:evidence.events},fromVersion);
    if(natural) {
      evidence.completionAudio=await backend.readCompletionAudio();
      assertUpgradeFocusCompletion(evidence.before,evidence.completed,evidence.completionAudio);
    }
    evidence.stage='complete';
  } finally {try{await backend.evidence(evidence);}finally{await backend.removeObserver?.();}}
}
