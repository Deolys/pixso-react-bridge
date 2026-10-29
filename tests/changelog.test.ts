import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScreenChangelogs } from '../src/changelog.js';
import { indexScreens } from '../src/artifacts.js';
import type { Capture, SnapshotManifest } from '../src/types.js';
import { fixture } from './fixture.js';

const createdAt = '2026-10-16T12:30:00.000Z';
function previous(capture: Capture) {
  const manifest: SnapshotManifest = { schemaVersion: 1, id: 'version-1', captureHash: '', source: capture.source, completeness: capture.completeness, roots: capture.roots, screens: indexScreens(capture, 180), nodeCount: capture.nodes.length, files: {} };
  return { capture, manifest };
}
function changelog(capture: Capture, before?: ReturnType<typeof previous>, summary?: string) {
  return buildScreenChangelogs({ capture, screens: indexScreens(capture, 180), previous: before, createdAt, summary });
}

test('initial version has one dated concise file per screen without a fictional comparison', () => {
  const capture = fixture(), [result] = changelog(capture);
  assert.equal(result.relativePath, `${indexScreens(capture, 180)[0].path}/CHANGELOG.md`);
  assert.match(result.text, /Дата: 2026-10-16T12:30:00.000Z/);
  assert.match(result.text, /Начальная версия/);
  assert.match(result.text, /Узлов: 13/);
  assert.doesNotMatch(result.text, /Предыдущая версия|добавлено/);
});

test('each screen receives exactly one file and only its own changes', () => {
  const old = fixture();
  old.nodes[0].children.push('screen-two');
  old.nodes.push({ id: 'screen-two', name: 'Second screen', type: 'FRAME', parentId: 'page', children: [], raw: {} });
  const capture = structuredClone(old); capture.nodes[3].raw.characters = 'Changed';
  const results = changelog(capture, previous(old));
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map(item => item.relativePath)).size, 2);
  assert(results.every(item => item.relativePath.endsWith('/CHANGELOG.md')));
  assert.match(results[0].text, /изменено 1/);
  assert.match(results[1].text, /Изменений узлов и их ресурсов не обнаружено/);
});

test('stable IDs report added, removed and edited nodes in concise meaningful categories', () => {
  const old = fixture(), capture = structuredClone(old);
  capture.nodes = capture.nodes.filter(node => node.id !== 'hidden');
  const screen = capture.nodes.find(node => node.id === 'screen')!;
  screen.children = screen.children.filter(id => id !== 'hidden'); screen.children.push('new');
  capture.nodes.push({ id: 'new', name: 'New', type: 'RECTANGLE', parentId: 'screen', children: [], raw: {} });
  capture.nodes.find(node => node.id === 'brand')!.raw.characters = 'NEW BRAND';
  capture.nodes.find(node => node.id === 'title')!.bounds!.x++;
  capture.nodes.find(node => node.id === 'card')!.raw.cornerRadius = 20;
  const oldBytes = JSON.stringify(old), [result] = changelog(capture, previous(old));
  assert.match(result.text, /Предыдущая версия: version\\-1/);
  assert.match(result.text, /добавлено 1, удалено 1, изменено 4/);
  for (const category of ['геометрия 1', 'оформление 1', 'текст 1', 'структура 3']) assert(result.text.includes(category));
  assert.equal(JSON.stringify(old), oldBytes);
  assert(!result.text.includes('NEW BRAND'));
});

test('equivalent data and version-specific media paths do not invent changes', () => {
  const old = fixture(); old.nodes[3].raw.fills = [{ type: 'IMAGE', imageHash: 'image-1' }];
  old.assets.push({ id: 'image-1', path: 'version-1/image.png', mimeType: 'image/png', sha256: 'a'.repeat(64) });
  const capture = structuredClone(old);
  capture.nodes.reverse(); capture.nodes.find(node => node.id === 'brand')!.raw = Object.fromEntries(Object.entries(old.nodes[3].raw).reverse());
  capture.assets[0].path = 'version-2/image.png';
  assert.match(changelog(capture, previous(old))[0].text, /Изменений узлов и их ресурсов не обнаружено/);
});

