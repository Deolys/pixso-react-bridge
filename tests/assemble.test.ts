import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { assembleWidgetScreen, type AssembleWidgetOptions } from '../src/assemble.js';
import { hash, slug } from '../src/fs.js';
import type { AgentTaskResult } from '../src/agents/index.js';

async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<AssembleWidgetOptions> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pixso-assemble-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const planDir = path.join(root, 'plan'); await mkdir(planDir);
  const viewTsx = path.join(planDir, 'View.tsx'), viewCss = path.join(planDir, 'View.css');
  await writeFile(viewTsx, "import { Node_root } from './Widget0001';\nimport './View.css';\nexport const View = Node_root;\nexport default View;\n");
  await writeFile(viewCss, '.screen { display: block; }\n');
  const widgets = [
    { id: 'root', nodeIds: ['root'], filename: 'Widget0001.tsx', cssFilename: 'Widget0001.css', directory: planDir, exportNames: { root: 'Node_root' } as Record<string, string> },
    { id: 'child', nodeIds: ['child'], filename: 'Widget0002.tsx', cssFilename: 'Widget0002.css', directory: planDir, exportNames: { child: 'Node_child' } as Record<string, string> },
  ];
  const workerResults: AgentTaskResult[] = [];
  for (const [index, widget] of widgets.entries()) {
    const taskDir = path.join(root, `worker-${index}`), outputDir = path.join(taskDir, 'output');
    await mkdir(path.join(outputDir, 'assets'), { recursive: true });
    const sources: Record<string, string> = {
      [widget.filename]: `export function ${Object.values(widget.exportNames)[0]}() { return <div data-pixso-id="${widget.id}"/>; }\n`,
      [widget.cssFilename]: `.widget-${index} { display: block; }\n`,
      'assets/shared.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'coverage.json': JSON.stringify({ schemaVersion: 1, reviewedNodeIds: widget.nodeIds, unsupported: index === 0 ? ['known-fidelity-gap'] : [], imports: [{ specifier: '@project/Button', projectPath: 'src/Button.tsx' }] }),
    };
    for (const [file, content] of Object.entries(sources)) await writeFile(path.join(outputDir, file), content);
    workerResults.push({
      id: `worker-${index}`, status: index === 0 ? 'succeeded' : 'skipped', attempts: 1, taskDir, workspace: taskDir, outputDir,
      stdoutPath: path.join(taskDir, 'stdout.log'), stderrPath: path.join(taskDir, 'stderr.log'), fingerprint: hash(`worker-${index}`),
      files: Object.keys(sources), outputHashes: Object.fromEntries(Object.entries(sources).map(([file, content]) => [file, hash(content)])),
    });
  }
  return { screenId: 'root', screenNodeIds: ['root', 'child'], widgetPlan: { viewTsx, viewCss, widgets }, workerResults, outputDir: path.join(root, 'assembled') };
}

async function replaceWorkerFile(options: AssembleWidgetOptions, index: number, filename: string, content: string): Promise<void> {
  const worker = options.workerResults[index];
  await writeFile(path.join(worker.outputDir, filename), content);
  worker.outputHashes[filename] = hash(content);
  if (!worker.files.includes(filename)) worker.files.push(filename);
}

test('assembles bounded worker outputs, shares identical assets and merges exact coverage', async t => {
  const options = await fixture(t);
  const result = await assembleWidgetScreen(options);
  assert.equal(result.status, 'succeeded'); assert.equal(result.id, `implement-${slug(options.screenId)}`);
  assert.equal(result.files.filter(file => file === 'assets/shared.svg').length, 1);
  assert.equal(await readFile(path.join(result.outputDir, 'View.tsx'), 'utf8'), await readFile(options.widgetPlan.viewTsx, 'utf8'));
  const coverage = JSON.parse(await readFile(path.join(result.outputDir, 'coverage.json'), 'utf8'));
  assert.deepEqual(coverage.reviewedNodeIds, options.screenNodeIds);
  assert.deepEqual(coverage.unsupported, ['known-fidelity-gap']);
  assert.deepEqual(coverage.imports, [{ specifier: '@project/Button', projectPath: 'src/Button.tsx' }]);
  for (const file of result.files) assert.equal(result.outputHashes[file], hash(await readFile(path.join(result.outputDir, file))));
  assert.equal(JSON.parse(await readFile(path.join(result.taskDir, 'worker-results.json'), 'utf8')).length, 2);
});

