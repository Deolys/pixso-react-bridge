import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixture.js';
import { defaultConfig } from '../src/config.js';
import { loadSnapshot, saveSnapshot } from '../src/artifacts.js';
import { inspectProject } from '../src/project.js';
import { buildComponentPlan, verifyComponentPlan, type ComponentDecision } from '../src/design-system.js';
import { hash } from '../src/fs.js';

async function prepare(options: { component?: boolean; instance?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-components-')), config = defaultConfig(root);
  config.artifactsDir = path.join(root, 'artifacts'); config.generation.outputDir = path.join(root, 'generated');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'test-project', dependencies: {} }));
  const componentSource = 'export interface ButtonProps { disabled?: boolean; variant?: "primary" }\nexport function Button(props: ButtonProps) { return <button disabled={props.disabled} data-variant={props.variant}>Review</button>; }\n';
  if (options.component) { await writeFile(path.join(root, 'Button.tsx'), componentSource); await writeFile(path.join(root, 'Button.css'), '.button { color: green; }'); }
  const capture = fixture(); if (options.instance) capture.nodes.find(n => n.id === 'button')!.type = 'INSTANCE';
  const snapshot = await saveSnapshot(capture, config.artifactsDir, { maxNodesPerTask: 4 }), { manifest } = await loadSnapshot(snapshot);
  const runDir = path.join(snapshot, 'runs', 'components'); await mkdir(runDir, { recursive: true });
  const profileFile = path.join(runDir, 'project-profile.json'); await inspectProject(config, profileFile);
  const analyses = [];
  for (const screen of manifest.screens) for (const [index, widget] of screen.widgets.entries()) {
    const analysisFile = path.join(runDir, `analysis-${index}.json`);
    const componentDecisions: ComponentDecision[] = widget.nodeIds.map(nodeId => ({ nodeId, decision: 'native', required: 'Ordinary fixture text or layout', available: 'Native HTML and CSS', reason: 'No reusable component contract in this fixture element', changes: [], evidence: [] }));
    await writeFile(analysisFile, JSON.stringify({ reviewedNodeIds: widget.nodeIds, unresolved: [], componentDecisions }));
    analyses.push({ screenId: screen.id, widgetId: widget.id, nodeIds: widget.nodeIds, analysisFile });
  }
  const optionsForPlan = { snapshot, runDir, config, profileFile, analyses };
  async function updateDecision(nodeId: string, mutate: (decision: ComponentDecision, analysis: any) => void) {
    const source = analyses.find(a => a.nodeIds.includes(nodeId))!; const analysis = JSON.parse(await readFile(source.analysisFile, 'utf8'));
    mutate(analysis.componentDecisions.find((d: ComponentDecision) => d.nodeId === nodeId), analysis); await writeFile(source.analysisFile, JSON.stringify(analysis));
  }
  return { ...optionsForPlan, manifest, componentSource, updateDecision, build: () => buildComponentPlan(optionsForPlan) };
}

test('compatible explicit native decisions cover every ID and bind capture, CSS and package evidence', async () => {
  const p = await prepare({ component: true }), reference = await p.build();
  assert.equal(reference.status, 'compatible'); assert.equal(reference.decisionCount, p.manifest.screens.flatMap(s => s.nodeIds).length);
  const report = await verifyComponentPlan(reference, p.config, p.manifest.screens.flatMap(s => s.nodeIds), p.manifest.captureHash);
  assert(report.sourceEvidence.some(e => e.projectPath === 'Button.css')); assert(report.sourceEvidence.some(e => e.projectPath === 'package.json'));
  await assert.rejects(verifyComponentPlan(reference, p.config, undefined, 'another-revision'), /different capture/);
  await writeFile(path.join(p.config.projectRoot, 'Button.css'), '.button { color: red; }');
  await assert.rejects(verifyComponentPlan(reference, p.config), /inventory changed/);
});

test('omitted, duplicate, and malformed component decisions block exact coverage', async () => {
  for (const mode of ['omit', 'duplicate', 'malformed']) {
    const p = await prepare();
    await p.updateDecision('button', (decision, analysis) => {
      if (mode === 'omit') analysis.componentDecisions = analysis.componentDecisions.filter((d: ComponentDecision) => d.nodeId !== 'button');
      if (mode === 'duplicate') analysis.componentDecisions.push(decision);
      if (mode === 'malformed') decision.reason = '';
    });
    const reference = await p.build(); assert.equal(reference.status, 'blocked'); assert(reference.blockingCount > 0);
    await assert.rejects(verifyComponentPlan(reference, p.config), /blocked/);
  }
});

