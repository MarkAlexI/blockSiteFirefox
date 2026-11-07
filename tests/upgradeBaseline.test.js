import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,rm,access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { baselineConfig,baselineConfigs,readUpgradeBaseline,withPreviousCheckout } from '../e2e/prepare-upgrade-baseline.mjs';

test('the Firefox upgrade matrix retains 5.4.14 and adds the actual preceding 5.6.0 runtime',()=>{
  assert.deepEqual(baselineConfigs.map(config=>config.fromVersion),['5.4.14','5.6.0']);
  assert.equal(baselineConfig,baselineConfigs[0]);
});

test('local previous-package discovery survives removal of the runner output directory',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bd-upgrade-pointer-'));
  const e2e=path.join(root,'e2e'),runtime=path.join(root,'previous-runtime');
  try{
    await mkdir(e2e);await mkdir(runtime);await mkdir(path.join(e2e,'test-results'));
    for(const name of ['prepare-upgrade-baseline.mjs','target-version.mjs','upgrade-baseline.json'])
      await writeFile(path.join(e2e,name),await readFile(new URL('../e2e/'+name,import.meta.url)));
    await writeFile(path.join(root,'manifest.json'),await readFile(new URL('../manifest.json',import.meta.url)));
    const bytes=Buffer.from(JSON.stringify({version:'5.4.14'}));
    await writeFile(path.join(runtime,'manifest.json'),bytes);
    await writeFile(path.join(root,'receipt.json'),JSON.stringify({commit:baselineConfig.commit,
      version:'5.4.14',runtimeFiles:1,files:[{path:'manifest.json',
        sha256:createHash('sha256').update(bytes).digest('hex')}]}));
    await writeFile(path.join(e2e,'upgrade-baseline.local.json'),JSON.stringify({runtime}));
    // Real Playwright cleanup was reproduced separately; its output directory
    // must not own the local preparation pointer used by the next worker.
    await rm(path.join(e2e,'test-results'),{recursive:true});
    const reader=await import(pathToFileURL(path.join(e2e,'prepare-upgrade-baseline.mjs')).href);
    const previous=await reader.readUpgradeBaseline('');
    assert.equal(previous.runtime,runtime);assert.equal(previous.manifest.version,'5.4.14');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('historical checkout works from a real shallow clone and preserves the branch on success and failure',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bd-upgrade-shallow-'));
  const origin=path.join(root,'origin'),clone=path.join(root,'clone'),source=path.join(root,'previous');
  const execute=promisify(execFile);
  const git=(args,cwd=origin)=>execute('git',args,{cwd});
  try{
    await mkdir(origin);await git(['init','--quiet']);
    await git(['config','user.name','E2E fixture']);await git(['config','user.email','fixture@example.invalid']);
    await writeFile(path.join(origin,'manifest.json'),JSON.stringify({version:'5.4.14'}));
    await git(['add','manifest.json']);await git(['commit','--quiet','-m','previous fixture']);
    const previous=(await git(['rev-parse','HEAD'])).stdout.trim();
    await writeFile(path.join(origin,'manifest.json'),JSON.stringify({version:'5.4.15'}));
    await git(['commit','--quiet','-am','current fixture']);
    const current=(await git(['rev-parse','HEAD'])).stdout.trim();
    await git(['clone','--quiet','--no-local','--depth=1',origin,clone]);
    assert.equal((await git(['rev-parse','--is-shallow-repository'],clone)).stdout.trim(),'true');
    const value=await withPreviousCheckout(clone,source,previous,async checkout=>
      JSON.parse(await readFile(path.join(checkout,'manifest.json'),'utf8')).version);
    assert.equal(value,'5.4.14');await assert.rejects(access(source));
    await assert.rejects(withPreviousCheckout(clone,source,previous,async()=>{throw new Error('controlled build failure');}),/controlled build failure/);
    await assert.rejects(access(source));
    assert.equal((await git(['rev-parse','HEAD'],clone)).stdout.trim(),current);
    assert.equal((await git(['status','--porcelain'],clone)).stdout.trim(),'');
    assert.equal((await git(['worktree','list','--porcelain'],clone)).stdout.includes(source),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('previous-package reader checks the pinned commit, version and extracted runtime bytes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bd-upgrade-reader-'));
  const runtime=path.join(root,'runtime');await mkdir(runtime);
  const bytes=Buffer.from(JSON.stringify({version:'5.4.14'}));
  const receipt={commit:baselineConfig.commit,version:'5.4.14',runtimeFiles:1,
    files:[{path:'manifest.json',sha256:createHash('sha256').update(bytes).digest('hex')}]};
  try{
    await writeFile(path.join(runtime,'manifest.json'),bytes);
    const save=value=>writeFile(path.join(root,'receipt.json'),JSON.stringify(value));
    await save(receipt);assert.equal((await readUpgradeBaseline(runtime)).manifest.version,'5.4.14');
    await save({...receipt,commit:'0'.repeat(40)});
    await assert.rejects(readUpgradeBaseline(runtime),/pinned commit/);
    await save(receipt);await writeFile(path.join(runtime,'manifest.json'),JSON.stringify({version:'5.4.14',changed:true}));
    await assert.rejects(readUpgradeBaseline(runtime),/previous runtime bytes/);
    await writeFile(path.join(runtime,'manifest.json'),JSON.stringify({version:'5.4.15'}));
    await assert.rejects(readUpgradeBaseline(runtime),/previous runtime package/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('both Firefox source packages resolve independently and cannot substitute for each other',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bd-firefox-upgrade-matrix-'));
  const runtimes={};
  try{
    for(const config of baselineConfigs) {
      const parent=path.join(root,config.fromVersion),runtime=path.join(parent,'runtime');
      await mkdir(runtime,{recursive:true});runtimes[config.fromVersion]=runtime;
      const bytes=Buffer.from(JSON.stringify({version:config.fromVersion}));
      await writeFile(path.join(runtime,'manifest.json'),bytes);
      await writeFile(path.join(parent,'receipt.json'),JSON.stringify({commit:config.commit,
        version:config.fromVersion,runtimeFiles:1,files:[{path:'manifest.json',
          sha256:createHash('sha256').update(bytes).digest('hex')}]}));
    }
    const pointerFile=path.join(root,'pointer.json');
    await writeFile(pointerFile,JSON.stringify({runtime:runtimes['5.4.14'],runtimes}));
    for(const config of baselineConfigs) {
      assert.equal((await readUpgradeBaseline(undefined,config,{env:{},pointerFile})).manifest.version,config.fromVersion);
      assert.equal((await readUpgradeBaseline(undefined,config,{env:{BD_PREVIOUS_EXTENSION_PATHS:JSON.stringify(runtimes)}})).runtime,
        runtimes[config.fromVersion]);
      const other=baselineConfigs.find(entry=>entry!==config);
      await assert.rejects(readUpgradeBaseline(runtimes[other.fromVersion],config),/pinned commit/);
    }
    const recent=baselineConfigs[1];
    await assert.rejects(readUpgradeBaseline(undefined,recent,{env:{BD_PREVIOUS_EXTENSION_PATH:runtimes['5.4.14'],
      BD_PREVIOUS_EXTENSION_PATHS:JSON.stringify({'5.4.14':runtimes['5.4.14']})}}),/missing prepared baseline 5\.6\.0/);
    await writeFile(pointerFile,JSON.stringify({runtime:runtimes['5.4.14']}));
    await assert.rejects(readUpgradeBaseline(undefined,recent,{env:{},pointerFile}),/prepare the pinned baseline 5\.6\.0/);
  }finally{await rm(root,{recursive:true,force:true});}
});
