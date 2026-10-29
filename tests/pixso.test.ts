import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { captureConnected } from '../src/pixso/index.js';
import { decodeToolResult, toolArguments, type PixsoConnection } from '../src/pixso/client.js';
import { collectReferences, explicitTruncation, extractDslNodes, normalizeNode, verifyInventory } from '../src/pixso/normalize.js';
import type { Raw } from '../src/types.js';
import { assertCapture, saveSnapshot, loadSnapshot } from '../src/artifacts.js';
import { runInNewContext } from 'node:vm';
import { inventoryScript } from '../src/pixso/scripts.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function mockPixso(options: { large?: boolean; broken?: boolean; drift?: boolean; references?: boolean; missingStyle?: boolean; mixedText?: boolean; largeReference?: boolean } = {}) {
  const png = new PNG({ width: 20, height: 10 }); png.data.fill(255);
  const buffer = PNG.sync.write(png);
  const root: Raw = { id: 'screen', type: 'FRAME', name: 'Screen', x: 0, y: 0, width: 20, height: 10, absoluteBoundingBox: { x: 0, y: 0, width: 20, height: 10 }, fills: [], parent: null, children: [] };
  const child: Raw = { id: 'label', type: 'TEXT', name: 'Label', x: 2, y: 3, width: 10, height: 4, characters: 'AB', fontSize: 12, parent: root };
  child.getRangeFontSize = (start: number) => start ? 16 : 12;
  if (options.large) child.unknownVendorProperty = 'x'.repeat(120_000);
  if (options.broken) Object.defineProperty(child, 'fills', { get() { throw new Error('unavailable paint'); }, enumerable: true });
  root.children = [child]; root.findAllAsync = async () => [child]; root.exportAsync = async () => buffer;
  const nodes: Raw = { screen: root, label: child };
  const pixso = {
    fileKey: 'file', apiVersion: '1.0.0', mixed: Symbol('mixed'), root: { name: 'Test' },
    getNodeById: (id: string) => nodes[id] ?? null, base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
    getStyleById: (id: string) => options.missingStyle ? null : { id, type: 'TEXT', name: 'Body', fontName: { family: 'Corporate Sans', style: 'Bold' }, fontSize: 16, description: options.largeReference ? 'r'.repeat(120_000) : 'Linked style metadata' },
    getImageByHash: () => ({ getBytesAsync: async () => buffer }),
    variables: { getVariableByIdAsync: async (id: string) => ({ id, name: id, valuesByMode: id === 'alias' ? { dark: { type: 'VARIABLE_ALIAS', id: 'base' } } : { dark: 16 } }) },
  };
  if (options.references) {
    child.textStyleId = 'font-style'; child.boundVariables = { fontSize: { type: 'VARIABLE_ALIAS', id: 'alias' } };
    root.fills = [{ type: 'IMAGE', imageHash: 'original-image' }];
  }
  if (options.mixedText) {
    child.fontSize = pixso.mixed;
    child.getRangeFontSize = (start: number, end: number) => end - start > 1 ? pixso.mixed : start === 0 ? 12 : 16;
  }
  let calls = 0;
  const connection: PixsoConnection = {
    tools: [{ name: 'eval_script', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }],
    async call(name, args) {
      assert.equal(name, 'eval_script'); calls++;
      if (options.drift && args.code.includes('chunk:serialized.slice(0,0)')) child.fontSize = 13;
      return new AsyncFunction('pixso', args.code)(pixso);
    },
    async close() {},
  };
  return { connection, pixso, calls: () => calls };
}

