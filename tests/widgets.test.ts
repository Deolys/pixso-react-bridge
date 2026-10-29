import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pathToFileURL } from 'node:url';
import { renderCapture } from '../src/render/index.js';
import { prepareWidgets, type WidgetPlan } from '../src/widgets.js';
import type { Capture, DesignNode, ScreenIndex } from '../src/types.js';

function fixture(count = 4): { capture: Capture; screen: ScreenIndex } {
  const nodes: DesignNode[] = [{ id: 'root', name: 'Root', type: 'FRAME', parentId: null, children: [], bounds: { x: 0, y: 0, width: 400, height: 400 }, raw: {} }];
  for (let index = 1; index < count; index++) {
    const id = `node-${index}`; nodes[0].children.push(id);
    nodes.push({ id, name: id, type: index === 1 ? 'TEXT' : index === 2 ? 'VECTOR' : 'RECTANGLE', parentId: 'root', children: [], bounds: { x: index, y: index * 2, width: 40, height: 20 }, raw: index === 1 ? { characters: 'Hello <world> & {all}', fontName: { family: 'A}B Font', style: 'Regular' }, textRuns: [{ start: 0, end: 5, style: { fontWeight: 700 } }] } : index === 2 ? { vectorPaths: [{ data: 'M0 0h40v20H0z', windingRule: 'EVENODD' }], fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] } : {} });
  }
  const capture: Capture = { schemaVersion: 1, source: { provider: 'fixture', fileKey: 'fixture', name: 'Fixture', capturedAt: '2026-01-01T00:00:00Z' }, roots: ['root'], nodes, assets: [], screenshots: [], completeness: { status: 'complete', receivedNodeCount: nodes.length, expectedNodeCount: nodes.length, issues: [] } };
  const screen: ScreenIndex = { id: 'root', name: 'Root', pageId: null, path: 'screen', nodeIds: nodes.map((node) => node.id), widgets: [] };
  for (let index = 0; index < nodes.length; index += 2) screen.widgets.push({ id: nodes[index].id, nodeIds: nodes.slice(index, index + 2).map((node) => node.id), path: `widget-${index}` });
  return { capture, screen };
}

async function assemble(plan: WidgetPlan, directory: string): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  await copyFile(plan.viewTsx, path.join(directory, 'View.tsx')); await copyFile(plan.viewCss, path.join(directory, 'View.css'));
  const files = [path.join(directory, 'View.tsx')];
  for (const widget of plan.widgets) {
    const filename = path.join(directory, widget.filename); await copyFile(path.join(widget.directory, widget.filename), filename); files.push(filename);
    await copyFile(path.join(widget.directory, widget.cssFilename), path.join(directory, widget.cssFilename));
  }
  return files;
}

test('widget modules compose and typecheck with every node ID, rich text and inline SVG preserved', async () => {
  // Keeping this fixture under the package allows TypeScript to resolve its real React types.
  const temporary = await mkdtemp(path.join(process.cwd(), 'node_modules', '.pixso-widget-test-'));
  const { capture, screen } = fixture();
  const baseline = path.join(temporary, 'baseline'); await renderCapture(capture, baseline, { componentName: 'View' });
  const plan = await prepareWidgets(baseline, screen, path.join(temporary, 'plan'));
  assert.equal(plan.widgets.length, 2);
  const sources = await Promise.all(plan.widgets.map((widget) => readFile(path.join(widget.directory, widget.filename), 'utf8')));
  const ids = sources.flatMap((source) => [...source.matchAll(/data-pixso-id=\{["']([^"']+)["']\}/g)].map((match) => match[1]));
  assert.deepEqual(ids.sort(), [...screen.nodeIds].sort());
  assert.match(sources[0], /<span[^>]+>\{"Hello"\}<\/span>/);
  assert.match(sources.join('\n'), /<svg[^>]+>.*<path d=\{"M0 0h40v20H0z"\}/s);
  assert.match(sources[0], /from "\.\/Widget0002"/);
  assert.match(await readFile(path.join(plan.widgets[0].directory, plan.widgets[0].cssFilename), 'utf8'), /A}B Font/);
  const files = await assemble(plan, path.join(temporary, 'assembled'));
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, skipLibCheck: true });
  const diagnostics = ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
  assert.deepEqual(diagnostics, []);
  const shellCss = await readFile(plan.viewCss, 'utf8');
  assert.match(shellCss, /\.pixso-capture/);
  assert.doesNotMatch(shellCss, /\.pixso-[a-f\d]{12}/);
});