test('missing Button and adaptation requirements produce explicit Russian actionable gap reports', async () => {
  for (const decision of ['create', 'adapt'] as const) {
    const p = await prepare({ component: decision === 'adapt' });
    await p.updateDecision('button', value => Object.assign(value, { decision, required: 'Button with primary and disabled variants', available: decision === 'create' ? 'No Button' : 'Existing Button lacks required variants', reason: 'Required states are absent', changes: ['Add primary and disabled variants with accessible behavior'] }));
    const reference = await p.build(); assert.equal(reference.status, 'blocked');
    const gap = await readFile(reference.gapsPath, 'utf8');
    assert.match(gap, /узел button/); assert.match(gap, /Button with primary/); assert.match(gap, /Задание для ИИ/); assert.match(gap, /disabled variants/);
  }
});

test('known Pixso instance cannot silently be native and unresolved analysis remains blocking', async () => {
  const instance = await prepare({ instance: true }); assert.equal((await instance.build()).status, 'blocked');
  const unresolved = await prepare(); await unresolved.updateDecision('button', (_, analysis) => { analysis.unresolved.push({ nodeId: 'button', issue: 'unverified Button API' }); });
  const result = await unresolved.build(); assert.equal(result.status, 'blocked'); assert.match(await readFile(result.planPath, 'utf8'), /unverified Button API/);
});

test('reuse verifies actual source bytes, source API excerpt and exported symbol', async () => {
  const p = await prepare({ component: true, instance: true });
  const evidence = { projectPath: 'Button.tsx', sha256: hash(p.componentSource), exportName: 'Button', excerpt: 'export interface ButtonProps { disabled?: boolean; variant?: "primary" }' };
  await p.updateDecision('button', value => Object.assign(value, { decision: 'reuse', required: 'Button with primary and disabled variants', available: 'Button exported by Button.tsx', reason: 'Existing API explicitly exposes both required props', evidence: [evidence] }));
  const reference = await p.build(); assert.equal(reference.status, 'compatible'); await verifyComponentPlan(reference, p.config);
  await p.updateDecision('button', value => { value.evidence[0].exportName = 'InventedButton'; });
  const badExport = await p.build(); assert.equal(badExport.status, 'blocked'); assert.match(await readFile(badExport.gapsPath, 'utf8'), /does not exist/);
  await p.updateDecision('button', value => { value.evidence[0] = { ...evidence, projectPath: 'MissingButton.tsx' }; });
  assert.equal((await p.build()).status, 'blocked');
  await p.updateDecision('button', value => { value.evidence[0] = { ...evidence, excerpt: 'nonexistent primaryVariant API' }; });
  assert.equal((await p.build()).status, 'blocked');
  await p.updateDecision('button', value => { value.evidence[0] = { ...evidence, sha256: '0'.repeat(64) }; });
  assert.equal((await p.build()).status, 'blocked');
});

test('truncated discovery blocks even with complete native decisions', async () => {
  const p = await prepare(), profile = JSON.parse(await readFile(p.profileFile, 'utf8'));
  profile.truncatedDiscovery = true; await writeFile(p.profileFile, JSON.stringify(profile));
  const reference = await p.build(); assert.equal(reference.status, 'blocked'); assert.match(await readFile(reference.gapsPath, 'utf8'), /truncated/);
});

test('declared complete inventory avoids incidental source scanning and resolves default exports', async () => {
  const p = await prepare({ component: true });
  await writeFile(path.join(p.config.projectRoot, 'Button.tsx'), 'function Button() { return <button />; }\nexport { Button };\nexport default Button;');
  p.config.generation.componentFiles = ['Button.tsx']; p.config.generation.cssFiles = ['Button.css'];
  const profile = await inspectProject(p.config); assert.deepEqual(profile.components[0].exports.sort(), ['Button', 'default']); assert.equal(profile.truncatedDiscovery, false);
});

test('a designated but uninstalled design-system package cannot pass with native decisions', async () => {
  const p = await prepare(); p.config.generation.designSystem = { name: 'Corporate UI', packageName: '@corp/ui' };
  await inspectProject(p.config, p.profileFile);
  const blocked = await p.build(); assert.equal(blocked.status, 'blocked'); assert.match(await readFile(blocked.gapsPath, 'utf8'), /@corp\/ui is not installed or verified/);
  const packageDirectory = path.join(p.config.projectRoot, 'node_modules', '@corp', 'ui'); await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@corp/ui', version: '1.0.0' }));
  await inspectProject(p.config, p.profileFile);
  const compatible = await p.build(); assert.equal(compatible.status, 'compatible');
  const report = await verifyComponentPlan(compatible, p.config); assert(report.sourceEvidence.some(e => e.projectPath === 'node_modules/@corp/ui/package.json'));
});
