import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Bounds, DesignNode, Raw } from '../types.js';
import { colorToCss } from '../render/index.js';

export interface ValidateOptions {
  url: string;
  rootNodeId: string;
  nodes: DesignNode[];
  referencePath?: string;
  outputDir: string;
  viewport: { width: number; height: number };
  maxPixelDiffRatio?: number;
  geometryTolerancePx?: number;
  browserChannel?: string;
  executablePath?: string;
  mode?: 'pixel-perfect' | 'tolerant';
}
export interface ValidationIssue { nodeId?: string; kind: string; property?: string; expected?: unknown; actual?: unknown; message: string }
export interface ValidationReport {
  schemaVersion: 1;
  status: 'passed' | 'failed' | 'geometry-only';
  complete: boolean;
  pixelPerfect: boolean;
  comparison: { mode: 'pixel-perfect' | 'tolerant'; algorithm: 'decoded-rgba-exact' | 'pixelmatch-perceptual'; maxPixelDiffRatio: number; geometryTolerancePx: number; channelThreshold: number; antiAliasingIgnored: boolean };
  rootNodeId: string;
  url: string;
  viewport: { width: number; height: number };
  checkedNodeCount: number;
  missingNodeIds: string[];
  extraNodeIds: string[];
  issues: ValidationIssue[];
  warnings: string[];
  pixelDiffRatio?: number;
  exactPixelDiffRatio?: number;
  pixelDiffPixels?: number;
  maxChannelDiff?: number;
  diffBounds?: Bounds;
  stability?: { stable: boolean; domStable: boolean; changedPixels?: number; intervalMs: number; firstScreenshotPath: string; secondScreenshotPath: string; diffPath?: string };
  fonts?: { loadedFaces: { family: string; status: string }[]; nodes: { nodeId: string; requestedFamily?: string; cssFamily: string; platformFonts?: { familyName: string; isCustomFont: boolean; glyphCount: number }[] }[]; inspectionError?: string };
  screenshotPath: string;
  referencePath?: string;
  diffPath?: string;
  reportPath: string;
}

export function assertLocalUrl(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) || url.username || url.password) throw new Error('Validation URL must be an HTTP(S) loopback address (localhost, 127.0.0.1 or [::1])');
  return url;
}

