import test from 'node:test';
import assert from 'node:assert/strict';
import { createFocusScheduleController } from '../schedules/focusScheduleController.js';
import { defaultFocusSchedule } from '../schedules/focusSchedule.js';
import { overdueFocusSettled } from '../e2e/overdue-observation.mjs';

const observed = now => ({ now,focusSession:{focusActive:false},dnr:[],alarms:[],
  events:['end_focus_session','start_scheduled_focus'].map(name=>({type:'alarm',value:{name}})) });

test('a real schedule controller can still be arming after the old overdue observation succeeds', async () => {
  const now = new Date(2026,9,26,11,43,3).getTime();
  const data = {focusSchedule:{...defaultFocusSchedule(),enabled:true,days:[0,1,2,3,4,5,6],
    startTime:'11:42',durationMinutes:1,notBefore:now-120000}};
  const before = structuredClone(data);
  const alarms = new Map();
  let release, entered;
  const waiting = new Promise(resolve=>{entered=resolve;});
  const blocked = new Promise(resolve=>{release=resolve;});
  const controller = createFocusScheduleController({
    storage:{get:async()=>structuredClone(data),set:async values=>Object.assign(data,structuredClone(values))},
    alarms:{get:async name=>alarms.get(name),clear:async name=>alarms.delete(name),
      create:async(name,value)=>{entered();await blocked;alarms.set(name,{name,scheduledTime:value.when});}},
    getAccess:async()=>({isPro:true}),getSession:async()=>({focusActive:false}),
    startSession:async()=>assert.fail('expired occurrence must not start'),runExclusive:fn=>fn(),now:()=>now
  });
  const operation = controller.reconcile();
  try {
    await waiting;
    const snapshot = observed(now);
    assert.equal(snapshot.focusSession.focusActive===false && !snapshot.dnr.length &&
      snapshot.events.length===2,true,'the old E2E condition has already succeeded');
    assert.equal(overdueFocusSettled(snapshot),false,'native delivery is earlier than rearming');
  } finally { release(); }
  await operation;
  assert.deepEqual(data,before,'a missed occurrence neither claims nor changes the schedule');
  const settled = {...observed(now),alarms:[...alarms.values()]};
  assert.equal(overdueFocusSettled(settled),true);
  assert.equal(settled.alarms[0].scheduledTime,new Date(2026,9,27,11,42).getTime());
});

test('overdue acceptance still rejects missing or expired next alarms and an unfinished Focus stop', () => {
  const good = {...observed(1000),alarms:[{name:'start_scheduled_focus',scheduledTime:2000}]};
  assert.equal(overdueFocusSettled(good),true);
  for (const change of [s=>s.alarms=[],s=>s.alarms[0].scheduledTime=999,
    s=>s.focusSession.focusActive=true,s=>s.dnr.push({id:901}),s=>s.events.pop(),
    s=>s.alarms.push({name:'end_focus_session',scheduledTime:900})]) {
    const state = structuredClone(good); change(state); assert.equal(overdueFocusSettled(state),false);
  }
});
