import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import firefox from 'selenium-webdriver/firefox.js';
import { expectedVersion } from './target-version.mjs';
import { baselineConfigs,readUpgradeBaseline } from './prepare-upgrade-baseline.mjs';
import { runVersionUpgrade, upgradeTimezone } from './version-upgrade.mjs';
import { installUpgradeObserver, readUpgradeObserver, removeUpgradeObserver, firefoxUpgradeIdentity } from './upgrade-probes.mjs';
import { installSoundObservation,readSoundObservation } from './sound-observation.mjs';
import { installFocusCompletionObserver,readFocusCompletionObserver,removeFocusCompletionObserver } from './upgrade-focus-completion.mjs';

const parent=async(e,fn,arg)=>{
  await e.driver.setContext(firefox.Context.CHROME);
  try{return await e.driver.executeScript(fn,arg);}finally{await e.driver.setContext(firefox.Context.CONTENT);}
};

export const upgradeScenarios=baselineConfigs.map((baseline,index)=>({
  id:index===0?'67':`67-${baseline.fromVersion}`,upgrade:true,persistent:true,nativeDesktop:true,timeout:120000,
  title:`native ${baseline.fromVersion} to current version update preserves paid state, Focus and spent Daily Limit`,
  prepare:async e=>{
    assert.ok(!process.env.BD_SIGNED_XPI,'this development-package update scenario requires both unsigned runtime packages');
    e.upgradeBaseline=await readUpgradeBaseline(undefined,baseline);
    e.config.extensionSource=e.upgradeBaseline.runtime;e.config.expectedVersion=baseline.fromVersion;
    e.config.verificationVersions=[baseline.fromVersion,expectedVersion];
    e.timezone=upgradeTimezone();
  },
  run:async e=>{
    const natural=index!==0;
    let audioPage;
    const readAudio=async()=>({alarms:await parent(e,readFocusCompletionObserver),
      sound:await audioPage.evaluate(readSoundObservation)});
    const current=path.resolve(process.env.BD_EXTENSION_PATH||fileURLToPath(new URL('..',import.meta.url)));
    await runVersionUpgrade(e,{
      identity:()=>parent(e,firefoxUpgradeIdentity,e.id),
      installObserver:async()=>{
        await parent(e,installUpgradeObserver,e.id);
        if(natural)await parent(e,installFocusCompletionObserver,e.id);
      },
      update:()=>e.installUpdatedRuntime(current),
      events:()=>parent(e,readUpgradeObserver),
      retainedOptionsState:async page=>(await e.driver.getAllWindowHandles()).includes(page.context)?'open':'closed_by_browser',
      startAudioObservation:async page=>{
        audioPage=page;
        return page.evaluate(installSoundObservation);
      },
      readCompletionAudio:readAudio,
      reloadRetainedOptions:async page=>{
        const handles=await e.driver.getAllWindowHandles();
        if(!handles.includes(page.context))return 'closed_by_browser';
        await e.command('browsingContext.reload',{context:page.context,wait:'complete'});
        e.options.push(page);
        return 'reloaded';
      },
      removeObserver:async()=>{
        try {
          if(audioPage) {
            try {
              e.result.upgradeFocusAudio=await readAudio();
              await writeFile(path.join(e.config.output,'upgrade-focus-audio.json'),JSON.stringify(e.result.upgradeFocusAudio,null,2)+'\n');
            } finally {await audioPage.evaluate(()=>{
              window.__bdSoundObservation?.restore();delete window.__bdSoundObservation;
            });}
          }
        } finally {
          try {if(natural)await parent(e,removeFocusCompletionObserver);}
          finally {await parent(e,removeUpgradeObserver);}
        }
      },
      evidence:async value=>{
        e.result.upgrade=value;
        await writeFile(path.join(e.config.output,'native-version-upgrade.json'),JSON.stringify(value,null,2)+'\n');
      }
    },{completion:natural?'alarm':'stop'});
  }
}));
