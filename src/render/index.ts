import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Capture, DesignNode, Raw } from '../types.js';

export interface RenderResult { files: string[]; warnings: string[]; nodeIds: string[] }

const number = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const px = (value: unknown): string => `${Math.round(number(value) * 10000) / 10000}px`;
const key = (id: string): string => `pixso-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
const expression = (value: string): string => `{${JSON.stringify(value)}}`;
const cssString = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, '\\a ')}"`;
const safeCss = (value: unknown): string | undefined => typeof value === 'string' && !/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(value) ? value : undefined;
const visiblePaints = (paints: unknown): Raw[] => Array.isArray(paints) ? paints.filter((paint) => paint && paint.visible !== false) : [];

export function colorToCss(color: unknown, opacity = 1): string | undefined {
  if (typeof color === 'string') return /^(#[\da-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/+-]+\)|transparent|currentColor)$/i.test(color) ? color : undefined;
  if (!color || typeof color !== 'object') return undefined;
  const value = color as Raw;
  if (![value.r, value.g, value.b].every((channel) => typeof channel === 'number' && Number.isFinite(channel))) return undefined;
  const scale = Math.max(value.r, value.g, value.b) > 1 ? 1 : 255;
  const channel = (n: number) => Math.round(Math.max(0, Math.min(255, n * scale)));
  return `rgba(${channel(value.r)}, ${channel(value.g)}, ${channel(value.b)}, ${Math.max(0, Math.min(1, number(value.a, 1) * opacity))})`;
}

function gradient(paint: Raw, warn: (message: string) => void): string | undefined {
  const stops = Array.isArray(paint.gradientStops) ? paint.gradientStops : [];
  if (!stops.length) { warn('Gradient has no stops'); return undefined; }
  const colors = stops.map((stop: Raw) => `${colorToCss(stop.color, number(paint.opacity, 1)) ?? 'transparent'} ${number(stop.position) * 100}%`).join(', ');
  const handles = paint.gradientHandlePositions;
  if (paint.type === 'GRADIENT_LINEAR') {
    if (!Array.isArray(handles) || handles.length < 2) warn('Gradient handle positions are missing; linear gradient direction is approximate');
    const start = handles?.[0] ?? { x: 0, y: 0 };
    const end = handles?.[1] ?? { x: 1, y: 0 };
    const angle = Math.atan2(number(end.y) - number(start.y), number(end.x) - number(start.x)) * 180 / Math.PI + 90;
    if (Array.isArray(handles) && (Math.abs(number(start.x)) > 0.001 || Math.abs(number(start.y)) > 0.001)) warn('Offset linear gradient handles require visual verification');
    return `linear-gradient(${angle}deg, ${colors})`;
  }
  if (paint.type === 'GRADIENT_RADIAL') {
    const center = handles?.[0] ?? { x: 0.5, y: 0.5 };
    warn('Radial gradient ellipse transform requires visual verification');
    return `radial-gradient(ellipse at ${number(center.x, 0.5) * 100}% ${number(center.y, 0.5) * 100}%, ${colors})`;
  }
  if (paint.type === 'GRADIENT_ANGULAR') { warn('Angular gradient transform requires visual verification'); return `conic-gradient(${colors})`; }
  warn(`Unsupported paint ${String(paint.type)}`);
  return undefined;
}

function textStyles(raw: Raw, warn: (message: string) => void): Record<string, string> {
  const style = { ...raw, ...raw.textStyle, ...raw.style };
  const result: Record<string, string> = {};
  const family = style.fontFamily ?? style.fontName?.family;
  if (typeof family === 'string') result['font-family'] = `${cssString(family)}, sans-serif`;
  if (typeof style.fontSize === 'number') result['font-size'] = px(style.fontSize);
  const weight = style.fontWeight ?? (/black|heavy/i.test(style.fontName?.style ?? '') ? 900 : /extra.?bold/i.test(style.fontName?.style ?? '') ? 800 : /semi.?bold|demi.?bold/i.test(style.fontName?.style ?? '') ? 600 : /bold/i.test(style.fontName?.style ?? '') ? 700 : /medium/i.test(style.fontName?.style ?? '') ? 500 : /extra.?light|ultra.?light/i.test(style.fontName?.style ?? '') ? 200 : /light/i.test(style.fontName?.style ?? '') ? 300 : /thin/i.test(style.fontName?.style ?? '') ? 100 : /regular|normal/i.test(style.fontName?.style ?? '') ? 400 : undefined);
  if (weight !== undefined && /^(?:[1-9]\d{0,2}|1000|normal|bold)$/.test(String(weight))) result['font-weight'] = String(weight);
  if (/italic|oblique/i.test(style.fontName?.style ?? style.fontStyle ?? '')) result['font-style'] = 'italic';
  const line = style.lineHeight;
  if (typeof line === 'number') result['line-height'] = px(line);
  else if (line && line.unit === 'PIXELS') result['line-height'] = px(line.value);
  else if (line && line.unit === 'PERCENT') result['line-height'] = `${number(line.value, 100)}%`;
  else if (typeof style.lineHeightPx === 'number') result['line-height'] = px(style.lineHeightPx);
  else if (line?.unit === 'AUTO') result['line-height'] = 'normal';
  else if (typeof line === 'string' && /^(normal|[\d.]+(?:px|%|em)?)$/.test(line)) result['line-height'] = line;
  const spacing = style.letterSpacing;
  if (typeof spacing === 'number') result['letter-spacing'] = px(spacing);
  else if (spacing?.unit === 'PIXELS') result['letter-spacing'] = px(spacing.value);
  else if (spacing?.unit === 'PERCENT') result['letter-spacing'] = `${number(spacing.value) / 100}em`;
  const align = String(style.textAlignHorizontal ?? style.textAlign ?? '').toLowerCase();
  if (['left', 'center', 'right', 'justify'].includes(align)) result['text-align'] = align;
  const decoration = String(style.textDecoration ?? '').toLowerCase().replace('_', '-');
  if (['underline', 'line-through', 'strikethrough', 'none'].includes(decoration)) result['text-decoration'] = decoration === 'strikethrough' ? 'line-through' : decoration;
  const textCase = String(style.textCase ?? '').toUpperCase();
  if (textCase === 'UPPER' || textCase === 'LOWER' || textCase === 'TITLE') result['text-transform'] = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[textCase];
  const paint = visiblePaints(style.fills)[0];
  const color = colorToCss(style.color) ?? (paint?.type === 'SOLID' ? colorToCss(paint.color, number(paint.opacity, 1)) : undefined);
  if (color) result.color = color;
  if (paint && paint.type !== 'SOLID') warn('Non-solid text paint requires visual verification');
  if (raw.paragraphIndent || raw.paragraphSpacing) warn('Paragraph-specific spacing requires refinement');
  return result;
}

type Matrix = [number, number, number, number, number, number];
function matrix(value: unknown): Matrix | undefined {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((row) => Array.isArray(row) && row.length === 3 && row.every((n) => typeof n === 'number' && Number.isFinite(n)))) return undefined;
  return [value[0][0], value[1][0], value[0][1], value[1][1], value[0][2], value[1][2]];
}
function relativeMatrix(child: Matrix, parent: Matrix): Matrix | undefined {
  const [a, b, c, d, e, f] = parent;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-10) return undefined;
  const inverse = [d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant];
  const [u, v, w, x, y, z] = child;
  return [inverse[0] * u + inverse[2] * v, inverse[1] * u + inverse[3] * v, inverse[0] * w + inverse[2] * x, inverse[1] * w + inverse[3] * x, inverse[0] * y + inverse[2] * z + inverse[4], inverse[1] * y + inverse[3] * z + inverse[5]];
}

