import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from './fixture.js';
import { saveSnapshot, loadSnapshot } from '../src/artifacts.js';
import { runPipeline, applyRun } from '../src/pipeline.js';
import { defaultConfig } from '../src/config.js';
import { importOperation } from '../src/operations.js';
import { runTransfer } from '../src/transfer.js';

test('parallel analyze -> implement -> apply preserves coverage, resume and user edits',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pixso-pipeline-')),c=defaultConfig(root);
  c.artifactsDir=path.join(root,'artifacts'); c.generation.outputDir=path.join(root,'src/generated');
  const snapshot=await saveSnapshot(fixture(),c.artifactsDir,{maxNodesPerTask:4});
  const runDir=path.join(snapshot,'runs','test');
  c.gigacode={command:process.execPath,args:[path.resolve('tests/mock-worker.mjs'),snapshot,runDir,'{taskId}','{outputDir}','{promptFile}'],concurrency:3,timeoutMs:30000,retries:0};
  const run=await runPipeline(snapshot,c,{runDir}); assert.equal(run.status,'awaiting-validation');
  const applied=await applyRun(runDir,c); assert(applied.files.some(f=>f.endsWith('View.tsx')));
  await writeFile(path.join(runDir,'.pipeline.lock'),JSON.stringify({pid:999999999}));
  const resumed=await runPipeline(snapshot,c,{runDir,resume:true}); assert.equal(resumed.status,'awaiting-validation');
  if('generationWorkers' in resumed) assert(resumed.generationWorkers.tasks.every(t=>t.status==='skipped'));
  const file=path.join(c.generation.outputDir,applied.files.find(f=>f.endsWith('View.css'))!);
  await writeFile(file,(await readFile(file,'utf8'))+'\n/* user edit */');
  await assert.rejects(applyRun(runDir,c),/edited\/unowned/);
});

test('snapshot manifest cannot silently omit screens or widget nodes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pixso-manifest-'));
  const snapshot=await saveSnapshot(fixture(),root);
  const filename=path.join(snapshot,'manifest.json'),m=JSON.parse(await readFile(filename,'utf8'));
  m.screens[0].widgets[0].nodeIds.pop(); await writeFile(filename,JSON.stringify(m));
  await assert.rejects(loadSnapshot(snapshot),/widget coverage/);
});

test('import cannot smuggle files outside its export bundle through asset paths',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pixso-import-')),c=fixture();
  c.assets=[{id:'bad',path:path.resolve('package.json'),mimeType:'application/json'}];
  await assert.rejects(saveSnapshot(c,path.join(root,'artifacts'),{baseDir:root}),/escapes root/);
});

test('native export import preserves full component/style reference files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pixso-native-import-')),config=defaultConfig(root);
  config.artifactsDir=path.join(root,'artifacts');
  const bundle=path.join(root,'bundle'); await mkdir(path.join(bundle,'raw'),{recursive:true});
  const references={components:{master:{name:'Full component source',huge:'x'.repeat(100000)}},styles:{},variables:{}};
  await writeFile(path.join(bundle,'raw','references.json'),JSON.stringify(references));
  await writeFile(path.join(bundle,'capture.json'),JSON.stringify(fixture()));
  const result=await importOperation(config,path.join(bundle,'capture.json'));
  assert.deepEqual(JSON.parse(await readFile(path.join(result.snapshot,'raw','references.json'),'utf8')),references);
});

test('missing or incompatible Button blocks before implementation and apply with a durable component report',async()=>{
  for(const mode of ['missing-button','adapt-button','missing-decision','unresolved']) {
    const root=await mkdtemp(path.join(tmpdir(),'pixso-gate-')),c=defaultConfig(root);
    c.artifactsDir=path.join(root,'artifacts');c.generation.outputDir=path.join(root,'src/generated');
    if(mode==='adapt-button')await writeFile(path.join(root,'Button.tsx'),'export const Button = () => <button>Existing</button>;');
    const snapshot=await saveSnapshot(fixture(),c.artifactsDir,{maxNodesPerTask:4}),runDir=path.join(snapshot,'runs','test');
    c.gigacode={command:process.execPath,args:[path.resolve('tests/mock-worker.mjs'),snapshot,runDir,'{taskId}','{outputDir}','{promptFile}'],env:{PIXSO_MOCK_COMPONENT_MODE:mode},concurrency:3,timeoutMs:30000,retries:0};
    const run=await runPipeline(snapshot,c,{runDir});assert.equal(run.status,'blocked-design-system');assert.equal(run.complete,false);
    const saved=JSON.parse(await readFile(path.join(runDir,'result.json'),'utf8'));assert.equal(saved.componentPlan.status,'blocked');assert(saved.componentPlan.blockingCount>0);
    assert.match(await readFile(saved.componentPlan.gapsPath,'utf8'),/перенос заблокирован/);
    await assert.rejects(access(path.join(runDir,'implementation')));await assert.rejects(access(path.join(runDir,'baseline')));
    await assert.rejects(applyRun(runDir,c),/usable code/);
  }
});

