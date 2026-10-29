import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { fixture, referenceHtml } from '../tests/fixture.js';
import { saveSnapshot, loadSnapshot } from '../src/artifacts.js';
import { defaultConfig } from '../src/config.js';
import { generateBaseline } from '../src/pipeline.js';
import { verifyOperation } from '../src/operations.js';
import { hash, writeJson } from '../src/fs.js';
import { runTransfer } from '../src/transfer.js';
import { acceptRun } from '../src/accept.js';

const root=path.resolve('output/demo'); await mkdir(root,{recursive:true});
const config=defaultConfig(root); config.artifactsDir=path.join(root,'artifacts');
config.validation.mode='pixel-perfect'; config.validation.maxPixelDiffRatio=0; config.validation.geometryTolerancePx=0.01;
config.validation.browserChannel=process.env.PIXSO_BROWSER_CHANNEL as 'chrome' | 'msedge' | undefined;
if(!config.validation.browserChannel && !existsSync(chromium.executablePath())) config.validation.browserChannel='chrome';
const browser=await chromium.launch({headless:true,channel:config.validation.browserChannel});
try {
  const page=await browser.newPage({viewport:{width:640,height:420},deviceScaleFactor:1});
  await page.setContent(referenceHtml); await page.evaluate(()=>document.fonts.ready);
  await writeFile(path.join(root,'reference.html'),referenceHtml);
  await page.screenshot({path:path.join(root,'reference.png')});
} finally {await browser.close();}
const c=fixture(); c.screenshots=[{nodeId:'screen',path:path.join(root,'reference.png'),width:640,height:420,scale:1}];
await writeJson(path.join(root,'capture.json'),c);
const snapshot=await saveSnapshot(c,config.artifactsDir,{maxNodesPerTask:4});
const baseline=await generateBaseline(snapshot,config,path.join(root,'generated'));
const view=path.relative(root,path.join(baseline.screens[0].directory,'View')).replaceAll('\\','/');
await writeFile(path.join(root,'index.html'),'<html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await writeFile(path.join(root,'main.tsx'),`import React from 'react'; import {createRoot} from 'react-dom/client'; import View from './${view}'; createRoot(document.getElementById('root')!).render(<View/>);`);
const server=await createServer({root,configFile:false,esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'warn'});
await server.listen();
try {
  const address=server.httpServer!.address(); if(!address||typeof address==='string')throw new Error('No local server address');
  const report=await verifyOperation(config,snapshot,'screen',`http://127.0.0.1:${address.port}`,path.join(root,'validation'));
  await writeJson(path.join(root,'demo-result.json'),{snapshot,baseline:baseline.runDir,report});
  console.log(JSON.stringify({snapshot,status:report.status,checkedNodeCount:report.checkedNodeCount,pixelDiffRatio:report.pixelDiffRatio,issues:report.issues,screenshot:report.screenshotPath,report:report.reportPath},null,2));
  assert.equal(report.status,'passed','Independent visual demo failed');
  assert.equal(report.pixelPerfect,true,'The fixture must pass exact RGBA comparison');
  // Negative control: an intentionally wrong color must be detected.
  const cssFile=path.join(baseline.screens[0].directory,'View.css'), original=await readFile(cssFile,'utf8');
  await writeFile(cssFile,original.replace('rgba(38, 140, 115, 1)','rgba(255, 0, 0, 1)'));
  try {
    const negative=await verifyOperation(config,snapshot,'screen',`http://127.0.0.1:${address.port}`,path.join(root,'negative-control'));
    assert.equal(negative.status,'failed'); assert(negative.issues.some(i=>i.kind==='pixels'||i.kind==='style'));
    console.log('Negative control: wrong color correctly rejected.');
  } finally {await writeFile(cssFile,original);}
} finally {await server.close();}

// Integration test of the production orchestrator with an explicitly simulated CLI.
// This exercises process isolation and acceptance, not a real GigaCode model.
const transferDir=path.join(snapshot,'runs','full-demo-transfer');
config.generation.outputDir=path.join(root,'src','pixso-generated');
config.gigacode={command:process.execPath,args:[path.resolve('tests/mock-worker.mjs'),snapshot,path.join(transferDir,'iteration-1'),'{taskId}','{outputDir}','{promptFile}'],concurrency:3,timeoutMs:30000,retries:0};
const transfer=await runTransfer(snapshot,config,{runDir:transferDir,iterations:1});
await writeJson(path.join(root,'transfer-result.json'),transfer);
console.log(JSON.stringify({simulation:'GigaCode CLI test double; production pipeline and browser',...transfer},null,2));
assert.equal(transfer.status,'accepted','Full orchestrator acceptance failed');
assert.equal(transfer.pixelPerfect,true);

// A correct, unrelated preview must never certify incorrect installed code.
const negativeDir=path.join(snapshot,'runs','wrong-installed-code'); await mkdir(negativeDir,{recursive:true});
for(const file of ['result.json','applied.json']) await copyFile(path.join(transferDir,'iteration-1',file),path.join(negativeDir,file));
const outputRoot=config.generation.outputDir, ledgerFile=path.join(outputRoot,'.pixso-files.json');
const ledgerText=await readFile(ledgerFile,'utf8'),ledger=JSON.parse(ledgerText) as Record<string,string>;
const cssEntry=(await Promise.all(Object.keys(ledger).filter(p=>p.endsWith('.css')).map(async p=>({p,text:await readFile(path.join(outputRoot,p),'utf8')})))).find(p=>p.text.includes('rgba(38, 140, 115, 1)'))!;
assert(cssEntry,'No color-bearing installed stylesheet');
const wrongCss=cssEntry.text.replace('rgba(38, 140, 115, 1)','rgba(255, 0, 0, 1)');
const preview=await createServer({root,configFile:false,esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},logLevel:'warn'});
try {
  await preview.listen();const address=preview.httpServer!.address();assert(address&&typeof address!=='string');
  config.validation.url=`http://127.0.0.1:${address.port}`;
  await writeFile(path.join(outputRoot,cssEntry.p),wrongCss);ledger[cssEntry.p]=hash(wrongCss);await writeJson(ledgerFile,ledger);
  const negative=await acceptRun(negativeDir,config);
  await writeJson(path.join(root,'wrong-installed-code.json'),negative);
  assert.equal(negative.complete,false);assert.equal(negative.pixelPerfect,false);
  assert(negative.screens.some(s=>!s.complete),'Mandatory installed-code check failed to detect the wrong component');
  assert((negative.integrationScreens as {complete:boolean}[]).some(s=>s.complete),'The independent preview should still match, proving it cannot override the installed result');
  console.log('Negative control: correct alternate preview cannot certify wrong installed code.');
} finally {
  delete config.validation.url;await writeFile(path.join(outputRoot,cssEntry.p),cssEntry.text);await writeFile(ledgerFile,ledgerText);await preview.close();
}
