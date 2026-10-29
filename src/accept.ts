import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createServer, type ViteDevServer } from 'vite';
import { absoluteAssets, loadSnapshot } from './artifacts.js';
import { hash, inside, json, rejectSymlinkPath, slug, writeJson } from './fs.js';
import { validateScreen } from './validate/index.js';
import { runProjectChecks } from './checks.js';
import { verifyComponentPlan, type ComponentPlanReference } from './design-system.js';
import { verifyDataPlan, validateDataImplementation, type DataPlanReference } from './project-data.js';
import type { BridgeConfig, SnapshotManifest } from './types.js';

export interface CompilerDiagnostic { code: number; category: string; message: string; file?: string; line?: number; column?: number }
export interface CompilerReport { status: 'passed' | 'failed'; checkedFiles: string[]; configs: string[]; sourceHashes: Record<string, string>; diagnostics: CompilerDiagnostic[]; reportPath: string }
export interface AcceptanceReport {
  [key: string]: unknown;
  schemaVersion: 1;
  status: 'accepted' | 'failed';
  complete: boolean;
  pixelPerfect: boolean;
  reportPath: string;
  captureHash?: string;
  installedHashes: Record<string, string>;
  issues: string[];
  screens: { screenId: string; status: string; complete: boolean; pixelPerfect?: boolean; reportPath?: string; reason?: string }[];
  compiler?: CompilerReport;
  projectChecks?: unknown;
}

function diagnostic(value: ts.Diagnostic): CompilerDiagnostic {
  const result: CompilerDiagnostic = { code: value.code, category: ts.DiagnosticCategory[value.category].toLowerCase(), message: ts.flattenDiagnosticMessageText(value.messageText, '\n') };
  if (value.file) {
    result.file = path.resolve(value.file.fileName);
    if (value.start !== undefined) { const position = value.file.getLineAndCharacterOfPosition(value.start); result.line = position.line + 1; result.column = position.character + 1; }
  }
  return result;
}

const defaultCompilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX, strict: true, esModuleInterop: true, allowSyntheticDefaultImports: true, skipLibCheck: true, noEmit: true };

