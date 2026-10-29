import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixture.js';
import { defaultConfig } from '../src/config.js';
import { loadSnapshot, saveSnapshot } from '../src/artifacts.js';
import { inspectProject } from '../src/project.js';
import { buildDataPlan, verifyDataPlan, validateDataImplementation, type DataBinding } from '../src/project-data.js';
import { hash } from '../src/fs.js';

async function prepare(dynamic = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'pixso-project-data-')), config = defaultConfig(root);
  config.artifactsDir = path.join(root, 'artifacts'); config.generation.outputDir = path.join(root, 'src/generated');
  await mkdir(path.join(root, 'src'), { recursive: true }); await mkdir(path.join(root, 'fixtures'), { recursive: true });
  const source = 'export interface SummaryProps { summary: { total: number } }\n', scenario = '{"total":128}';
  await writeFile(path.join(root, 'src/data.ts'), source); await writeFile(path.join(root, 'fixtures/summary.json'), scenario);
  await writeFile(path.join(root, 'preview.ts'), 'import summary from "./fixtures/summary.json";\nexport async function preparePixsoPreview() { return {props:{summary}}; }');
  config.validation.setupFile = 'preview.ts';
  const capture = fixture(), snapshot = await saveSnapshot(capture, config.artifactsDir, { maxNodesPerTask: 4 }), { manifest } = await loadSnapshot(snapshot);
  const runDir = path.join(snapshot, 'runs', 'data'); await mkdir(runDir, { recursive: true });
  const profileFile = path.join(runDir, 'project-profile.json'); await inspectProject(config, profileFile);
  const analyses = [];
  for (const screen of manifest.screens) for (const [index, widget] of screen.widgets.entries()) {
    const analysisFile = path.join(runDir, `analysis-${index}.json`);
    const dataBindings: DataBinding[] = widget.nodeIds.map(nodeId => ({ nodeId, kind: capture.nodes.find(node => node.id === nodeId)!.raw.characters ? 'static' : 'none', reason: 'Stable fixture label or ordinary geometry', changes: [] }));
    if (dynamic) for (const item of dataBindings) if (item.nodeId === 'value') Object.assign(item, { kind: 'dynamic', reason: 'Summary total is an example business value', binding: { delivery: 'props', expression: 'props.summary.total', source: { projectPath: 'src/data.ts', sha256: hash(source), excerpt: source, exportName: 'SummaryProps' }, fixturePath: 'fixtures/summary.json', fixtureSha256: hash(scenario), fixtureExcerpt: scenario } });
    await writeFile(analysisFile, JSON.stringify({ dataBindings })); analyses.push({ screenId: screen.id, widgetId: widget.id, nodeIds: widget.nodeIds, analysisFile });
  }
  const options = { snapshot, runDir, config, profileFile, analyses };
  async function update(nodeId: string, mutate: (binding: DataBinding, analysis: any) => void) {
    const file = analyses.find(item => item.nodeIds.includes(nodeId))!.analysisFile, analysis = JSON.parse(await readFile(file, 'utf8'));
    mutate(analysis.dataBindings.find((item: DataBinding) => item.nodeId === nodeId), analysis); await writeFile(file, JSON.stringify(analysis));
  }
  const ids = manifest.screens.flatMap(screen => screen.nodeIds);
  return { ...options, ids, manifest, source, scenario, update, build: () => buildDataPlan(options) };
}

test('data discovery includes project MSW, Mirage, JSON fixtures, factories and Storybook sources with hashes', async () => {
  const p = await prepare();
  await writeFile(path.join(p.config.projectRoot, 'package.json'), JSON.stringify({ dependencies: { msw: '2', miragejs: '1', 'json-server': '1', '@storybook/react': '8', fishery: '2' } }));
  const files = ['mocks/handlers.ts', 'factories/user.js', '.storybook/preview.ts', 'stories/Card.stories.tsx', 'db.json'];
  for (const file of files) { await mkdir(path.dirname(path.join(p.config.projectRoot, file)), { recursive: true }); await writeFile(path.join(p.config.projectRoot, file), file.endsWith('.json') ? '{}' : 'export const fixture = {};'); }
  const profile = await inspectProject(p.config);
  for (const mechanism of ['MSW', 'Mirage', 'json-server', 'Storybook', 'factory']) assert(profile.data.mechanisms.includes(mechanism));
  for (const file of [...files, 'fixtures/summary.json']) assert(profile.data.files.some(item => item.path === file && item.sha256.length === 64));
});