test('transfer surfaces the missing-component task and stops without applying or wasting repair iterations',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pixso-transfer-gate-')),c=defaultConfig(root);
  c.artifactsDir=path.join(root,'artifacts');c.generation.outputDir=path.join(root,'src/generated');
  const snapshot=await saveSnapshot(fixture(),c.artifactsDir,{maxNodesPerTask:4}),runDir=path.join(snapshot,'runs','transfer');
  c.gigacode={command:process.execPath,args:[path.resolve('tests/mock-worker.mjs'),snapshot,path.join(runDir,'iteration-1'),'{taskId}','{outputDir}','{promptFile}'],env:{PIXSO_MOCK_COMPONENT_MODE:'missing-button'},concurrency:3,timeoutMs:30000,retries:0};
  const run=await runTransfer(snapshot,c,{runDir,iterations:3});
  assert.equal(run.status,'blocked-design-system');assert.equal(run.complete,false);assert.equal(run.attempts.length,1);
  assert('componentPlan' in run && run.componentPlan);
  assert.match(await readFile(run.componentPlan.gapsPath,'utf8'),/Задание для ИИ/);
  await assert.rejects(access(c.generation.outputDir));await assert.rejects(access(path.join(runDir,'iteration-2')));
});

test('project data gate blocks missing scenarios and inline dynamic values before apply, while real props pass',async()=>{
  for(const mode of ['missing-binding','unknown','dynamic-literal','dynamic-props']) {
    const root=await mkdtemp(path.join(tmpdir(),'pixso-data-gate-')),c=defaultConfig(root);
    c.artifactsDir=path.join(root,'artifacts');c.generation.outputDir=path.join(root,'src/generated');
    await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'fixtures'),{recursive:true});
    await writeFile(path.join(root,'src/data.ts'),'export interface SummaryProps { summary: { total: number } }');
    await writeFile(path.join(root,'fixtures/summary.json'),'{"total":128}');
    await writeFile(path.join(root,'preview.ts'),'export async function preparePixsoPreview() { return {props:{summary:{total:128}}}; }');
    c.validation.setupFile='preview.ts';
    const snapshot=await saveSnapshot(fixture(),c.artifactsDir,{maxNodesPerTask:4}),runDir=path.join(snapshot,'runs','test');
    c.gigacode={command:process.execPath,args:[path.resolve('tests/mock-worker.mjs'),snapshot,runDir,'{taskId}','{outputDir}','{promptFile}'],env:{PIXSO_MOCK_DATA_MODE:mode},concurrency:3,timeoutMs:30000,retries:0};
    const run=await runPipeline(snapshot,c,{runDir});
    if(mode==='dynamic-props') {
      assert.equal(run.status,'awaiting-validation');const applied=await applyRun(runDir,c);
      const tsx=await Promise.all(applied.files.filter(file=>file.endsWith('.tsx')).map(file=>readFile(path.join(c.generation.outputDir,file),'utf8')));
      assert(tsx.some(text=>text.includes('{props.summary.total}')));assert(tsx.every(text=>!text.includes('{"128"}')));
    } else {
      assert.equal(run.status,'blocked-project-data');assert.equal(run.complete,false);
      const saved=JSON.parse(await readFile(path.join(runDir,'result.json'),'utf8'));assert.equal(saved.dataPlan.status,'blocked');assert.match(await readFile(saved.dataPlan.gapsPath,'utf8'),/Задание для ИИ/);
      if(mode!=='dynamic-literal')await assert.rejects(access(path.join(runDir,'implementation')));
      await assert.rejects(applyRun(runDir,c),/usable code/);await assert.rejects(access(c.generation.outputDir));
    }
  }
});
