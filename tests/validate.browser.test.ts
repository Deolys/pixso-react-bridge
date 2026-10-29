import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { validateScreen } from '../src/validate/index.js';
import type { DesignNode } from '../src/types.js';

test('strict browser acceptance rejects 1px movement, wrong fonts, missing resources/nodes and a pixel-identical screenshot overlay', { timeout: 120_000 }, async (context) => {
  const browserChannel = process.env.PIXSO_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'chrome' : undefined);
  if (!browserChannel && !existsSync(chromium.executablePath())) { context.skip('Browser regression requires an installed Playwright Chromium or PIXSO_BROWSER_CHANNEL'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pixso-browser-gates-'));
  const bitmap = new PNG({ width: 3, height: 3 }); for (let offset = 0; offset < bitmap.data.length; offset += 4) bitmap.data.set([20, 100, 200, 255], offset);
  const image = PNG.sync.write(bitmap); let referenceBytes: Buffer | undefined;
  const html = (mode: string) => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}#screen{position:relative;width:240px;height:140px;background:white}#text{position:absolute;left:${mode === 'move' ? 11 : 10}px;top:10px;width:180px;height:30px;font:20px/30px ${mode === 'font' ? '"Times New Roman"' : 'Arial'};color:black}#image{position:absolute;left:10px;top:70px;width:30px;height:30px}#button{position:absolute;left:120px;top:70px;width:90px;height:30px;border:0;padding:0;background:rgb(20,100,200)}${mode === 'pseudo-overlay' ? 'body::after{content:"";position:fixed;inset:0;width:240px;height:140px;background-image:url(/reference.png);pointer-events:none;z-index:9999}' : ''}</style></head><body><div id="screen" data-pixso-id="screen"><div id="text" data-pixso-id="text">Pixel exact</div>${mode === 'missing-node' ? '' : `<img id="image" data-pixso-id="image" alt="" src="/${mode === 'missing-image' ? 'missing' : 'photo'}.png">`}<button id="button" data-pixso-id="button" aria-label="Apply"></button></div>${mode === 'overlay' ? '<img src="/reference.png" alt="" style="position:fixed;inset:0;width:240px;height:140px;z-index:9999;pointer-events:none">' : ''}${mode === 'unstable' ? '<script>let x=10;setInterval(()=>document.getElementById("text").style.left=(++x)+"px",25)</script>' : ''}</body></html>`;
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (route === '/photo.png') { response.setHeader('Content-Type', 'image/png'); response.end(image); }
    else if (route === '/reference.png' && referenceBytes) { response.setHeader('Content-Type', 'image/png'); response.end(referenceBytes); }
    else if (route.endsWith('.png')) { response.statusCode = 404; response.end('missing'); }
    else { response.setHeader('Content-Type', 'text/html'); response.end(html(route.slice(1))); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const baseUrl = `http://127.0.0.1:${address.port}`;
  const referencePath = path.join(directory, 'reference.png');
  const browser = await chromium.launch({ headless: true, channel: browserChannel });
  try {
    const page = await browser.newPage({ viewport: { width: 240, height: 140 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await page.goto(`${baseUrl}/reference`, { waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: referencePath, animations: 'disabled', caret: 'hide' }); referenceBytes = await readFile(referencePath);
  } finally { await browser.close(); }
  const nodes: DesignNode[] = [
    { id: 'screen', name: 'Screen', type: 'FRAME', parentId: null, children: ['text', 'image', 'button'], bounds: { x: 0, y: 0, width: 240, height: 140 }, raw: { fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] } },
    { id: 'text', name: 'Label', type: 'TEXT', parentId: 'screen', children: [], bounds: { x: 10, y: 10, width: 180, height: 30 }, raw: { characters: 'Pixel exact', fontName: { family: 'Arial', style: 'Regular' }, fontSize: 20, lineHeight: { unit: 'PIXELS', value: 30 } } },
    { id: 'image', name: 'Image', type: 'RECTANGLE', parentId: 'screen', children: [], bounds: { x: 10, y: 70, width: 30, height: 30 }, raw: { fills: [{ type: 'IMAGE', imageHash: 'photo' }] } },
    { id: 'button', name: 'Button', type: 'FRAME', parentId: 'screen', children: [], bounds: { x: 120, y: 70, width: 90, height: 30 }, raw: { fills: [{ type: 'SOLID', color: { r: 20 / 255, g: 100 / 255, b: 200 / 255 } }] } },
  ];
  try {
    const run = (mode: string, comparisonMode?: 'pixel-perfect' | 'tolerant') => validateScreen({ url: `${baseUrl}/${mode}`, rootNodeId: 'screen', nodes, referencePath, outputDir: path.join(directory, mode + (comparisonMode ?? '')), viewport: { width: 240, height: 140 }, browserChannel, mode: comparisonMode, maxPixelDiffRatio: 1, geometryTolerancePx: 100 });
    const correct = await run('reference'); assert.equal(correct.status, 'passed', JSON.stringify(correct.issues)); assert.equal(correct.pixelPerfect, true); assert.equal(correct.pixelDiffPixels, 0); assert.equal(correct.stability?.stable, true); assert.equal(correct.comparison.maxPixelDiffRatio, 0);
    const moved = await run('move'); assert.equal(moved.complete, false); assert.ok(moved.issues.some((issue) => issue.kind === 'geometry')); assert.ok(moved.issues.some((issue) => issue.kind === 'pixels'));
    const font = await run('font'); assert.ok(font.issues.some((issue) => issue.kind === 'font')); assert.equal(font.pixelPerfect, false);
    const missingImage = await run('missing-image'); assert.ok(missingImage.issues.some((issue) => issue.kind === 'readiness' || issue.kind === 'http')); assert.equal(missingImage.complete, false);
    const missingNode = await run('missing-node'); assert.ok(missingNode.missingNodeIds.includes('image')); assert.equal(missingNode.complete, false);
    const overlay = await run('overlay'); assert.equal(overlay.pixelDiffPixels, 0); assert.ok(overlay.issues.some((issue) => issue.kind === 'overlay')); assert.equal(overlay.pixelPerfect, false); assert.equal(overlay.complete, false);
    const pseudoOverlay = await run('pseudo-overlay'); assert.equal(pseudoOverlay.pixelDiffPixels, 0); assert.ok(pseudoOverlay.issues.some((issue) => issue.kind === 'overlay')); assert.equal(pseudoOverlay.complete, false);
    const unstable = await run('unstable'); assert.equal(unstable.stability?.stable, false); assert.equal(unstable.complete, false);
    const tolerant = await run('reference', 'tolerant'); assert.equal(tolerant.status, 'passed'); assert.equal(tolerant.pixelPerfect, false); assert.equal(tolerant.complete, false);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