test('dynamic plan pins actual fixture/API/setup evidence and rejects changed fixture or snapshot', async () => {
  const p = await prepare(true), reference = await p.build(); assert.equal(reference.status, 'compatible');
  const report = await verifyDataPlan(reference, p.config, p.ids, p.manifest.captureHash);
  assert.equal(report.bindings.find(item => item.nodeId === 'value')?.designText, '128'); assert.equal(report.setupFile, 'preview.ts');
  assert(report.sourceEvidence.some(item => item.projectPath === 'fixtures/summary.json'));
  await assert.rejects(verifyDataPlan(reference, p.config, p.ids, 'different-capture'), /different capture/);
  await writeFile(path.join(p.config.projectRoot, 'fixtures/summary.json'), '{"total":999}');
  await assert.rejects(verifyDataPlan(reference, p.config), /inventory changed/);
});

test('missing classifications, unknown scenarios, fake excerpts and false none classification block data generation', async () => {
  for (const mode of ['missing', 'unknown', 'fake-fixture', 'fake-api', 'none']) {
    const p = await prepare(true);
    await p.update('value', (binding, analysis) => {
      if (mode === 'missing') analysis.dataBindings = analysis.dataBindings.filter((item: DataBinding) => item.nodeId !== 'value');
      else if (mode === 'unknown') { binding.kind = 'unknown'; binding.reason = 'Required customer scenario is missing'; binding.changes = ['Add a scenario using existing project factories']; delete binding.binding; }
      else if (mode === 'fake-fixture') binding.binding!.fixtureExcerpt = 'invented fixture data';
      else if (mode === 'fake-api') binding.binding!.source.exportName = 'InventedProps';
      else { binding.kind = 'none'; delete binding.binding; }
    });
    const reference = await p.build(); assert.equal(reference.status, 'blocked'); assert.match(await readFile(reference.gapsPath, 'utf8'), /Задание для ИИ/);
  }
});

test('dynamic data requires validation setup; generation bootstrap and external URL do not replace it', async () => {
  const p = await prepare(true); delete p.config.validation.setupFile; p.config.generation.data = { setupFile: 'preview.ts' }; p.config.validation.url = 'http://127.0.0.1:3000';
  await inspectProject(p.config, p.profileFile); const reference = await p.build(); assert.equal(reference.status, 'blocked'); assert.match(await readFile(reference.gapsPath, 'utf8'), /requires existing preview setup/);
});

test('configured missing data files and truncated discovery produce actionable reports', async () => {
  const p = await prepare(); p.config.generation.data = { mockFiles: ['missing-fixture.json'] }; await inspectProject(p.config, p.profileFile);
  const missing = await p.build(); assert.equal(missing.status, 'blocked'); assert.match(await readFile(missing.gapsPath, 'utf8'), /missing-fixture.json/);
  delete p.config.generation.data; const profile = await inspectProject(p.config); profile.data.truncatedDiscovery = true; await writeFile(p.profileFile, JSON.stringify(profile));
  const truncated = await p.build(); assert.equal(truncated.status, 'blocked'); assert.match(await readFile(truncated.gapsPath, 'utf8'), /truncated/);
});

test('AST gate accepts real props and static/style literals but rejects hardcoded dynamic text and changed coverage', async () => {
  const p = await prepare(true), reference = await p.build(), report = await verifyDataPlan(reference, p.config), outputDir = path.join(p.runDir, 'implementation'); await mkdir(outputDir);
  const coverage = { dataBindings: report.bindings.map(item => ({ nodeId: item.nodeId, kind: item.kind, ...(item.binding ? { expression: item.binding.expression } : {}) })), imports: [{ specifier: 'project-data', projectPath: 'src/data.ts' }] };
  await writeFile(path.join(outputDir, 'coverage.json'), JSON.stringify(coverage));
  const valid = 'import type {SummaryProps} from "project-data"; export function View(props: SummaryProps) { return <><div data-pixso-id="value" style={{width:128}}>{props.summary.total}</div><button data-pixso-id="button-text">Review design</button><span>128</span></>; }';
  await writeFile(path.join(outputDir, 'View.tsx'), valid); await validateDataImplementation(report, outputDir, p.ids);
  for (const literal of ['128', '{"128"}', '{128}']) { await writeFile(path.join(outputDir, 'View.tsx'), valid.replace('{props.summary.total}', literal)); await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /Hardcoded dynamic/); }
  await writeFile(path.join(outputDir, 'View.tsx'), valid.replace('props: SummaryProps', 'props: SummaryProps = {summary:{total:128}}')); await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /must not be defaults/);
  await writeFile(path.join(outputDir, 'View.tsx'), valid.replace('return <>', 'props = {summary:{total:128}}; return <>')); await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /reassigned/);
  await writeFile(path.join(outputDir, 'View.tsx'), valid.replace('return <>', 'const alias=props; alias.summary.total=128; return <>')); await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /reassigned/);
  await writeFile(path.join(outputDir, 'View.tsx'), valid.replace('return <>', 'const value="128"; return <>').replace('style={{width:128}}>{props.summary.total}', 'data-total={props.summary.total}>{value}')); await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /not rendered/);
  for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'label', 'value']) {
    await writeFile(path.join(outputDir, 'View.tsx'), valid.replace('return <>', 'const value="128"; return <>').replace('style={{width:128}}>{props.summary.total}', `${attribute}={props.summary.total}>{value}`));
    await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /not rendered/);
  }
  await writeFile(path.join(outputDir, 'View.tsx'), valid); coverage.dataBindings.find(item => item.nodeId === 'value')!.kind = 'static'; await writeFile(path.join(outputDir, 'coverage.json'), JSON.stringify(coverage));
  await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /changed approved/);
});

