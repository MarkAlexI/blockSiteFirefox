import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedVersion } from './target-version.mjs';

const execute = promisify(execFile);
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory);
export const baselineConfigs = JSON.parse(await readFile(path.join(directory,'upgrade-baseline.json'),'utf8'));
assert.ok(Array.isArray(baselineConfigs) && baselineConfigs.length > 0);
assert.equal(new Set(baselineConfigs.map(config=>config.fromVersion)).size,baselineConfigs.length);
for(const config of baselineConfigs) {
  assert.match(config.commit,/^[0-9a-f]{40}$/,'immutable previous commits');
  assert.match(config.fromVersion,/^\d+\.\d+\.\d+$/);
  Object.freeze(config.packageArgs);Object.freeze(config);
}
Object.freeze(baselineConfigs);
export const baselineConfig = baselineConfigs[0];

export async function withPreviousCheckout(repository,source,commit,action) {
  assert.match(commit,/^[0-9a-f]{40}$/,'an immutable previous commit is required');
  const git=args=>execute('git',args,{cwd:repository,timeout:60000,maxBuffer:4*1024*1024});
  try {await git(['cat-file','-e',commit+'^{tree}']);}
  catch {await git(['fetch','--no-tags','--depth=1','origin',commit]);}
  // Unlike cloning a shallow repository, a worktree can directly use the
  // explicitly fetched historical object without depending on branch refs.
  await git(['worktree','add','--quiet','--detach',source,commit]);
  try {return await action(source);}
  finally {await git(['worktree','remove','--force',source]);}
}

export async function readUpgradeBaseline(runtimeOverride,config=baselineConfig,
  {env=process.env,pointerFile=path.join(directory,'upgrade-baseline.local.json')}={}) {
  assert.ok(baselineConfigs.includes(config),'a pinned upgrade baseline is required');
  let selected=runtimeOverride;
  if(selected===undefined) {
    if(env.BD_PREVIOUS_EXTENSION_PATHS) {
      const paths=JSON.parse(env.BD_PREVIOUS_EXTENSION_PATHS);
      selected=paths[config.fromVersion];
      assert.ok(typeof selected==='string'&&selected,'missing prepared baseline '+config.fromVersion);
    } else if(config===baselineConfig) selected=env.BD_PREVIOUS_EXTENSION_PATH;
  }
  if(!selected) {
    const pointer=JSON.parse(await readFile(pointerFile,'utf8'));
    selected=pointer.runtimes?.[config.fromVersion] || (config===baselineConfig ? pointer.runtime : undefined);
  }
  assert.ok(typeof selected==='string'&&selected,'prepare the pinned baseline '+config.fromVersion);
  const runtime = path.resolve(selected);
  const receipt = JSON.parse(await readFile(path.join(runtime,'../receipt.json'),'utf8'));
  const manifest = JSON.parse(await readFile(path.join(runtime,'manifest.json'),'utf8'));
  assert.equal(receipt.commit,config.commit,'the previous package must come from the pinned commit');
  assert.equal(receipt.version,config.fromVersion);
  assert.equal(manifest.version,config.fromVersion,'prepare the actual previous runtime package first');
  assert.equal(receipt.files.length,receipt.runtimeFiles);
  for (const file of receipt.files) {
    assert.ok(!path.isAbsolute(file.path)&&!file.path.split(/[\\/]/).includes('..'));
    const sha256=createHash('sha256').update(await readFile(path.join(runtime,file.path))).digest('hex');
    assert.equal(sha256,file.sha256,'previous runtime bytes: '+file.path);
  }
  return {runtime,manifest,receipt};
}

export async function prepareUpgradeBaseline(config=baselineConfig) {
  assert.ok(baselineConfigs.includes(config),'a pinned upgrade baseline is required');
  const current = JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
  assert.equal(current.version,expectedVersion,'current package version');
  assert.notEqual(current.version,config.fromVersion,'upgrade needs two actual versions');
  const parent = process.env.RUNNER_TEMP || tmpdir();
  await mkdir(parent,{recursive:true});
  const output = await mkdtemp(path.join(parent,'bd-upgrade-baseline-'));
  // A separate checkout lets the historical packager enforce its clean-HEAD
  // rule without changing the user's branch, index or working files.
  const source = path.join(output,'source');
  return withPreviousCheckout(root,source,config.commit,async()=>{
    const manifest = JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
    assert.equal(manifest.version,config.fromVersion);
    await execute(process.execPath,[path.join(source,config.packageTool),...config.packageArgs],
      {cwd:source,timeout:30000,maxBuffer:4*1024*1024});
    const archives = (await readdir(path.join(source,'dist'))).filter(name=>name.endsWith(config.archiveSuffix));
    assert.equal(archives.length,1);
    const archive = path.join(source,'dist',archives[0]), runtime = path.join(output,'runtime');
    const bytes = await readFile(archive);
    const metadata = JSON.parse(await readFile(archive+'.build.json','utf8'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.equal(metadata.commit,config.commit);
    assert.equal(metadata.version,config.fromVersion);
    assert.equal(metadata.sha256,sha256);
    await execute(process.env.BD_PYTHON || 'python3',['-c',[
      'from pathlib import Path, PurePosixPath','import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as z:',
      '    assert z.testzip() is None',
      '    for name in z.namelist():',
      '        p = PurePosixPath(name)',
      '        assert not p.is_absolute() and ".." not in p.parts',
      '    z.extractall(sys.argv[2])'
    ].join('\n'),archive,runtime],{timeout:30000});
    const files=[];
    for (const file of metadata.runtimeFiles) files.push({path:file.path,
      sha256:createHash('sha256').update(await readFile(path.join(runtime,file.path))).digest('hex')});
    const receipt = {repository:config.repository,commit:config.commit,
      version:manifest.version,archive:archives[0],sha256,runtimeFiles:files.length,files};
    await writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    return {runtime,receipt};
  });
}

export async function prepareUpgradeBaselines() {
  const prepared=[];
  // Each version uses a separate historical checkout, archive and receipt.
  // Publish discovery only after the entire matrix was prepared successfully.
  for(const config of baselineConfigs) prepared.push(await prepareUpgradeBaseline(config));
  const runtimes=Object.fromEntries(prepared.map(({runtime,receipt})=>[receipt.version,runtime]));
  const runtime=runtimes[baselineConfig.fromVersion];
  await writeFile(path.join(directory,'upgrade-baseline.local.json'),JSON.stringify({runtime,runtimes})+'\n');
  if(process.env.GITHUB_ENV) await writeFile(process.env.GITHUB_ENV,
    `BD_PREVIOUS_EXTENSION_PATH=${runtime}\nBD_PREVIOUS_EXTENSION_PATHS=${JSON.stringify(runtimes)}\n`,{flag:'a'});
  return prepared;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  for(const {runtime,receipt} of await prepareUpgradeBaselines()) console.log(JSON.stringify({runtime,
    commit:receipt.commit,version:receipt.version,sha256:receipt.sha256,runtimeFiles:receipt.runtimeFiles}));
}
