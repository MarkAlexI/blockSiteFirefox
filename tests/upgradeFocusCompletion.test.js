import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assertUpgradeFocusCompletion,installFocusCompletionObserver,readFocusCompletionObserver,
  removeFocusCompletionObserver } from '../e2e/upgrade-focus-completion.mjs';

function sample() {
  const before={id:'fixture-id',focusSession:{focusActive:true,focusEndTime:61000},settings:{focusSessionSound:true},
    rules:[{id:901},{id:902}],dailyRuleUsage:{usageSeconds:{'902:general':45,'902:list-1':840}}};
  const completed={...structuredClone(before),now:61050,focusSession:{focusActive:false},alarms:[],dnr:[{id:901}]};
  const audio={alarms:[{extensionId:before.id,at:61001,alarm:{name:'end_focus_session',scheduledTime:61000}}],
    sound:{backend:'Firefox native Web Audio graph',errors:[],contexts:[{
      gains:2,ended:2,peak:0.6,closed:true,startedAt:61010,timeline:[
        {stage:'resume:begin',audioTime:0},{stage:'resume:resolved',audioTime:0},
        {stage:'oscillator:ended',audioTime:0.35},{stage:'oscillator:ended',audioTime:0.82},
        {stage:'close:begin',audioTime:0.84},{stage:'close:resolved',audioTime:0.84}]}]}};
  return {before,completed,audio};
}

test('Firefox upgrade completion requires its inherited alarm, two ended notes, native signal and resource closure',()=>{
  const s=sample();assertUpgradeFocusCompletion(s.before,s.completed,s.audio);
});

for(const [name,change] of [
  ['early completion',s=>s.completed.now=60000],
  ['still active Focus',s=>s.completed.focusSession.focusActive=true],
  ['leftover completion alarm',s=>s.completed.alarms=[{name:'end_focus_session'}]],
  ['lost Basic protection',s=>s.completed.dnr=[]],
  ['reset spent limit',s=>s.completed.dailyRuleUsage.usageSeconds['902:general']=0],
  ['changed saved rules',s=>s.completed.rules=[]],
  ['lost sound preference',s=>s.completed.settings.focusSessionSound=false],
  ['missing native alarm',s=>s.audio.alarms=[]],
  ['duplicate native alarm',s=>s.audio.alarms.push(structuredClone(s.audio.alarms[0]))],
  ['another extension alarm',s=>s.audio.alarms[0].extensionId='other'],
  ['changed alarm deadline',s=>s.audio.alarms[0].alarm.scheduledTime++],
  ['another audio backend',s=>s.audio.sound.backend='Chromium native offscreen contexts'],
  ['failed native playback',s=>s.audio.sound.errors.push('resume rejected')],
  ['missing native audio graph',s=>s.audio.sound.contexts=[]],
  ['duplicate playback',s=>s.audio.sound.contexts.push(structuredClone(s.audio.sound.contexts[0]))],
  ['sound before completion',s=>s.audio.sound.contexts[0].startedAt=10000],
  ['missing native note',s=>s.audio.sound.contexts[0].gains=1],
  ['missing ended event',s=>s.audio.sound.contexts[0].ended=1],
  ['silent output',s=>s.audio.sound.contexts[0].peak=0],
  ['unreleased AudioContext',s=>s.audio.sound.contexts[0].closed=false],
  ['unsettled close promise',s=>s.audio.sound.contexts[0].timeline.pop()],
  ['missing ended timeline',s=>s.audio.sound.contexts[0].timeline.splice(2,1)],
  ['frozen native clock',s=>s.audio.sound.contexts[0].timeline.forEach(item=>{item.audioTime=0;})]
]) test(`Firefox upgrade completion rejects ${name}`,()=>{
  const s=sample();change(s);assert.throws(()=>assertUpgradeFocusCompletion(s.before,s.completed,s.audio));
});

function observer() {
  const listeners=new Map();
  const logger={listeners,addListener(id,fn){listeners.set(id,new Set([fn]));},
    removeListener(id,fn){listeners.get(id)?.delete(fn);}};
  const realm=vm.createContext({window:{},ChromeUtils:{importESModule:()=>({ExtensionActivityLog:logger})}});
  const invoke=(fn,arg)=>vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`,realm);
  invoke(installFocusCompletionObserver,'target');
  return {invoke,logger,listener:[...listeners.get('target')][0]};
}

test('native completion observer retains owned alarm delivery and duplicates without dispatching an event',()=>{
  const o=observer();
  const event={id:'target',type:'api_event',name:'alarms.onAlarm',viewType:'background',timeStamp:61001,
    data:{args:[{name:'end_focus_session',scheduledTime:61000}]}};
  for(const change of [{id:'other'},{type:'api_call'},{viewType:'popup'},{name:'runtime.onInstalled'},
    {data:{args:[{name:'other',scheduledTime:61000}]}}])o.listener({...event,...change});
  assert.equal(o.invoke(readFocusCompletionObserver).length,0);
  o.listener(event);o.listener(event);
  assert.deepEqual(JSON.parse(JSON.stringify(o.invoke(readFocusCompletionObserver))),Array(2).fill({
    at:61001,extensionId:'target',alarm:{name:'end_focus_session',scheduledTime:61000}}));
  o.invoke(removeFocusCompletionObserver);assert.equal(o.logger.listeners.get('target').size,0);
  assert.throws(()=>o.invoke(readFocusCompletionObserver),/observer disappeared/);
});

test('malformed native alarm evidence is a failure rather than an empty successful observation',()=>{
  const o=observer();
  o.listener({id:'target',type:'api_event',name:'alarms.onAlarm',viewType:'background',data:{}});
  assert.throws(()=>o.invoke(readFocusCompletionObserver));
});
