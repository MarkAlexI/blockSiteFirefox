// Alarm delivery and a committed Focus stop can be observed before the queued
// scheduled-alarm handler finishes arming the next occurrence.
export function overdueFocusSettled(snapshot) {
  const alarmFired = name => snapshot.events.some(event => event.type === 'alarm' && event.value.name === name);
  return snapshot.focusSession.focusActive === false && !snapshot.dnr.length &&
    alarmFired('end_focus_session') && alarmFired('start_scheduled_focus') &&
    !snapshot.alarms.some(alarm => alarm.name === 'end_focus_session') &&
    snapshot.alarms.some(alarm => alarm.name === 'start_scheduled_focus' && alarm.scheduledTime > snapshot.now);
}
