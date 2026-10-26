import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import firefox from 'selenium-webdriver/firefox.js';
import { expectedVersion } from './target-version.mjs';
import { readUpgradeBaseline } from './prepare-upgrade-baseline.mjs';
import { runVersionUpgrade, upgradeTimezone } from './version-upgrade.mjs';
import { installUpgradeObserver, readUpgradeObserver, removeUpgradeObserver, firefoxUpgradeIdentity } from './upgrade-probes.mjs';

const parent=async(e,fn,arg)=>{
  await e.driver.setContext(firefox.Context.CHROME);
  try{return await e.driver.executeScript(fn,arg);}finally{await e.driver.setContext(firefox.Context.CONTENT);}
};

export const upgradeScenarios=[{id:'67',persistent:true,nativeDesktop:true,timeout:120000,
  title:'native 5.4.14 to current version update preserves paid state, Focus and spent Daily Limit',
  prepare:async e=>{
    assert.ok(!process.env.BD_SIGNED_XPI,'this development-package update scenario requires both unsigned runtime packages');
    e.upgradeBaseline=await readUpgradeBaseline();
    e.config.extensionSource=e.upgradeBaseline.runtime;e.config.expectedVersion='5.4.14';
    e.config.verificationVersions=['5.4.14',expectedVersion];
    e.timezone=upgradeTimezone();
  },
  run:async e=>{
    const current=path.resolve(process.env.BD_EXTENSION_PATH||fileURLToPath(new URL('..',import.meta.url)));
    await runVersionUpgrade(e,{
      identity:()=>parent(e,firefoxUpgradeIdentity,e.id),
      installObserver:()=>parent(e,installUpgradeObserver,e.id),
      update:()=>e.installUpdatedRuntime(current),
      events:()=>parent(e,readUpgradeObserver),
      removeObserver:()=>parent(e,removeUpgradeObserver),
      evidence:async value=>{
        e.result.upgrade=value;
        await writeFile(path.join(e.config.output,'native-version-upgrade.json'),JSON.stringify(value,null,2)+'\n');
      }
    });
  }
}];
