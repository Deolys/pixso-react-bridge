import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { assertCapture, loadSnapshot, saveSnapshot } from '../src/artifacts.js';
import { defaultConfig } from '../src/config.js';
import { captureConnected } from '../src/pixso/index.js';
import type { PixsoConnection } from '../src/pixso/client.js';
import { createScopedSnapshot, selectCapture } from '../src/scope.js';
import type { Capture, Raw } from '../src/types.js';
import { fixture } from './fixture.js';

function selectable(): Capture {
  const capture = fixture();
  for (const node of capture.nodes) node.raw.parentId = node.parentId;
  for (const id of ['screen', 'sidebar', 'card', 'button']) capture.screenshots.push({ nodeId: id, path: `${id}.png`, width: 2, height: 1, scale: 1 });
  return capture;
}

test('selection owns exactly its descendants, normalizes overlaps and preserves absolute placement and raw values', () => {
  const input = selectable(), before = structuredClone(input);
  input.nodes.find(node => node.id === 'card')!.raw.vendorData = { unusual: ['preserve', 42] };
  before.nodes.find(node => node.id === 'card')!.raw.vendorData = { unusual: ['preserve', 42] };
  const selected = selectCapture(input, ['button', 'card', 'card'], { name: 'Account widget' });
  assert.deepEqual(selected.roots, ['card']);
  assert.deepEqual(selected.nodes.map(node => node.id), ['card', 'badge', 'value', 'label', 'button', 'button-text']);
  assert.equal(selected.nodes[0].parentId, null);
  assert.equal(selected.nodes[0].raw.parentId, 'screen');
  assert.deepEqual(selected.nodes[0].bounds, before.nodes.find(node => node.id === 'card')!.bounds);
  assert.deepEqual(selected.nodes[0].raw, before.nodes.find(node => node.id === 'card')!.raw);
  assert.deepEqual(selected.completeness, { status: 'complete', expectedNodeCount: 6, receivedNodeCount: 6, issues: [] });
  assert.equal(selected.scope?.name, 'Account widget');
  assert.deepEqual(input, before);
});

test('host ancestors remain read-only context and siblings never enter the implementation tree', () => {
  const input = selectable();
  const selected = selectCapture(input, ['card', 'sidebar']);
  assert.deepEqual(selected.scope?.ancestors.map(node => node.id), ['screen', 'page']);
  assert.deepEqual(selected.scope?.ancestors[0], input.nodes.find(node => node.id === 'screen'));
  assert.equal(selected.nodes.some(node => ['page', 'screen', 'title', 'subtitle', 'hidden'].includes(node.id)), false);
  assert.deepEqual(selected.roots, ['card', 'sidebar']);
  selected.scope!.ancestors[0].raw.changed = true;
  assert.equal(input.nodes.find(node => node.id === 'screen')!.raw.changed, undefined);
  const nested = selectCapture(selectCapture(input, ['card']), ['button']);
  assert.deepEqual(nested.scope?.ancestors.map(node => node.id), ['card', 'screen', 'page']);
  assert.deepEqual(nested.nodes.map(node => node.id), ['button', 'button-text']);
});

test('selection retains resolved references and shared dependency assets without dangling implementation ownership', () => {
  const input = selectable();
  input.assets = [
    { id: 'shared-image', path: 'shared.png', mimeType: 'image/png' },
    { id: 'host-vector', nodeId: 'title', path: 'vector.svg', mimeType: 'image/svg+xml' },
    { id: 'selected-vector', nodeId: 'badge', path: 'badge.svg', mimeType: 'image/svg+xml' },
  ];
  const resolved = { variables: { color: { valuesByMode: { light: '#abcdef' } } }, styles: {} };
  input.nodes.find(node => node.id === 'card')!.raw._resolvedReferences = resolved;
  const result = selectCapture(input, ['card']);
  assertCapture(result);
  assert.deepEqual(result.nodes[0].raw._resolvedReferences, resolved);
  assert.equal(result.assets.find(asset => asset.id === 'host-vector')!.nodeId, undefined);
  assert.equal(result.assets.find(asset => asset.id === 'selected-vector')!.nodeId, 'badge');
  assert.equal(result.assets.length, 3);
  assert.equal(input.assets[1].nodeId, 'title');
});

