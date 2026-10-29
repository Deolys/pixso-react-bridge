import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { assertCapture, saveSnapshot, loadSnapshot, indexScreens, diffSnapshots } from '../src/artifacts.js';
import { hash } from '../src/fs.js';
import { fixture } from './fixture.js';

test('complete graph requires independent count, all relationships, no orphans or duplicates', () => {
  const c = fixture(); assertCapture(c);
  const broken = structuredClone(c); broken.nodes.pop(); assert.throws(() => assertCapture(broken), /mismatch/);
  const unverified = structuredClone(c); unverified.completeness.status = 'unverified'; assert.throws(() => assertCapture(unverified), /not proven/);
  const missing = structuredClone(c); missing.nodes[1].children.push('missing'); assert.throws(() => assertCapture(missing), /Missing child/);
  const orphan = structuredClone(c); orphan.nodes[2].parentId = null; assert.throws(() => assertCapture(orphan), /relationship/);
});

test('version storage is lossless for huge unicode properties and bounded chunks; tamper detection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-artifacts-')), c = fixture();
  c.nodes[3].raw.unknownVendorData = 'Большой 🦊'.repeat(40000);
  const dir = await saveSnapshot(c, root, { maxChunkBytes: 2048, maxNodesPerTask: 3 });
  const { capture, manifest } = await loadSnapshot(dir); assert.equal(capture.nodes[3].raw.unknownVendorData, c.nodes[3].raw.unknownVendorData);
  const index = JSON.parse(await readFile(path.join(dir, 'node-index.json'), 'utf8'));
  const chunks = await Promise.all(index.brand.chunks.map(async (f: string) => { const b = await readFile(path.join(dir,f)); assert(b.length <= 2048); assert(!b.toString('utf8').includes('\uFFFD')); return b; }));
  assert(Buffer.concat(chunks).equals(await readFile(path.join(dir,index.brand.path))));
  const tasks = manifest.screens[0].widgets.flatMap(w => w.nodeIds); assert.equal(tasks.length, new Set(tasks).size); assert.equal(tasks.length, 13);
  await writeFile(path.join(dir,index.brand.path),'{}'); await assert.rejects(loadSnapshot(dir),/integrity/);
});

test('each capture has a separate version, and diff detects stable-id edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'pixso-version-')), c = fixture();
  const before = await saveSnapshot(c,root); c.nodes[3].raw.characters = 'Changed';
  const after = await saveSnapshot(c,root); assert.notEqual(before,after);
  assert.deepEqual((await diffSnapshots(before,after)).changed,['brand']);
});

test('screen changelogs are optional, dated, immutable and diff the last compatible version', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-log-')), capture = fixture();
  const first = await saveSnapshot(capture, root);
  assert.equal(Object.keys((await loadSnapshot(first)).manifest.files).some(file => file.endsWith('/CHANGELOG.md')), false);
  capture.nodes.find(node => node.id === 'brand')!.raw.characters = 'New brand';
  const second = await saveSnapshot(capture, root, { changelog: { enabled: true, summary: 'Обновление бренда' } });
  const { manifest } = await loadSnapshot(second);
  const logs = Object.keys(manifest.files).filter(file => file.endsWith('/CHANGELOG.md'));
  assert.equal(logs.length, manifest.screens.length);
  const text = await readFile(path.join(second, logs[0]), 'utf8');
  assert.match(text, /Обновление бренда/); assert.match(text, /\d{4}-\d{2}-\d{2}T/); assert.match(text, /1/);
  assert(text.trim().split('\n').length <= 9);
  assert.equal((await loadSnapshot(first)).capture.nodes.find(node => node.id === 'brand')!.raw.characters, 'ATLAS');
  await writeFile(path.join(second, logs[0]), 'edited');
  await assert.rejects(loadSnapshot(second), /integrity/);
});

test('a one-off change note opts into changelog without a global flag', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-log-note-'));
  const snapshot = await saveSnapshot(fixture(), root, { changelog: { summary: 'Начальная версия' } });
  const { manifest } = await loadSnapshot(snapshot);
  assert.equal(Object.keys(manifest.files).filter(file => file.endsWith('/CHANGELOG.md')).length, 1);
});

function referencePng(red = 255): Buffer {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([red, 32, 64, 255, 0, 128, 255, 255]);
  return PNG.sync.write(png);
}

async function snapshotWithReference() {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-reference-')), capture = fixture();
  const original = referencePng();
  await writeFile(path.join(root, 'reference.png'), original);
  capture.screenshots.push({ nodeId: 'screen', path: 'reference.png', width: 2, height: 1, scale: 1 });
  const dir = await saveSnapshot(capture, path.join(root, 'artifacts'), { baseDir: root });
  return { root, dir, original, input: capture, ...await loadSnapshot(dir) };
}

test('imported reference bytes become part of canonical capture identity without modifying the source', async () => {
  const { root, dir, original, input, capture, manifest } = await snapshotWithReference();
  assert.equal(capture.screenshots[0].sha256, hash(original));
  assert.equal(manifest.files[capture.screenshots[0].path], hash(original));
  assert.equal(manifest.captureHash, hash(JSON.stringify(capture)));
  assert.equal(input.screenshots[0].sha256, undefined);
  assert.equal(input.screenshots[0].path, 'reference.png');
  assert.deepEqual(await readFile(path.join(root, 'reference.png')), original);
  await writeFile(path.join(root, 'reference.png'), referencePng(0));
  const next = await saveSnapshot(input, path.join(root, 'artifacts'), { baseDir: root });
  assert.notEqual((await loadSnapshot(next)).manifest.captureHash, manifest.captureHash);
  assert.deepEqual(await readFile(path.join(dir, capture.screenshots[0].path)), original);
  input.screenshots[0].sha256 = hash(original);
  await assert.rejects(saveSnapshot(input, path.join(root, 'artifacts'), { baseDir: root }), /Reference image hash mismatch/);
});

test('changing a reference and its manifest entry cannot preserve a valid capture identity', async () => {
  const { dir, capture, manifest } = await snapshotWithReference();
  const captureHash = manifest.captureHash, changed = referencePng(0), relative = capture.screenshots[0].path;
  await writeFile(path.join(dir, relative), changed);
  manifest.files[relative] = hash(changed);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.equal(manifest.captureHash, captureHash);
  await assert.rejects(loadSnapshot(dir), /Reference image integrity check failed/);
});

test('a required reference cannot be removed from the manifest hash inventory', async () => {
  const { dir, capture, manifest } = await snapshotWithReference();
  delete manifest.files[capture.screenshots[0].path];
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(loadSnapshot(dir), /Unhashed reference image/);
});

test('legacy stored references require a new import rather than silent mutation', async () => {
  const { dir, capture, manifest } = await snapshotWithReference();
  delete capture.screenshots[0].sha256;
  const legacyCapture = JSON.stringify(capture);
  await writeFile(path.join(dir, 'capture.json'), legacyCapture);
  manifest.files['capture.json'] = hash(legacyCapture);
  manifest.captureHash = hash(JSON.stringify(capture));
  const legacyManifest = JSON.stringify(manifest);
  await writeFile(path.join(dir, 'manifest.json'), legacyManifest);
  await assert.rejects(loadSnapshot(dir), /recapture or import the original export into a new snapshot/);
  assert.equal(await readFile(path.join(dir, 'capture.json'), 'utf8'), legacyCapture);
  assert.equal(await readFile(path.join(dir, 'manifest.json'), 'utf8'), legacyManifest);
});
