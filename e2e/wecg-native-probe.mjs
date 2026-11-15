import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { runtimePaths } from '../tools/package-amo.js';
import { baselineConfigs, readUpgradeBaseline } from './prepare-upgrade-baseline.mjs';
import { startNativeWindowManager } from './native-window-manager.mjs';
import { By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { ExtensionHarness, poll, delay } from './fixtures.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(process.env.BD_EXTENSION_PATH || path.join(directory,'..'));
const root=path.resolve(process.env.BD_WECG_RESULTS || path.join(directory,'test-results','wecg'));
const caseId=process.env.BD_WECG_CASE || '617';
assert.ok(['617','1195'].includes(caseId),'BD_WECG_CASE must be 617 or 1195');
await mkdir(root,{recursive:true});
const currentManifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
const previous=caseId==='617' ? process.env.BD_WECG_PREVIOUS_EXTENSION_PATH ||
  (await readUpgradeBaseline(undefined,baselineConfigs.at(-1))).runtime : source;
const previousManifest=JSON.parse(await readFile(path.join(previous,'manifest.json'),'utf8'));
if(caseId==='617') assert.notEqual(previousManifest.version,currentManifest.version,'use two actual extension versions');
async function archiveRuntime() {
 const files={};
 async function add(relative){
  const location=path.join(source,relative);
  const entries=await readdir(location,{withFileTypes:true}).catch(error=>{if(error.code==='ENOTDIR')return null;throw error;});
  if(entries)for(const item of entries)await add(relative+'/'+item.name);
  else files[relative]=new Uint8Array(await readFile(location));
 }
 for(const relative of runtimePaths)await add(relative);
 await writeFile(path.join(root,'current-runtime.zip'),zipSync(files));
}
await archiveRuntime();
const A='http://wecg-parent.bd-e2e.test/page',B='http://wecg-frame.bd-e2e.test/frame';
const C='http://wecg-target.bd-e2e.test/selected/path?query=yes#fragment';
const U='http://wecg-update.bd-e2e.test/page';
const html=url=>'<html><head><title>WECG fixture</title></head><body>'+(
 String(url).includes('wecg-parent')?`<h1>Top A</h1><iframe id="cross" style="width:600px;height:220px" src="${B}"></iframe>`:
 String(url).includes('wecg-frame')?`<h1>Frame B</h1><a id="target" style="display:block;width:400px;height:45px" href="${C.replaceAll('&','&amp;')}">Block this iframe link</a>`:
 '<h1>Matching page</h1><input id="unsaved" value="original">')+
 '<script>document.documentElement.dataset.fixtureToken=String(performance.timeOrigin)+":"+Math.random()</script></body></html>';
// Explicit probes complement the main scenario inventory; CI runs each once.
const result={startedAt:new Date().toISOString(),browser:null,tests:[],
  versions:{from:previousManifest.version,to:currentManifest.version},
  method:'Native temporary development-addon update or native frame context menu; real browser events and host permissions.'};
let desktop;
const e=new ExtensionHarness({headless:false,installation:'temporary',extensionSource:previous,
 expectedVersion:previousManifest.version,verificationVersions:[previousManifest.version,currentManifest.version],fixtureHtml:html,output:root+'/firefox-native'},result);
const api=(fn,arg)=>e.probe.evaluate(fn,arg);
async function parent(fn,arg){await e.driver.setContext(firefox.Context.CHROME);try{return await e.driver.executeScript(fn,arg);}finally{await e.driver.setContext(firefox.Context.CONTENT);}}
async function events(){return parent(()=>window.__wecgNativeEvents.events);}
async function installObserver(){return parent(id=>{
 const {ExtensionActivityLog:log}=ChromeUtils.importESModule('resource://gre/modules/ExtensionActivityLog.sys.mjs');
 const view={events:[],log,id};view.listener=a=>{
  if(a.id!==id||!['runtime.onInstalled','runtime.onMessage','contextMenus.onClicked','menus.onClicked','scripting.executeScript','permissions.request'].includes(a.name))return;
  const args=a.data?.args||[];let data;
  if(a.name==='scripting.executeScript')data={target:args[0]?.target};
  else if(a.name==='runtime.onMessage')data={message:args[0],sender:args[1]&&{frameId:args[1].frameId,tabId:args[1].tab?.id,url:args[1].url}};
  else data=args;
  try{view.events.push({at:Number(a.timeStamp),type:a.type,name:a.name,data:JSON.parse(JSON.stringify(data))});}catch{}
 };log.addListener(id,view.listener);window.__wecgNativeEvents=view;
},e.id);}
async function focus(tab){await api(async t=>{await browser.tabs.update(t.id,{active:true});await browser.windows.update(t.windowId,{focused:true});},tab);}
async function identity(page){return page.evaluate(()=>({timeOrigin:performance.timeOrigin,token:document.documentElement.dataset.fixtureToken,
 value:document.getElementById('unsaved')?.value,url:location.href,visibility:document.visibilityState}));}
try{
 await e.prepare();desktop=await startNativeWindowManager(root);result.desktop=desktop.evidence;await e.launch();await parent(()=>Services.prefs.setBoolPref('focusmanager.testmode',false));
 if(caseId!=='1195'){
 const rule={id:501,blockURL:'wecg-update.bd-e2e.test',redirectURL:'',category:'social',isWhitelist:false,
  assignments:[{listId:'general',disabledByUser:false,blockingMode:'daily_limit',schedule:null,dailyLimit:{minutes:10}}]};
 await e.seed({rules:[rule],usage:{'501:general':37}});await e.reconcile(e.probe);
 const page=await e.newPage(U);const tab=await api(async url=>(await browser.tabs.query({url}))[0],U);await focus(tab);
 await page.evaluate(()=>document.getElementById('unsaved').value='retain unsaved value');
 await poll(()=>e.state(),s=>s.dailyRuleUsage.lastSample?.assignmentKeys[0]==='501:general','old version owns the visible segment');
 const before=await identity(page);const usageBeforeUpdate=(await e.state()).dailyRuleUsage.usageSeconds['501:general']||0;await installObserver();
 const installed=await e.driver.installAddon(root+'/current-runtime.zip',true);assert.equal(installed,e.id);
 const updateEvents=await poll(events,v=>v.some(x=>x.name==='runtime.onInstalled'),'native installation event');
 result.updateEvents=updateEvents;
 assert.ok(updateEvents.some(x=>x.name==='runtime.onInstalled'&&x.data[0]?.reason==='update'&&x.data[0]?.previousVersion===previousManifest.version),'real native version update, not reload/install');
 e.probe=await e.newPage(`${e.baseUrl}/index.html`);e.manifest.version=currentManifest.version;
 assert.equal(await api(()=>browser.runtime.getManifest().version),currentManifest.version);
 const after=await identity(page);const usageAfterUpdate=(await e.state()).dailyRuleUsage.usageSeconds['501:general']||0;
 result.update={before,after,tab,usageBeforeUpdate,usageAfterUpdate};assert.equal(after.timeOrigin,before.timeOrigin);assert.equal(after.token,before.token);assert.equal(after.value,before.value);
 assert.ok(usageBeforeUpdate>=37&&usageAfterUpdate>=usageBeforeUpdate,'the native update preserves the accrued budget');
 await delay(1300);
 const live=await api(id=>browser.tabs.get(id),tab.id);
 const blank=await api(windowId=>browser.tabs.create({windowId,url:'about:blank',active:true}),live.windowId);
 await focus(blank);result.update.hidden=await poll(()=>identity(page),s=>s.visibility==='hidden','retained document actually becomes hidden');
 await delay(1300);await focus(live);result.update.visible=await poll(()=>identity(page),s=>s.visibility==='visible','same document actually becomes visible');
 const resumed=await poll(()=>e.state(),s=>s.dailyRuleUsage.lastSample?.assignmentKeys.includes('501:general')&&
  s.dailyRuleUsage.lastSample.timestamp>=updateEvents[0].at,'the updated worker owns the foreground segment');
 result.update.usageBeforeVisibilityCycle=resumed.dailyRuleUsage.usageSeconds['501:general']||0;await delay(1300);
 result.update.firstCycleEvents=await events();
 // A newly activated page can prepare its programmatic observer. Check a
 // second real visibility transition separately from document preservation.
 await focus(blank);await poll(()=>identity(page),s=>s.visibility==='hidden','second hidden boundary');await delay(300);
 await focus(live);await poll(()=>identity(page),s=>s.visibility==='visible','second visible boundary');await delay(300);
 const visibilityEvents=await poll(events,v=>['hidden','visible'].every(visibility=>v.slice(result.update.firstCycleEvents.length).some(x=>
  x.name==='runtime.onMessage'&&x.data.message?.type==='daily-limit:visibility'&&x.data.message.visibilityState===visibility&&x.data.sender?.tabId===tab.id)),
  'both native visibility messages after update, without reloading the retained page');
 const usage=await poll(()=>e.state(),s=>(s.dailyRuleUsage.usageSeconds['501:general']||0)>result.update.usageBeforeVisibilityCycle,'new foreground seconds accrue after native update');
 result.update.final=await identity(page);assert.deepEqual(result.update.final,before,'the same unsaved document survives both visibility cycles');
 result.tests.push({id:'617',status:'passed',before,after,usage:usage.dailyRuleUsage,events:visibilityEvents});console.log('PASS 617 native update retained the document and restored visibility messages');
 }

 if(caseId!=='617'){
 await installObserver();
 await api(async()=>{for(const t of await browser.tabs.query({}))if(!t.url.startsWith(browser.runtime.getURL('')))await browser.tabs.remove(t.id);});
 await e.seed();await e.reconcile(e.probe);
 result.menuSetup=await api(()=>browser.runtime.sendMessage({type:'pro_status_changed'}));
 const top=await e.newPage(A);const target=await api(async url=>(await browser.tabs.query({url}))[0],A);await focus(target);
 await poll(()=>top.evaluate(()=>document.getElementById('cross')?.contentWindow!==null),Boolean,'cross-origin iframe exists');
 const frames=await api(id=>browser.scripting.executeScript({target:{tabId:id,allFrames:true},func:()=>({url:location.href,top:window===window.top})}),target.id);
 const child=frames.find(x=>x.result.url===B);assert.ok(child&&child.frameId>0);
 result.frames=frames;
 const menuTitle=await api(()=>browser.i18n.getMessage('blockthat'));
 const permissionChange=await parent(async({id,origin})=>{
  const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
  const extension=WebExtensionPolicy.getByID(id).extension;
  await ExtensionPermissions.remove(id,{permissions:[],origins:['*://*/*']},extension);
  await ExtensionPermissions.add(id,{permissions:[],origins:[origin]},extension);
  return {allowedOrigins:extension.allowedOrigins.patterns.map(p=>p.pattern)};
 },{id:e.id,origin:'http://wecg-target.bd-e2e.test/*'});
 result.permissionChange=permissionChange;
 const denied=await api(async({id,frameId,origin})=>{
  const allowed=await browser.permissions.contains({origins:[origin]});
  try{await browser.scripting.executeScript({target:{tabId:id,frameIds:[frameId]},func:()=>document.title});return {allowed,denied:false};}
  catch(error){return {allowed,denied:true,error:error.message};}
 },{id:target.id,frameId:child.frameId,origin:'http://wecg-frame.bd-e2e.test/*'});
 result.denied=denied;assert.equal(denied.allowed,false);assert.equal(denied.denied,true,'native cross-origin frame injection is denied');
 await focus(target);await top.front();
 await e.driver.switchTo().frame(await e.driver.findElement(By.id('cross')));
 await e.driver.actions().contextClick(await e.driver.findElement(By.id('target'))).perform();await e.driver.switchTo().defaultContent();
 await e.driver.setContext(firefox.Context.CHROME);
 try{
  const menu=await poll(()=>e.driver.executeScript(()=>({state:document.getElementById('contentAreaContextMenu')?.state,
   items:[...document.querySelectorAll('#contentAreaContextMenu menuitem')].filter(x=>!x.hidden).map(x=>({id:x.id,label:x.label}))})),s=>s.state==='open','native link context menu opens');
  result.menu=menu;
  const item=await poll(()=>e.driver.executeScript(label=>[...document.querySelectorAll('#contentAreaContextMenu menuitem')].find(x=>!x.hidden&&x.label===label),menuTitle),Boolean,'native extension menu item ready');
  assert.ok(item,'BlockDistraction native menu item');result.clickWatermark=(await e.driver.executeScript(()=>window.__wecgNativeEvents.events)).length;
  await item.click();
 }finally{await e.driver.setContext(firefox.Context.CONTENT);}
 const state=await poll(()=>e.state(),s=>s.rules.length===1,'native menu saved a rule');
 assert.equal(state.rules[0].blockURL,'wecg-target.bd-e2e.test/selected/path');
 const afterClick=(await events()).slice(result.clickWatermark);result.afterClick=afterClick;
 assert.ok(afterClick.some(x=>['contextMenus.onClicked','menus.onClicked'].includes(x.name)&&x.data[0]?.linkUrl===C&&x.data[0]?.frameId===child.frameId));
 assert.equal(afterClick.some(x=>x.name==='scripting.executeScript'),false,'context-menu action needs no DOM injection');
 assert.equal(afterClick.some(x=>x.name==='permissions.request'),false,'context-menu action needs no extra grant');
 assert.equal(await top.url(),A,'the parent stays on its own URL');
 const blocked=await e.assertBlocked(C);result.blocked=await blocked.url();
 result.tests.push({id:'1195',status:'passed',denied,rule:state.rules[0],events:afterClick,blocked:result.blocked});
 console.log('PASS 1195 native iframe context menu blocked linkUrl while frame scripting was denied');
 }
 result.status='passed';result.browserErrors=e.pageErrors;result.fixtureErrors=e.networkErrors;
 assert.deepEqual(e.pageErrors,[]);assert.deepEqual(e.networkErrors,[]);
}catch(error){result.status='failed';result.error={message:error.message,stack:error.stack};console.error(error.stack);process.exitCode=1;}
finally{
 result.finishedAt=new Date().toISOString();await writeFile(root+'/firefox-native-'+caseId+'-results.json',JSON.stringify(result,null,2)+'\n');
 try{await e.close();}finally{await desktop?.close();}
}
