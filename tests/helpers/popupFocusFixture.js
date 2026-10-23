import { readFileSync } from 'node:fs';
import { FakeDocument } from './extensionTestHarness.js';
const source = readFileSync(new URL('../../popup.js', import.meta.url), 'utf8');
const begin = source.indexOf('  async initFocusSession('), end = source.indexOf('\n  logRulesMutationFailure(', begin);
if (begin < 0 || end < begin) throw new Error('Missing Popup Focus methods');
export function popupFocusFixture({ response = { success: true }, messageError, refreshError } = {}) {
  const document = new FakeDocument(); document.activeElement = document.body;
  const create = (id, tag, parent) => { const el = document.createElement(tag); el.id = id; parent.appendChild(el); return el; };
  const section = document.addElement('focus-session-section'), controls = create('focus-controls','div',section);
  const start = create('focus-start-view','div',controls), active = create('focus-active-view','div',controls);
  const fields = { focusSection: section, focusControls: controls, focusStartView: start, focusActiveView: active };
  for (const [key,id,tag,parent] of [
    ['focusDurationInput','focus-duration','input',start], ['focusDurationError','focus-duration-error','p',start],
    ['focusProNote','focus-pro-note','small',start], ['focusModeControl','focus-mode-control','div',start],
    ['hardcoreModeControl','hardcore-mode-control','div',start], ['startFocusBtn','start-focus-btn','button',start],
    ['focusActiveLabel','focus-active-label','p',active], ['focusHardcoreDescription','focus-hardcore-description','p',active],
    ['focusTimerDisplay','focus-timer-display','div',active], ['stopFocusBtn','stop-focus-btn','button',active]
  ]) fields[key] = create(id,tag,parent);
  fields.focusModeSelect = create('focus-mode-select','select',fields.focusModeControl);
  fields.hardcoreModeCheckbox = create('focus-hardcore-mode','input',fields.hardcoreModeControl);
  fields.focusDurationInput.value = '25'; fields.focusModeSelect.value = 'blacklist'; fields.focusDurationError.hidden = true;
  active.classList.add('hidden');
  const notices=[],messages=[],errors=[],timers=new Map(),intervals=new Map(); let next=0,reads=0,read,send;
  let state={focusActive:false,focusEndTime:0,isHardcore:false,focusMode:'blacklist'};
  const api={runtime:{async sendMessage(message){
    messages.push(structuredClone(message)); if(send)return send(message); if(messageError)throw messageError;
    if(response?.success&&!response.superseded)state=message.type==='start_focus_session'
      ? {focusActive:true,focusEndTime:Date.now()+message.duration*60000,isHardcore:message.isHardcore,focusMode:message.focusMode}
      : {focusActive:false,focusEndTime:0,isHardcore:false,focusMode:'blacklist'};
    return response;
  }}};
  const deps={document,chrome:api,browser:api,t:key=>key,customAlert:message=>notices.push(message),
    getFocusSessionState:async()=>{reads++;if(refreshError)throw refreshError;return read?read():structuredClone(state);},
    setInterval:fn=>{intervals.set(++next,fn);return next;},clearInterval:id=>intervals.delete(id),
    setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)};
  const C=new Function(...Object.keys(deps),`return class PopupFocus {${source.slice(begin,end)}}`)(...Object.values(deps));
  const c=new C(); Object.assign(c,fields,{isPro:true,isLegacyUser:false,rulesContainer:document.addElement('rules-container'),
    logger:{error:(...args)=>errors.push(args),info:(...args)=>errors.push(args)}});
  document.addElement('controls').classList.add('controls'); const other=document.addElement('options-link','button');
  return {c,controller:c,document,fields,other,notices,alerts:notices,messages,errors,timers,intervals,
    get reads(){return reads;},get refreshes(){return reads;},
    state:value=>{state={focusActive:false,focusEndTime:0,isHardcore:false,focusMode:'blacklist',...value};},
    read:fn=>{read=fn;},send:fn=>{send=fn;},
    async focus(node){node.focus();await document.dispatch('focusin',{target:node});},
    async ready(){await c.initFocusSession();return c;}};
}
