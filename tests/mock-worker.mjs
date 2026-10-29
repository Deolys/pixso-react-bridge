import { readFile, readdir, writeFile, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [snapshot,runDir,taskId,out] = process.argv.slice(2);
const manifest=JSON.parse(await readFile(path.join(snapshot,'manifest.json'),'utf8'));
const capture=JSON.parse(await readFile(path.join(snapshot,'capture.json'),'utf8'));
const dataMode=process.env.PIXSO_MOCK_DATA_MODE;
const staticBindings=ids=>ids.map(nodeId=>({nodeId,kind:capture.nodes.find(n=>n.id===nodeId)?.raw?.characters?'static':'none',reason:'This deterministic fixture intentionally models fixed demonstration labels and geometry; no live business dataset is declared.',changes:[]}));
const dynamicMode=['dynamic-literal','dynamic-props'].includes(dataMode);
const coverageBindings=ids=>staticBindings(ids).map(({nodeId,kind})=>({nodeId,kind,...(dynamicMode&&nodeId==='value'?{kind:'dynamic',expression:'props.summary.total'}:{})}));
async function writeCoverage(nodeIds) {
  const imports=[];
  if(dataMode==='dynamic-props') {
    for(const entry of await readdir(out))if(entry.endsWith('.tsx')) {
      const filename=path.join(out,entry);let text=await readFile(filename,'utf8');
      text=text.replace(/props: Record<string, unknown>/g,'props: SummaryProps').replace(/function View\(\)/g,'function View(props: SummaryProps)').replace(/\{\s*["']128["']\s*\}/g,'{props.summary.total}');
      await writeFile(filename,'import type { SummaryProps } from "pixso-project-data";\n'+text);
    }
    imports.push({specifier:'pixso-project-data',projectPath:'src/data.ts'});
  }
  await writeFile(path.join(out,'coverage.json'),JSON.stringify({schemaVersion:1,reviewedNodeIds:nodeIds,unsupported:[],imports,dataBindings:coverageBindings(nodeIds)}));
}
const slug=value=>`${value.replace(/[^\p{L}\p{N}_-]+/gu,'-').slice(0,60)||'item'}-${createHash('sha256').update(value).digest('hex').slice(0,8)}`;
await mkdir(out,{recursive:true});
for(const screen of manifest.screens) {
  if(taskId===`implement-${slug(screen.id)}`) {
    await cp(path.join(runDir,'baseline','screens',slug(screen.id)),out,{recursive:true});
    await writeCoverage(screen.nodeIds);
  }
  for(const [i,widget] of screen.widgets.entries()) if(taskId===`analyze-${slug(screen.id)}-${i+1}`) {
    const componentDecisions=widget.nodeIds.map(nodeId=>({nodeId,decision:'native',required:'Fixture layout/text or primitive visual geometry',available:'Native semantic HTML with project CSS',reason:'The test fixture explicitly uses ordinary layout, text and primitives without a reusable design-system requirement.',changes:[],evidence:[]}));
    const mode=process.env.PIXSO_MOCK_COMPONENT_MODE;
    if(mode==='missing-decision')componentDecisions.pop();
    if(mode==='missing-button'||mode==='adapt-button')for(const decision of componentDecisions)if(decision.nodeId==='button')Object.assign(decision,{decision:mode==='missing-button'?'create':'adapt',required:'Button with primary and disabled states, 160x44 geometry',available:mode==='missing-button'?'No Button in project':'Existing Button lacks primary and disabled variants',reason:'The required design-system API is unavailable.',changes:[mode==='missing-button'?'Create an accessible project Button with primary and disabled states':'Add primary and disabled variants to the existing Button without changing current consumers']});
    const dataBindings=staticBindings(widget.nodeIds);
    if(dataMode==='missing-binding')dataBindings.pop();
    if(dataMode==='unknown')for(const decision of dataBindings)if(decision.nodeId==='value')Object.assign(decision,{kind:'unknown',reason:'The design total is business data but its project scenario is absent',changes:['Add the summary total scenario through the existing project fixture mechanism and wire its data props']});
    if(dynamicMode)for(const decision of dataBindings)if(decision.nodeId==='value') {
      const profile=JSON.parse(await readFile(path.join(runDir,'project-profile.json'),'utf8'));
      const source=await readFile(path.join(profile.root,'src/data.ts'),'utf8'),fixture=await readFile(path.join(profile.root,'fixtures/summary.json'),'utf8');
      Object.assign(decision,{kind:'dynamic',reason:'Summary total is business data',binding:{delivery:'props',expression:'props.summary.total',source:{projectPath:'src/data.ts',sha256:createHash('sha256').update(source).digest('hex'),excerpt:source,exportName:'SummaryProps'},fixturePath:'fixtures/summary.json',fixtureSha256:createHash('sha256').update(fixture).digest('hex'),fixtureExcerpt:fixture}});
    }
    await writeFile(path.join(out,'analysis.json'),JSON.stringify({schemaVersion:1,reviewedNodeIds:widget.nodeIds,componentDecisions,dataBindings,componentMappings:[],layout:[],assets:[],unresolved:mode==='unresolved'?['Button compatibility remains unresolved']:[]}));
  }
  for(const [i,widget] of screen.widgets.entries()) if(taskId===`implement-widget-${slug(screen.id)}-${i+1}`) {
    const plans=JSON.parse(await readFile(path.join(runDir,'widget-plans.json'),'utf8'));
    await cp(plans[screen.id].widgets[i].directory,out,{recursive:true});
    await writeCoverage(widget.nodeIds);
  }
}