test('selection refuses missing independent references, missing host context and invalid roots', () => {
  const input = selectable();
  assert.throws(() => selectCapture(input, ['title']), /no independent PNG reference.*Recapture.*nodeIds/);
  const scaled = structuredClone(input); scaled.screenshots.find(reference => reference.nodeId === 'card')!.scale = 2;
  assert.throws(() => selectCapture(scaled, ['card']), /scale 1/);
  assert.throws(() => selectCapture(input, []), /at least one/);
  assert.throws(() => selectCapture(input, ['unknown']), /does not exist/);
  assert.throws(() => selectCapture(input, ['page']), /instead of PAGE/);
  input.nodes.find(node => node.id === 'page')!.raw.parentId = 'unavailable-document';
  assert.throws(() => selectCapture(input, ['card']), /Ancestor context.*missing.*Recapture/);
});

test('scoped snapshot is a new immutable version with media hashes and raw dependency evidence intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-scope-')), capture = selectable();
  const png = new PNG({ width: 2, height: 1 }); png.data.fill(255);
  const bytes = PNG.sync.write(png);
  for (const reference of capture.screenshots) await writeFile(path.join(root, reference.path), bytes);
  await mkdir(path.join(root, 'evidence'));
  const definitions = JSON.stringify({ components: { shared: [{ id: 'master', type: 'COMPONENT' }] }, variables: {}, styles: {} });
  await writeFile(path.join(root, 'evidence/references.json'), definitions);
  const config = defaultConfig(root); config.artifactsDir = path.join(root, 'artifacts');
  const source = await saveSnapshot(capture, config.artifactsDir, { baseDir: root, rawDir: path.join(root, 'evidence') });
  const original = await readFile(path.join(source, 'capture.json'));
  const result = await createScopedSnapshot(source, ['card'], config, { name: 'Account widget' });
  assert.notEqual(result, source);
  const { capture: scoped, manifest } = await loadSnapshot(result);
  assert.deepEqual(scoped.roots, ['card']);
  assert.equal(manifest.screens.length, 1);
  assert.equal(manifest.screens[0].id, 'card');
  assert.deepEqual(await readFile(path.join(source, 'capture.json')), original);
  assert.equal(await readFile(path.join(result, 'raw/references.json'), 'utf8'), definitions);
  assert.deepEqual(await readFile(path.join(result, scoped.screenshots[0].path)), bytes);
  assert.ok(scoped.screenshots[0].sha256);
  const context=JSON.parse(await readFile(path.join(result,'context-index.json'),'utf8'));
  assert.equal(context.kind,'context-only'); assert.deepEqual(Object.keys(context.ancestors),['screen','page']);
  assert(context.ancestors.screen.chunks.length);
  const implementation=JSON.parse(await readFile(path.join(result,'node-index.json'),'utf8'));
  assert.equal(implementation.screen,undefined);
});

test('imported scope metadata must match roots and preserve an unambiguous complete ancestor chain', () => {
  const original=selectCapture(selectable(),['card']);
  const mismatched=structuredClone(original); mismatched.scope!.rootIds=['button'];
  assert.throws(()=>assertCapture(mismatched),/scope metadata/);
  const duplicate=structuredClone(original); duplicate.scope!.ancestors.push(duplicate.scope!.ancestors[0]);
  assert.throws(()=>assertCapture(duplicate),/duplicate scope ancestor/);
  const missing=structuredClone(original); missing.scope!.ancestors.pop();
  assert.throws(()=>assertCapture(missing),/Missing scope ancestor/);
  const input=selectable(); for (const node of input.nodes) delete node.raw.parentId;
  const nested=selectCapture(selectCapture(input,['card']),['button']);
  assert.deepEqual(nested.scope!.ancestors.map(node=>node.id),['card','screen','page']);
});

