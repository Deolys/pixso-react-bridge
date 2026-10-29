// Scripts are read-only, fixed by this package, and use only the documented Pixso Plugin API.
const knownFields = `id name type visible locked opacity blendMode isMask maskType effects effectStyleId x y width height rotation relativeTransform absoluteTransform absoluteBoundingBox absoluteRenderBounds constraints constrainProportions layoutAlign layoutGrow layoutPositioning layoutMode layoutWrap primaryAxisSizingMode counterAxisSizingMode primaryAxisAlignItems counterAxisAlignItems counterAxisAlignContent paddingLeft paddingRight paddingTop paddingBottom itemSpacing counterAxisSpacing layoutSizingHorizontal layoutSizingVertical minWidth maxWidth minHeight maxHeight clipsContent fills fillStyleId strokes strokeStyleId strokeWeight strokeAlign strokeCap strokeJoin strokeMiterLimit strokeTopWeight strokeRightWeight strokeBottomWeight strokeLeftWeight dashPattern cornerRadius topLeftRadius topRightRadius bottomLeftRadius bottomRightRadius cornerSmoothing layoutGrids gridStyleId characters fontName fontSize fontWeight textAlignHorizontal textAlignVertical textAutoResize textCase textDecoration letterSpacing lineHeight paragraphSpacing paragraphIndent listOptions hyperlink textStyleId hasMissingFont autoRename arcData pointCount innerRadius vectorNetwork vectorPaths fillGeometry strokeGeometry booleanOperation componentProperties componentPropertyDefinitions componentPropertyReferences variantProperties variantGroupProperties boundVariables explicitVariableModes resolvedVariableModes reactions exportSettings guides overflowDirection numberOfFixedChildren overlayPositionType overlayBackground overlayBackgroundInteraction detachedInfo remote key description documentationLinks`.split(' ');

export const serializerSource = `
const knownFields = ${JSON.stringify(knownFields)};
const errors = [];
function plain(value, path, stack = new Set()) {
  if (value === undefined || typeof value === 'function') return undefined;
  if (typeof value === 'symbol' || value === pixso.mixed) return { __pixsoMixed: true };
  if (value === null || typeof value !== 'object') return value;
  if (stack.has(value)) { errors.push(path + ': cyclic object'); return null; }
  stack.add(value);
  let result;
  if (Array.isArray(value) || value instanceof Uint8Array) result = Array.from(value).map((v, i) => plain(v, path + '.' + i, stack));
  else {
    result = {};
    for (const k of Object.keys(value).sort()) {
      try { const v = plain(value[k], path + '.' + k, stack); if (v !== undefined) result[k] = v; }
      catch (e) { errors.push(path + '.' + k + ': ' + String(e)); }
    }
  }
  stack.delete(value); return result;
}
function readable(item) {
  const keys = new Set(knownFields);
  let proto = item;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) keys.add(key);
    proto = Object.getPrototypeOf(proto);
  }
  const result = {};
  for (const key of Array.from(keys).sort()) {
    if (['parent','children','mainComponent','constructor','__proto__'].includes(key)) continue;
    try { if (!(key in item)) continue; const value = plain(item[key], item.id + '.' + key); if (value !== undefined) result[key] = value; }
    catch (e) { errors.push(item.id + '.' + key + ': ' + String(e)); }
  }
  if ('parent' in item) result.parentId = item.parent ? item.parent.id : null;
  if ('children' in item) result.children = Array.from(item.children).map(n => n.id);
  if ('mainComponent' in item) result.componentRef = item.mainComponent ? item.mainComponent.id : null;
  if (item.type === 'TEXT' && typeof item.characters === 'string' && item.characters.length) {
    const methods = ['FontSize','FontName','TextCase','TextDecoration','LetterSpacing','LineHeight','Fills','TextStyleId','FillStyleId','ListOptions'];
    const runs = [];
    function range(start,end) {
      const style = {}; let mixed = false;
      for (const suffix of methods) {
        const method = 'getRange' + suffix;
        if (typeof item[method] !== 'function') continue;
        try { const v = item[method](start,end); if (v === pixso.mixed) mixed = true; style[suffix[0].toLowerCase() + suffix.slice(1)] = plain(v,item.id+'.'+method); }
        catch (e) { errors.push(item.id + '.' + method + ': ' + String(e)); }
      }
      if (mixed && end - start > 1) { const middle = Math.floor((start+end)/2); range(start,middle); range(middle,end); }
      else { const previous=runs[runs.length-1]; if (previous && JSON.stringify(previous.style)===JSON.stringify(style)) {previous.end=end; previous.characters+=item.characters.slice(start,end);} else runs.push({start,end,characters:item.characters.slice(start,end),style}); }
    }
    range(0,item.characters.length); result.textRuns = runs;
  }
  return result;
}
`;