test('captures complete properties in bounded chunks with independent coverage and a real PNG', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixso-capture-test-'));
  try {
    const mock = mockPixso({ large: true });
    const capture = await captureConnected(mock.connection, { transport: 'http', fileKey: 'file', nodeIds: ['screen'], chunkChars: 4096 }, dir);
    assert.deepEqual(capture.completeness, { status: 'complete', expectedNodeCount: 2, receivedNodeCount: 2, issues: [] });
    assert.equal(capture.nodes[1]!.raw.unknownVendorProperty.length, 120_000);
    assert.deepEqual(capture.nodes[0]!.children, ['label']);
    assert.equal(capture.screenshots[0]!.width, 20);
    assertCapture(capture);
    assert.ok(mock.calls() > 30);
    assert.equal(JSON.parse(await readFile(join(dir, 'capture-evidence.json'), 'utf8')).inventoryBefore.total, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('inventory chunks preserve a row with 10000 children under an enforced upstream payload limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixso-large-inventory-test-'));
  try {
    const mock = mockPixso(); const pixso = mock.pixso as Raw; const root = pixso.getNodeById('screen');
    const children = Array.from({ length: 10000 }, (_, i) => ({ id: `child-${i}`, name: `Child ${i}`, type: 'RECTANGLE', parent: root, x: i, y: 0, width: 1, height: 1 }));
    const nodes = new Map([[root.id, root], ...children.map(node => [node.id, node])]);
    root.children = children; root.findAllAsync = async () => children; pixso.getNodeById = (id: string) => nodes.get(id);
    const payloadLimit = 16384;
    const unbounded = await new AsyncFunction('pixso', inventoryScript(['screen'], 0, 150))(pixso);
    assert.ok(Buffer.byteLength(JSON.stringify(unbounded)) > payloadLimit);
    let largestPayload = 0; let inventoryParts = 0; let resumedInventoryParts = 0;
    const connection: PixsoConnection = {
      tools: mock.connection.tools, close: async () => {},
      async call(_name, args) {
        const result = await new AsyncFunction('pixso', args.code)(pixso);
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (bytes > payloadLimit) throw new Error('Response payload exceeds upstream size limit');
        largestPayload = Math.max(largestPayload, bytes);
        if (args.code.startsWith('const inventoryPage =')) { inventoryParts++; if (result.offset > 0) resumedInventoryParts++; }
        return result;
      },
    };
    const capture = await captureConnected(connection, { transport: 'http', fileKey: 'file', nodeIds: ['screen'], chunkChars: 4096 }, dir);
    assert.equal(capture.completeness.status, 'complete', capture.completeness.issues.join('\n'));
    assert.equal(capture.completeness.expectedNodeCount, 10001); assert.equal(capture.nodes.length, 10001);
    assert.deepEqual(capture.nodes[0]!.children, children.map(child => child.id));
    assert.deepEqual(capture.nodes.slice(1).map(node => node.id), children.map(child => child.id));
    assert.ok(inventoryParts > 134); assert.ok(resumedInventoryParts > 2); assert.ok(largestPayload <= payloadLimit);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('linked typography, variable aliases, original image bytes survive versioned snapshot storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixso-references-test-'));
  try {
    const capture = await captureConnected(mockPixso({ references: true, mixedText: true }).connection, { transport: 'http', fileKey: 'file', nodeIds: ['screen'] }, join(dir, 'raw'));
    assert.equal(capture.completeness.status, 'complete', capture.completeness.issues.join('\n'));
    assert.equal(capture.nodes[1]!.raw._resolvedReferences.styles['font-style'].fontName.family, 'Corporate Sans');
    assert.equal(capture.nodes[1]!.raw._resolvedReferences.variables.base.valuesByMode.dark, 16);
    assert.deepEqual(capture.nodes[1]!.raw.textRuns.map((run: Raw) => [run.start, run.end, run.style.fontSize]), [[0, 1, 12], [1, 2, 16]]);
    assert.equal(capture.assets[0]!.id, 'original-image');
    const path = await saveSnapshot(capture, join(dir, 'artifacts'), { rawDir: join(dir, 'raw'), baseDir: dir, maxChunkBytes: 2048 });
    const loaded = await loadSnapshot(path);
    assert.deepEqual(loaded.capture.nodes, capture.nodes);
    assert.equal(loaded.manifest.nodeCount, 2);
    assert.ok(loaded.capture.assets[0]!.sha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an unresolved linked style prevents snapshot acceptance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixso-missing-style-test-'));
  try {
    const capture = await captureConnected(mockPixso({ references: true, missingStyle: true }).connection, { transport: 'http', fileKey: 'file', nodeIds: ['screen'] }, dir);
    assert.equal(capture.completeness.status, 'incomplete');
    assert.throws(() => assertCapture(capture), /Unresolved styles/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('large referenced style is transferred in full through bounded envelopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pixso-large-reference-test-'));
  try {
    const mock = mockPixso({ references: true, largeReference: true });
    const capture = await captureConnected(mock.connection, { transport: 'http', fileKey: 'file', nodeIds: ['screen'], chunkChars: 2048 }, dir);
    assert.equal(capture.completeness.status, 'complete', capture.completeness.issues.join('\n'));
    assert.equal(capture.nodes[1]!.raw._resolvedReferences.styles['font-style'].description.length, 120_000);
    assert.ok(mock.calls() > 60);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('property failures and changed node values prevent complete status', async () => {
  for (const option of [{ broken: true }, { drift: true }]) {
    const dir = await mkdtemp(join(tmpdir(), 'pixso-incomplete-test-'));
    try {
      const capture = await captureConnected(mockPixso(option).connection, { transport: 'http', fileKey: 'file', nodeIds: ['screen'] }, dir);
      assert.equal(capture.completeness.status, 'incomplete');
      assert.ok(capture.completeness.issues.some(x => /unavailable paint|changed while capturing/.test(x)));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('a legacy full DSL never becomes complete without independent evidence', async () => {
  const connection: PixsoConnection = {
    tools: [{ name: 'get_node_dsl', inputSchema: {} }],
    async call() { return { id: 'root', type: 'FRAME', children: [], width: 10, height: 10, x: 0, y: 0 }; }, async close() {},
  };
  const dir = await mkdtemp(join(tmpdir(), 'pixso-legacy-test-'));
  try {
    const result = await captureConnected(connection, { transport: 'http', nodeIds: ['root'] }, dir);
    assert.equal(result.nodes.length, 1);
    assert.equal(result.completeness.status, 'unverified');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MCP parser refuses clipped JSON and explicit errors, accepts structured and text JSON', () => {
  assert.throws(() => decodeToolResult({ content: [{ type: 'text', text: '{"roots":[' }] }), /not complete JSON/);
  assert.throws(() => decodeToolResult({ isError: true, content: [] }), /tool error/);
  assert.deepEqual(decodeToolResult({ structuredContent: { result: { roots: [] } } }), { roots: [] });
  assert.deepEqual(decodeToolResult({ structuredContent: { result: JSON.stringify(JSON.stringify({ roots: [] })) } }), { roots: [] });
  assert.throws(() => decodeToolResult({ _meta: { truncated: true }, structuredContent: { roots: [] } }), /truncated/);
  assert.deepEqual(decodeToolResult({ content: [{ type: 'text', text: '```json\n{"roots":[]}\n```' }] }), { roots: [] });
  assert.equal(explicitTruncation({ stats: { truncated: true } }), true);
  assert.equal(explicitTruncation({ text: 'This label says truncated' }), false);
});

test('reference scan includes arbitrary overrides, aliases, image hashes and components', () => {
  const references = collectReferences({ children: [{ override: { fills: [{ imageHash: 'image' }], size: 'variable:v$dark', font: 'style:s' }, componentRef: 'c' }], alias: { type: 'VARIABLE_ALIAS', id: 'a' }, vectorRef: 'vector' });
  assert.deepEqual([...references.variables].sort(), ['a', 'v']);
  assert.deepEqual([...references.components], ['c']);
  assert.deepEqual([...references.images], ['image']);
  assert.deepEqual([...references.styles], ['s']);
  assert.deepEqual([...references.vectors], ['vector']);
});

test('inventory proves child order, parent agreement, duplicate count and reachability', () => {
  const raw = { id: 'r', type: 'FRAME', parentId: null, children: ['missing'] };
  const node = normalizeNode(raw);
  const issues = verifyInventory([{ ...raw, children: [] }], [node], ['r'], 2);
  assert.ok(issues.some(x => x.includes('coverage')));
  assert.ok(issues.some(x => x.includes('Child order')));
  assert.ok(issues.some(x => x.includes('Missing child')));
});

test('schema discovery rejects unknown required arguments, and normalization preserves opaque fields', () => {
  assert.throws(() => toolArguments({ name: 'eval_script', inputSchema: { required: ['source'], properties: { source: {} } } }, { code: 'return 1' }), /unsupported argument source/);
  const raw = { roots: [{ id: 'r', type: 'FRAME', box: { x: 0, y: 0, w: 15, h: 20 }, vendor: { a: [1, 2, 3] }, children: [{ id: 'c', type: 'TEXT', text: { content: 'All text' } }] }] };
  const nodes = extractDslNodes(raw);
  assert.equal(nodes.length, 2); assert.equal(nodes[1]!.parentId, 'r');
  assert.deepEqual(nodes[0]!.bounds, { x: 0, y: 0, width: 15, height: 20 });
  assert.deepEqual(nodes[0]!.raw.vendor, { a: [1, 2, 3] });
});
