import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
import { getLocalDateKey } from '../rules/dailyLimitManager.js';

const TEST_FIREFOX_ANDROID = true;
let workerImportId = 0;

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeFocusRule(id, listId, { blockURL = null, isWhitelist = false } = {}) {
  return {
    id,
    blockURL: blockURL || `${listId}-${id}.example`,
    redirectURL: '',
    category: isWhitelist ? 'whitelist' : 'social',
    isWhitelist,
    assignments: [{
      listId: isWhitelist ? 'general' : listId,
      disabledByUser: false,
      blockingMode: 'always',
      schedule: null,
      dailyLimit: null
    }]
  };
}

function makeDailyLimitRule(id, listId, { blockURL = null, minutes = 10 } = {}) {
  const rule = makeFocusRule(id, listId, { blockURL });
  rule.assignments[0].blockingMode = 'daily_limit';
  rule.assignments[0].dailyLimit = { minutes };
  return rule;
}

function sendWorkerMessage(listener, message) {
  return new Promise((resolve, reject) => {
    if (listener(message, {}, resolve) !== true) {
      reject(new Error('Worker did not keep its response channel open: ' + message.type));
    }
  });
}

async function withWorker(callback, {
  credentials = {},
  settings = {},
  local = {},
  dnrLimits = {},
  supportsWindows = !TEST_FIREFOX_ANDROID
} = {}) {
  const api = createExtensionApi({
    sync: {
      settings: { mode: 'normal', debugMode: false, focusSessionSound: false, ...settings },
      credentials: {
        isPro: true,
        licenseKey: 'BD-OLD-KEY',
        installationDate: '2026-08-01T00:00:00.000Z',
        isLegacyUser: false,
        ...credentials
      }
    },
    local: {
      rules: [],
      ruleLists: [
        { id: 'general', name: 'General', disabledCategories: [] },
        { id: 'list-1', name: 'Study', disabledCategories: [] }
      ],
      activeRuleListId: 'list-1',
      dailyRuleUsage: { version: 2, date: getLocalDateKey(), usageSeconds: {}, lastSample: null },
      focusSession: {
        focusActive: false,
        focusEndTime: 0,
        isHardcore: false,
        focusMode: 'blacklist'
      },
      ...local
    }
  });

  for (const areaName of ['local', 'sync']) {
    const area = api.storage[areaName];
    const originalSet = area.set.bind(area);
    area.set = async (values, callback) => {
      const previous = structuredClone(area.data);
      await originalSet(values, callback);
      const changes = Object.fromEntries(Object.keys(values)
        .filter(key => JSON.stringify(previous[key]) !== JSON.stringify(area.data[key]))
        .map(key => [key, { oldValue: previous[key], newValue: structuredClone(area.data[key]) }]));
      if (Object.keys(changes).length) api.storage.onChanged.emit(changes, areaName);
    };
  }

  api.runtime.onStartup = createEvent();
  api.runtime.onInstalled = createEvent();
  api.runtime.onMessage = createEvent();
  api.tabs.onUpdated = createEvent();
  api.tabs.onActivated = createEvent();
  api.tabs.onCreated = createEvent();
  api.tabs.get = async id => api.tabs.values.find(tab => tab.id === id) || { id };
  api.contextMenuPresent = false;
  api.contextMenuDetails = null;
  api.contextMenus = {
    onClicked: createEvent(),
    remove(_id, callback) {
      api.contextMenuPresent = false;
      api.contextMenuDetails = null;
      callback?.();
    },
    create(details, callback) {
      api.contextMenuPresent = true;
      api.contextMenuDetails = structuredClone(details);
      callback?.();
    }
  };
  api.alarmValues = new Map();
  api.alarms = {
    onAlarm: createEvent(),
    get(name, callback) {
      const alarm = api.alarmValues.get(name);
      callback?.(alarm);
      return Promise.resolve(alarm);
    },
    create(name, details) {
      api.alarmValues.set(name, { name, ...details });
      return Promise.resolve();
    },
    clear(name) {
      api.alarmValues.delete(name);
      return Promise.resolve(true);
    }
  };
  api.permissions = {
    onAdded: createEvent(),
    onRemoved: createEvent(),
    contains: async () => true,
    getAll: async () => ({
      data_collection: ['authenticationInfo', 'technicalAndInteraction']
    })
  };
  api.dynamicRules = [];
  api.dnrUpdates = [];
  api.declarativeNetRequest = {
    ...dnrLimits,
    getDynamicRules: async () => structuredClone(api.dynamicRules),
    updateDynamicRules: async update => {
      api.dnrUpdates.push(structuredClone(update));
      const removed = new Set(update.removeRuleIds || []);
      api.dynamicRules = api.dynamicRules.filter(rule => !removed.has(rule.id));
      api.dynamicRules.push(...structuredClone(update.addRules || []));
    }
  };
  api.notificationsCreated = [];
  api.notifications = {
    create(id, details) {
      api.notificationsCreated.push({ id, details });
    }
  };
  if (supportsWindows) {
    api.windows = {
      WINDOW_ID_NONE: -1,
      onFocusChanged: createEvent()
    };
  }

  let fetchHandler = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ isPro: true })
  });
  api.setFetchHandler = handler => {
    fetchHandler = handler;
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (...args) => fetchHandler(...args);
  try {
    await withExtensionEnvironment(api, async () => {
      workerImportId += 1;
      await import('../scripts/service_worker.js?workerStateRegression=' + workerImportId);
      assert.equal(api.runtime.onMessage.listeners.length, 1);
      if (!supportsWindows) assert.equal(api.windows, undefined);
      ProManager=(await import('../pro/proManager.js')).ProManager;
      const closeTabsModule = await import('../scripts/closeTabs.js');
      closeTabsMatchingRules = closeTabsModule.closeTabsMatchingRules;
      closeNonWhitelistedTabs = closeTabsModule.closeNonWhitelistedTabs;
      await new Promise(resolve=>setImmediate(resolve));
      await callback({
        api,
        send: message => sendWorkerMessage(api.runtime.onMessage.listeners[0], message),
        alarm: alarm => api.alarms.onAlarm.listeners[0](alarm),
        startup: () => api.runtime.onStartup.listeners[0]()
      });
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

let ProManager;
let closeTabsMatchingRules;
let closeNonWhitelistedTabs;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,label){for(let i=0;i<1000;i++){if(predicate())return;await tick();}throw new Error(label);}
const inactive={focusActive:false,focusEndTime:0,isHardcore:false,focusMode:'blacklist'};
import {createDnrSynchronizer} from '../scripts/dnrSynchronizer.js';
import {createSpaNavigationEnforcer} from '../scripts/spaNavigationEnforcer.js';
test('metadata migration preserves a concurrent successful license activation', {timeout:5000}, async () => {
  await withWorker(async ({api, send}) => {
    delete api.storage.sync.data.credentials.isLegacyUser;
    const captured = createDeferred();
    const release = createDeferred();
    const originalGet = api.storage.sync.get.bind(api.storage.sync);
    const originalMetadata = ProManager.initializeInstallationMetadata;
    let captureNext = false;
    ProManager.initializeInstallationMetadata = async function(...args) {
      captureNext = true;
      return originalMetadata.apply(this, args);
    };
    api.storage.sync.get = async (keys, callback) => {
      const snapshot = await originalGet(keys, callback);
      if (captureNext && Array.isArray(keys) && keys.includes('credentials')) {
        captureNext = false;
        captured.resolve();
        await release.promise;
      }
      return snapshot;
    };
    try {
      const update = api.runtime.onInstalled.listeners[0]({reason:'update'});
      await captured.promise;
      const activationPromise = send({type:'activate_pro_license',licenseKey:'BD-NEW-VALID-KEY'});
      for(let i=0;i<10;i++)await tick();
      release.resolve();
      const [,activation]=await Promise.all([update,activationPromise]);
      assert.equal(activation.success,true);
      assert.equal(api.storage.sync.data.credentials.isPro,true);
      assert.equal(api.storage.sync.data.credentials.licenseKey,'BD-NEW-VALID-KEY');

    } finally {
      release.resolve();
      ProManager.initializeInstallationMetadata = originalMetadata;
      api.storage.sync.get = originalGet;
    }
  }, {credentials:{isPro:false,licenseKey:null},local:{activeRuleListId:'general'}});
});

test('startup usage migration preserves accounting from a concurrent tab event', {timeout:5000}, async () => {
  const rule=makeDailyLimitRule(21,'general',{blockURL:'usage.example',minutes:20});
  await withWorker(async({api,send,startup})=>{
    api.tabs.values=[{id:10,url:'https://usage.example/page',active:true}];
    api.scripting={executeScript:async()=>[{result:{visibilityState:'visible',hidden:false,hasFocus:true}}]};
    const captured=createDeferred();const release=createDeferred();
    const originalGet=api.storage.local.get.bind(api.storage.local);let hold=true;
    api.storage.local.get=async(keys,callback)=>{
      const snapshot=await originalGet(keys,callback);
      if(hold&&keys==='dailyRuleUsage'){
        hold=false;captured.resolve();await release.promise;
      }
      return snapshot;
    };
    const start=startup();await captured.promise;
    const tabEvent=api.tabs.onUpdated.listeners[0](10,{url:'https://usage.example/page'},api.tabs.values[0]);
    for(let i=0;i<10;i++)await tick();
    release.resolve();await Promise.all([start,tabEvent]);
    const after=structuredClone(api.storage.local.data.dailyRuleUsage.usageSeconds);
    assert.ok(after['21:general']>=849,JSON.stringify(after));

  },{local:{activeRuleListId:'general',lastCheck:Date.now(),rules:[rule],dailyRuleUsage:{version:1,date:getLocalDateKey(),usageSeconds:{'21':840},lastSample:{timestamp:Date.now()-10000,ruleId:21}}}});
});

test('deleting a rule invalidates its pending SPA redirect', {timeout:5000}, async () => {
  await withWorker(async ({api,send}) => {
    api.tabs.values=[{id:10,url:'https://stale.example/page',active:false},{id:11,url:'https://safe.example',active:true}];
    const captured=createDeferred();const release=createDeferred();
    const originalGet=api.tabs.get;
    api.tabs.get=async id=>{
      const snapshot=structuredClone(api.tabs.values.find(tab=>tab.id===id));
      captured.resolve();await release.promise;return snapshot;
    };
    try {
      const navigation=api.tabs.onUpdated.listeners[0](10,{url:'https://stale.example/page'},api.tabs.values[0]);
      await captured.promise;
      assert.equal((await send({type:'rules:delete',payload:{ruleId:21}})).success,true);
      assert.equal(api.storage.local.data.rules.length,0);
      assert.equal(api.dynamicRules.length,0);
      release.resolve();await navigation;
      assert.equal(api.updatedTabs.length,0);

    } finally {release.resolve();api.tabs.get=originalGet;}
  }, {local:{activeRuleListId:'general',rules:[makeFocusRule(21,'general',{blockURL:'stale.example'})]}});
});

test('bulk tab closure preserves a tab that navigated to a safe URL', {timeout:5000}, async () => {
  await withWorker(async ({api})=>{
    api.tabs.values=[{id:10,url:'https://stale.example/page',windowId:1,active:true}];
    const captured=createDeferred();const release=createDeferred();
    const originalCreate=api.tabs.create;
    api.tabs.create=async details=>{captured.resolve();await release.promise;return originalCreate(details);};
    const closure=closeTabsMatchingRules(['stale.example']);
    await captured.promise;
    api.tabs.values[0].url='https://safe.example/important-document';
    release.resolve();await closure;
    assert.deepEqual(api.removedTabs,[]);

  });
});

test('a paid rule commits before the next queued logout writes Free credentials', {timeout:5000}, async () => {
  await withWorker(async ({api,send})=>{
    const captured=createDeferred();const release=createDeferred();
    const originalGet=api.declarativeNetRequest.getDynamicRules;
    let hold=true;
    api.declarativeNetRequest.getDynamicRules=async()=>{
      if(hold){hold=false;captured.resolve();await release.promise;}
      return originalGet();
    };
    const addition=send({type:'rules:add',payload:{blockURL:'paid.example',redirectURL:'',category:'social',assignment:{listId:'general',blockingMode:'daily_limit',dailyLimit:{minutes:10}}}});
    await captured.promise;
    const originalSet=api.storage.sync.set.bind(api.storage.sync);
    api.storage.sync.set=(values,callback)=>{
      if(values.credentials?.isPro===false)assert.equal(api.storage.local.data.rules.length,1,'paid rule must commit before logout');
      return originalSet(values,callback);
    };
    const logoutPromise=send({type:'logout_pro'});
    for(let i=0;i<10;i++)await tick();
    release.resolve();const [added,logout]=await Promise.all([addition,logoutPromise]);
    assert.equal(logout.success,true);
    assert.equal(added.success,true);
    assert.equal(api.storage.local.data.rules[0].assignments[0].blockingMode,'daily_limit');

  },{local:{activeRuleListId:'general'}});
});

test('every DNR caller receives the final tail failure', {timeout:5000}, async()=>{
  let rules=[{id:1,blockURL:'first.example'}];let applied=[];let fail=false;
  const captured=createDeferred();const release=createDeferred();let firstReport=true;
  const synchronizer=createDnrSynchronizer({
    getRules:async()=>structuredClone(rules),getFocusSessionState:async()=>inactive,
    isRuleActiveNow:()=>true,
    createDnrRule:async(id,blockURL)=>({id,priority:1,action:{type:'redirect',redirect:{url:'https://blocked.example/'}},condition:{urlFilter:blockURL,resourceTypes:['main_frame']}}),
    closeTabsMatchingRules:async()=>{},
    declarativeNetRequest:{getDynamicRules:async()=>structuredClone(applied),updateDynamicRules:async patch=>{if(fail)throw new Error('late DNR failure');const ids=new Set(patch.removeRuleIds);applied=applied.filter(rule=>!ids.has(rule.id)).concat(patch.addRules);}},
    logger:{log(){},info(){},warn(){},error(){}},
    onSyncResult:async()=>{if(firstReport){firstReport=false;captured.resolve();await release.promise;}}
  });
  const first=synchronizer.requestSync();await captured.promise;
  rules=[];fail=true;const second=synchronizer.requestSync();
  release.resolve();const [firstResult,secondResult]=await Promise.all([first,second]);
  assert.equal(firstResult.success,false);assert.equal(secondResult.success,false);
  assert.equal((await synchronizer.inspectState()).inSync,false);

});

test('SPA checks never reuse identity across an A-B-A navigation', {timeout:5000}, async()=>{
  const old=createDeferred();const latest=createDeferred();const updates=[];
  let aCalls=0;let url='https://a.example';
  const enforcer=createSpaNavigationEnforcer({tabsApi:{get:async()=>({id:1,url}),update:async(_id,details)=>updates.push(details.url)},resolveNavigation:async observed=>{
    if(observed==='https://b.example')return null;
    aCalls++;return aCalls===1?old.promise:latest.promise;
  }});
  const first=enforcer.enforce(1,'https://a.example');
  url='https://b.example';await enforcer.enforce(1,'https://b.example');
  url='https://a.example';const third=enforcer.enforce(1,'https://a.example');
  old.resolve({redirectUrl:'https://old-blocked.example'});
  assert.equal((await first).status,'superseded');
  latest.resolve(null);await third;
  assert.deepEqual(updates,[]);

});

test('worker import reports a tail DNR failure and restores previous rules', {timeout:5000}, async()=>{
  await withWorker(async({api,send})=>{
    const captured=createDeferred();const release=createDeferred();
    const originalSet=api.storage.local.set.bind(api.storage.local);let hold=true;
    api.storage.local.set=async(values,callback)=>{
      if(hold&&values.diagnosticState?.lastDnrSync?.changed===true){
        hold=false;captured.resolve();await release.promise;
      }
      return originalSet(values,callback);
    };
    api.runtime.onMessage.listeners[0]({type:'reload_rules'},{},()=>{});
    await captured.promise;
    assert.equal(api.dynamicRules.length,1);
    api.declarativeNetRequest.updateDynamicRules=async()=>{throw new Error('import DNR rejected');};
    const importing=send({type:'rules:replaceAll',payload:{rules:[makeFocusRule(22,'general',{blockURL:'new-import.example'})]}});
    await until(()=>api.storage.local.data.rules[0]?.blockURL==='new-import.example','import local commit');
    release.resolve();const response=await importing;
    assert.equal(response.success,false);
    assert.equal(response.error.code,'import_sync_failed');
    assert.equal(api.storage.local.data.rules[0].blockURL,'old-rule.example');
    assert.match(api.dynamicRules[0].condition.urlFilter,/old-rule/);

    await tick();
  },{local:{activeRuleListId:'general',rules:[makeFocusRule(21,'general',{blockURL:'old-rule.example'})]}});
});

test('concurrent rule additions preserve both rules with distinct IDs', {timeout:5000}, async()=>{
  await withWorker(async({api,send})=>{
    const responses=await Promise.all(['one.example','two.example'].map(blockURL=>send({type:'rules:add',payload:{blockURL,redirectURL:'',category:'social',assignment:{listId:'general',blockingMode:'always'}}})));
    assert.ok(responses.every(response=>response.success));
    assert.equal(api.storage.local.data.rules.length,2);
    assert.equal(new Set(api.storage.local.data.rules.map(rule=>rule.id)).size,2);

  },{local:{activeRuleListId:'general'}});
});

test('storage events invalidate SPA decisions made in another extension page', { timeout: 5000 }, async () => {
  await withWorker(async ({ api }) => {
    const url = 'https://stale.example/page';
    api.tabs.values = [{ id: 10, url, active: false }];
    const captured = createDeferred();
    const release = createDeferred();
    api.tabs.get = async id => {
      captured.resolve();
      await release.promise;
      return { id, url };
    };
    const navigation = api.tabs.onUpdated.listeners[0](10, { url }, api.tabs.values[0]);
    await captured.promise;
    await api.storage.local.set({ rules: [] });
    release.resolve();
    await navigation;
    assert.deepEqual(api.updatedTabs, []);
    assert.deepEqual(api.storage.local.data.rules, []);
  }, { local: { activeRuleListId: 'general', rules: [makeFocusRule(21, 'general', { blockURL: 'stale.example' })] } });
});

test('storage changes during DNR work refresh the drain without closing tabs from an old snapshot', { timeout: 5000 }, async () => {
  await withWorker(async ({ api }) => {
    api.tabs.values = [{ id: 10, url: 'https://stale.example/page', active: false }];
    const captured = createDeferred();
    const release = createDeferred();
    const originalGet = api.declarativeNetRequest.getDynamicRules;
    let first = true;
    api.declarativeNetRequest.getDynamicRules = async () => {
      if (first) {
        first = false;
        captured.resolve();
        await release.promise;
      }
      return originalGet();
    };
    api.runtime.onMessage.listeners[0]({ type: 'reload_rules' }, {}, () => {});
    await captured.promise;
    await api.storage.local.set({ rules: [] });
    release.resolve();
    await until(() => api.dnrUpdates.length === 2 && api.storage.local.data.diagnosticState?.lastDnrSync?.success === true, 'fresh DNR drain');
    assert.deepEqual(api.dynamicRules, []);
    assert.deepEqual(api.removedTabs, []);
  }, { local: { activeRuleListId: 'general', rules: [makeFocusRule(21, 'general', { blockURL: 'stale.example' })] } });
});

test('Whitelist batch closure rechecks a tab that navigated to an allowed page', { timeout: 5000 }, async () => {
  await withWorker(async ({ api }) => {
    api.tabs.values = [{ id: 10, url: 'https://blocked.example/page', windowId: 1, active: true }];
    const captured = createDeferred();
    const release = createDeferred();
    const originalCreate = api.tabs.create;
    api.tabs.create = async details => {
      captured.resolve();
      await release.promise;
      return originalCreate(details);
    };
    const closure = closeNonWhitelistedTabs([makeFocusRule(21, 'general', { blockURL: 'allowed.example', isWhitelist: true })]);
    await captured.promise;
    api.tabs.values[0].url = 'https://allowed.example/important-document';
    release.resolve();
    await closure;
    assert.deepEqual(api.removedTabs, []);
  });
});

test('single-tab Whitelist enforcement checks the current URL after awaited rule reads', { timeout: 5000 }, async () => {
  await withWorker(async ({ api }) => {
    const observedUrl = 'https://blocked.example/page';
    api.tabs.values = [{ id: 10, url: observedUrl, active: false }];
    const captured = createDeferred();
    const release = createDeferred();
    const originalGet = api.storage.local.get.bind(api.storage.local);
    let first = true;
    api.storage.local.get = async (keys, callback) => {
      const snapshot = await originalGet(keys);
      if (first && keys === 'rules') {
        first = false;
        captured.resolve();
        await release.promise;
      }
      callback?.(snapshot);
      return snapshot;
    };
    const navigation = api.tabs.onUpdated.listeners[0](10, { url: observedUrl }, api.tabs.values[0]);
    await captured.promise;
    api.tabs.values[0].url = 'https://allowed.example/important-document';
    release.resolve();
    await navigation;
    assert.deepEqual(api.removedTabs, []);
    assert.deepEqual(api.updatedTabs, []);
  }, { local: {
    activeRuleListId: 'general',
    rules: [makeFocusRule(21, 'general', { blockURL: 'allowed.example', isWhitelist: true })],
    focusSession: { focusActive: true, focusEndTime: Date.now() + 600000, isHardcore: false, focusMode: 'whitelist' }
  } });
});

test('a queued paid rule is rejected after logout, while a basic Free rule still succeeds', { timeout: 5000 }, async () => {
  await withWorker(async ({ api, send }) => {
    const logout = send({ type: 'logout_pro' });
    const paidRule = send({ type: 'rules:add', payload: {
      blockURL: 'paid.example', redirectURL: '', category: 'social',
      assignment: { listId: 'general', blockingMode: 'daily_limit', dailyLimit: { minutes: 10 } }
    } });
    const [loggedOut, paid] = await Promise.all([logout, paidRule]);
    assert.equal(loggedOut.success, true);
    assert.equal(paid.success, false);
    assert.equal(paid.error.code, 'pro_required');
    assert.deepEqual(api.storage.local.data.rules, []);
    const basic = await send({ type: 'rules:add', payload: { blockURL: 'basic.example', redirectURL: '', category: 'social' } });
    assert.equal(basic.success, true);
    assert.equal(api.storage.local.data.rules.length, 1);
  }, { local: { activeRuleListId: 'general' } });
});
