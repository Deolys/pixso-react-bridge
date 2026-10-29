import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { hash, inside, slug, writeJson } from './fs.js';
import type { AgentTaskResult } from './agents/index.js';

export interface WidgetAssemblyPlan {
  viewTsx: string;
  viewCss: string;
  widgets: {
    id: string;
    nodeIds: string[];
    filename: string;
    cssFilename: string;
    directory: string;
    exportNames: Record<string, string>;
  }[];
}
export interface AssembleWidgetOptions {
  screenId: string;
  screenNodeIds: string[];
  widgetPlan: WidgetAssemblyPlan;
  /** Results are aligned with widgetPlan.widgets; expected filenames and coverage prove the assignment. */
  workerResults: AgentTaskResult[];
  outputDir: string;
}

function safeRelative(file: string): string {
  if (!file || path.isAbsolute(file) || /[:\0]/.test(file) || file.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe assembled file path: ${file}`);
  return file.replaceAll('\\', '/');
}

function sameIds(actual: unknown, expected: string[], label: string): asserts actual is string[] {
  const actualIds = new Set(Array.isArray(actual) ? actual : []);
  if (!Array.isArray(actual) || actual.some(id => typeof id !== 'string' || !id) || actual.length !== expected.length || actualIds.size !== actual.length || expected.some(id => !actualIds.has(id))) throw new Error(`${label}: missing, duplicate or extra node IDs`);
}

async function fileHash(file: string): Promise<string> {
  if (!(await lstat(file)).isFile()) throw new Error(`Assembly input must be a regular file, not a symlink: ${file}`);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function inventory(root: string, prefix = ''): Promise<Record<string, string>> {
  const directory = path.join(root, prefix), stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Assembly directory is not a regular directory: ${directory}`);
  const files: Record<string, string> = Object.create(null);
  for (const name of (await readdir(directory)).sort()) {
    const relative = safeRelative(prefix ? `${prefix}/${name}` : name), file = path.join(root, relative), entry = await lstat(file);
    if (entry.isSymbolicLink()) throw new Error(`Assembly rejects output symlinks: ${file}`);
    if (entry.isDirectory()) Object.assign(files, await inventory(root, relative));
    else files[relative] = await fileHash(file);
  }
  return files;
}

function assertInventory(actual: Record<string, string>, recorded: Record<string, string>, files: string[], label: string): void {
  const names = Object.keys(actual).sort();
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded) || !Array.isArray(files) || new Set(files).size !== files.length || JSON.stringify(names) !== JSON.stringify([...files].sort()) || JSON.stringify(names) !== JSON.stringify(Object.keys(recorded).sort()) || names.some(file => actual[file] !== recorded[file])) throw new Error(`${label}: output inventory or SHA-256 changed after the worker completed`);
}

function assertExports(source: string, filename: string, names: string[]): void {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const exported = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) if (!element.isTypeOnly) exported.add(element.name.text);
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) || modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) exported.add(statement.name.text);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text);
  }
  for (const name of names) if (!exported.has(name)) throw new Error(`${filename}: missing assigned named export ${name}`);
}

