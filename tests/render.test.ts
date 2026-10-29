import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import type { Capture, DesignNode } from '../src/types.js';
import { colorToCss, renderCapture } from '../src/render/index.js';

function capture(children: DesignNode[] = []): Capture {
  return { schemaVersion: 1, source: { provider: 'fixture', fileKey: 'fixture', name: 'Fixture', capturedAt: '2026-01-01T00:00:00Z' }, roots: ['root'], nodes: [{ id: 'root', name: 'Screen', type: 'FRAME', parentId: null, children: children.map((node) => node.id), bounds: { x: 100, y: 50, width: 320, height: 240 }, raw: { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }], clipsContent: true } }, ...children], assets: [], screenshots: [], completeness: { status: 'complete', receivedNodeCount: children.length + 1, issues: [] } };
}
function child(id: string, raw: Record<string, unknown> = {}, type = 'RECTANGLE'): DesignNode {
  return { id, name: id, type, parentId: 'root', children: [], bounds: { x: 120, y: 80, width: 80, height: 40 }, raw };
}
const temp = () => mkdtemp(path.join(os.tmpdir(), 'pixso-render-test-'));

test('renders exact relative geometry, independent CSS classes and escaped JSX text', async () => {
  const directory = await temp();
  const content = '</div><script>alert("bad")</script> & {label}\nРусский';
  const design = capture([child('text"/>', { characters: content, fontSize: 18, fontName: { family: 'Arial', style: 'SemiBold' }, lineHeight: { unit: 'PIXELS', value: 24 }, fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.6 } }] }, 'TEXT')]);
  const result = await renderCapture(design, directory, { componentName: 'View' });
  const source = await readFile(path.join(directory, 'View.tsx'), 'utf8');
  const css = await readFile(path.join(directory, 'View.css'), 'utf8');
  assert.deepEqual(result.nodeIds, ['root', 'text"/>']);
  assert.equal(result.warnings.length, 0);
  assert.ok(source.includes(`{${JSON.stringify(content)}}`));
  assert.ok(source.includes('data-pixso-id={"text\\\"/>"}'));
  assert.match(css, /left: 20px;\n  top: 30px;/);
  assert.match(css, /font-weight: 600;/);
  assert.match(css, /line-height: 24px;/);
  assert.match(css, /background-color: rgba\(255, 255, 255, 1\);/);
  assert.doesNotMatch(source, /style=\{/);
  const output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true, fileName: 'View.tsx' });
  assert.deepEqual(output.diagnostics, []);
});

test('text runs preserve gaps and suffix and reject overlapping ranges', async () => {
  const directory = await temp();
  const design = capture([child('text', { characters: 'Hello world!', textAlignVertical: 'CENTER', textRuns: [{ start: 6, end: 11, style: { fontWeight: 700, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] } }, { start: 8, end: 10, fontWeight: 900 }] }, 'TEXT')]);
  const result = await renderCapture(design, directory);
  const source = await readFile(path.join(directory, 'PixsoScreen.tsx'), 'utf8');
  assert.match(source, /\{"Hello "\}<span[^>]+>\{"world"\}<\/span>\{"!"\}/);
  assert.ok(result.warnings.some((warning) => warning.includes('Overlapping text segments')));
  assert.match(source, /<span>\{"Hello "\}/);
  assert.match(await readFile(path.join(directory, 'PixsoScreen.css'), 'utf8'), /color: rgba\(255, 0, 0, 1\);/);
});

test('affine child transforms preserve exact nested rotation and local dimensions', async () => {
  const directory = await temp();
  const design = capture([child('rotated', { width: 80, height: 40, absoluteTransform: [[0, -1, 160], [1, 0, 80]] })]);
  design.nodes[0].raw.absoluteTransform = [[1, 0, 100], [0, 1, 50]];
  const result = await renderCapture(design, directory);
  const css = await readFile(path.join(directory, 'PixsoScreen.css'), 'utf8');
  assert.match(css, /transform: matrix\(0, 1, -1, 0, 60, 30\);/);
  assert.match(css, /transform-origin: 0 0;/);
  assert.equal(result.warnings.length, 0);
});

