import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { acceptRun, checkTypescript, verifyInstalledFiles, pinPreviewFile, verifyPreviewEvidence, previewRequestFile } from '../src/accept.js';
import { saveSnapshot } from '../src/artifacts.js';
import { defaultConfig } from '../src/config.js';
import { hash, slug, writeJson } from '../src/fs.js';
import type { Capture } from '../src/types.js';

const temp = () => mkdtemp(path.join(os.tmpdir(), 'pixso-accept-test-'));

test('preview evidence rejects changed transitive resources even when installed generated files are unchanged', async () => {
  const project = await temp(), dependency = path.join(project, 'shared-theme.css');
  await writeFile(dependency, '.button { color: red }');
  const evidence: Record<string,string> = {};
  await pinPreviewFile(dependency, evidence); await verifyPreviewEvidence(evidence);
  await writeFile(dependency, '.button { color: blue }');
  await assert.rejects(verifyPreviewEvidence(evidence), /Preview dependency changed/);
  await assert.rejects(pinPreviewFile(dependency,evidence), /Preview dependency changed/);
});

test('public assets take Vite serving precedence and their mutation invalidates preview evidence', async () => {
  const project=await temp(), publicDir=path.join(project,'public');await mkdir(publicDir);
  await writeFile(path.join(project,'font.woff'),'root unused font');
  await writeFile(path.join(publicDir,'font.woff'),'served font');
  const served=previewRequestFile('/font.woff',project,publicDir), evidence:Record<string,string>={};
  assert.equal(served,path.join(publicDir,'font.woff'));
  await pinPreviewFile(served,evidence);
  await writeFile(served,'changed served font');
  await assert.rejects(verifyPreviewEvidence(evidence),/Preview dependency changed/);
  assert.throws(()=>previewRequestFile('/../../outside',project,publicDir),/escapes root/);
});

test('installed-file verification detects missing, edited, unowned and escaping paths', async () => {
  const project = await temp(); const output = path.join(project, 'generated'); await mkdir(output);
  await writeFile(path.join(output, 'View.tsx'), 'export default () => null;');
  const digest = hash('export default () => null;');
  await writeJson(path.join(output, '.pixso-files.json'), { 'View.tsx': digest });
  assert.deepEqual(await verifyInstalledFiles(project, output, ['View.tsx']), { 'View.tsx': digest });
  await assert.rejects(verifyInstalledFiles(project, output, ['../outside.ts']), /escapes/);
  await writeFile(path.join(output, 'Unowned.ts'), 'export {};');
  await assert.rejects(verifyInstalledFiles(project, output, ['Unowned.ts']), /ownership ledger/);
  await writeFile(path.join(output, 'View.tsx'), 'export default () => 1;');
  await assert.rejects(verifyInstalledFiles(project, output, ['View.tsx']), /changed/);
  await unlink(path.join(output, 'View.tsx'));
  await assert.rejects(verifyInstalledFiles(project, output, ['View.tsx']), /ENOENT/);
});

test('TypeScript acceptance includes generated files excluded by the project tsconfig', async () => {
  const project = await temp(); await mkdir(path.join(project, 'src')); await mkdir(path.join(project, 'generated')); await mkdir(path.join(project, 'artifacts'));
  await writeJson(path.join(project, 'tsconfig.json'), { compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, types: [], incremental: true, tsBuildInfoFile: './cache.tsbuildinfo' }, include: ['src/**/*.ts', 'artifacts/**/*.ts'] });
  const artifact = path.join(project, 'artifacts', 'broken.ts');
  await writeFile(artifact, 'export const stagedWorker: number = "incomplete staging";');
  await writeFile(path.join(project, 'src', 'main.ts'), 'export const fromProject: number = "wrong project type";');
  const generated = path.join(project, 'generated', 'View.ts');
  await writeFile(generated, 'export const fromGenerated: number = "wrong generated type";');
  const excludes = [path.join(project, 'artifacts'), path.join(project, 'generated')];
  const report = await checkTypescript(project, [generated], path.join(project, 'reports'), excludes);
  assert.equal(report.status, 'failed');
  assert.ok(report.diagnostics.some((issue) => issue.code === 2322 && issue.file === generated));
  assert.ok(report.diagnostics.some((issue) => issue.code === 2322 && issue.file === path.join(project, 'src', 'main.ts')));
  assert.ok(!report.checkedFiles.includes(artifact));
  assert.ok(!report.diagnostics.some((issue) => issue.file === artifact));
  assert.equal(JSON.parse(await readFile(report.reportPath, 'utf8')).status, 'failed');
  await writeFile(generated, 'export const fromGenerated: number = 1;');
  await writeFile(path.join(project, 'src', 'main.ts'), 'export const fromProject: number = 2;');
  assert.equal((await checkTypescript(project, [generated], path.join(project, 'reports'), excludes)).status, 'passed');
});

test('acceptance fails with a durable report before browser startup when installed screen output is tampered', async () => {
  const project = await temp(), runDir = path.join(project, 'run'); await mkdir(runDir);
  const config = defaultConfig(project); config.artifactsDir = path.join(project, '.pixso-artifacts'); config.generation.outputDir = path.join(project, 'generated');
  const capture: Capture = { schemaVersion: 1, source: { provider: 'fixture', fileKey: 'fixture', name: 'Fixture', capturedAt: '2026-01-01T00:00:00Z' }, roots: ['screen'], nodes: [{ id: 'screen', name: 'Screen', type: 'FRAME', parentId: null, children: [], bounds: { x: 0, y: 0, width: 80, height: 40 }, raw: {} }], assets: [], screenshots: [], completeness: { status: 'complete', receivedNodeCount: 1, expectedNodeCount: 1, issues: [] } };
  const snapshot = await saveSnapshot(capture, config.artifactsDir, { baseDir: project });
  const screenDir = path.join(config.generation.outputDir, slug('screen')); await mkdir(screenDir, { recursive: true });
  const contents: Record<string, string> = { 'View.tsx': 'export default () => null;', 'View.css': '.view {}', 'coverage.json': JSON.stringify({ reviewedNodeIds: ['screen'], unsupported: [] }) };
  const files = Object.keys(contents).map((file) => `${slug('screen')}/${file}`);
  const ledger: Record<string, string> = {};
  for (const [filename, content] of Object.entries(contents)) { await writeFile(path.join(screenDir, filename), content); ledger[`${slug('screen')}/${filename}`] = hash(content); }
  await writeJson(path.join(config.generation.outputDir, '.pixso-files.json'), ledger);
  await writeJson(path.join(runDir, 'result.json'), { snapshot, unsupported: [], generation: { status: 'succeeded' } });
  await writeJson(path.join(runDir, 'applied.json'), { snapshot, outputDir: config.generation.outputDir, files });
  await writeFile(path.join(screenDir, 'View.css'), '.view {display:none}');
  const report = await acceptRun(runDir, config);
  assert.equal(report.status, 'failed'); assert.equal(report.complete, false);
  assert.ok(report.captureHash);
  assert.ok(report.issues.some((issue) => issue.includes('Installed file changed')));
  assert.equal(report.compiler, undefined);
  assert.equal(JSON.parse(await readFile(report.reportPath, 'utf8')).complete, false);
  await writeFile(path.join(screenDir, 'View.css'), contents['View.css']);
  const missingPlan = await acceptRun(runDir, config);
  assert.equal(missingPlan.complete, false); assert.equal(missingPlan.pixelPerfect, false);
  assert(missingPlan.issues.some(issue => issue.includes('Missing mandatory component-plan')));
  assert.equal(missingPlan.compiler, undefined);
});
