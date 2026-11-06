import assert from 'node:assert/strict';

// Passive native delivery in the parent process survives replacement of the
// extension's old event page. It never dispatches or reschedules an alarm.
export function installFocusCompletionObserver(id) {
  if(window.__bdUpgradeFocusObserver)throw new Error('Focus completion observer already installed');
  const {ExtensionActivityLog}=ChromeUtils.importESModule('resource://gre/modules/ExtensionActivityLog.sys.mjs');
  const record={id,alarms:[],errors:[],logger:ExtensionActivityLog};
  record.listener=activity=>{
    if(activity.id!==id||activity.type!=='api_event'||activity.name!=='alarms.onAlarm'||activity.viewType!=='background')return;
    try {
      const alarm=activity.data.args[0];
      if(alarm.name!=='end_focus_session')return;
      record.alarms.push({at:Number(activity.timeStamp),extensionId:activity.id,
        alarm:{name:alarm.name,scheduledTime:alarm.scheduledTime}});
    }catch(error){record.errors.push(String(error));}
  };
  ExtensionActivityLog.addListener(id,record.listener);window.__bdUpgradeFocusObserver=record;
}

export function readFocusCompletionObserver() {
  const record=window.__bdUpgradeFocusObserver;
  if(!record||!record.logger.listeners.get(record.id)?.has(record.listener))throw new Error('Native Focus observer disappeared');
  if(record.errors.length)throw new Error(record.errors.join('; '));
  return JSON.parse(JSON.stringify(record.alarms));
}

export function removeFocusCompletionObserver() {
  const record=window.__bdUpgradeFocusObserver;if(!record)return;
  record.logger.removeListener(record.id,record.listener);delete window.__bdUpgradeFocusObserver;
}

// This case keeps its current Options view open. It observes native Firefox
// Web Audio in the event page; it is not an idle-wake or speaker-volume test.
export function assertUpgradeFocusCompletion(before,completed,audio) {
  const deadline=before.focusSession.focusEndTime;
  assert.equal(before.settings.focusSessionSound,true);
  assert.ok(completed.now>=deadline,'the inherited Focus deadline expires naturally');
  assert.equal(completed.focusSession.focusActive,false);
  assert.equal(completed.alarms.some(alarm=>alarm.name==='end_focus_session'),false);
  assert.deepEqual(completed.dnr.map(rule=>rule.id),[901],'Basic protection remains after Focus');
  assert.deepEqual(completed.dailyRuleUsage.usageSeconds,before.dailyRuleUsage.usageSeconds);
  assert.deepEqual(completed.rules,before.rules);
  assert.equal(completed.settings.focusSessionSound,true);
  assert.equal(audio.alarms.length,1,'one native completion alarm was delivered across the update');
  assert.equal(audio.alarms[0].extensionId,before.id);
  assert.ok(Number.isFinite(audio.alarms[0].at));
  assert.deepEqual(audio.alarms[0].alarm,{name:'end_focus_session',scheduledTime:deadline});
  assert.equal(audio.sound.backend,'Firefox native Web Audio graph');
  assert.deepEqual(audio.sound.errors,[]);
  assert.equal(audio.sound.contexts.length,1,'one native AudioContext, with no duplicate playback');
  const context=audio.sound.contexts[0];
  assert.ok(context.startedAt>=deadline-1000,'the update itself must not play the completion sound');
  assert.equal(context.gains,2);
  assert.equal(context.ended,2,'both native note-ended events arrived');
  assert.ok(context.peak>0.001,'the native analyser measured a non-silent signal');
  assert.equal(context.closed,true,'native audio resources were released');
  for(const stage of ['resume:resolved','close:begin','close:resolved']) {
    assert.equal(context.timeline.filter(item=>item.stage===stage).length,1,stage+' happened once');
  }
  assert.equal(context.timeline.filter(item=>item.stage==='oscillator:ended').length,2);
  const times=context.timeline.map(item=>item.audioTime).filter(Number.isFinite);
  assert.ok(times.length>=2&&times.at(-1)>times[0],'the native audio clock advanced');
}