test('retains hidden node identifiers and reports unsupported masks and unknown children', async () => {
  const directory = await temp();
  const design = capture([child('hidden', { visible: false, isMask: true, cornerSmoothing: 0.5 })]);
  design.nodes[1].children.push('missing');
  const result = await renderCapture(design, directory);
  assert.deepEqual(result.nodeIds, ['root', 'hidden']);
  assert.ok(result.warnings.some((warning) => warning.includes('Mask semantics')));
  assert.ok(result.warnings.some((warning) => warning.includes('Missing child node missing')));
  assert.match(await readFile(path.join(directory, 'PixsoScreen.css'), 'utf8'), /display: none;/);
});

test('copies image assets and uses local CSS URLs without image data in JSX', async () => {
  const directory = await temp();
  const source = path.join(directory, 'source.svg');
  await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
  const design = capture([child('image', { fills: [{ type: 'IMAGE', imageRef: 'ref', scaleMode: 'FIT' }] })]);
  design.assets.push({ id: 'ref', mimeType: 'image/svg+xml', path: source });
  const result = await renderCapture(design, path.join(directory, 'output'));
  assert.equal(result.warnings.length, 0);
  const css = await readFile(path.join(directory, 'output', 'PixsoScreen.css'), 'utf8');
  assert.match(css, /background-image: url\("\.\/assets\/pixso-[a-f0-9]+\.svg"\);/);
  assert.match(css, /background-size: contain;/);
  assert.equal(result.files.filter((file) => file.endsWith('.svg')).length, 1);
});

test('rejects duplicate identifiers and cycles instead of silently losing nodes', async () => {
  const directory = await temp();
  await assert.rejects(renderCapture(capture([child('duplicate'), child('duplicate')]), directory), /Duplicate/);
  const cyclic = capture([child('child')]);
  cyclic.nodes[1].children = ['root'];
  await assert.rejects(renderCapture(cyclic, directory), /Cycle/);
  await assert.rejects(renderCapture(capture(), directory, { componentName: '../bad' }), /PascalCase/);
});

test('composed boolean SVG retains operand IDs without painting operands a second time', async () => {
  const directory = await temp();
  const source = path.join(directory, 'boolean.svg');
  await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><path d="M0 0h80v40H0z"/></svg>');
  const boolean = child('boolean', {}, 'BOOLEAN_OPERATION');
  const operand = { ...child('operand', { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] }), parentId: 'boolean' };
  boolean.children = ['operand'];
  const design = capture([boolean]); design.nodes.push(operand);
  design.assets.push({ id: 'boolean', nodeId: 'boolean', mimeType: 'image/svg+xml', path: source });
  const result = await renderCapture(design, path.join(directory, 'output'));
  assert.deepEqual(result.nodeIds, ['root', 'boolean', 'operand']);
  const jsx = await readFile(path.join(directory, 'output', 'PixsoScreen.tsx'), 'utf8');
  assert.match(jsx, /data-pixso-id=\{"operand"\}[^>]+data-pixso-composited-by=\{"boolean"\}/);
  assert.equal((jsx.match(/<img /g) ?? []).length, 1);
  assert.match(await readFile(path.join(directory, 'output', 'PixsoScreen.css'), 'utf8'), /visibility: hidden;/);
});

test('color conversion clamps channels and never accepts arbitrary CSS expressions', () => {
  assert.equal(colorToCss({ r: 1, g: 0, b: 0.5, a: 0.5 }, 0.5), 'rgba(255, 0, 128, 0.25)');
  assert.equal(colorToCss('red; background: url(https://evil.invalid)'), undefined);
  assert.equal(colorToCss({ r: NaN, g: 0, b: 0 }), undefined);
  assert.equal(colorToCss('#abcdef'), '#abcdef');
});
