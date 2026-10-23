import test from 'node:test';
import assert from 'node:assert/strict';
import { popupFocusFixture } from './helpers/popupFocusFixture.js';
import { createExtensionApi, withExtensionEnvironment } from './helpers/extensionTestHarness.js';
const active = (extra={}) => ({focusActive:true,focusEndTime:Date.now()+60000,isHardcore:false,focusMode:'blacklist',...extra});
for(const value of ['', '0','241','1.5','25oops']) test(`Focus rejects ${JSON.stringify(value)} with a persistent associated field error`,async()=>{
  const f=popupFocusFixture();await f.ready();f.fields.focusDurationInput.value=value;await f.focus(f.fields.startFocusBtn);await f.c.startFocusSession();
  assert.equal(f.messages.length,0);assert.equal(f.fields.focusDurationInput.value,value);
  assert.equal(f.fields.focusDurationInput.getAttribute('aria-invalid'),'true');assert.equal(f.fields.focusDurationError.hidden,false);
  assert.equal(f.fields.focusDurationError.textContent,'focussessioninvalidduration');assert.equal(f.document.activeElement,f.fields.focusDurationInput);assert.deepEqual(f.notices,[]);
});
test('duration corrections remove only the owned error description',async()=>{
  const f=popupFocusFixture();await f.ready();f.fields.focusDurationInput.setAttribute('aria-describedby','other-help');
  f.fields.focusDurationInput.value='0';await f.focus(f.fields.startFocusBtn);await f.c.startFocusSession();
  assert.equal(f.fields.focusDurationInput.getAttribute('aria-describedby'),'other-help focus-duration-error');
  f.fields.focusDurationInput.value='25';await f.fields.focusDurationInput.dispatch('input');
  assert.equal(f.fields.focusDurationInput.getAttribute('aria-describedby'),'other-help');assert.equal(f.fields.focusDurationInput.getAttribute('aria-invalid'),null);assert.equal(f.fields.focusDurationError.hidden,true);
});
for(const kind of ['start','stop']) test(`pending ${kind} guards both actions and retains the focused button`,async()=>{
  const f=popupFocusFixture();if(kind==='stop')f.state(active());await f.ready();let release;const gate=new Promise(r=>{release=r;});f.send(()=>gate);
  const button=kind==='start'?f.fields.startFocusBtn:f.fields.stopFocusBtn;await f.focus(button);
  const first=f.c[kind==='start'?'startFocusSession':'stopFocusSession'](),duplicate=f.c.startFocusSession(),opposite=f.c.stopFocusSession();
  try{assert.equal(f.messages.length,1);assert.equal(button.getAttribute('aria-disabled'),'true');assert.equal(button.disabled,false);assert.equal(f.document.activeElement,button);assert.equal(f.fields.focusControls.getAttribute('aria-busy'),'true');assert.equal(f.fields.focusDurationInput.disabled,true);}
  finally{release({success:false});await Promise.all([first,duplicate,opposite]);}
  assert.equal(button.getAttribute('aria-disabled'),null);assert.equal(f.fields.focusControls.getAttribute('aria-busy'),null);assert.equal(f.fields.focusDurationInput.disabled,false);
});
for(const hardcore of [false,true]) test(`confirmed ${hardcore?'Hardcore':'normal'} Start has a safe visible focus target`,async()=>{
  const f=popupFocusFixture();await f.ready();f.fields.hardcoreModeCheckbox.checked=hardcore;await f.focus(f.fields.startFocusBtn);await f.c.startFocusSession();
  assert.equal(f.document.activeElement,hardcore?f.fields.focusActiveLabel:f.fields.stopFocusBtn);assert.equal(f.fields.stopFocusBtn.hidden,hardcore);
  assert.equal(f.fields.focusStartView.hidden,true);assert.equal(f.fields.focusActiveView.hidden,false);assert.equal(f.messages.length,1);
  assert.equal(f.notices.length,hardcore?0:1,'focused Hardcore text is not also a live notice');if(!hardcore)assert.ok(f.notices[0].startsWith('focussessionactivebanner'));
});
test('confirmed Stop focuses Start and announces one observed completion',async()=>{
  const f=popupFocusFixture();f.state(active());await f.ready();await f.focus(f.fields.stopFocusBtn);await f.c.stopFocusSession();
  assert.equal(f.document.activeElement,f.fields.startFocusBtn);assert.deepEqual(f.notices,['focussessionended']);
});
test('an early storage refresh transfers Start focus while the request stays guarded',async()=>{
  const f=popupFocusFixture();await f.ready();let release;const gate=new Promise(r=>{release=r;});f.send(()=>gate);await f.focus(f.fields.startFocusBtn);const pending=f.c.startFocusSession();
  try{f.state(active());await f.c.updateFocusUI();assert.equal(f.document.activeElement,f.fields.stopFocusBtn);assert.equal(f.fields.stopFocusBtn.getAttribute('aria-disabled'),'true');assert.deepEqual(f.notices,[]);await f.c.stopFocusSession();assert.equal(f.messages.length,1);}
  finally{release({success:true});await pending;}assert.equal(f.notices.length,1);
});
test('a pending transition respects a later focus choice across the storage update and reply',async()=>{
  const f=popupFocusFixture();await f.ready();let release;const gate=new Promise(r=>{release=r;});f.send(()=>gate);await f.focus(f.fields.startFocusBtn);const pending=f.c.startFocusSession();
  await f.focus(f.other);f.state(active());await f.c.updateFocusUI();release({success:true});await pending;assert.equal(f.document.activeElement,f.other);
});
test('background completion repairs disappearing Stop focus while preserving unrelated focus',async()=>{
  const f=popupFocusFixture();f.state(active());await f.ready();assert.deepEqual(f.notices,[]);await f.focus(f.fields.stopFocusBtn);f.state({});await f.c.updateFocusUI();assert.equal(f.document.activeElement,f.fields.startFocusBtn);assert.deepEqual(f.notices,['focussessionended']);
  f.state(active());await f.c.updateFocusUI();await f.focus(f.other);f.state({});await f.c.updateFocusUI();assert.equal(f.document.activeElement,f.other);
});
test('timer ticks neither enqueue notices nor focus the changing counter',async()=>{
  const f=popupFocusFixture();await f.ready();f.fields.hardcoreModeCheckbox.checked=true;await f.focus(f.fields.startFocusBtn);await f.c.startFocusSession();const count=f.notices.length;
  for(const tick of f.intervals.values()){tick();tick();}assert.equal(f.notices.length,count);assert.equal(f.document.activeElement,f.fields.focusActiveLabel);assert.notEqual(f.fields.focusActiveLabel.getAttribute('aria-describedby'),'focus-timer-display');
});
test('transport, missing reply and private backend failures produce one safe retryable notice',async()=>{
  for(const input of [{messageError:new Error('private transport')},{response:{success:false,error:'private backend'}},{response:null}]){
    const f=popupFocusFixture(input);await f.ready();await f.focus(f.fields.startFocusBtn);await f.c.startFocusSession();assert.deepEqual(f.notices,['errorupdatingrules']);assert.equal(f.fields.startFocusBtn.getAttribute('aria-disabled'),null);assert.equal(f.fields.focusDurationInput.disabled,false);
  }
});
test('pending synchronization reports the committed Stop once without retrying it',async()=>{
  const f=popupFocusFixture({response:{success:true,syncPending:true}});f.state(active());await f.ready();await f.focus(f.fields.stopFocusBtn);await f.c.stopFocusSession();assert.equal(f.messages.length,1);assert.deepEqual(f.notices,['ruleschangessavedpending']);assert.equal(f.document.activeElement,f.fields.startFocusBtn);
});
test('a failed state read retains the displayed active session, timer and rule locks',async()=>{
  const f=popupFocusFixture();f.state(active());await f.ready();const timer=f.c.focusTimerInterval;f.read(()=>{throw new Error('storage unavailable');});await f.c.updateFocusUI();
  assert.equal(f.fields.focusActiveView.hidden,false);assert.equal(f.fields.focusStartView.hidden,true);assert.equal(f.c.focusTimerInterval,timer);assert.equal(f.c.rulesContainer.classList.contains('focus-lock-active'),true);assert.deepEqual(f.notices,['errorupdatingrules']);
});
test('overlapping reads render only the newest Focus state',async()=>{
  const f=popupFocusFixture();await f.ready();let release;const gate=new Promise(r=>{release=r;});f.read(()=>gate);const first=f.c.updateFocusUI();f.read(()=>active({isHardcore:true}));await f.c.updateFocusUI();release({focusActive:false});await first;
  assert.equal(f.fields.focusActiveView.hidden,false);assert.equal(f.fields.stopFocusBtn.hidden,true);assert.equal(f.notices.length,1);
});
test('Free and Legacy keep their duration and paid-control states after pending work',async()=>{
  for(const legacy of [false,true]){const f=popupFocusFixture();f.c.isPro=false;f.c.isLegacyUser=legacy;await f.ready();assert.equal(f.fields.focusDurationInput.disabled,!legacy);await f.focus(f.fields.startFocusBtn);await f.c.startFocusSession();assert.equal(f.messages[0].duration,25);assert.equal(f.messages[0].isHardcore,false);await f.focus(f.fields.stopFocusBtn);await f.c.stopFocusSession();assert.equal(f.fields.focusDurationInput.disabled,!legacy);}
});
test('strict Focus reads reject unavailable storage while default readers retain their fallback',async()=>{
  const api=createExtensionApi();api.storage.local.get=async()=>{throw new Error('unavailable');};await withExtensionEnvironment(api,async()=>{const {getFocusSessionState}=await import('../utils/focusSession.js');assert.equal((await getFocusSessionState()).focusActive,false);await assert.rejects(getFocusSessionState({throwOnError:true}),/unavailable/);});
});
test('superseded Start never announces an unobserved activation',async()=>{
  const f=popupFocusFixture({response:{success:true,superseded:true}});await f.ready();await f.focus(f.fields.startFocusBtn);await f.c.startFocusSession();assert.deepEqual(f.notices,[]);assert.equal(f.fields.focusActiveView.hidden,true);
});
test('late action completion after disposal neither announces nor moves focus',async()=>{
  const f=popupFocusFixture();await f.ready();let release;const gate=new Promise(r=>{release=r;});f.send(()=>gate);await f.focus(f.fields.startFocusBtn);const pending=f.c.startFocusSession();f.c.focusDisposed=true;await f.focus(f.other);f.state(active());release({success:true});await pending;assert.equal(f.document.activeElement,f.other);assert.deepEqual(f.notices,[]);assert.equal((f.document.listeners.get('focusin')||[]).length,0);
});
test('losing paid access repairs focus only when its selected control becomes unavailable',async()=>{
  const f=popupFocusFixture();await f.ready();await f.focus(f.fields.focusModeSelect);f.c.isPro=false;await f.c.updateFocusUI();assert.equal(f.document.activeElement,f.fields.startFocusBtn);assert.equal(f.fields.focusDurationInput.disabled,true);await f.focus(f.other);await f.c.updateFocusUI();assert.equal(f.document.activeElement,f.other);
});
test('background Hardcore start outside the controls announces once without moving focus',async()=>{
  const f=popupFocusFixture();await f.ready();await f.focus(f.other);f.state(active({isHardcore:true}));await f.c.updateFocusUI();assert.equal(f.document.activeElement,f.other);assert.equal(f.notices.length,1);assert.ok(f.notices[0].includes('focussessionhardcore'));await f.c.updateFocusUI();assert.equal(f.notices.length,1);
});
