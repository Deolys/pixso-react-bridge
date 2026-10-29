import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { fixture, referenceHtml } from '../tests/fixture.js';
import { saveSnapshot, loadSnapshot } from '../src/artifacts.js';
import { createScopedSnapshot } from '../src/scope.js';
import { defaultConfig } from '../src/config.js';
import { runTransfer } from '../src/transfer.js';
import { acceptRun } from '../src/accept.js';
import { slug, writeJson } from '../src/fs.js';

// Simulated Pixso and GigaCode; actual installed React, project fixtures and Chrome.
const root = path.resolve('output/demo-data');
await mkdir(path.join(root, 'src'), {recursive:true}); await mkdir(path.join(root, 'fixtures'), {recursive:true});
const config = defaultConfig(root);
config.artifactsDir = path.join(root, 'artifacts'); config.generation.outputDir = path.join(root, 'src/generated');
config.versioning = {screenChangelog:true};
config.generation.data = {mockFiles:['fixtures/summary.json'],instructions:'Use the existing JSON fixture scenario through SummaryProps. Production widgets receive data through props.'};
config.validation.setupFile = 'preview.tsx';
config.validation.browserChannel = process.env.PIXSO_BROWSER_CHANNEL as 'chrome' | 'msedge' | undefined;
if (!config.validation.browserChannel && !existsSync(chromium.executablePath())) config.validation.browserChannel = 'chrome';
await writeFile(path.join(root, 'src/data.ts'), 'export interface SummaryProps { summary: { total: number } }\n');
await writeJson(path.join(root, 'fixtures/summary.json'), {total:128});
await writeJson(path.join(root, 'package.json'), {name:'pixso-project-fixture-demo',private:true,type:'module'});
await writeJson(path.join(root, 'tsconfig.json'), {compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',jsx:'react-jsx',strict:true,skipLibCheck:true,esModuleInterop:true,resolveJsonModule:true},include:['src/**/*.ts','src/**/*.tsx','preview.tsx']});
await writeFile(path.join(root, 'preview.tsx'), `import {createContext, useContext, type ReactNode} from 'react';
import summary from './fixtures/summary.json';
const FixtureReady = createContext(false);
function Ready({children}:{children:ReactNode}) { if(!useContext(FixtureReady)) throw new Error('Missing project provider'); return children; }
function Provider({children}:{children:ReactNode}) { return <FixtureReady.Provider value={true}><Ready>{children}</Ready></FixtureReady.Provider>; }
export async function preparePixsoPreview({screenId}:{screenId:string}) {
  if(screenId!=='card') throw new Error('Unexpected host screen');
  await new Promise(resolve=>setTimeout(resolve,30));
  return {props:{summary},Provider};
}
`);
const browser = await chromium.launch({headless:true,channel:config.validation.browserChannel});
try {
  const page = await browser.newPage({viewport:{width:640,height:420},deviceScaleFactor:1});
  await page.setContent(referenceHtml); await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(root,'screen.png'),omitBackground:true});
  // Independently authored standalone reference; never a crop of the host screenshot.
  await page.evaluate(()=>{
    const card=document.querySelector<HTMLElement>('.card')!.cloneNode(true) as HTMLElement;
    card.style.position='relative'; card.style.left='0'; card.style.top='0';
    document.body.replaceChildren(card);
  });
  await page.setViewportSize({width:432,height:248});
  await page.screenshot({path:path.join(root,'card.png'),omitBackground:true});
} finally { await browser.close(); }
const capture=fixture();
for(const node of capture.nodes) node.raw.parentId=node.parentId;
capture.screenshots=[{nodeId:'screen',path:'screen.png',width:640,height:420,scale:1},{nodeId:'card',path:'card.png',width:432,height:248,scale:1}];
const full=await saveSnapshot(capture,config.artifactsDir,{baseDir:root});
const selected=await createScopedSnapshot(full,['card','value'],config,{name:'Summary microfrontend',changeNote:'Микрофронтенд сводки с проектными фикстурами'});
const {manifest, capture: scoped}=await loadSnapshot(selected);
assert.deepEqual(scoped.roots,['card']); assert.equal(scoped.nodes.length,6);
assert.equal(scoped.nodes.some(node=>node.id==='sidebar'),false); assert.equal(scoped.scope!.ancestors.length,2);
assert.equal(Object.keys(manifest.files).filter(file=>file.endsWith('/CHANGELOG.md')).length,1);
// Small partitions ensure the business value crosses several generated widget boundaries.
const snapshot=await saveSnapshot(scoped,config.artifactsDir,{baseDir:selected,maxNodesPerTask:2,changelog:{enabled:true,summary:'Проверка передачи props между виджетами'}});
const runDir=path.join(snapshot,'runs','data-demo-transfer');
config.gigacode={command:process.execPath,args:[path.resolve('tests/mock-worker.mjs'),snapshot,path.join(runDir,'iteration-1'),'{taskId}','{outputDir}','{promptFile}'],concurrency:3,timeoutMs:30000,retries:0,env:{PIXSO_MOCK_DATA_MODE:'dynamic-props'}};
const transfer=await runTransfer(snapshot,config,{runDir,iterations:1});
await writeJson(path.join(root,'transfer-result.json'),transfer);
assert.equal(transfer.status,'accepted',JSON.stringify(transfer)); assert.equal(transfer.pixelPerfect,true);
const acceptance=JSON.parse(await readFile(path.join(runDir,'iteration-1/acceptance/acceptance.json'),'utf8'));
assert(Object.keys(acceptance.previewEvidence).some(file=>file.endsWith('summary.json')));
const installed=path.join(config.generation.outputDir,slug('card'));
const coverage=JSON.parse(await readFile(path.join(installed,'coverage.json'),'utf8'));
assert.equal(coverage.dataBindings.find((binding:{nodeId:string})=>binding.nodeId==='value').expression,'props.summary.total');
// A changed fixture invalidates evidence even though installed source hashes still match.
await writeJson(path.join(root,'fixtures/summary.json'),{total:999});
const changed=await acceptRun(path.join(runDir,'iteration-1'),config);
assert.equal(changed.complete,false); assert(changed.issues.some(issue=>/data|inventory|profile/i.test(issue)));
await writeJson(path.join(root,'fixture-mutation-rejected.json'),changed);
await writeJson(path.join(root,'fixtures/summary.json'),{total:128});
const restored=await acceptRun(path.join(runDir,'iteration-1'),config); assert.equal(restored.complete,true,JSON.stringify(restored.issues));
console.log(JSON.stringify({simulation:'Pixso/GigaCode test doubles; actual React+TypeScript+Chrome with project fixtures and Provider',snapshot,scope:scoped.roots,widgets:(await loadSnapshot(snapshot)).manifest.screens[0].widgets.length,status:transfer.status,pixelPerfect:transfer.pixelPerfect,fixtureMutationRejected:!changed.complete,report:restored.reportPath},null,2));