function projectConfigs(projectRoot: string): { projects: { filename?: string; parsed: ts.ParsedCommandLine }[]; errors: ts.Diagnostic[] } {
  const errors: ts.Diagnostic[] = [], projects: { filename?: string; parsed: ts.ParsedCommandLine }[] = [];
  const visited = new Set<string>();
  function visit(filename: string): void {
    filename = path.resolve(filename); if (visited.has(filename)) return; visited.add(filename);
    const config = ts.readConfigFile(filename, ts.sys.readFile);
    if (config.error) { errors.push(config.error); return; }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(filename), undefined, filename);
    errors.push(...parsed.errors); projects.push({ filename, parsed });
    for (const reference of parsed.projectReferences ?? []) visit(ts.resolveProjectReferencePath(reference));
  }
  const filename = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
  if (filename && path.resolve(path.dirname(filename)) === path.resolve(projectRoot)) visit(filename);
  if (!projects.length) projects.push({ parsed: { options: { ...defaultCompilerOptions }, fileNames: ts.sys.readDirectory(projectRoot, ['.ts', '.tsx'], ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.pixso-artifacts/**']), errors: [] } });
  return { projects, errors };
}

/** Checks project sources and generated files even when the project's include/exclude omits them. */
export async function checkTypescript(projectRoot: string, installedFiles: string[], outputDir: string, excludeDirs: string[] = []): Promise<CompilerReport> {
  const generated = installedFiles.filter((filename) => /\.[cm]?tsx?$/.test(filename));
  const { projects, errors } = projectConfigs(projectRoot);
  const allDiagnostics = [...errors];
  const checkedFiles = new Set<string>();
  const sourceHashes: Record<string, string> = {};
  let checkedGenerated = false;
  const excluded = (filename: string): boolean => excludeDirs.some((directory) => {
    const relative = path.relative(path.resolve(projectRoot, directory), path.resolve(filename));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
  for (const { parsed } of projects) {
    if (!parsed.fileNames.length && parsed.projectReferences?.length) continue;
    const addGenerated = parsed.options.jsx !== undefined || projects.length === 1;
    const rootNames = [...new Set([...parsed.fileNames.filter((filename) => !excluded(filename)), ...(addGenerated ? generated : [])])];
    if (addGenerated) checkedGenerated = true;
    if (!rootNames.length) continue;
    const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined, declaration: parsed.options.declaration ?? parsed.options.composite };
    const program = ts.createProgram({ rootNames, options });
    for (const source of program.getSourceFiles()) sourceHashes[path.resolve(source.fileName)] = hash(source.text);
    rootNames.forEach((file) => checkedFiles.add(path.resolve(file)));
    allDiagnostics.push(...ts.getPreEmitDiagnostics(program));
  }
  if (!checkedGenerated && generated.length) {
    const main = projects.find((project) => project.parsed.options.moduleResolution !== ts.ModuleResolutionKind.Node16 && project.parsed.options.moduleResolution !== ts.ModuleResolutionKind.NodeNext) ?? projects[0];
    const program = ts.createProgram({ rootNames: generated, options: { ...defaultCompilerOptions, ...main.parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined, declaration: main.parsed.options.declaration ?? main.parsed.options.composite, jsx: main.parsed.options.jsx ?? ts.JsxEmit.ReactJSX } });
    for (const source of program.getSourceFiles()) sourceHashes[path.resolve(source.fileName)] = hash(source.text);
    generated.forEach((file) => checkedFiles.add(path.resolve(file)));
    allDiagnostics.push(...ts.getPreEmitDiagnostics(program));
  }
  const diagnostics = [...new Map(allDiagnostics.map(diagnostic).map((item) => [JSON.stringify(item), item])).values()];
  if (!generated.length) diagnostics.push({ code: 0, category: 'error', message: 'No installed TypeScript source files were provided' });
  const reportPath = path.join(outputDir, 'typescript.json');
  const report: CompilerReport = { status: diagnostics.some((item) => item.category === 'error') ? 'failed' : 'passed', checkedFiles: [...checkedFiles].sort(), configs: projects.flatMap((project) => project.filename ? [project.filename] : []), sourceHashes, diagnostics, reportPath };
  await writeJson(reportPath, report);
  return report;
}

export async function verifyInstalledFiles(projectRoot: string, outputDir: string, files: string[], expected?: Record<string, string>): Promise<Record<string, string>> {
  if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string') || new Set(files).size !== files.length) throw new Error('Applied file inventory is empty or malformed');
  const root = inside(projectRoot, path.relative(projectRoot, path.resolve(outputDir)));
  await rejectSymlinkPath(projectRoot, root);
  const ledgerPath = path.join(root, '.pixso-files.json');
  await rejectSymlinkPath(root, ledgerPath);
  const ledger = await json<Record<string, string>>(ledgerPath);
  const hashes: Record<string, string> = {};
  for (const relative of files) {
    if (path.isAbsolute(relative)) throw new Error(`Applied file must be relative: ${relative}`);
    const filename = inside(root, relative); await rejectSymlinkPath(root, filename);
    const digest = hash(await readFile(filename));
    if (typeof ledger[relative] !== 'string' || ledger[relative] !== digest) throw new Error(`Installed file changed or is missing from the ownership ledger: ${relative}`);
    if (expected && expected[relative] !== digest) throw new Error(`Installed file changed during acceptance: ${relative}`);
    hashes[relative] = digest;
  }
  return hashes;
}

function scriptString(value: string): string { return JSON.stringify(value).replace(/[<>&]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
const fsUrl = (filename: string): string => `/@fs/${path.resolve(filename).replaceAll('\\', '/')}`;

/** Pins every source/resource actually transformed or served by the installed-code preview. */
export async function pinPreviewFile(filename: string, evidence: Record<string, string>): Promise<void> {
  const file = path.resolve(filename), digest = hash(await readFile(file));
  if (evidence[file] !== undefined && evidence[file] !== digest) throw new Error(`Preview dependency changed during acceptance: ${file}`);
  evidence[file] = digest;
}
export async function verifyPreviewEvidence(evidence: Record<string, string>): Promise<void> {
  for (const file of Object.keys(evidence)) await pinPreviewFile(file, evidence);
}
export function previewRequestFile(pathname: string, projectRoot: string, publicDir: string | false): string {
  if (pathname.startsWith('/@fs/')) return path.resolve(pathname.slice(5));
  // Vite serves public/ before project-root files, without invoking transform hooks.
  if (publicDir) {
    const publicFile = inside(publicDir, `.${pathname}`);
    if (ts.sys.fileExists(publicFile)) return publicFile;
  }
  return inside(projectRoot, `.${pathname}`);
}

async function startHarness(config: BridgeConfig, manifest: SnapshotManifest, outputDir: string, evidence: Record<string, string>): Promise<{ server: ViteDevServer; baseUrl: string }> {
  const screenMap = new Map(manifest.screens.map((screen) => [screen.id, inside(outputDir, `${slug(screen.id)}/View.tsx`)]));
  const cssFiles = config.generation.cssFiles.map((filename) => inside(config.projectRoot, filename));
  const setupFile = config.validation.setupFile ? inside(config.projectRoot, config.validation.setupFile) : undefined;
  if (setupFile) { await rejectSymlinkPath(config.projectRoot, setupFile); await pinPreviewFile(setupFile, evidence); }
  for (const filename of cssFiles) await readFile(filename);
  const { projects } = projectConfigs(config.projectRoot);
  const compilerOptions = projects.find((project) => project.parsed.options.jsx !== undefined)?.parsed.options ?? projects[0].parsed.options;
  const server = await createServer({
    configFile: false, root: config.projectRoot, appType: 'custom', logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [config.projectRoot] } },
    plugins: [{
      name: 'pixso-acceptance-harness',
      enforce: 'pre',
      async transform(_code, id) {
        const filename = id.split('?')[0];
        if (path.isAbsolute(filename) && ts.sys.fileExists(filename)) await pinPreviewFile(filename, evidence);
        return null;
      },
      resolveId(source, importer) {
        if (!importer || source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null;
        const resolved = ts.resolveModuleName(source, importer.split('?')[0], compilerOptions, ts.sys).resolvedModule;
        return resolved && !resolved.isExternalLibraryImport && !/\.d\.[cm]?ts$/.test(resolved.resolvedFileName) ? resolved.resolvedFileName : null;
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          try {
            // Reject direct reference serving; reference pixels are comparison data, never UI assets.
            const pathname = decodeURIComponent(url.pathname);
            const candidate = previewRequestFile(pathname, config.projectRoot, vite.config.publicDir);
            if (ts.sys.fileExists(candidate)) {
              const artifactRelative = path.relative(path.resolve(config.artifactsDir), candidate);
              if (!path.isAbsolute(artifactRelative) && artifactRelative !== '..' && !artifactRelative.startsWith(`..${path.sep}`)) throw new Error('Design artifact files must not be served by the implementation preview');
              await pinPreviewFile(candidate, evidence);
            }
          } catch (error) { response.statusCode = 403; response.end(error instanceof Error ? error.message : String(error)); return; }
          if (url.pathname !== '/__pixso_preview') { next(); return; }
          const filename = screenMap.get(url.searchParams.get('screen') ?? '');
          if (!filename) { response.statusCode = 404; response.end('Unknown Pixso screen'); return; }
          const imports = cssFiles.map((file) => `import ${scriptString(fsUrl(file))};`).join('\n');
          const setup = setupFile ? `import {preparePixsoPreview} from ${scriptString(fsUrl(setupFile))};
const preview = await preparePixsoPreview({screenId:${scriptString(url.searchParams.get('screen')!)}});
if (!preview || typeof preview !== 'object' || Array.isArray(preview) || Object.keys(preview).some(key => !['props','Provider'].includes(key))) throw new Error('preparePixsoPreview must return {props?,Provider?}');
if (preview.props !== undefined && (!preview.props || typeof preview.props !== 'object' || Array.isArray(preview.props))) throw new Error('Preview props must be an object');` : 'const preview = {};';
          const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="pixso-preview-root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';${imports}import View from ${scriptString(fsUrl(filename))};${setup}const view=React.createElement(View,preview.props);createRoot(document.getElementById('pixso-preview-root')).render(preview.Provider ? React.createElement(preview.Provider,null,view) : view);</script></body></html>`;
          try { response.statusCode = 200; response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url ?? '/__pixso_preview', html)); }
          catch (error) { response.statusCode = 500; response.end(error instanceof Error ? error.message : String(error)); }
        });
      },
    }],
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Local Vite preview did not expose a TCP port');
    return { server, baseUrl: `http://127.0.0.1:${address.port}/__pixso_preview` };
  } catch (error) { await server.close(); throw error; }
}

/** Acceptance is tied to the immutable capture and the hashes of the installed project files. */
export async function acceptRun(runDir: string, config: BridgeConfig): Promise<AcceptanceReport> {
  const directory = path.join(path.resolve(runDir), 'acceptance'); await mkdir(directory, { recursive: true });
  const report: AcceptanceReport = { schemaVersion: 1, status: 'failed', complete: false, pixelPerfect: false, reportPath: path.join(directory, 'acceptance.json'), installedHashes: {}, issues: [], screens: [] };
  let harness: Awaited<ReturnType<typeof startHarness>> | undefined;
  const previewEvidence: Record<string, string> = {};
  try {
    const result = await json<{ snapshot: string; unsupported: unknown[]; generation: { status: string }; componentPlan?: ComponentPlanReference; dataPlan?: DataPlanReference }>(path.join(runDir, 'result.json'));
    const applied = await json<{ outputDir: string; files: string[]; snapshot: string }>(path.join(runDir, 'applied.json'));
    if (typeof result.snapshot !== 'string' || !Array.isArray(result.unsupported) || result.generation?.status !== 'succeeded') throw new Error('Run has no successfully generated, coverage-checked code');
    if (path.resolve(applied.snapshot) !== path.resolve(result.snapshot)) throw new Error('Applied files belong to a different snapshot');
    if (path.resolve(applied.outputDir) !== path.resolve(config.projectRoot, config.generation.outputDir)) throw new Error('Applied output directory does not match the project configuration');
    const { capture, manifest } = await loadSnapshot(result.snapshot);
    const absoluteCapture = absoluteAssets(capture, result.snapshot);
    report.captureHash = manifest.captureHash;
    report.snapshot = path.resolve(result.snapshot);
    report.unsupported = result.unsupported;
    if (result.unsupported.length) report.issues.push(`${result.unsupported.length} unresolved generation fidelity gaps`);
    if (!manifest.screens.length) throw new Error('Snapshot has no screens to accept');
    for (const screen of manifest.screens) for (const filename of ['View.tsx', 'View.css', 'coverage.json']) if (!applied.files.includes(`${slug(screen.id)}/${filename}`)) throw new Error(`Applied screen file is missing: ${screen.id}/${filename}`);
    report.installedHashes = await verifyInstalledFiles(config.projectRoot, applied.outputDir, applied.files);
    if (!result.componentPlan) throw new Error('Missing mandatory component-plan.json evidence; rerun analysis before acceptance');
    const expectedNodeIds = [...new Set(manifest.screens.flatMap(screen => screen.nodeIds))];
    await verifyComponentPlan(result.componentPlan, config, expectedNodeIds, manifest.captureHash);
    report.componentPlan = result.componentPlan;
    if (!result.dataPlan) throw new Error('Missing mandatory data-plan.json evidence; rerun analysis before acceptance');
    const dataPlan = await verifyDataPlan(result.dataPlan, config, expectedNodeIds, manifest.captureHash);
    report.dataPlan = result.dataPlan;
    for (const screen of manifest.screens) await validateDataImplementation(dataPlan, inside(applied.outputDir, slug(screen.id)), screen.nodeIds);
    const setupFile = config.validation.setupFile ? inside(config.projectRoot, config.validation.setupFile) : undefined;
    if (setupFile) { await rejectSymlinkPath(config.projectRoot, setupFile); await pinPreviewFile(setupFile, previewEvidence); }
    for (const project of projectConfigs(config.projectRoot).projects) if (project.filename) await pinPreviewFile(project.filename, previewEvidence);
    report.validationMode = config.validation.mode ?? 'pixel-perfect';
    if (config.validation.mode === 'tolerant') report.issues.push('Tolerant comparison is diagnostic only; pixel-perfect acceptance requires exact RGBA equality');
    report.compiler = await checkTypescript(config.projectRoot, [...applied.files.map((file) => inside(applied.outputDir, file)), ...(setupFile ? [setupFile] : [])], directory, [config.artifactsDir]);
    if (report.compiler.status !== 'passed') report.issues.push('TypeScript compilation failed; inspect typescript.json');
    const projectChecks = await runProjectChecks(config, path.join(directory, 'project-checks'));
    report.projectChecks = projectChecks;
    if (projectChecks.status === 'failed') report.issues.push('Configured project checks failed');
    report.projectChecksCoverage = projectChecks.status === 'not-configured' ? 'No project-specific validation commands were configured; built-in TypeScript and per-screen DOM/pixel checks are mandatory and independent.' : 'Configured project validation commands were executed.';
    // A separately supplied URL cannot prove that it renders the installed files.
    if (report.compiler.status === 'passed') harness = await startHarness(config, manifest, applied.outputDir, previewEvidence);
    report.previewMode = 'mandatory-installed-code-harness';
    const integrationScreens: AcceptanceReport['screens'] = [];
    report.integrationScreens = integrationScreens;
    for (const screen of manifest.screens) {
      if (report.compiler.status !== 'passed') { report.screens.push({ screenId: screen.id, status: 'failed', complete: false, reason: 'Preview skipped because TypeScript compilation failed' }); continue; }
      if (!capture.screenshots.some((reference) => reference.nodeId === screen.id)) report.issues.push(`Screen ${screen.id} has no independent reference screenshot`);
      const target = `${harness!.baseUrl}?screen=${encodeURIComponent(screen.id)}`;
      try {
        const selected = new Set(screen.nodeIds);
        const nodes = absoluteCapture.nodes.filter((node) => selected.has(node.id));
        const root = nodes.find((node) => node.id === screen.id);
        if (!root?.bounds || root.bounds.width <= 0 || root.bounds.height <= 0) throw new Error('Screen has no measurable viewport');
        const reference = absoluteCapture.screenshots.find((item) => item.nodeId === screen.id);
        if (reference && reference.scale !== 1) throw new Error('Reference screenshot must have scale=1');
        const validation = await validateScreen({ ...config.validation, url: target, rootNodeId: screen.id, nodes, referencePath: reference?.path, viewport: { width: Math.ceil(root.bounds.width), height: Math.ceil(root.bounds.height) }, outputDir: path.join(directory, 'screens', slug(screen.id)) });
        report.screens.push({ screenId: screen.id, status: validation.status, complete: validation.complete, pixelPerfect: validation.pixelPerfect, reportPath: validation.reportPath });
        if (!validation.complete || !validation.pixelPerfect || validation.status !== 'passed') report.issues.push(`Screen ${screen.id} failed pixel-perfect acceptance (${validation.status})`);
        if (config.validation.url) {
          const integration = await validateScreen({ ...config.validation, url: config.validation.url.replaceAll('{screenId}', encodeURIComponent(screen.id)), rootNodeId: screen.id, nodes, referencePath: reference?.path, viewport: { width: Math.ceil(root.bounds.width), height: Math.ceil(root.bounds.height) }, outputDir: path.join(directory, 'integration', slug(screen.id)) });
          integrationScreens.push({ screenId: screen.id, status: integration.status, complete: integration.complete, pixelPerfect: integration.pixelPerfect, reportPath: integration.reportPath });
          if (!integration.complete || !integration.pixelPerfect) report.issues.push(`Screen ${screen.id} failed additional project URL validation`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.screens.push({ screenId: screen.id, status: 'failed', complete: false, reason }); report.issues.push(`Screen ${screen.id}: ${reason}`);
      }
    }
    await verifyInstalledFiles(config.projectRoot, applied.outputDir, applied.files, report.installedHashes);
    await verifyPreviewEvidence(previewEvidence);
    for (const [filename, digest] of Object.entries(report.compiler.sourceHashes)) {
      const text = ts.sys.readFile(filename);
      if (text === undefined || hash(text) !== digest) throw new Error(`Compiler input changed during acceptance: ${filename}`);
    }
    await verifyComponentPlan(result.componentPlan, config, expectedNodeIds, manifest.captureHash);
    await verifyDataPlan(result.dataPlan, config, expectedNodeIds, manifest.captureHash);
    if ((await loadSnapshot(result.snapshot)).manifest.captureHash !== manifest.captureHash) throw new Error('Snapshot changed during acceptance');
    report.complete = report.issues.length === 0 && report.compiler.status === 'passed' && report.screens.length === manifest.screens.length && report.screens.every((screen) => screen.complete && screen.pixelPerfect === true && screen.status === 'passed');
    report.pixelPerfect = report.complete;
    report.scope = 'Captured screen viewports and states in this browser environment; no guarantee for uncaptured breakpoints, interactions or other rendering engines';
    report.status = report.complete ? 'accepted' : 'failed';
  } catch (error) { report.issues.push(error instanceof Error ? error.message : String(error)); }
  finally {
    if (harness) { try { await harness.server.close(); } catch (error) { report.issues.push(`Preview shutdown failed: ${String(error)}`); report.status = 'failed'; report.complete = false; report.pixelPerfect = false; } }
    report.finishedAt = new Date().toISOString();
    report.previewEvidence = previewEvidence;
    await writeJson(report.reportPath, report);
  }
  return report;
}
