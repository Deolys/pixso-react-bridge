import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../src/config.js';
import { fixture } from './fixture.js';
import { PNG } from 'pngjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('real stdio MCP handshake, canonical import, snapshot summary and paged artifact reads',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'pixso-mcp-')),c=defaultConfig(root);
  c.artifactsDir=path.join(root,'artifacts');
  const configFile=path.join(root,'config.json'),captureFile=path.join(root,'capture.json');
  const capture=fixture(); capture.nodes[3].raw.large='Я🦊'.repeat(10000);
  const png = new PNG({width:432,height:248});
  await writeFile(path.join(root,'card.png'), PNG.sync.write(png));
  capture.screenshots.push({nodeId:'card',path:'card.png',width:432,height:248,scale:1});
  await writeFile(configFile,JSON.stringify(c)); await writeFile(captureFile,JSON.stringify(capture));
  const client=new Client({name:'integration-test',version:'1.0.0'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve('dist/cli.js'),'serve','--config',configFile],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>{
    const r=await client.callTool({name,arguments:args}); assert.notEqual(r.isError,true,JSON.stringify(r));
    return JSON.parse((r.content as {text:string}[])[0].text);
  };
  try{
    const {tools}=await client.listTools(); assert(tools.some(t=>t.name==='pixso_accept')); assert(tools.some(t=>t.name==='pixso_start_job'));
    assert.equal((await call('pixso_status')).workers,4);
    const imported=await call('pixso_import',{file:captureFile,changeNote:'Первый импорт'});
    const snapshot=await call('pixso_snapshot',{snapshot:imported.snapshot}); assert.equal(snapshot.nodeCount,14); assert.equal(snapshot.screens.length,1);
    assert.match(snapshot.screens[0].changelog,/CHANGELOG.md$/);
    const scoped=await call('pixso_scope',{snapshot:imported.snapshot,nodeIds:['card','value'],scopeName:'Summary microfrontend',changeNote:'Выделение микрофронтенда'});
    const summary=await call('pixso_snapshot',{snapshot:scoped.snapshot});
    assert.deepEqual(summary.scope.rootIds,['card']); assert.equal(summary.scope.name,'Summary microfrontend'); assert.equal(summary.nodeCount,6); assert.equal(summary.screens[0].id,'card');
    const cli=await promisify(execFile)(process.execPath,[path.resolve('dist/cli.js'),'scope','--config',configFile,'--snapshot',imported.snapshot,'--nodes','card,value','--scope-name','CLI microfrontend']);
    assert.equal((await call('pixso_snapshot',{snapshot:JSON.parse(cli.stdout).snapshot})).scope.name,'CLI microfrontend');
    let offset:number|null=0,combined='';
    while(offset!==null){const page=await call('pixso_read_artifact',{file:path.join(imported.snapshot,'capture.json'),offset,limit:997});combined+=page.content;offset=page.nextOffset;}
    assert.equal(JSON.parse(combined).nodes[3].raw.large,capture.nodes[3].raw.large);
    const denied=await client.callTool({name:'pixso_read_artifact',arguments:{file:configFile}}); assert.equal(denied.isError,true);
  }finally{await client.close();}
});
