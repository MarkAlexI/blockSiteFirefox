// Privileged parent-process observation only. No extension listener, event
// dispatch, response substitution or runtime source modification is involved.
export function installUpgradeObserver(id) {
  if(window.__bdUpgradeObserver)throw new Error('Upgrade observer already installed');
  const {ExtensionActivityLog}=ChromeUtils.importESModule('resource://gre/modules/ExtensionActivityLog.sys.mjs');
  const record={id,events:[],errors:[],logger:ExtensionActivityLog};
  record.listener=activity=>{
    if(activity.id!==id||activity.type!=='api_event'||activity.name!=='runtime.onInstalled'||activity.viewType!=='background')return;
    try{
      const details=activity.data.args[0];
      record.events.push({at:Number(activity.timeStamp),extensionId:activity.id,
        details:{reason:details.reason,previousVersion:details.previousVersion}});
    }catch(error){record.errors.push(String(error));}
  };
  ExtensionActivityLog.addListener(id,record.listener);window.__bdUpgradeObserver=record;
}

export function readUpgradeObserver() {
  const r=window.__bdUpgradeObserver;
  if(!r||!r.logger.listeners.get(r.id)?.has(r.listener))throw new Error('Native upgrade observer disappeared');
  if(r.errors.length)throw new Error(r.errors.join('; '));
  return JSON.parse(JSON.stringify(r.events));
}

export function removeUpgradeObserver() {
  const r=window.__bdUpgradeObserver;if(!r)return;
  r.logger.removeListener(r.id,r.listener);delete window.__bdUpgradeObserver;
}

export async function firefoxUpgradeIdentity(id) {
  const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const addon=await AddonManager.getAddonByID(id);
  return {pid:Services.appinfo.processID,
    profile:Services.dirsvc.get('ProfD',Components.interfaces.nsIFile).path,
    id:addon.id,version:addon.version,installDate:addon.installDate.getTime(),temporary:addon.temporarilyInstalled};
}
