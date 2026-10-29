import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PNG } from 'pngjs';
import { assertLocalUrl, compareGeometry, comparePngFiles, validateScreen } from '../src/validate/index.js';

test('validation opens only HTTP(S) loopback URLs', () => {
  assert.equal(assertLocalUrl('http://localhost:5173/page').hostname, 'localhost');
  assert.equal(assertLocalUrl('http://127.0.0.1:3000').hostname, '127.0.0.1');
  assert.equal(assertLocalUrl('http://[::1]:3000').hostname, '[::1]');
  for (const url of ['https://pixso.cn/design/file', 'http://localhost.evil.invalid', 'file:///C:/reference.png', 'http://user:pass@localhost']) assert.throws(() => assertLocalUrl(url), /loopback/);
});

test('geometry checks include positions and sizes with explicit tolerance', () => {
  const expected = { x: 12, y: 20, width: 100, height: 50 };
  assert.deepEqual(compareGeometry(expected, { x: 12.4, y: 20, width: 100.1, height: 50 }, 0.5, 'box'), []);
  const issues = compareGeometry(expected, { x: 14, y: 20, width: 110, height: 50 }, 0.5, 'box');
  assert.deepEqual(issues.map((issue) => issue.property), ['x', 'width']);
  assert.equal(issues[0].nodeId, 'box');
});

function png(width: number, height: number, red: number): Buffer {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) { image.data[offset] = red; image.data[offset + 3] = 255; }
  return PNG.sync.write(image);
}

test('pixel comparison detects errors and never mutates the reference image', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixso-validation-test-'));
  const reference = path.join(directory, 'reference.png');
  const actual = path.join(directory, 'actual.png');
  const diff = path.join(directory, 'diff.png');
  const original = png(4, 4, 255);
  await writeFile(reference, original); await writeFile(actual, original);
  assert.equal((await comparePngFiles(reference, actual, diff)).ratio, 0);
  await writeFile(actual, png(4, 4, 0));
  assert.equal((await comparePngFiles(reference, actual, diff)).ratio, 1);
  assert.deepEqual(await readFile(reference), original);
  await assert.rejects(comparePngFiles(reference, actual, reference), /Reference path/);
  const linkedDiff = path.join(directory, 'linked-diff.png');
  await link(reference, linkedDiff);
  await assert.rejects(comparePngFiles(reference, actual, linkedDiff), /hardlinks/);
  await writeFile(actual, png(5, 4, 255));
  const mismatch = await comparePngFiles(reference, actual, diff);
  assert.equal(mismatch.sameDimensions, false); assert.equal(mismatch.ratio, 1);
});

test('invalid viewport and missing root fail before browser startup', async () => {
  const base = { url: 'http://localhost:3000', rootNodeId: 'root', nodes: [], outputDir: os.tmpdir(), viewport: { width: 320, height: 240 } };
  await assert.rejects(validateScreen({ ...base, viewport: { width: NaN, height: 10 } }), /Viewport/);
  await assert.rejects(validateScreen(base), /Root node/);
  await assert.rejects(validateScreen({ ...base, maxPixelDiffRatio: -1 }), /maxPixelDiffRatio/);
});

test('strict comparison detects a single one-level RGBA channel difference ignored by perceptual matching', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixso-exact-pixels-'));
  const reference = path.join(directory, 'reference.png'), actual = path.join(directory, 'actual.png');
  const original = PNG.sync.read(png(8, 8, 200));
  await writeFile(reference, PNG.sync.write(original));
  original.data[(3 * 8 + 2) * 4] = 201;
  await writeFile(actual, PNG.sync.write(original));
  const strict = await comparePngFiles(reference, actual, path.join(directory, 'strict.png'));
  assert.equal(strict.ratio, 1 / 64); assert.equal(strict.exactChangedPixels, 1); assert.equal(strict.maxChannelDiff, 1);
  assert.deepEqual(strict.diffBounds, { x: 2, y: 3, width: 1, height: 1 });
  const tolerant = await comparePngFiles(reference, actual, path.join(directory, 'tolerant.png'), { mode: 'tolerant' });
  assert.equal(tolerant.ratio, 0); assert.equal(tolerant.exactChangedPixels, 1);
  original.data[(3 * 8 + 2) * 4] = 200; original.data[(3 * 8 + 2) * 4 + 3] = 254;
  await writeFile(actual, PNG.sync.write(original));
  assert.equal((await comparePngFiles(reference, actual, path.join(directory, 'alpha.png'))).exactChangedPixels, 1);
});

test('strict comparison counts antialiased edge differences that tolerant matching can suppress', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixso-antialias-pixels-'));
  const reference = path.join(directory, 'reference.png'), actual = path.join(directory, 'actual.png');
  const original = new PNG({ width: 5, height: 5 });
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) { const value = x < 2 ? 0 : x === 2 ? 128 : 255; original.data.set([value, value, value, 255], (y * 5 + x) * 4); }
  await writeFile(reference, PNG.sync.write(original));
  original.data.set([80, 80, 80, 255], (2 * 5 + 2) * 4);
  await writeFile(actual, PNG.sync.write(original));
  const strict = await comparePngFiles(reference, actual, path.join(directory, 'strict.png'));
  assert.equal(strict.exactChangedPixels, 1); assert.equal(strict.maxChannelDiff, 48); assert.equal(strict.ratio, 1 / 25);
  const tolerant = await comparePngFiles(reference, actual, path.join(directory, 'tolerant.png'), { mode: 'tolerant' });
  assert.equal(tolerant.ratio, 0); assert.equal(tolerant.exactChangedPixels, 1);
});