test('dynamic destructured props cannot embed design values in binding defaults', async () => {
  const p = await prepare(true); await p.update('value', item => { item.binding!.expression = 'total'; });
  const reference = await p.build(), report = await verifyDataPlan(reference, p.config), outputDir = path.join(p.runDir, 'destructured'); await mkdir(outputDir);
  await writeFile(path.join(outputDir, 'coverage.json'), JSON.stringify({ dataBindings: report.bindings.map(item => ({ nodeId: item.nodeId, kind: item.kind, ...(item.binding ? { expression: item.binding.expression } : {}) })) }));
  await writeFile(path.join(outputDir, 'View.tsx'), 'export function View({total="128"}) { return <div data-pixso-id="value">{total}</div>; }');
  await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /defaults in destructured/);
});

test('data API evidence pins transitive project type sources', async () => {
  const p = await prepare(true), barrel = 'export type { SummaryProps } from "./summary-types.js";';
  await writeFile(path.join(p.config.projectRoot, 'src/summary-types.ts'), p.source); await writeFile(path.join(p.config.projectRoot, 'src/data.ts'), barrel);
  await p.update('value', item => { item.binding!.source.sha256 = hash(barrel); item.binding!.source.excerpt = barrel; });
  const reference = await p.build(), report = await verifyDataPlan(reference, p.config);
  assert(report.sourceEvidence.some(item => item.projectPath === 'src/summary-types.ts'));
  await writeFile(path.join(p.config.projectRoot, 'src/summary-types.ts'), p.source.replace('number', 'string'));
  await assert.rejects(verifyDataPlan(reference, p.config), /data source changed/);
});

test('AST gate rejects fixture imports into production and local objects posing as hook data', async () => {
  const p = await prepare(true), hookSource = 'export function useSummary() { return { total: 0 }; }';
  await writeFile(path.join(p.config.projectRoot, 'src/useSummary.ts'), hookSource);
  await p.update('value', binding => { binding.binding!.delivery = 'hook'; binding.binding!.expression = 'summary.total'; binding.binding!.source = { projectPath: 'src/useSummary.ts', sha256: hash(hookSource), excerpt: hookSource, exportName: 'useSummary' }; });
  const reference = await p.build(), report = await verifyDataPlan(reference, p.config), outputDir = path.join(p.runDir, 'implementation'); await mkdir(outputDir);
  const coverage = { dataBindings: report.bindings.map(item => ({ nodeId: item.nodeId, kind: item.kind, ...(item.binding ? { expression: item.binding.expression } : {}) })), imports: [{ specifier: 'project-hook', projectPath: 'src/useSummary.ts' }, { specifier: 'fixture', projectPath: 'fixtures/summary.json' }] };
  await writeFile(path.join(outputDir, 'coverage.json'), JSON.stringify(coverage));
  const view = 'import {useSummary} from "project-hook"; export function View() { const summary=useSummary(); return <div data-pixso-id="value">{summary.total}</div>; }';
  await writeFile(path.join(outputDir, 'View.tsx'), view); await validateDataImplementation(report, outputDir, p.ids);
  await writeFile(path.join(outputDir, 'View.tsx'), view.replace('const summary=useSummary()', 'const summary={total:128}')); await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /not derived/);
  await writeFile(path.join(outputDir, 'View.tsx'), 'import fixture from "fixture";\n' + view); await assert.rejects(validateDataImplementation(report, outputDir, p.ids), /must not be imported/);
});