test('large screen partition contains all nodes once and rejects dropped or unknown data', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pixso-large-widgets-'));
  const { capture, screen } = fixture(501);
  // Fifty-one bounded partitions, including a root that references many direct children.
  screen.widgets = [];
  for (let index = 0; index < capture.nodes.length; index += 10) screen.widgets.push({ id: capture.nodes[index].id, nodeIds: capture.nodes.slice(index, index + 10).map((node) => node.id), path: `part-${index}` });
  const baseline = path.join(temporary, 'baseline'); await renderCapture(capture, baseline, { componentName: 'View' });
  const plan = await prepareWidgets(baseline, screen, path.join(temporary, 'plan'));
  assert.equal(plan.widgets.length, 51);
  const ids: string[] = [];
  for (const widget of plan.widgets) {
    const source = await readFile(path.join(widget.directory, widget.filename), 'utf8');
    assert.equal((source.match(/data-pixso-id=/g) ?? []).length, widget.nodeIds.length);
    ids.push(...widget.nodeIds);
  }
  assert.equal(new Set(ids).size, 501);
  const missing = structuredClone(screen); missing.widgets[0].nodeIds.pop();
  await assert.rejects(prepareWidgets(baseline, missing, path.join(temporary, 'missing')), /cover every/);
  const duplicate = structuredClone(screen); duplicate.widgets[1].nodeIds.push('root');
  await assert.rejects(prepareWidgets(baseline, duplicate, path.join(temporary, 'duplicate')), /duplicate node/);
  await writeFile(path.join(baseline, 'View.css'), (await readFile(path.join(baseline, 'View.css'), 'utf8')) + '\n.pixso-0123456789ab {color:red}\n');
  await assert.rejects(prepareWidgets(baseline, screen, path.join(temporary, 'unknown')), /uncaptured design node/);
});

test('shell and nested widget exports forward real props through local and foreign child calls', async () => {
  const temporary = await mkdtemp(path.join(process.cwd(), 'node_modules', '.pixso-widget-props-'));
  const { capture, screen } = fixture();
  for (const [index, node] of capture.nodes.entries()) {
    node.parentId = index ? capture.nodes[index - 1].id : null;
    node.children = index + 1 < capture.nodes.length ? [capture.nodes[index + 1].id] : [];
    node.type = index === 3 ? 'TEXT' : 'FRAME';
    node.raw = index === 3 ? { characters: 'DATA_PLACEHOLDER' } : {};
  }
  const baseline = path.join(temporary, 'baseline'); await renderCapture(capture, baseline, { componentName: 'View' });
  const original = await readFile(path.join(baseline, 'View.tsx'), 'utf8');
  assert.ok(original.includes('{"DATA_PLACEHOLDER"}'));
  await writeFile(path.join(baseline, 'View.tsx'), original.replace('{"DATA_PLACEHOLDER"}', '{String(props.summary)}'));
  const plan = await prepareWidgets(baseline, screen, path.join(temporary, 'plan'));
  const assembled = path.join(temporary, 'assembled'); await assemble(plan, assembled);
  const bundle = path.join(assembled, 'view.mjs');
  await build({ entryPoints: [path.join(assembled, 'View.tsx')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime'] });
  const { View } = await import(pathToFileURL(bundle).href);
  const first = renderToStaticMarkup(createElement(View, { summary: 'Passed through every boundary' }));
  const second = renderToStaticMarkup(createElement(View, { summary: 'Updated scenario' }));
  assert.match(first, /Passed through every boundary/);
  assert.match(second, /Updated scenario/);
  assert.doesNotMatch(second, /Passed through every boundary|DATA_PLACEHOLDER/);
  assert.equal((first.match(/data-pixso-id=/g) ?? []).length, 4);
  assert.doesNotMatch(first, /summary=/);
});

test('each widget receives only the local assets and URL constants it needs', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pixso-widget-assets-'));
  const { capture, screen } = fixture();
  const svg = path.join(temporary, 'source.svg'); await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>');
  capture.assets.push({ id: 'vector', nodeId: 'node-2', path: svg, mimeType: 'image/svg+xml' });
  capture.nodes[3].raw.fills = [{ type: 'IMAGE', imageHash: 'image', scaleMode: 'FIT' }];
  capture.assets.push({ id: 'image', path: svg, mimeType: 'image/svg+xml' });
  const baseline = path.join(temporary, 'baseline'); await renderCapture(capture, baseline, { componentName: 'View' });
  const plan = await prepareWidgets(baseline, screen, path.join(temporary, 'plan'));
  assert.doesNotMatch(await readFile(path.join(plan.widgets[0].directory, plan.widgets[0].filename), 'utf8'), /new URL/);
  const widget = plan.widgets[1], source = await readFile(path.join(widget.directory, widget.filename), 'utf8'), css = await readFile(path.join(widget.directory, widget.cssFilename), 'utf8');
  const imageReference = source.match(/new URL\("(\.\/assets\/[^"]+)"/);
  assert.ok(imageReference);
  assert.match(await readFile(path.join(widget.directory, imageReference[1]), 'utf8'), /<svg/);
  const cssReference = css.match(/url\("(\.\/assets\/[^"]+)"/);
  assert.ok(cssReference);
  assert.match(await readFile(path.join(widget.directory, cssReference[1]), 'utf8'), /<svg/);
});