test('changed resource bytes and unknown raw properties are not omitted', () => {
  const old = fixture(); old.nodes[3].raw.fills = [{ type: 'IMAGE', imageHash: 'image-1' }];
  old.assets.push({ id: 'image-1', path: 'image.png', mimeType: 'image/png', sha256: 'a'.repeat(64) });
  const capture = structuredClone(old); capture.assets[0].sha256 = 'b'.repeat(64);
  capture.nodes[4].raw.vendorSpecificState = { newMode: true };
  const [result] = changelog(capture, previous(old));
  assert.match(result.text, /изменено 2/);
  assert.match(result.text, /ресурсы 1; прочее 1/);
});

test('all canonical media references and node-bound assets detect changed bytes once per node', () => {
  const references = [
    { imageHash: 'shared' }, { imageRef: 'shared' }, { assetId: 'shared' }, { assetHash: 'shared' },
    { vectorRef: 'shared' }, { fills: [{ type: 'asset', id: 'shared' }] },
    { assetId: 'shared', nested: [{ vectorRef: 'shared' }, { type: 'asset', id: 'shared' }] },
    {},
  ];
  for (const reference of references) {
    const old = fixture(), card = old.nodes.find(node => node.id === 'card')!;
    Object.assign(card.raw, reference);
    old.assets.push({ id: 'shared', path: 'shared.svg', mimeType: 'image/svg+xml', sha256: 'a'.repeat(64), ...(!Object.keys(reference).length ? { nodeId: card.id } : {}) });
    const capture = structuredClone(old); capture.assets[0].sha256 = 'b'.repeat(64);
    const [result] = changelog(capture, previous(old));
    assert.match(result.text, /добавлено 0, удалено 0, изменено 1/, JSON.stringify(reference));
    assert.match(result.text, /ресурсы 1/, JSON.stringify(reference));
    assert.doesNotMatch(result.text, /Изменений узлов и их ресурсов не обнаружено/);
  }
});

test('different files, selection scopes and screen IDs never compare', () => {
  for (const mismatch of ['file', 'scope', 'screen']) {
    const old = fixture(), capture = fixture(), before = previous(old);
    if (mismatch === 'file') old.source.fileKey = 'another-file';
    if (mismatch === 'scope') old.roots = ['screen'];
    if (mismatch === 'screen') before.manifest.screens[0].id = 'another-screen';
    const [result] = changelog(capture, before);
    assert.match(result.text, /Начальная версия/);
    assert.doesNotMatch(result.text, /Предыдущая версия|version|добавлено/);
  }
});

test('large diffs and multiline notes remain bounded and escape Markdown and HTML', () => {
  const old = fixture(), capture = structuredClone(old);
  for (const node of capture.nodes) node.raw.characters = 'large '.repeat(10000);
  old.screenshots.push({ nodeId: 'screen', path: 'old.png', width: 640, height: 420, scale: 1, sha256: 'a'.repeat(64) });
  capture.screenshots.push({ nodeId: 'screen', path: 'new.png', width: 640, height: 420, scale: 1, sha256: 'b'.repeat(64) });
  const [result] = changelog(capture, previous(old), '# Heading\n<script>bad</script>\r\n[link](url) ' + 'длинно '.repeat(1000));
  assert(result.text.trimEnd().split('\n').length <= 9);
  assert(result.text.length < 1500);
  assert.match(result.text, /Примечание: \\# Heading &lt;script&gt;bad&lt;\/script&gt; \\\[link\\\]\\\(url\\\)/);
  assert.match(result.text, /Эталонный снимок изменён/);
  assert.match(result.text, /…\n$/);
  assert(!result.text.includes('large large'));
});