export function inventoryScript(nodeIds: string[], offset: number, limit: number): string {
  return `const requested = ${JSON.stringify(nodeIds)};
let roots = requested.length ? requested.map(id => pixso.getNodeById(id)) : Array.from(pixso.root.children);
if (roots.some(n => !n)) throw new Error('Requested node does not exist in active file');
const rootIds = new Set(roots.map(n=>n.id)); roots=roots.filter(n=>{let p=n.parent;while(p){if(rootIds.has(p.id))return false;p=p.parent;}return true;});
const all = []; const seen = new Set();
for (const root of roots) {
  const descendants = typeof root.findAllAsync === 'function' ? await root.findAllAsync() : [];
  if ('children' in root && root.children.length && typeof root.findAllAsync !== 'function') throw new Error('findAllAsync is required to prove inventory coverage');
  for (const node of [root,...descendants]) if (!seen.has(node.id)) { seen.add(node.id); all.push(node); }
}

const rows = all.map(n => ({id:n.id,name:n.name,type:n.type,parentId:n.parent?n.parent.id:null,children:'children' in n?Array.from(n.children).map(c=>c.id):[]}));
return {fileKey:pixso.fileKey,name:pixso.root.name,apiVersion:pixso.apiVersion,roots:roots.map(n=>n.id),total:rows.length,offset:${offset},rows:rows.slice(${offset},${offset + limit})};`;
}

/** Row pagination alone cannot bound an individual node's children list. */
export function inventoryChunkScript(nodeIds: string[], rowOffset: number, rowLimit: number, offset: number, limit: number): string {
  return `const inventoryPage = await (async () => { ${inventoryScript(nodeIds, rowOffset, rowLimit)} })();
const serialized=JSON.stringify(inventoryPage);${fingerprint('serialized')}
return {fileKey:inventoryPage.fileKey,fingerprint,total:serialized.length,offset:${offset},chunk:serialized.slice(${offset},${offset + limit})};`;
}

/** A string envelope can be fetched in bounded chunks even for an enormous single node. */
export function nodeScript(id: string, offset: number, limit: number): string {
  return `${serializerSource}\nconst node = pixso.getNodeById(${JSON.stringify(id)});
if (!node) throw new Error('Node vanished during capture');
const raw=readable(node); const serialized=JSON.stringify({raw,errors});
${fingerprint('serialized')}
return {id:node.id,fileKey:pixso.fileKey,fingerprint,total:serialized.length,offset:${offset},chunk:serialized.slice(${offset},${offset + limit})};`;
}

export function referenceScript(kind: 'style' | 'variable', id: string, offset: number, limit: number): string {
  const read = kind === 'style'
    ? `pixso.getStyleById(${JSON.stringify(id)})`
    : `await pixso.variables.getVariableByIdAsync(${JSON.stringify(id)})`;
  return `${serializerSource}\nconst value=${read}; if (!value) throw new Error('Referenced ${kind} not found');
const raw=readable(value);const serialized=JSON.stringify({id:${JSON.stringify(id)},raw,errors});${fingerprint('serialized')}
return {id:${JSON.stringify(id)},fileKey:pixso.fileKey,fingerprint,total:serialized.length,offset:${offset},chunk:serialized.slice(${offset},${offset + limit})};`;
}

export function imageScript(id: string, format: 'PNG' | 'SVG' | 'ORIGINAL', offset: number, limit: number): string {
  const operation = format === 'ORIGINAL'
    ? `const image=pixso.getImageByHash(${JSON.stringify(id)}); if(!image)throw new Error('Image hash not found'); const bytes=await image.getBytesAsync();`
    : `const node=pixso.getNodeById(${JSON.stringify(id)}); if(!node)throw new Error('Export node not found'); const bytes=await node.exportAsync(${JSON.stringify({ format, contentsOnly: true, useAbsoluteBounds: true, ...(format === 'PNG' ? { constraint: { type: 'SCALE', value: 1 } } : {}) })});`;
  return `${operation}\nconst base64=pixso.base64Encode(bytes); ${fingerprint('base64')} return {id:${JSON.stringify(id)},fileKey:pixso.fileKey,fingerprint,total:base64.length,offset:${offset},chunk:base64.slice(${offset},${offset + limit})};`;
}

function fingerprint(variable: string): string {
  return `let h1=2166136261,h2=5381;for(let i=0;i<${variable}.length;i++){const c=${variable}.charCodeAt(i);h1=Math.imul(h1^c,16777619);h2=Math.imul(h2,33)^c;}const fingerprint=(h1>>>0).toString(16)+':'+(h2>>>0).toString(16);`;
}
