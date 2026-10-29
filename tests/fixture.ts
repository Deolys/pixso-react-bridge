import type { Capture, DesignNode } from '../src/types.js';

export function fixture(): Capture {
  const node = (id:string,type:string,parentId:string|null,x:number,y:number,width:number,height:number,raw:Record<string,unknown>,children:string[]=[]): DesignNode => ({id,name:id,type,parentId,children,bounds:{x,y,width,height},raw:{id,type,width,height,...raw}});
  const fill = (r:number,g:number,b:number) => [{type:'SOLID',color:{r:r/255,g:g/255,b:b/255},opacity:1}];
  const text = (characters:string,size:number,weight:number,color:number[]) => ({characters,fontFamily:'Arial',fontSize:size,fontWeight:weight,lineHeight:{unit:'PIXELS',value:size+8},fills:fill(color[0],color[1],color[2])});
  const nodes:DesignNode[] = [
    node('page','PAGE',null,0,0,640,420,{},['screen']),
    node('screen','FRAME','page',100,80,640,420,{fills:fill(244,247,251),clipsContent:true},['sidebar','title','subtitle','card','hidden']),
    node('sidebar','FRAME','screen',100,80,152,420,{fills:fill(20,34,52)},['brand','nav']),
    node('brand','TEXT','sidebar',120,104,112,32,text('ATLAS',22,700,[255,255,255])),
    node('nav','TEXT','sidebar',120,168,112,24,text('Overview',16,400,[194,208,224])),
    node('title','TEXT','screen',280,108,420,40,text('Design transfer',28,700,[20,34,52])),
    node('subtitle','TEXT','screen',280,156,420,28,text('Every layer has a place.',16,400,[83,99,119])),
    node('card','FRAME','screen',280,208,432,248,{fills:fill(255,255,255),cornerRadius:16},['badge','value','label','button']),
    node('badge','ELLIPSE','card',304,232,32,32,{fills:fill(38,140,115)}),
    node('value','TEXT','card',304,280,380,56,text('128',40,700,[20,34,52])),
    node('label','TEXT','card',304,336,380,28,text('Layers captured',16,400,[83,99,119])),
    node('button','FRAME','card',304,388,160,44,{fills:fill(38,140,115),cornerRadius:8},['button-text']),
    node('button-text','TEXT','button',320,396,128,28,text('Review design',16,700,[255,255,255])),
    node('hidden','RECTANGLE','screen',100,80,10,10,{visible:false,fills:fill(255,0,0)}),
  ];
  return {schemaVersion:1,source:{provider:'independent-test-fixture',fileKey:'atlas-demo',name:'Atlas demo',revision:'1',capturedAt:'2026-10-16T00:00:00.000Z'},roots:['page'],nodes,assets:[],screenshots:[],completeness:{status:'complete',expectedNodeCount:nodes.length,receivedNodeCount:nodes.length,issues:[]}};
}

// Independently authored reference: this markup never reads generated CSS or renderer output.
export const referenceHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif}.canvas{position:relative;width:640px;height:420px;overflow:hidden;background:rgb(244,247,251)}
.sidebar{position:absolute;left:0;top:0;width:152px;height:420px;background:rgb(20,34,52)}.brand{position:absolute;left:20px;top:24px;width:112px;height:32px;color:white;font-size:22px;font-weight:700;line-height:30px}.nav{position:absolute;left:20px;top:88px;width:112px;height:24px;color:rgb(194,208,224);font-size:16px;font-weight:400;line-height:24px}
.title{position:absolute;left:180px;top:28px;width:420px;height:40px;color:rgb(20,34,52);font-size:28px;font-weight:700;line-height:36px}.subtitle{position:absolute;left:180px;top:76px;width:420px;height:28px;color:rgb(83,99,119);font-size:16px;font-weight:400;line-height:24px}
.card{position:absolute;left:180px;top:128px;width:432px;height:248px;background:white;border-radius:16px}.badge{position:absolute;left:24px;top:24px;width:32px;height:32px;background:rgb(38,140,115);border-radius:50%}.value{position:absolute;left:24px;top:72px;width:380px;height:56px;font-size:40px;font-weight:700;line-height:48px;color:rgb(20,34,52)}.label{position:absolute;left:24px;top:128px;width:380px;height:28px;font-size:16px;font-weight:400;line-height:24px;color:rgb(83,99,119)}.button{position:absolute;left:24px;top:180px;width:160px;height:44px;background:rgb(38,140,115);border-radius:8px}.button-text{position:absolute;left:16px;top:8px;width:128px;height:28px;font-size:16px;font-weight:700;line-height:24px;color:white}
</style></head><body><main class="canvas"><aside class="sidebar"><div class="brand">ATLAS</div><div class="nav">Overview</div></aside><div class="title">Design transfer</div><div class="subtitle">Every layer has a place.</div><div class="card"><div class="badge"></div><div class="value">128</div><div class="label">Layers captured</div><div class="button"><div class="button-text">Review design</div></div></div></main></body></html>`;
