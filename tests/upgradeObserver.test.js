import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installUpgradeObserver,readUpgradeObserver,removeUpgradeObserver } from '../e2e/upgrade-probes.mjs';

test('native update observer reads only owned background lifecycle delivery and unregisters itself',()=>{
  const listeners=new Map();
  const logger={listeners,addListener(id,fn){listeners.set(id,new Set([fn]));},
    removeListener(id,fn){listeners.get(id)?.delete(fn);}};
  const realm=vm.createContext({window:{},ChromeUtils:{importESModule:()=>({ExtensionActivityLog:logger})}});
  const invoke=(fn,arg)=>vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`,realm);
  invoke(installUpgradeObserver,'target');
  const listener=[...listeners.get('target')][0];
  const event={id:'target',type:'api_event',name:'runtime.onInstalled',viewType:'background',timeStamp:1234,
    data:{args:[{reason:'update',previousVersion:'5.4.14'}]}};
  for(const change of [{id:'other'},{viewType:'popup'},{name:'runtime.onMessage'}])listener({...event,...change});
  assert.equal(invoke(readUpgradeObserver).length,0);
  listener(event);
  assert.deepEqual(JSON.parse(JSON.stringify(invoke(readUpgradeObserver))),[
    {at:1234,extensionId:'target',details:{reason:'update',previousVersion:'5.4.14'}}]);
  invoke(removeUpgradeObserver);assert.equal(listeners.get('target').size,0);
  assert.throws(()=>invoke(readUpgradeObserver),/observer disappeared/);
});

test('a malformed native update cannot become an accepted receipt',()=>{
  let listener;
  const listeners=new Map();
  const logger={listeners,addListener(id,fn){listener=fn;listeners.set(id,new Set([fn]));}};
  const realm=vm.createContext({window:{},ChromeUtils:{importESModule:()=>({ExtensionActivityLog:logger})}});
  vm.runInContext(`(${installUpgradeObserver.toString()})('target')`,realm);
  listener({id:'target',type:'api_event',name:'runtime.onInstalled',viewType:'background',timeStamp:1234,data:{}});
  assert.throws(()=>vm.runInContext(`(${readUpgradeObserver.toString()})()`,realm));
});