function canonical(value: string): string {
  if (value.toLowerCase() === 'transparent') return '0,0,0,0';
  if (/^#[a-f\d]{3,8}$/i.test(value)) {
    let hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((character) => character + character).join('');
    if (hex.length === 6 || hex.length === 8) return `${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${hex.length === 8 ? Math.round(parseInt(hex.slice(6, 8), 16) / 255 * 1000) / 1000 : 1}`;
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (rgba) return `${Number(rgba[1])},${Number(rgba[2])},${Number(rgba[3])},${rgba[4] === undefined ? 1 : Number(rgba[4])}`;
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function expectedStyles(node: DesignNode): Record<string, string> {
  const raw = node.raw;
  const result: Record<string, string> = {};
  const style = { ...raw, ...raw.textStyle, ...raw.style };
  if (typeof raw.opacity === 'number') result.opacity = String(raw.opacity);
  if (raw.clipsContent === true) result.overflow = 'hidden';
  if (typeof raw.cornerRadius === 'number') result.borderTopLeftRadius = `${raw.cornerRadius}px`;
  const paints: Raw[] = Array.isArray(raw.fills ?? raw.backgrounds) ? (raw.fills ?? raw.backgrounds).filter((paint: Raw) => paint.visible !== false) : [];
  if (paints.length === 1 && paints[0].type === 'SOLID' && !['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'].includes(node.type)) {
    const color = colorToCss(paints[0].color, typeof paints[0].opacity === 'number' ? paints[0].opacity : 1);
    if (color) result[node.type === 'TEXT' ? 'color' : 'backgroundColor'] = color;
  }
  if (node.type === 'TEXT') {
    if (typeof style.fontSize === 'number') result.fontSize = `${style.fontSize}px`;
    if (typeof style.fontWeight === 'number') result.fontWeight = String(style.fontWeight);
    const lineHeight = style.lineHeight;
    if (typeof lineHeight === 'number') result.lineHeight = `${lineHeight}px`;
    else if (lineHeight?.unit === 'PIXELS') result.lineHeight = `${lineHeight.value}px`;
    else if (typeof style.lineHeightPx === 'number') result.lineHeight = `${style.lineHeightPx}px`;
    const align = String(style.textAlignHorizontal ?? style.textAlign ?? '').toLowerCase();
    if (['left', 'center', 'right', 'justify'].includes(align)) result.textAlign = align;
  }
  return result;
}

export function compareGeometry(expected: Bounds, actual: Bounds, tolerance: number, nodeId: string): ValidationIssue[] {
  return (['x', 'y', 'width', 'height'] as const).filter((property) => Math.abs(expected[property] - actual[property]) > tolerance).map((property) => ({ nodeId, kind: 'geometry', property, expected: expected[property], actual: actual[property], message: `${property} differs by ${Math.abs(expected[property] - actual[property]).toFixed(3)}px (tolerance ${tolerance}px)` }));
}

async function protectReference(referencePath: string, outputs: string[]): Promise<void> {
  const referenceReal = await realpath(referencePath);
  const referenceStat = await stat(referencePath);
  for (const output of outputs) {
    if (path.resolve(referencePath) === path.resolve(output)) throw new Error('Reference path must differ from validation outputs');
    try {
      const outputReal = await realpath(output);
      const outputStat = await stat(output);
      if (outputReal === referenceReal || (referenceStat.ino !== 0 && referenceStat.dev === outputStat.dev && referenceStat.ino === outputStat.ino)) throw new Error('Reference path must differ from validation outputs, including symlinks and hardlinks');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export interface PngComparison {
  ratio: number; sameDimensions: boolean; mode: 'pixel-perfect' | 'tolerant';
  exactRatio?: number; exactChangedPixels?: number; maxChannelDiff?: number; diffBounds?: Bounds;
  reference: { width: number; height: number }; actual: { width: number; height: number };
}

export async function comparePngFiles(referencePath: string, actualPath: string, diffPath: string, options: { mode?: 'pixel-perfect' | 'tolerant' } = {}): Promise<PngComparison> {
  const mode = options.mode ?? 'pixel-perfect';
  if (!['pixel-perfect', 'tolerant'].includes(mode)) throw new Error('Unknown pixel comparison mode');
  await protectReference(referencePath, [diffPath, actualPath]);
  const reference = PNG.sync.read(await readFile(referencePath));
  const actual = PNG.sync.read(await readFile(actualPath));
  const sameDimensions = reference.width === actual.width && reference.height === actual.height;
  if (!sameDimensions) return { ratio: 1, sameDimensions, mode, reference: { width: reference.width, height: reference.height }, actual: { width: actual.width, height: actual.height } };
  const diff = new PNG({ width: actual.width, height: actual.height });
  let exactChangedPixels = 0, maxChannelDiff = 0, minX = actual.width, minY = actual.height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < actual.width * actual.height; pixel++) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(reference.data[pixel * 4 + channel] - actual.data[pixel * 4 + channel]);
      maxChannelDiff = Math.max(maxChannelDiff, delta); if (delta !== 0) changed = true;
    }
    if (changed) {
      exactChangedPixels++;
      const x = pixel % actual.width, y = Math.floor(pixel / actual.width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      diff.data[pixel * 4] = 255; diff.data[pixel * 4 + 3] = 255;
    }
  }
  const changed = mode === 'pixel-perfect' ? exactChangedPixels : pixelmatch(reference.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0.1, includeAA: false });
  await mkdir(path.dirname(diffPath), { recursive: true });
  await writeFile(diffPath, PNG.sync.write(diff));
  return { ratio: changed / (actual.width * actual.height), exactRatio: exactChangedPixels / (actual.width * actual.height), exactChangedPixels, maxChannelDiff, diffBounds: exactChangedPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : undefined, sameDimensions, mode, reference: { width: reference.width, height: reference.height }, actual: { width: actual.width, height: actual.height } };
}

export async function validateScreen(options: ValidateOptions): Promise<ValidationReport> {
  assertLocalUrl(options.url);
  if (!Number.isInteger(options.viewport.width) || !Number.isInteger(options.viewport.height) || options.viewport.width < 1 || options.viewport.height < 1 || options.viewport.width > 16384 || options.viewport.height > 16384) throw new Error('Viewport dimensions must be integer pixels between 1 and 16384');
  const mode = options.mode ?? 'pixel-perfect';
  if (!['pixel-perfect', 'tolerant'].includes(mode)) throw new Error('mode must be pixel-perfect or tolerant');
  const requestedRatio = options.maxPixelDiffRatio ?? 0.01, requestedGeometry = options.geometryTolerancePx ?? 1;
  if (!Number.isFinite(requestedRatio) || requestedRatio < 0 || requestedRatio > 1) throw new Error('maxPixelDiffRatio must be between 0 and 1');
  if (!Number.isFinite(requestedGeometry) || requestedGeometry < 0) throw new Error('geometryTolerancePx must be non-negative');
  const maxPixelDiffRatio = mode === 'pixel-perfect' ? 0 : requestedRatio;
  // DOM bounds are floating point; this allows only serialization rounding, never image differences.
  const geometryTolerance = mode === 'pixel-perfect' ? Math.min(requestedGeometry, 0.01) : requestedGeometry;
  const root = options.nodes.find((node) => node.id === options.rootNodeId);
  if (!root?.bounds) throw new Error('Root node with bounds is required for geometry validation');
  if (new Set(options.nodes.map((node) => node.id)).size !== options.nodes.length) throw new Error('Duplicate design node IDs');
  const directory = path.resolve(options.outputDir);
  const screenshotPath = path.join(directory, 'actual.png');
  const diffPath = path.join(directory, 'diff.png');
  const firstScreenshotPath = path.join(directory, 'actual-before.png');
  const stabilityDiffPath = path.join(directory, 'stability-diff.png');
  const reportPath = path.join(directory, 'validation.json');
  if (options.referencePath && [screenshotPath, diffPath, reportPath, firstScreenshotPath, stabilityDiffPath].includes(path.resolve(options.referencePath))) throw new Error('Reference path must differ from validation outputs');
  if (options.referencePath) await protectReference(options.referencePath, [screenshotPath, diffPath, reportPath, firstScreenshotPath, stabilityDiffPath]);
  await mkdir(directory, { recursive: true });
  const report: ValidationReport = { schemaVersion: 1, status: 'failed', complete: false, pixelPerfect: false, comparison: { mode, algorithm: mode === 'pixel-perfect' ? 'decoded-rgba-exact' : 'pixelmatch-perceptual', maxPixelDiffRatio, geometryTolerancePx: geometryTolerance, channelThreshold: mode === 'pixel-perfect' ? 0 : 0.1, antiAliasingIgnored: mode === 'tolerant' }, rootNodeId: options.rootNodeId, url: options.url, viewport: options.viewport, checkedNodeCount: 0, missingNodeIds: [], extraNodeIds: [], issues: [], warnings: [], screenshotPath, referencePath: options.referencePath && path.resolve(options.referencePath), reportPath };
  if (mode === 'tolerant') report.warnings.push('Tolerant comparison is diagnostic only and cannot establish pixel-perfect completion');
  const byId = new Map(options.nodes.map((node) => [node.id, node]));
  const hidden = (node: DesignNode): boolean => {
    const visited = new Set<string>();
    let current: DesignNode | undefined = node;
    while (current && !visited.has(current.id)) {
      if (current.raw.visible === false || current.raw.hidden === true) return true;
      visited.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, channel: options.browserChannel, executablePath: options.executablePath });
    const page = await browser.newPage({ viewport: options.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    page.on('pageerror', (error) => report.issues.push({ kind: 'runtime', message: error.message }));
    page.on('response', (response) => { if (response.status() >= 400) report.issues.push({ kind: 'http', message: `${response.status()} ${response.url()}` }); });
    page.on('requestfailed', (request) => report.issues.push({ kind: 'network', message: `${request.url()}: ${request.failure()?.errorText ?? 'failed'}` }));
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try { assertLocalUrl(request.url()); } catch { report.issues.push({ kind: 'navigation', message: 'Blocked redirect away from loopback URL' }); await route.abort(); return; }
      }
      await route.continue();
    });
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assertLocalUrl(page.url());
    try {
      await page.waitForFunction((rootId) => Array.from(document.querySelectorAll<HTMLElement>('[data-pixso-id]')).some((element) => element.dataset.pixsoId === rootId), options.rootNodeId, { timeout: 15_000 });
    } catch { report.issues.push({ nodeId: options.rootNodeId, kind: 'readiness', message: 'Screen root did not mount within 15 seconds' }); }
    const readiness = await page.evaluate(async () => {
      const errors: string[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([document.fonts.ready, new Promise<void>((resolve) => { timer = setTimeout(() => { errors.push('Fonts did not settle within 15 seconds'); resolve(); }, 15_000); })]);
      if (timer) clearTimeout(timer);
      await Promise.all(Array.from(document.images).map(async (image) => {
        try { if (!image.complete) await Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000))]); if (image.naturalWidth === 0) errors.push(`Image failed: ${image.currentSrc || image.src}`); }
        catch { errors.push(`Image failed to decode: ${image.currentSrc || image.src}`); }
      }));
      const backgrounds = new Set<string>();
      for (const element of Array.from(document.querySelectorAll('*'))) {
        for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) backgrounds.add(match[1]);
      }
      await Promise.all([...backgrounds].map(async (url) => {
        const image = new Image(); image.src = url;
        try { await Promise.race([image.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000))]); }
        catch { errors.push(`Background image failed to decode: ${url}`); }
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const loadedFaces: { family: string; status: string }[] = [];
      document.fonts.forEach((face) => { loadedFaces.push({ family: face.family, status: face.status }); if (face.status === 'error') errors.push(`Font face failed to load: ${face.family}`); });
      return { errors, loadedFaces };
    });
    readiness.errors.forEach((message) => report.issues.push({ kind: 'readiness', message }));
    report.fonts = { loadedFaces: readiness.loadedFaces, nodes: [] };
    const observe = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-pixso-id]')).map((element) => {
      const rect = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const styles: Record<string, string> = {};
      for (const property of ['opacity', 'overflow', 'borderTopLeftRadius', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'fontFamily', 'display', 'visibility']) styles[property] = String(computed[property as keyof CSSStyleDeclaration]);
      return { id: element.dataset.pixsoId!, compositedBy: element.dataset.pixsoCompositedBy, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles, text: element.textContent ?? '' };
    }));
    const observations = await observe();
    const actualById = new Map(observations.map((item) => [item.id, item]));
    const actualRoot = actualById.get(options.rootNodeId);
    const duplicates = [...new Set(observations.map((item) => item.id).filter((id, index, all) => all.indexOf(id) !== index))];
    duplicates.forEach((nodeId) => report.issues.push({ nodeId, kind: 'duplicate', message: 'Multiple DOM elements use this data-pixso-id' }));
    report.missingNodeIds = options.nodes.filter((node) => !actualById.has(node.id)).map((node) => node.id);
    report.extraNodeIds = [...actualById.keys()].filter((id) => !byId.has(id));
    report.missingNodeIds.forEach((nodeId) => report.issues.push({ nodeId, kind: 'missing', message: 'Node has no DOM element with data-pixso-id' }));
    report.extraNodeIds.forEach((nodeId) => report.issues.push({ nodeId, kind: 'extra', message: 'DOM node is absent from the captured design' }));
    for (const node of options.nodes) {
      const actual = actualById.get(node.id);
      if (!actual || !actualRoot) continue;
      report.checkedNodeCount++;
      if (hidden(node)) {
        if (actual.bounds.width > 0 && actual.bounds.height > 0 && actual.styles.display !== 'none' && actual.styles.visibility !== 'hidden') report.issues.push({ nodeId: node.id, kind: 'visibility', message: 'Design node is hidden but DOM node is visible' });
        continue;
      }
      let composed = false;
      if (actual.compositedBy) {
        const seen = new Set<string>();
        let ancestor = node.parentId ? byId.get(node.parentId) : undefined;
        while (ancestor && !seen.has(ancestor.id)) {
          if (ancestor.id === actual.compositedBy && (['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'].includes(ancestor.type) || Array.isArray(ancestor.raw.vectorPaths) || Array.isArray(ancestor.raw.fillGeometry))) composed = true;
          seen.add(ancestor.id); ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
        }
        if (!composed) report.issues.push({ nodeId: node.id, kind: 'composition', message: 'Node claims an unrelated or unsupported flattened ancestor' });
      }
      if (!composed && (actual.styles.display === 'none' || actual.styles.visibility === 'hidden')) report.issues.push({ nodeId: node.id, kind: 'visibility', message: 'Visible design node is hidden in the DOM' });
      if (!node.bounds) { report.issues.push({ nodeId: node.id, kind: 'geometry', message: 'Design node is missing bounds' }); continue; }
      const expected = { x: node.bounds.x - root.bounds.x, y: node.bounds.y - root.bounds.y, width: node.bounds.width, height: node.bounds.height };
      const relativeActual = { ...actual.bounds, x: actual.bounds.x - actualRoot.bounds.x, y: actual.bounds.y - actualRoot.bounds.y };
      report.issues.push(...compareGeometry(expected, relativeActual, geometryTolerance, node.id));
      for (const [property, expectedValue] of Object.entries(expectedStyles(node))) {
        const actualValue = actual.styles[property] ?? '';
        const numericMatch = /^[-\d.]+px$/.test(expectedValue) && /^[-\d.]+px$/.test(actualValue) && Math.abs(parseFloat(expectedValue) - parseFloat(actualValue)) < 0.05;
        if (!numericMatch && canonical(expectedValue) !== canonical(actualValue)) report.issues.push({ nodeId: node.id, kind: 'style', property, expected: expectedValue, actual: actualValue, message: `Computed ${property} differs from design` });
      }
      if (node.type === 'TEXT') {
        const expectedText = typeof node.raw.characters === 'string' ? node.raw.characters : typeof node.raw.text === 'string' ? node.raw.text : typeof node.raw.content === 'string' ? node.raw.content : undefined;
        if (expectedText !== undefined && actual.text !== expectedText) report.issues.push({ nodeId: node.id, kind: 'text', expected: expectedText, actual: actual.text, message: 'Rendered text differs from design' });
        const typography = { ...node.raw, ...node.raw.textStyle, ...node.raw.style };
        const requestedFamily = typeof typography.fontFamily === 'string' ? typography.fontFamily : typeof typography.fontName?.family === 'string' ? typography.fontName.family : undefined;
        report.fonts.nodes.push({ nodeId: node.id, requestedFamily, cssFamily: actual.styles.fontFamily });
        const familyKey = (value: string) => value.trim().replace(/^["']|["']$/g, '').toLowerCase();
        if (requestedFamily && familyKey(actual.styles.fontFamily.split(',')[0]) !== familyKey(requestedFamily)) report.issues.push({ nodeId: node.id, kind: 'font', expected: requestedFamily, actual: actual.styles.fontFamily, message: 'CSS font family differs from the captured font' });
        if (node.raw.hasMissingFont === true) report.issues.push({ nodeId: node.id, kind: 'font', message: 'Pixso reported a missing source font' });
      }
    }
    try {
      const session = await page.context().newCDPSession(page);
      await session.send('DOM.enable'); await session.send('CSS.enable');
      const document = await session.send('DOM.getDocument');
      const selectors = await page.evaluate((ids) => ids.map((id) => ({ id, selector: `[data-pixso-id="${CSS.escape(id)}"]` })), report.fonts.nodes.map((item) => item.nodeId));
      for (const item of selectors) {
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: item.selector });
        if (!nodeId) continue;
        const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
        const evidence = report.fonts.nodes.find((font) => font.nodeId === item.id)!;
        evidence.platformFonts = fonts;
        const requested = evidence.requestedFamily?.replace(/["']/g, '').trim().toLowerCase();
        const used = fonts.filter((font) => font.glyphCount > 0);
        const declared = report.fonts.loadedFaces.some((face) => face.family.replace(/["']/g, '').trim().toLowerCase() === requested && face.status === 'loaded');
        if (requested && !['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy'].includes(requested) && used.length && !used.some((font) => (font.isCustomFont && declared) || font.familyName.toLowerCase() === requested)) report.issues.push({ nodeId: item.id, kind: 'font', expected: requested, actual: used.map((font) => font.familyName), message: 'Chromium used fallback platform fonts instead of the requested family' });
      }
      await session.detach();
    } catch (error) { report.fonts.inspectionError = error instanceof Error ? error.message : String(error); report.warnings.push('Platform-font inspection was unavailable; font identity is not independently established'); }
    const structural = await page.evaluate(({ sourceNodes, rootId }) => {
      const issues: { nodeId?: string; kind: string; message: string; expected?: unknown; actual?: unknown }[] = [];
      const sources = new Map(sourceNodes.map((node) => [node.id, node]));
      const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-pixso-id]'));
      const rootElement = elements.find((element) => element.dataset.pixsoId === rootId);
      if (!rootElement) return issues;
      const rootRect = rootElement.getBoundingClientRect();
      const helpers = {
        opacity(element: Element): number {
        let value = 1; let current: Element | null = element;
        while (current) { const style = getComputedStyle(current); if (style.display === 'none' || style.visibility === 'hidden') return 0; value *= Number(style.opacity); current = current.parentElement; }
        return value;
        },
        expectedOpacity(id: string): number {
        let result = 1, current = sources.get(id); const seen = new Set<string>();
        while (current && !seen.has(current.id)) { seen.add(current.id); if (current.hidden) return 0; result *= current.opacity; current = current.parentId ? sources.get(current.parentId) : undefined; }
        return result;
        },
        intersection(a: DOMRect, b: DOMRect): number { return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)); }
      };
      const targets: { element: HTMLElement; id: string; rect: DOMRect }[] = [];
      for (const element of elements) {
        const id = element.dataset.pixsoId!, source = sources.get(id);
        if (!source || helpers.expectedOpacity(id) === 0 || element.dataset.pixsoCompositedBy) continue;
        if (Math.abs(helpers.opacity(element) - helpers.expectedOpacity(id)) > 0.005) issues.push({ nodeId: id, kind: 'occlusion', message: 'Effective ancestor opacity/visibility differs from the source', expected: helpers.expectedOpacity(id), actual: helpers.opacity(element) });
        const controls = element.matches('button,input,select,textarea,a[href],[role="button"],[role="checkbox"],[role="link"]') ? [element] : Array.from(element.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[role="button"],[role="checkbox"],[role="link"]')).filter((control) => control.closest('[data-pixso-id]') === element);
        for (const control of controls) targets.push({ element: control, id, rect: control.getBoundingClientRect() });
        if (source.type === 'TEXT' && element.textContent?.trim()) {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let text: Node | null;
          while ((text = walker.nextNode())) {
            if (!text.textContent?.trim() || !text.parentElement) continue;
            const range = document.createRange(); range.selectNodeContents(text);
            const rect = range.getBoundingClientRect();
            if (!rect.width || !rect.height || helpers.opacity(text.parentElement) + 0.005 < helpers.expectedOpacity(id)) issues.push({ nodeId: id, kind: 'occlusion', message: 'Text content is hidden or has no visible layout box' });
            else targets.push({ element: text.parentElement, id, rect });
          }
        }
      }
      for (const target of targets) {
        const x = target.rect.x + target.rect.width / 2, y = target.rect.y + target.rect.height / 2;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const top = document.elementFromPoint(x, y);
        if (top && top !== target.element && !target.element.contains(top) && !top.contains(target.element)) issues.push({ nodeId: target.id, kind: 'occlusion', message: 'Text or control is covered by an unrelated DOM element', actual: top.tagName.toLowerCase() });
      }
      const emitted = new Set<Element>();
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
        const style = getComputedStyle(element), tag = element.tagName.toLowerCase();
        if (!['img', 'canvas', 'image'].includes(tag) && !/url\(/.test(style.backgroundImage) && !/url\(/.test(style.content)) continue;
        if (helpers.opacity(element) === 0) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const id = element.closest<HTMLElement>('[data-pixso-id]')?.dataset.pixsoId;
        const source = id ? sources.get(id) : undefined;
        const sourceGraphic = source?.graphic && source.bounds && rect.width <= source.bounds.width + 1 && rect.height <= source.bounds.height + 1;
        if (sourceGraphic) continue;
        const coversScreen = rootRect.width * rootRect.height > 0 && helpers.intersection(rect, rootRect) >= rootRect.width * rootRect.height * 0.9;
        const coversText = targets.some((target) => !element.contains(target.element) && helpers.intersection(rect, target.rect) > target.rect.width * target.rect.height * 0.5);
        if ((coversScreen || coversText) && !emitted.has(element)) { emitted.add(element); issues.push({ nodeId: id, kind: 'overlay', message: 'Unmapped image/canvas/background covers the screen or text; screenshots cannot substitute for source UI', actual: { tag, width: rect.width, height: rect.height } }); }
      }
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (style.content === 'none' || style.display === 'none' || Number(style.opacity) === 0 || (!/url\(/.test(style.backgroundImage) && !/url\(/.test(style.content)) || helpers.opacity(element) === 0) continue;
        const parent = element.getBoundingClientRect(), width = parseFloat(style.width) || parent.width, height = parseFloat(style.height) || parent.height;
        const rect = new DOMRect((style.position === 'fixed' ? 0 : parent.x) + (parseFloat(style.left) || 0), (style.position === 'fixed' ? 0 : parent.y) + (parseFloat(style.top) || 0), width, height);
        const id = element.closest<HTMLElement>('[data-pixso-id]')?.dataset.pixsoId, source = id ? sources.get(id) : undefined;
        if (source?.graphic && source.bounds && width <= source.bounds.width + 1 && height <= source.bounds.height + 1) continue;
        if (rootRect.width * rootRect.height > 0 && helpers.intersection(rect, rootRect) >= rootRect.width * rootRect.height * 0.9) issues.push({ nodeId: id, kind: 'overlay', message: 'Unmapped pseudo-element image covers the screen', actual: pseudo });
      }
      return issues;
    }, { rootId: options.rootNodeId, sourceNodes: options.nodes.map((node) => ({ id: node.id, parentId: node.parentId, type: node.type, bounds: node.bounds, opacity: typeof node.raw.opacity === 'number' ? node.raw.opacity : 1, hidden: hidden(node), graphic: ['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE'].includes(node.type) || (Array.isArray(node.raw.fills ?? node.raw.backgrounds) && (node.raw.fills ?? node.raw.backgrounds).some((paint: Raw) => paint.type === 'IMAGE')) })) });
    report.issues.push(...structural);
    report.warnings.push('Occlusion and source-image checks are structural heuristics; they do not prove arbitrary application behavior or exclude every possible CSS/JavaScript substitution');
    await page.screenshot({ path: firstScreenshotPath, fullPage: false, animations: 'disabled', caret: 'hide', omitBackground: true });
    await page.waitForTimeout(150);
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: 'disabled', caret: 'hide', omitBackground: true });
    const stable = await comparePngFiles(firstScreenshotPath, screenshotPath, stabilityDiffPath);
    const domStable = JSON.stringify(observations) === JSON.stringify(await observe());
    report.stability = { stable: stable.sameDimensions && stable.exactChangedPixels === 0 && domStable, domStable, changedPixels: stable.exactChangedPixels, intervalMs: 150, firstScreenshotPath, secondScreenshotPath: screenshotPath, diffPath: stable.sameDimensions ? stabilityDiffPath : undefined };
    if (!report.stability.stable) report.issues.push({ kind: 'stability', actual: stable.exactChangedPixels, message: 'Two successive screenshots or DOM observations differ; the screen is not stable' });
    if (options.referencePath) {
      const pixel = await comparePngFiles(options.referencePath, screenshotPath, diffPath, { mode });
      report.pixelDiffRatio = pixel.ratio;
      report.exactPixelDiffRatio = pixel.exactRatio; report.pixelDiffPixels = pixel.exactChangedPixels; report.maxChannelDiff = pixel.maxChannelDiff; report.diffBounds = pixel.diffBounds;
      if (pixel.sameDimensions) report.diffPath = diffPath;
      else report.issues.push({ kind: 'dimensions', expected: pixel.reference, actual: pixel.actual, message: 'Reference and actual screenshot dimensions differ; reference was not resized' });
      if (pixel.ratio > maxPixelDiffRatio) report.issues.push({ kind: 'pixels', expected: maxPixelDiffRatio, actual: pixel.ratio, message: 'Pixel difference exceeds the configured maximum' });
      report.status = report.issues.length ? 'failed' : 'passed';
      report.pixelPerfect = mode === 'pixel-perfect' && report.status === 'passed' && pixel.sameDimensions && pixel.exactChangedPixels === 0 && report.stability.stable;
      report.complete = report.pixelPerfect;
    } else {
      report.status = report.issues.length ? 'failed' : 'geometry-only';
      report.warnings.push('No independent Pixso reference image supplied; full visual fidelity is unverified');
    }
  } catch (error) {
    report.issues.push({ kind: 'validation', message: error instanceof Error ? error.message : String(error) });
    report.status = 'failed'; report.complete = false; report.pixelPerfect = false;
  } finally {
    await browser?.close();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}