/** Generates a reference-viewport baseline. GigaCode can refine this into project components. */
export async function renderCapture(capture: Capture, outputDir: string, options: { componentName?: string } = {}): Promise<RenderResult> {
  const componentName = options.componentName ?? 'PixsoScreen';
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(componentName)) throw new Error('componentName must be a PascalCase JavaScript identifier');
  if (!capture.nodes.length || !capture.roots.length) throw new Error('Capture contains no renderable roots');
  const directory = path.resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const files: string[] = [];
  const warnings = new Set<string>();
  const nodes = new Map(capture.nodes.map((node) => [node.id, node]));
  if (nodes.size !== capture.nodes.length) throw new Error('Duplicate node IDs in capture');
  const assetCssUrls = new Map<string, string>();
  const nodeAssets = new Map<string, string>();
  const assetImports: string[] = [];
  for (const asset of capture.assets) {
    if (!/^(image\/(png|jpeg|webp|gif|svg\+xml|avif))$/.test(asset.mimeType)) continue;
    const extension: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif' };
    const filename = `${key(asset.id)}${extension[asset.mimeType]}`;
    const destination = path.join(directory, 'assets', filename);
    try {
      await mkdir(path.dirname(destination), { recursive: true });
      if (path.resolve(asset.path) !== destination) await copyFile(asset.path, destination);
      files.push(destination);
      const variable = `pixsoAsset${assetImports.length}`;
      assetImports.push(`const ${variable} = new URL(${JSON.stringify(`./assets/${filename}`)}, import.meta.url).href;`);
      assetCssUrls.set(asset.id, `url(${cssString(`./assets/${filename}`)})`);
      if (asset.nodeId) nodeAssets.set(asset.nodeId, variable);
    } catch (error) { warnings.add(`Asset ${asset.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const css: string[] = ['/* Exact geometry at the captured viewport. Refine responsive rules against project patterns. */', '.pixso-capture, .pixso-capture * { box-sizing: border-box; }', '.pixso-capture { position: relative; margin: 0; padding: 0; }', '.pixso-capture > .pixso-root { position: relative; }', '.pixso-capture svg { display: block; overflow: visible; }'];
  const emitted = new Set<string>();
  const stack = new Set<string>();
  const assetImage = (paint: Raw): string | undefined => assetCssUrls.get(String(paint.imageRef ?? paint.imageHash ?? paint.imageId ?? ''));
  const addRule = (className: string, style: Record<string, string>): void => { css.push(`.${className} {\n${Object.entries(style).map(([property, value]) => `  ${property}: ${value};`).join('\n')}\n}`); };
  const compositedNodes: Record<string, string> = {};
  const render = (id: string, parent?: DesignNode, compositedBy?: string): string => {
    const node = nodes.get(id);
    if (!node) { warnings.add(`Missing child node ${id}`); return ''; }
    if (stack.has(id)) throw new Error(`Cycle in design tree at ${id}`);
    if (emitted.has(id)) throw new Error(`Node ${id} belongs to multiple parents`);
    emitted.add(id); stack.add(id);
    const raw = node.raw;
    const warn = (message: string) => warnings.add(`${node.id} (${node.name}): ${message}`);
    const className = key(id);
    const bounds = node.bounds;
    const style: Record<string, string> = { position: parent ? 'absolute' : 'relative', margin: '0', padding: '0', border: '0', 'min-width': '0', 'min-height': '0' };
    if (!bounds) warn('Node has no bounds; geometry is unverified');
    const width = number(raw.width, number(raw.size?.x, number(bounds?.width)));
    const height = number(raw.height, number(raw.size?.y, number(bounds?.height)));
    style.width = px(width); style.height = px(height);
    if (parent) {
      style.left = px(number(bounds?.x) - number(parent.bounds?.x));
      style.top = px(number(bounds?.y) - number(parent.bounds?.y));
    }
    const absolute = matrix(raw.absoluteTransform);
    const parentAbsolute = parent && matrix(parent.raw.absoluteTransform);
    const relative = parent && (absolute && parentAbsolute ? relativeMatrix(absolute, parentAbsolute) : matrix(raw.relativeTransform));
    if (relative) {
      style.left = '0px'; style.top = '0px'; style['transform-origin'] = '0 0';
      style.transform = `matrix(${relative.join(', ')})`;
    } else if (number(raw.rotation)) {
      style.transform = `rotate(${-number(raw.rotation)}deg)`;
      style['transform-origin'] = 'center';
      if (parent && bounds) {
        style.left = px(bounds.x - number(parent.bounds?.x) + (bounds.width - width) / 2);
        style.top = px(bounds.y - number(parent.bounds?.y) + (bounds.height - height) / 2);
      }
      warn('Rotation has no transform matrix; verify rotated bounds');
    }
    if (raw.visible === false || raw.hidden === true) style.display = 'none';
    if (compositedBy) { style.visibility = 'hidden'; compositedNodes[id] = compositedBy; }
    if (typeof raw.opacity === 'number') style.opacity = String(Math.max(0, Math.min(1, raw.opacity)));
    if (raw.clipsContent === true || raw.clipContent === true) style.overflow = 'hidden';
    if (raw.isMask) warn('Mask semantics require an SVG or project-specific implementation');
    if (raw.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(raw.blendMode)) {
      const blend = String(raw.blendMode).toLowerCase().replaceAll('_', '-');
      if (['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].includes(blend)) style['mix-blend-mode'] = blend;
      else warn(`Unsupported blend mode ${String(raw.blendMode)}`);
    }
    const radii = raw.rectangleCornerRadii ?? (['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius'].some((property) => typeof raw[property] === 'number') ? [raw.topLeftRadius, raw.topRightRadius, raw.bottomRightRadius, raw.bottomLeftRadius] : undefined);
    if (Array.isArray(radii) && radii.length === 4) style['border-radius'] = radii.map(px).join(' ');
    else if (typeof raw.cornerRadius === 'number') style['border-radius'] = px(raw.cornerRadius);
    if (node.type === 'ELLIPSE') style['border-radius'] = '50%';
    if (node.type === 'ELLIPSE' && raw.arcData && (number(raw.arcData.innerRadius) > 0 || Math.abs(number(raw.arcData.endingAngle, Math.PI * 2) - number(raw.arcData.startingAngle) - Math.PI * 2) > 0.001)) warn('Partial ellipse arcs require an exported SVG asset');
    if (number(raw.cornerSmoothing)) warn('Corner smoothing is unsupported in plain CSS');
    const shadows: string[] = [];
    for (const effect of Array.isArray(raw.effects) ? raw.effects : []) {
      if (effect.visible === false) continue;
      if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') shadows.push(`${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(effect.offset?.x)} ${px(effect.offset?.y)} ${px(effect.radius)} ${px(effect.spread)} ${colorToCss(effect.color) ?? 'transparent'}`);
      else if (effect.type === 'LAYER_BLUR') style.filter = `blur(${px(effect.radius)})`;
      else if (effect.type === 'BACKGROUND_BLUR') style['backdrop-filter'] = `blur(${px(effect.radius)})`;
      else warn(`Unsupported effect ${String(effect.type)}`);
    }
    if (shadows.length) style['box-shadow'] = shadows.join(', ');
    const paints = visiblePaints(raw.fills ?? raw.backgrounds);
    const strokes = visiblePaints(raw.strokes);
    const isText = node.type === 'TEXT';
    const vectorPaths: Raw[] = Array.isArray(raw.vectorPaths) ? raw.vectorPaths : Array.isArray(raw.fillGeometry) ? raw.fillGeometry : [];
    const isVector = vectorPaths.length > 0;
    const illustration = ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'].includes(node.type);
    let content = '';
    if (isText) {
      if (raw.hasMissingFont) warn('Pixso reports a missing font');
      Object.assign(style, { 'white-space': 'pre-wrap', 'overflow-wrap': 'break-word', ...textStyles(raw, warn) });
      const vertical = String(raw.textAlignVertical ?? '').toUpperCase();
      if (vertical === 'CENTER' || vertical === 'BOTTOM') { style.display = raw.visible === false || raw.hidden === true ? 'none' : 'flex'; style['flex-direction'] = 'column'; style['justify-content'] = vertical === 'CENTER' ? 'center' : 'flex-end'; }
      const text = typeof raw.characters === 'string' ? raw.characters : typeof raw.text === 'string' ? raw.text : typeof raw.content === 'string' ? raw.content : '';
      const segments: Raw[] = Array.isArray(raw.styledTextSegments) ? raw.styledTextSegments : Array.isArray(raw.textSegments) ? raw.textSegments : Array.isArray(raw.textRuns) ? raw.textRuns : [];
      const ranged = segments.length > 0 && segments.every((segment) => Number.isInteger(segment.start) && Number.isInteger(segment.end) && segment.start >= 0 && segment.end >= segment.start && segment.end <= text.length);
      if (ranged) {
        let offset = 0;
        for (const [index, segment] of [...segments].sort((a, b) => a.start - b.start).entries()) {
          if (segment.start < offset) { warn('Overlapping text segments were ignored'); continue; }
          if (segment.start > offset) content += expression(text.slice(offset, segment.start));
          const runClass = `${className}-run-${index}`;
          addRule(runClass, textStyles(segment, warn));
          content += `<span className="${runClass}">${expression(text.slice(segment.start, segment.end))}</span>`;
          offset = segment.end;
        }
        if (offset < text.length) content += expression(text.slice(offset));
      } else { content = expression(text); if (segments.length) warn('Invalid text ranges; base text style retained'); }
      if (Array.isArray(raw.characterStyleOverrides) && raw.characterStyleOverrides.length && !segments.length) warn('Character style overrides require styled text segments');
      if (vertical === 'CENTER' || vertical === 'BOTTOM') content = `<span>${content}</span>`;
    } else if (illustration && nodeAssets.has(id)) {
      if (number(raw.opacity, 1) !== 1 || number(raw.rotation) || (Array.isArray(raw.effects) && raw.effects.some((effect: Raw) => effect.visible !== false))) warn('Exported illustration may include opacity, rotation or effects already; verify against reference to avoid double application');
      content = `<img className="${className}-asset" src={${nodeAssets.get(id)}} alt="" aria-hidden="true" />`;
      addRule(`${className}-asset`, { display: 'block', width: '100%', height: '100%', 'object-fit': 'fill' });
    } else if (isVector) {
      const firstPaint = paints[0];
      const fill = firstPaint?.type === 'SOLID' ? colorToCss(firstPaint.color, number(firstPaint.opacity, 1)) ?? 'none' : 'none';
      if (paints.length > 1 || (firstPaint && firstPaint.type !== 'SOLID')) warn('Vector non-solid or layered fills need an exported SVG asset');
      if (strokes.length > 1 || (strokes[0] && strokes[0].type !== 'SOLID')) warn('Vector non-solid or layered strokes need an exported SVG asset');
      const stroke = strokes[0]?.type === 'SOLID' ? colorToCss(strokes[0].color, number(strokes[0].opacity, 1)) ?? 'none' : 'none';
      const strokeWidth = number(raw.strokeWeight, 1);
      if (raw.strokeAlign && raw.strokeAlign !== 'CENTER' && stroke !== 'none') warn('SVG stroke alignment defaults to center; export an SVG asset for exact outlined strokes');
      content = `<svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" aria-hidden="true">${vectorPaths.map((item) => `<path d=${expression(String(item.data ?? item.path ?? ''))} fill=${expression(fill)} fillRule="${item.windingRule === 'EVENODD' ? 'evenodd' : 'nonzero'}" stroke=${expression(stroke)} strokeWidth={${strokeWidth}} />`).join('')}</svg>`;
    } else {
      const backgrounds: string[] = [];
      if (paints.filter((paint) => paint.type === 'IMAGE').length > 1) warn('Multiple image fills with independent crop modes require refinement');
      for (const paint of [...paints].reverse()) {
        if (paint.type === 'SOLID') { const color = colorToCss(paint.color, number(paint.opacity, 1)); if (color) { if (paints.length === 1) style['background-color'] = color; else backgrounds.push(`linear-gradient(${color}, ${color})`); } }
        else if (paint.type === 'IMAGE') {
          const image = assetImage(paint);
          if (image) {
            backgrounds.push(image);
            style['background-size'] = paint.scaleMode === 'FIT' ? 'contain' : paint.scaleMode === 'TILE' ? 'auto' : 'cover';
            style['background-repeat'] = paint.scaleMode === 'TILE' ? 'repeat' : 'no-repeat';
            style['background-position'] = 'center';
            if (paint.imageTransform || paint.rotation || number(paint.opacity, 1) !== 1 || paint.filters) warn('Image crop, opacity or filter requires visual refinement');
          } else warn(`Missing image asset ${String(paint.imageRef ?? paint.imageHash ?? paint.imageId ?? '')}`);
        } else { const value = gradient(paint, warn); if (value) backgrounds.push(value); }
      }
      if (backgrounds.length) style['background-image'] = backgrounds.join(', ');
      if (illustration) warn('Vector geometry and exported illustration asset are missing');
      if (strokes.length) {
        const stroke = strokes[0];
        if (strokes.length > 1) warn('Multiple strokes need an exported vector or CSS refinement');
        if (stroke.type === 'SOLID') {
          const strokeColor = colorToCss(stroke.color, number(stroke.opacity, 1)) ?? 'transparent';
          const thickness = number(raw.strokeWeight, 1);
          const dashed = Array.isArray(raw.dashPattern) && raw.dashPattern.length > 0;
          if (raw.strokeAlign === 'OUTSIDE') { style.outline = `${px(thickness)} ${dashed ? 'dashed' : 'solid'} ${strokeColor}`; style['outline-offset'] = '0px'; }
          else if (raw.strokeAlign === 'CENTER') { style.outline = `${px(thickness)} ${dashed ? 'dashed' : 'solid'} ${strokeColor}`; style['outline-offset'] = px(-thickness / 2); }
          else if (dashed) { style.border = `${px(thickness)} dashed ${strokeColor}`; warn('Dashed inside border changes the containing box; verify child positions'); }
          else style['box-shadow'] = [`inset 0 0 0 ${px(thickness)} ${strokeColor}`, style['box-shadow']].filter(Boolean).join(', ');
          if (['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'].some((property) => typeof raw[property] === 'number' && raw[property] !== thickness)) warn('Individual edge stroke widths need CSS refinement');
        } else warn('Non-solid border paint needs CSS refinement');
      }
    }
    const cssProperties: Record<string, string> = { backgroundColor: 'background-color', color: 'color', fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight', lineHeight: 'line-height', letterSpacing: 'letter-spacing', textAlign: 'text-align', borderRadius: 'border-radius', boxShadow: 'box-shadow', overflow: 'overflow' };
    for (const [property, target] of Object.entries(cssProperties)) {
      const value = raw.css?.[property] ?? raw.css?.[target];
      if (typeof value === 'number') style[target] = ['font-weight', 'line-height'].includes(target) ? String(value) : px(value);
      else { const clean = safeCss(value); if (clean !== undefined) style[target] = clean; }
    }
    addRule(className, style);
    // Boolean operands remain indexed with their geometry, but the composed SVG already draws them.
    const flattened = (illustration && nodeAssets.has(id)) || isVector;
    const childMarkup = node.children.map((child) => render(child, node, compositedBy ?? (flattened ? id : undefined))).join('\n');
    if (isText && node.children.length) warn('Text node unexpectedly contains children');
    stack.delete(id);
    return `<div className="${className}${parent ? '' : ' pixso-root'}" data-pixso-id=${expression(id)} data-pixso-name=${expression(node.name)}${compositedBy ? ` data-pixso-composited-by=${expression(compositedBy)}` : ''}>${content}${childMarkup}</div>`;
  };
  const markup = capture.roots.map((id) => render(id)).join('\n');
  const unreachable = capture.nodes.filter((node) => !emitted.has(node.id));
  if (unreachable.length) warnings.add(`${unreachable.length} nodes are outside the selected root trees`);
  if (capture.completeness.status !== 'complete') warnings.add(`Capture completeness is ${capture.completeness.status}; full transfer is unverified`);
  const tsxPath = path.join(directory, `${componentName}.tsx`);
  const cssPath = path.join(directory, `${componentName}.css`);
  const metadataPath = path.join(directory, 'render-report.json');
  await writeFile(tsxPath, `import './${componentName}.css';\n${assetImports.join('\n')}\n\nexport default function ${componentName}() {\n  return <div className="pixso-capture">\n${markup}\n  </div>;\n}\n`, 'utf8');
  await writeFile(cssPath, `${css.join('\n\n')}\n`, 'utf8');
  const report = { schemaVersion: 1, mode: 'reference-viewport', componentName, nodeIds: [...emitted], compositedNodes, warnings: [...warnings], source: capture.source, complete: false, validationRequired: true };
  await writeFile(metadataPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  files.push(tsxPath, cssPath, metadataPath);
  return { files, warnings: [...warnings], nodeIds: [...emitted] };
}