test('conflicting asset bytes fail before any aggregate output is written', async t => {
  const options = await fixture(t);
  await replaceWorkerFile(options, 1, 'assets/shared.svg', '<svg>different</svg>');
  await assert.rejects(assembleWidgetScreen(options), /Conflicting widget file bytes/);
  await assert.rejects(access(options.outputDir));
});

test('changed output hashes and extra unrecorded files are rejected', async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.workerResults[0].outputDir, 'Widget0001.css'), 'mutated');
  await assert.rejects(assembleWidgetScreen(options), /inventory or SHA-256 changed/);
  await replaceWorkerFile(options, 0, 'Widget0001.css', 'valid again');
  await writeFile(path.join(options.workerResults[0].outputDir, 'unexpected.txt'), 'unrecorded');
  await assert.rejects(assembleWidgetScreen(options), /inventory or SHA-256 changed/);
});

test('coverage omissions and import mapping conflicts are rejected', async t => {
  const options = await fixture(t);
  const coverage = JSON.parse(await readFile(path.join(options.workerResults[1].outputDir, 'coverage.json'), 'utf8'));
  coverage.reviewedNodeIds = [];
  await replaceWorkerFile(options, 1, 'coverage.json', JSON.stringify(coverage));
  await assert.rejects(assembleWidgetScreen(options), /missing, duplicate or extra node IDs/);
  coverage.reviewedNodeIds = ['child']; coverage.imports[0].projectPath = 'src/DifferentButton.tsx';
  await replaceWorkerFile(options, 1, 'coverage.json', JSON.stringify(coverage));
  await assert.rejects(assembleWidgetScreen(options), /Conflicting import mapping/);
});

test('workers cannot overwrite the deterministic shell or omit assigned exports', async t => {
  const options = await fixture(t);
  await replaceWorkerFile(options, 0, 'Widget0001.tsx', 'export const Unrelated = () => null;');
  await assert.rejects(assembleWidgetScreen(options), /missing assigned named export Node_root/);
  await replaceWorkerFile(options, 0, 'Widget0001.tsx', 'export const Node_root = () => null;');
  await replaceWorkerFile(options, 0, 'View.tsx', 'export default () => null;');
  await assert.rejects(assembleWidgetScreen(options), /may not overwrite deterministic screen shell/);
});

test('identical assembly resumes and protects changed assembled files', async t => {
  const options = await fixture(t);
  const first = await assembleWidgetScreen(options), second = await assembleWidgetScreen(options);
  assert.equal(second.fingerprint, first.fingerprint);
  const edited = path.join(options.outputDir, 'View.css'); await writeFile(edited, 'user edit');
  await assert.rejects(assembleWidgetScreen(options), /Existing assembled screen/);
  assert.equal(await readFile(edited, 'utf8'), 'user edit');
});

test('output symlinks and junctions are rejected', async t => {
  const options = await fixture(t);
  const target = path.dirname(options.widgetPlan.viewTsx);
  await symlink(target, path.join(options.workerResults[0].outputDir, 'escape'), 'junction');
  await assert.rejects(assembleWidgetScreen(options), /rejects output symlinks/);
});

test('assembly preserves validated per-widget data bindings and requires complete binding coverage', async t => {
  const options = await fixture(t);
  const coverages = await Promise.all(options.workerResults.map(async worker => JSON.parse(await readFile(path.join(worker.outputDir, 'coverage.json'), 'utf8'))));
  coverages[0].dataBindings = [{ nodeId: 'root', kind: 'none' }];
  coverages[1].dataBindings = [{ nodeId: 'child', kind: 'dynamic', expression: 'props.summary.total' }];
  await replaceWorkerFile(options, 0, 'coverage.json', JSON.stringify(coverages[0]));
  await assert.rejects(assembleWidgetScreen(options), /Assembled dataBindings.*missing/);
  await replaceWorkerFile(options, 1, 'coverage.json', JSON.stringify(coverages[1]));
  const result = await assembleWidgetScreen(options);
  const assembled = JSON.parse(await readFile(path.join(result.outputDir, 'coverage.json'), 'utf8'));
  assert.deepEqual(assembled.dataBindings, [...coverages[0].dataBindings, ...coverages[1].dataBindings]);
  coverages[1].dataBindings[0].expression = '';
  await replaceWorkerFile(options, 1, 'coverage.json', JSON.stringify(coverages[1]));
  await assert.rejects(assembleWidgetScreen(options), /invalid data binding/);
});