function connectedSelection(drift = false) {
  const png = new PNG({ width: 20, height: 10 }); png.data.fill(255); const bytes = PNG.sync.write(png);
  const document: Raw = { id: 'document', name: 'Design', type: 'DOCUMENT', parent: null, children: [] };
  const page: Raw = { id: 'page', name: 'Page', type: 'PAGE', parent: document, children: [] };
  const host: Raw = { id: 'host', name: 'Host', type: 'FRAME', parent: page, children: [], unknownContext: 'x'.repeat(80_000), absoluteBoundingBox: { x: 40, y: 30, width: 200, height: 100 } };
  const selected: Raw = { id: 'selected', name: 'Microfrontend', type: 'INSTANCE', parent: host, children: [], absoluteBoundingBox: { x: 80, y: 60, width: 20, height: 10 } };
  const child: Raw = { id: 'child', name: 'Content', type: 'TEXT', parent: selected, characters: 'Hello', absoluteBoundingBox: { x: 81, y: 61, width: 10, height: 5 } };
  const sibling: Raw = { id: 'sibling', name: 'Host sibling', type: 'FRAME', parent: host, children: [] };
  document.children = [page]; page.children = [host]; host.children = [selected, sibling]; selected.children = [child];
  selected.findAllAsync = async () => [child]; selected.exportAsync = async () => bytes;
  const nodes: Raw = { document, page, host, selected, child, sibling };
  const lookedUp: string[] = [];
  const pixso = { fileKey: 'selection-test', root: document, mixed: Symbol('mixed'), apiVersion: '1.0', getNodeById(id: string) { lookedUp.push(id); return nodes[id] ?? null; }, base64Encode: (value: Uint8Array) => Buffer.from(value).toString('base64') };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const connection: PixsoConnection = {
    tools: [{ name: 'eval_script', inputSchema: { properties: { script: { type: 'string' } } } }],
    async call(_name, args) {
      if (drift && args.script.includes('const node = pixso.getNodeById("host")') && args.script.includes('chunk:serialized.slice(0,0)')) host.name = 'Changed host';
      return new AsyncFunction('pixso', args.script)(pixso);
    },
    async close() {},
  };
  return { connection, lookedUp };
}

test('connected selected capture chunks full ancestor context, exports independent PNG and excludes siblings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-connected-scope-')), mock = connectedSelection();
  const capture = await captureConnected(mock.connection, { transport: 'http', fileKey: 'selection-test', nodeIds: ['child', 'selected', 'selected'], scopeName: 'Account widget', chunkChars: 1024 }, root);
  assert.equal(capture.completeness.status, 'complete', capture.completeness.issues.join('\n'));
  assertCapture(capture);
  assert.deepEqual(capture.roots, ['selected']);
  assert.deepEqual(capture.nodes.map(node => node.id), ['selected', 'child']);
  assert.equal(capture.nodes[0].parentId, null);
  assert.equal(capture.nodes[0].raw.parentId, 'host');
  assert.equal(capture.nodes[0].bounds!.x, 80);
  assert.deepEqual(capture.scope?.ancestors.map(node => node.id), ['document', 'host', 'page']);
  assert.equal(capture.scope?.ancestors.find(node => node.id === 'host')!.raw.unknownContext.length, 80_000);
  assert.equal(capture.scope?.name, 'Account widget');
  assert.deepEqual(capture.screenshots.map(reference => reference.nodeId), ['selected']);
  assert.equal(mock.lookedUp.includes('sibling'), false);
});

test('changed ancestor context prevents complete selected capture', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-scope-drift-'));
  const capture = await captureConnected(connectedSelection(true).connection, { transport: 'http', fileKey: 'selection-test', nodeIds: ['selected'] }, root);
  assert.equal(capture.completeness.status, 'incomplete');
  assert.ok(capture.completeness.issues.some(issue => /Node host changed while capturing/.test(issue)));
});