/** Deterministic assembly only; compilation and visual acceptance remain independent gates. */
export async function assembleWidgetScreen(options: AssembleWidgetOptions): Promise<AgentTaskResult> {
  const { screenId, screenNodeIds, widgetPlan, workerResults } = options;
  if (!screenId || !screenNodeIds.length || !widgetPlan.widgets.length) throw new Error('Assembly requires a screen and non-empty node/widget inventories');
  sameIds(screenNodeIds, [...new Set(screenNodeIds)], 'Screen inventory');
  if (workerResults.length !== widgetPlan.widgets.length) throw new Error('Each widget requires exactly one aligned worker result');
  sameIds(widgetPlan.widgets.flatMap(widget => widget.nodeIds), screenNodeIds, 'Widget partition');
  const sourceFiles = new Map<string, { source?: string; bytes?: Buffer; sha256: string }>();
  const insensitivePaths = new Map<string, string>();
  function add(file: string, value: { source?: string; bytes?: Buffer; sha256: string }): void {
    file = safeRelative(file);
    const previousCase = insensitivePaths.get(file.toLowerCase());
    if (previousCase && previousCase !== file) throw new Error(`Case-conflicting assembled files: ${previousCase} and ${file}`);
    const previous = sourceFiles.get(file);
    if (previous && previous.sha256 !== value.sha256) throw new Error(`Conflicting widget file bytes: ${file}`);
    if (!previous) sourceFiles.set(file, value);
    insensitivePaths.set(file.toLowerCase(), file);
  }
  const primaryOwners = new Map<string, number>();
  for (const [index, widget] of widgetPlan.widgets.entries()) {
    for (const filename of [widget.filename, widget.cssFilename]) {
      if (safeRelative(filename).includes('/') || /^(view\.(tsx|css)|coverage\.json)$/i.test(filename)) throw new Error(`Invalid widget filename: ${filename}`);
      if (primaryOwners.has(filename.toLowerCase())) throw new Error(`Duplicate widget filename: ${filename}`);
      primaryOwners.set(filename.toLowerCase(), index);
    }
    if (!widget.filename.endsWith('.tsx') || !widget.cssFilename.endsWith('.css')) throw new Error('Widgets require .tsx and .css files');
    sameIds(Object.keys(widget.exportNames), widget.nodeIds, `Widget ${widget.id} export mapping`);
    if (Object.values(widget.exportNames).some(name => !/^[$A-Z_a-z][$0-9A-Z_a-z]*$/.test(name)) || new Set(Object.values(widget.exportNames)).size !== widget.nodeIds.length) throw new Error(`Widget ${widget.id} has invalid or duplicate export names`);
  }
  const unsupported: unknown[] = [];
  const dataBindings: { nodeId: string; kind: string; expression?: string }[] = [];
  const imports = new Map<string, { specifier: string; projectPath: string }>();
  for (const [index, widget] of widgetPlan.widgets.entries()) {
    const result = workerResults[index];
    if (!['succeeded', 'skipped'].includes(result.status)) throw new Error(`Widget worker did not succeed: ${result.id}`);
    const files = await inventory(result.outputDir);
    assertInventory(files, result.outputHashes, result.files, result.id);
    for (const expected of [widget.filename, widget.cssFilename, 'coverage.json']) if (!Object.hasOwn(files, expected)) throw new Error(`${result.id}: required output missing: ${expected}`);
    const coverage = JSON.parse(await readFile(path.join(result.outputDir, 'coverage.json'), 'utf8')) as Record<string, unknown>;
    if (coverage.schemaVersion !== 1 || !Array.isArray(coverage.unsupported) || !Array.isArray(coverage.imports)) throw new Error(`${result.id}: invalid coverage schema`);
    sameIds(coverage.reviewedNodeIds, widget.nodeIds, result.id);
    unsupported.push(...coverage.unsupported);
    if (coverage.dataBindings !== undefined) {
      if (!Array.isArray(coverage.dataBindings)) throw new Error(`${result.id}: dataBindings must be an array`);
      sameIds(coverage.dataBindings.map(value => value?.nodeId), widget.nodeIds, `${result.id} dataBindings`);
      for (const value of coverage.dataBindings) {
        if (!['none', 'static', 'dynamic', 'unknown'].includes(value.kind) || (value.expression !== undefined && typeof value.expression !== 'string') || (value.kind === 'dynamic' && !value.expression?.trim())) throw new Error(`${result.id}: invalid data binding for ${value.nodeId}`);
        dataBindings.push({ nodeId: value.nodeId, kind: value.kind, ...(value.expression !== undefined ? { expression: value.expression } : {}) });
      }
    }
    for (const value of coverage.imports) {
      if (!value || typeof value !== 'object' || typeof value.specifier !== 'string' || !value.specifier || value.specifier.includes('\0') || typeof value.projectPath !== 'string') throw new Error(`${result.id}: invalid component import mapping`);
      const mapping = { specifier: value.specifier, projectPath: safeRelative(value.projectPath) };
      const previous = imports.get(mapping.specifier);
      if (previous && previous.projectPath !== mapping.projectPath) throw new Error(`Conflicting import mapping for ${mapping.specifier}`);
      imports.set(mapping.specifier, mapping);
    }
    assertExports(await readFile(path.join(result.outputDir, widget.filename), 'utf8'), widget.filename, Object.values(widget.exportNames));
    for (const [file, sha256] of Object.entries(files)) {
      if (file === 'coverage.json') continue;
      if (/^view\.(tsx|css)$/i.test(file)) throw new Error(`Worker may not overwrite deterministic screen shell: ${file}`);
      const owner = primaryOwners.get(file.toLowerCase());
      if (owner !== undefined && owner !== index) throw new Error(`Worker ${result.id} wrote another widget's module: ${file}`);
      add(file, { source: path.join(result.outputDir, file), sha256 });
    }
  }
  if (dataBindings.length) sameIds(dataBindings.map(value => value.nodeId), screenNodeIds, 'Assembled dataBindings');
  for (const [file, source] of [['View.tsx', widgetPlan.viewTsx], ['View.css', widgetPlan.viewCss]]) add(file, { source, sha256: await fileHash(source) });
  const coverage = Buffer.from(JSON.stringify({ schemaVersion: 1, reviewedNodeIds: screenNodeIds, unsupported, imports: [...imports.values()].sort((a, b) => a.specifier.localeCompare(b.specifier)), ...(dataBindings.length ? { dataBindings } : {}) }, null, 2) + '\n');
  add('coverage.json', { bytes: coverage, sha256: hash(coverage) });
  const outputDir = path.resolve(options.outputDir);
  const outputHashes = Object.fromEntries([...sourceFiles].sort(([left], [right]) => left.localeCompare(right)).map(([file, value]) => [file, value.sha256]));
  const files = Object.keys(outputHashes);
  let existing: Record<string, string> = {};
  try { existing = await inventory(outputDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (Object.keys(existing).length) assertInventory(existing, outputHashes, files, 'Existing assembled screen');
  else {
    await mkdir(outputDir, { recursive: true });
    for (const [file, value] of sourceFiles) {
      const target = inside(outputDir, file);
      await mkdir(path.dirname(target), { recursive: true });
      if (value.bytes) await writeFile(target, value.bytes, { flag: 'wx' });
      else await copyFile(value.source!, target, constants.COPYFILE_EXCL);
      if (await fileHash(target) !== value.sha256) throw new Error(`Assembly source changed while copying: ${file}`);
    }
  }
  const fingerprint = hash(JSON.stringify({ screenId, screenNodeIds, workers: workerResults.map(worker => worker.fingerprint), outputHashes }));
  const taskDir = `${outputDir}.assembly-${fingerprint.slice(0, 12)}`;
  await mkdir(taskDir, { recursive: true });
  const result: AgentTaskResult = {
    id: `implement-${slug(screenId)}`, status: 'succeeded', attempts: 1, taskDir, workspace: path.dirname(outputDir), outputDir,
    stdoutPath: path.join(taskDir, 'stdout.log'), stderrPath: path.join(taskDir, 'stderr.log'), fingerprint, files, outputHashes,
  };
  await writeFile(result.stdoutPath, `Deterministically assembled ${widgetPlan.widgets.length} widget outputs covering ${screenNodeIds.length} nodes. Compilation and visual acceptance remain required.\n`);
  await writeFile(result.stderrPath, '');
  await writeJson(path.join(taskDir, 'worker-results.json'), workerResults);
  await writeJson(path.join(taskDir, 'result.json'), result);
  return result;
}
